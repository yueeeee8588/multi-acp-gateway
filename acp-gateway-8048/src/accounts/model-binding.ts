import type { ModelAccessRule, ModelAccountBinding } from '../types';

export function wildcardMatch(pattern: string, target: string): boolean {
  pattern = pattern.toLowerCase();
  target = target.toLowerCase();

  // Match the fixed suffix first so a trailing literal cannot trigger retries.
  const lastStar = pattern.lastIndexOf('*');
  const suffixLength = pattern.length - lastStar - 1;
  const targetEnd = target.length - suffixLength;
  if (targetEnd < 0 || (lastStar < 0 && targetEnd !== 0)) return false;
  for (let offset = 0; offset < suffixLength; offset++) {
    const char = pattern[lastStar + 1 + offset];
    if (char !== '?' && char !== target[targetEnd + offset]) return false;
  }
  if (lastStar < 0) return true;

  let patternIndex = 0;
  let targetIndex = 0;
  let restartPattern = -1;
  let restartTarget = 0;
  while (targetIndex < targetEnd) {
    const char = pattern[patternIndex];
    if (char === '*') {
      restartPattern = ++patternIndex;
      restartTarget = targetIndex;
      if (patternIndex > lastStar) return true;
    } else if (char === '?' || char === target[targetIndex]) {
      patternIndex++;
      targetIndex++;
    } else if (restartPattern >= 0) {
      patternIndex = restartPattern;
      targetIndex = ++restartTarget;
    } else {
      return false;
    }
  }
  while (pattern[patternIndex] === '*') patternIndex++;
  return patternIndex > lastStar;
}

export function matchesModelAccessRule(rule: ModelAccessRule | undefined, model: string): boolean {
  if (!rule || rule.mode === 'all') return true;
  const matched = rule.patterns.some((pattern) => wildcardMatch(pattern, model));
  return rule.mode === 'allow' ? matched : !matched;
}

function specificity(pattern: string): number[] {
  let literalCount = 0;
  let starCount = 0;
  let prefixLength = pattern.length;
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === '*' || char === '?') {
      prefixLength = Math.min(prefixLength, index);
      if (char === '*') starCount++;
    } else {
      literalCount++;
    }
  }
  return [Number(literalCount === pattern.length), literalCount, prefixLength, -starCount];
}

export function resolveModelAccountBinding(
  bindings: ModelAccountBinding[] | undefined,
  model: string,
): ModelAccountBinding | null {
  let winner: ModelAccountBinding | null = null;
  let winnerScore: number[] = [];
  for (const binding of bindings ?? []) {
    if (binding.enabled === false || !binding.accountIds.length || !wildcardMatch(binding.modelPattern, model)) continue;
    const score = specificity(binding.modelPattern);
    const firstDifference = score.findIndex((value, index) => value !== winnerScore[index]);
    if (!winner || (firstDifference >= 0 && score[firstDifference]! > winnerScore[firstDifference]!)) {
      winner = binding;
      winnerScore = score;
    }
  }
  return winner;
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

export function normalizeModelAccessRule(value: unknown): ModelAccessRule {
  if (value === undefined) return { mode: 'all', patterns: [] };
  const { mode, patterns } = requireObject(value, 'modelAccessRule');
  if (mode !== 'all' && mode !== 'allow' && mode !== 'deny') {
    throw new TypeError('modelAccessRule.mode must be all, allow or deny');
  }
  if (!Array.isArray(patterns)) throw new TypeError('modelAccessRule.patterns must be an array');
  return {
    mode,
    patterns: patterns.map((pattern, index) => requireNonEmptyString(pattern, `modelAccessRule.patterns[${index}]`)),
  };
}

export function normalizeModelAccountBindings(value: unknown): ModelAccountBinding[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError('modelAccountBindings must be an array');
  const ids = new Set<string>();
  return value.map((entry, index) => {
    const field = `modelAccountBindings[${index}]`;
    const { id, modelPattern, mode, accountIds, enabled, note } = requireObject(entry, field);
    const bindingId = requireNonEmptyString(id, `${field}.id`);
    const pattern = requireNonEmptyString(modelPattern, `${field}.modelPattern`);
    if (ids.has(bindingId)) throw new TypeError(`${field}.id must be unique`);
    ids.add(bindingId);
    if (mode !== 'exclusive' && mode !== 'priority') {
      throw new TypeError(`${field}.mode must be exclusive or priority`);
    }
    if (!Array.isArray(accountIds)) throw new TypeError(`${field}.accountIds must be an array`);
    if (typeof enabled !== 'boolean') throw new TypeError(`${field}.enabled must be a boolean`);
    if (note !== undefined && typeof note !== 'string') throw new TypeError(`${field}.note must be a string`);
    return {
      id: bindingId,
      modelPattern: pattern,
      mode,
      accountIds: [...new Set(accountIds.map((accountId, accountIndex) =>
        requireNonEmptyString(accountId, `${field}.accountIds[${accountIndex}]`),
      ))],
      enabled,
      ...(note?.trim() ? { note: note.trim() } : {}),
    };
  });
}
