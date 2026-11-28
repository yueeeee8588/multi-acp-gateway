import { createHash } from 'node:crypto';
import type {
  GatewayConfig,
  GeminiContent,
  GeminiFunctionDeclaration,
  SensitiveWordRule,
  SensitiveWordScope,
} from '../types';

export type SensitiveFilterConfig = Pick<
  GatewayConfig,
  'sensitiveFilterEnabled' | 'sensitiveWords'
>;

export type SensitiveFilterToolDeclaration = GeminiFunctionDeclaration & {
  parametersJsonSchema?: Record<string, unknown>;
};

const REGEX_META_RE = /[.*+?^${}()|[\]\\]/g;

function escapeRegExp(pattern: string): string {
  return pattern.replace(REGEX_META_RE, '\\$&');
}

export function getEffectiveSensitiveRules(
  config: SensitiveFilterConfig,
): SensitiveWordRule[] {
  if (!config.sensitiveFilterEnabled || !Array.isArray(config.sensitiveWords)) {
    return [];
  }
  return config.sensitiveWords.filter(
    (rule): rule is SensitiveWordRule =>
      Boolean(rule && rule.enabled && typeof rule.pattern === 'string' && rule.pattern.trim().length > 0),
  );
}

export function computeSensitiveFilterFingerprint(config: SensitiveFilterConfig): string {
  const effective = getEffectiveSensitiveRules(config);
  if (effective.length === 0) {
    return '';
  }
  const canonical = effective.map((rule) => ({
    pattern: rule.pattern,
    replace: typeof rule.replace === 'string' ? rule.replace : '',
    case_insensitive: Boolean(rule.case_insensitive),
    scope: rule.scope ?? 'all',
  }));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

interface ParsedWildcardPattern {
  startsWithWildcard: boolean;
  endsWithWildcard: boolean;
  literals: string[];
}

function parseWildcardPattern(pattern: string): ParsedWildcardPattern | null {
  const collapsed = pattern.replace(/\*+/g, '*');
  if (collapsed.replace(/\*/g, '').trim().length === 0) {
    return null;
  }
  const parts = collapsed.split('*');
  const startsWithWildcard = parts[0] === '';
  const endsWithWildcard = parts[parts.length - 1] === '';
  const literals = parts.filter((part) => part.length > 0);
  if (literals.length === 0) {
    return null;
  }
  return { startsWithWildcard, endsWithWildcard, literals };
}

function replaceWildcardOnLine(
  line: string,
  parsed: ParsedWildcardPattern,
  replacement: string,
  patterns: RegExp[],
): string {
  const findLiteral = (index: number, from: number): number => {
    const pattern = patterns[index];
    if (!pattern) return line.indexOf(parsed.literals[index]!, from);
    pattern.lastIndex = from;
    return pattern.exec(line)?.index ?? -1;
  };

  let cursor = 0;
  let result = '';
  let changed = false;

  while (cursor <= line.length) {
    const firstIdx = findLiteral(0, cursor);
    if (firstIdx === -1) {
      if (!changed) return line;
      result += line.slice(cursor);
      break;
    }

    const matchStart = parsed.startsWithWildcard ? cursor : firstIdx;
    let pos = firstIdx + parsed.literals[0]!.length;
    let matched = true;
    for (let i = 1; i < parsed.literals.length; i++) {
      const idx = findLiteral(i, pos);
      if (idx === -1) {
        matched = false;
        break;
      }
      pos = idx + parsed.literals[i]!.length;
    }

    if (!matched) {
      if (!changed) return line;
      result += line.slice(cursor);
      break;
    }

    const matchEnd = parsed.endsWithWildcard ? line.length : pos;
    result += line.slice(cursor, matchStart) + replacement;
    changed = true;
    cursor = matchEnd;

    if (parsed.endsWithWildcard) {
      break;
    }
  }

  return result;
}

function applyWildcardRule(
  text: string,
  pattern: string,
  replacement: string,
  caseInsensitive: boolean,
): string {
  const parsed = parseWildcardPattern(pattern);
  if (!parsed) {
    return text;
  }

  // Literal-only expressions preserve the original string offsets in case-insensitive matches.
  const patterns = caseInsensitive
    ? parsed.literals.map((literal) => new RegExp(escapeRegExp(literal), 'gi'))
    : [];
  let out = '';
  let lineStart = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text.charCodeAt(i);
    if (ch === 13 || ch === 10) {
      const line = text.slice(lineStart, i);
      out += replaceWildcardOnLine(line, parsed, replacement, patterns);
      const sepStart = i;
      if (ch === 13 && i + 1 < text.length && text.charCodeAt(i + 1) === 10) {
        i += 2;
      } else {
        i += 1;
      }
      out += text.slice(sepStart, i);
      lineStart = i;
    } else {
      i += 1;
    }
  }
  if (lineStart <= text.length) {
    out += replaceWildcardOnLine(text.slice(lineStart), parsed, replacement, patterns);
  }
  return out;
}

