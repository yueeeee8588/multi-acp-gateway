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

function isFilterActive(config: SensitiveFilterConfig): boolean {
  return getEffectiveSensitiveRules(config).length > 0;
}

function compileWildcardPattern(pattern: string, caseInsensitive: boolean): RegExp | null {
  const collapsed = pattern.replace(/\*+/g, '*');
  if (collapsed.replace(/\*/g, '').trim().length === 0) {
    return null;
  }
  const parts = collapsed.split('*').map(escapeRegExp);
  const startsWithWildcard = collapsed.startsWith('*');
  const endsWithWildcard = collapsed.endsWith('*');
  let regexSource = parts[0];
  for (let i = 0; i < parts.length - 1; i++) {
    const isLeading = i === 0 && startsWithWildcard;
    const isTrailing = i === parts.length - 2 && endsWithWildcard;
    const wildcard = isLeading || isTrailing ? '[^\\r\\n]*' : '[^\\r\\n]*?';
    regexSource += wildcard + parts[i + 1];
  }
  return new RegExp(regexSource, caseInsensitive ? 'gi' : 'g');
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
    if (!rule || !rule.enabled || !rule.pattern) continue;
    if (targetScope !== undefined) {
      const ruleScope = rule.scope ?? 'all';
      if (ruleScope !== 'all' && ruleScope !== targetScope) {
        continue;
      }
    }
    const replacement = typeof rule.replace === 'string' ? rule.replace : '';
    if (rule.pattern.includes('*')) {
      const re = compileWildcardPattern(rule.pattern, Boolean(rule.case_insensitive));
      if (!re) continue;
      out = out.replace(re, () => replacement);
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
  if (!text || !isFilterActive(config)) {
    return text;
  }
  return filterTextWithSensitiveRules(text, config.sensitiveWords, targetScope);
}

export function applySensitiveFilterToContents(
  contents: GeminiContent[],
  config: SensitiveFilterConfig,
): GeminiContent[] {
  if (!Array.isArray(contents) || contents.length === 0 || !isFilterActive(config)) {
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
      const filtered = filterTextWithSensitiveRules(part.text, config.sensitiveWords, 'messages');
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
  if (!Array.isArray(declarations) || declarations.length === 0 || !isFilterActive(config)) {
    return declarations;
  }
  return declarations.map((decl) => {
    if (typeof decl.description !== 'string' || decl.description.length === 0) {
      return decl;
    }
    const filteredDescription = filterTextWithSensitiveRules(
      decl.description,
      config.sensitiveWords,
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