/**
 * 按顺序应用敏感词替换规则，确定性输出（不破坏前缀缓存）。
 */
export function filterTextWithSensitiveRules(
  text: string,
  rules: readonly SensitiveWordRule[],
  targetScope?: SensitiveWordScope,
): string {
  if (!text || !Array.isArray(rules) || rules.length === 0) {
    return text;
  }
  let out = text;
  for (const rule of rules) {
    if (!rule || !rule.enabled || typeof rule.pattern !== 'string' || rule.pattern.trim().length === 0) {
      continue;
    }
    if (targetScope !== undefined) {
      const ruleScope = rule.scope ?? 'all';
      if (ruleScope !== 'all' && ruleScope !== targetScope) {
        continue;
      }
    }
    const replacement = typeof rule.replace === 'string' ? rule.replace : '';
    if (rule.pattern.includes('*')) {
      out = applyWildcardRule(out, rule.pattern, replacement, Boolean(rule.case_insensitive));
    } else if (rule.case_insensitive) {
      const escaped = escapeRegExp(rule.pattern);
      const re = new RegExp(escaped, 'gi');
      out = out.replace(re, () => replacement);
    } else {
      out = out.split(rule.pattern).join(replacement);
    }
  }
  return out;
}

export function applySensitiveFilterToText(
  text: string,
  config: SensitiveFilterConfig,
  targetScope: SensitiveWordScope = 'system',
): string {
  if (!text) {
    return text;
  }
  const effectiveRules = getEffectiveSensitiveRules(config);
  if (effectiveRules.length === 0) {
    return text;
  }
  return filterTextWithSensitiveRules(text, effectiveRules, targetScope);
}

export function applySensitiveFilterToContents(
  contents: GeminiContent[],
  config: SensitiveFilterConfig,
): GeminiContent[] {
  if (!Array.isArray(contents) || contents.length === 0) {
    return contents;
  }
  const effectiveRules = getEffectiveSensitiveRules(config);
  if (effectiveRules.length === 0) {
    return contents;
  }
  return contents.map((content) => {
    if (!Array.isArray(content.parts) || content.parts.length === 0) {
      return content;
    }
    let changed = false;
    const nextParts = content.parts.map((part) => {
      if (typeof part.text !== 'string') {
        return part;
      }
      const filtered = filterTextWithSensitiveRules(part.text, effectiveRules, 'messages');
      if (filtered === part.text) {
        return part;
      }
      changed = true;
      return { ...part, text: filtered };
    });
    return changed ? { ...content, parts: nextParts } : content;
  });
}

export function applySensitiveFilterToTools<T extends SensitiveFilterToolDeclaration>(
  declarations: T[],
  config: SensitiveFilterConfig,
): T[] {
  if (!Array.isArray(declarations) || declarations.length === 0) {
    return declarations;
  }
  const effectiveRules = getEffectiveSensitiveRules(config);
  if (effectiveRules.length === 0) {
    return declarations;
  }
  return declarations.map((decl) => {
    if (typeof decl.description !== 'string' || decl.description.length === 0) {
      return decl;
    }
    const filteredDescription = filterTextWithSensitiveRules(
      decl.description,
      effectiveRules,
      'tools',
    );
    if (filteredDescription === decl.description) {
      return decl;
    }
    return {
      ...decl,
      description: filteredDescription,
    };
  });
}
