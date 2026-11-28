import { store } from '../db/store';
import type {
  GatewayConfig,
  QuotaCooldownScope,
  RoutingStrategy,
  SensitiveWordRule,
  SensitiveWordScope,
} from '../types';

const VALID_SENSITIVE_WORD_SCOPES = new Set<SensitiveWordScope>([
  'all',
  'system',
  'messages',
  'tools',
]);

const VALID_ROUTING_STRATEGIES = new Set<RoutingStrategy>([
  'sticky-round-robin',
  'fill-first',
  'cache-first',
  'performance-first',
]);

const VALID_QUOTA_COOLDOWN_SCOPES = new Set<QuotaCooldownScope>([
  'family',
  'account',
]);

export const RISK_CONTROL_LIMITS = {
  maxConcurrencyPerExitIp: { min: 0, max: 64 },
  minExitIpRequestIntervalMs: { min: 0, max: 10000 },
  minAccountRequestIntervalMs: { min: 0, max: 30000 },
  requestJitterMs: { min: 0, max: 10000 },
  maxWorkerSpawnsPerMinute: { min: 0, max: 120 },
  maxQuotaAccountSwitches: { min: 0, max: 10 },
  policyBlockCooldownMs: { min: 60_000, max: 604_800_000 },
  maxInternal429RetriesBeforeCancel: { min: 1, max: 8 },
} as const;

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function normalizeString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function normalizePositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    return fallback;
  }
  return Math.max(1, Math.round(value));
}

function normalizeNonNegativeInt(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return Math.max(0, Math.round(value));
}

function normalizeCooldownStepsMinutes(value: unknown, fallback: number[]): number[] {
  if (!Array.isArray(value)) {
    return [...fallback];
  }
  const filtered = value.filter(
    (item): item is number => typeof item === 'number' && Number.isFinite(item) && item > 0,
  );
  return filtered.length > 0 ? filtered : [...fallback];
}

export function validateCoreConfigPatch(patch: Record<string, unknown>): void {
  for (const field of ['host', 'agyPath'] as const) {
    if (field in patch && patch[field] !== undefined && typeof patch[field] !== 'string') {
      throw new Error(`${field} must be a string`);
    }
  }
  for (const field of ['perAccountConcurrency', 'maxImagesPerRequest', 'maxLogsRetained'] as const) {
    if (field in patch && patch[field] !== undefined) {
      const value = patch[field];
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
        throw new Error(`${field} must be a positive integer`);
      }
    }
  }
  for (const field of ['maxAccountSwitches', 'queueWaitTimeoutMs', 'softErrorCutoffMs'] as const) {
    if (field in patch && patch[field] !== undefined) {
      const value = patch[field];
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        throw new Error(`${field} must be a non-negative integer`);
      }
    }
  }
  if ('cooldownStepsMinutes' in patch && patch.cooldownStepsMinutes !== undefined) {
    const value = patch.cooldownStepsMinutes;
    if (
      !Array.isArray(value) ||
      value.length === 0 ||
      !value.every((item) => typeof item === 'number' && Number.isFinite(item) && item > 0)
    ) {
      throw new Error('cooldownStepsMinutes must be a non-empty array of positive numbers');
    }
  }
}

function normalizeBoundedInt(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  const rounded = Math.round(value);
  return Math.min(max, Math.max(min, rounded));
}

function normalizeQuotaCooldownScope(
  value: unknown,
  fallback: QuotaCooldownScope,
): QuotaCooldownScope {
  return typeof value === 'string' && VALID_QUOTA_COOLDOWN_SCOPES.has(value as QuotaCooldownScope)
    ? (value as QuotaCooldownScope)
    : fallback;
}

export function validateRiskControlPatch(patch: Record<string, unknown>): void {
  validateCoreConfigPatch(patch);
  for (const field of [
    'strictProxyBinding',
    'blockOnExitIpDrift',
    'excludeDefaultComponents',
    'accountFailover',
  ] as const) {
    if (field in patch && patch[field] !== undefined && typeof patch[field] !== 'boolean') {
      throw new Error(`${field} must be a boolean`);
    }
  }

  for (const [field, { min, max }] of Object.entries(RISK_CONTROL_LIMITS) as Array<
    [keyof typeof RISK_CONTROL_LIMITS, { min: number; max: number }]
  >) {
    if (field in patch && patch[field] !== undefined) {
      const value = patch[field];
      if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
        throw new Error(`${field} must be an integer between ${min} and ${max}`);
      }
    }
  }

  if ('quotaCooldownScope' in patch && patch.quotaCooldownScope !== undefined) {
    if (
      typeof patch.quotaCooldownScope !== 'string' ||
      !VALID_QUOTA_COOLDOWN_SCOPES.has(patch.quotaCooldownScope as QuotaCooldownScope)
    ) {
      throw new Error("quotaCooldownScope must be 'family' or 'account'");
    }
  }
}

function normalizeRoutingStrategy(
  value: unknown,
  fallback: RoutingStrategy,
): RoutingStrategy {
  return typeof value === 'string' && VALID_ROUTING_STRATEGIES.has(value as RoutingStrategy)
    ? (value as RoutingStrategy)
    : fallback;
}

export function validateSensitiveFilterPatch(patch: Record<string, unknown>): void {
  if ('sensitiveFilterEnabled' in patch && typeof patch.sensitiveFilterEnabled !== 'boolean') {
    throw new Error('sensitiveFilterEnabled must be a boolean');
  }
  if ('sensitiveWords' in patch) {
    if (!Array.isArray(patch.sensitiveWords)) {
      throw new Error('sensitiveWords must be an array');
    }
    for (let i = 0; i < patch.sensitiveWords.length; i++) {
      const item = patch.sensitiveWords[i];
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new Error(`sensitiveWords[${i}] must be an object`);
      }
      const r = item as Record<string, unknown>;
      if (typeof r.pattern !== 'string') {
        throw new Error(`sensitiveWords[${i}].pattern must be a string`);
      }
      if (typeof r.replace !== 'string') {
        throw new Error(`sensitiveWords[${i}].replace must be a string`);
      }
      if (typeof r.case_insensitive !== 'boolean') {
        throw new Error(`sensitiveWords[${i}].case_insensitive must be a boolean`);
      }
      if (typeof r.enabled !== 'boolean') {
        throw new Error(`sensitiveWords[${i}].enabled must be a boolean`);
      }
      if (
        r.scope !== undefined &&
        (typeof r.scope !== 'string' ||
          !VALID_SENSITIVE_WORD_SCOPES.has(r.scope as SensitiveWordScope))
      ) {
        throw new Error(
          `sensitiveWords[${i}].scope must be one of all, system, messages, tools`,
        );
      }
    }
  }
}

function normalizeSensitiveWords(
  value: unknown,
  fallback: SensitiveWordRule[],
): SensitiveWordRule[] {
  if (!Array.isArray(value)) {
    return fallback.map((rule) => ({
      ...rule,
      scope:
        rule.scope && VALID_SENSITIVE_WORD_SCOPES.has(rule.scope)
          ? rule.scope
          : 'all',
    }));
  }
  const out: SensitiveWordRule[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const r = item as Record<string, unknown>;
    if (typeof r.pattern !== 'string' || r.pattern.trim().length === 0) continue;
    const scope: SensitiveWordScope =
      typeof r.scope === 'string' &&
      VALID_SENSITIVE_WORD_SCOPES.has(r.scope as SensitiveWordScope)
        ? (r.scope as SensitiveWordScope)
        : 'all';
    out.push({
      pattern: r.pattern,
      replace: typeof r.replace === 'string' ? r.replace : '',
      case_insensitive: Boolean(r.case_insensitive),
      enabled: typeof r.enabled === 'boolean' ? r.enabled : true,
      scope,
    });
  }
  return out;
}

export const DEFAULT_CONFIG: GatewayConfig = {
  port: 8048,
  host: '127.0.0.1',
  agyPath: '',
  apiKey: '',
  defaultProxy: '',
  routingStrategy: 'sticky-round-robin',
  perAccountConcurrency: 2,
  maxAccountSwitches: 3,
  queueWaitTimeoutMs: 60000,
  softErrorCutoffMs: 2800,
  cooldownStepsMinutes: [1, 5, 15, 30, 60],
  maxImagesPerRequest: 200,
  maxLogsRetained: 500,
  // 默认不再把思考块即时透传给客户端：先缓冲，等真正出现正文再统一下发。
  // 配合 handler 的 alt=sse "提前放行 200 + : keepalive" 保活，纯思考/空响应期间既不会
  // 把脏思考泄给客户端，也不会让客户端干等响应头，更不会把重试闸门锁死。
  streamThoughtImmediately: false,
  // alt=sse 下"只出思考不出正文"时最多等多久就先放行 200（并起 : keepalive 心跳）。
  streamThoughtEarlyReleaseMs: 3000,
  cacheSettlingDelayMs: 1000,
  strictProxyBinding: true,
  blockOnExitIpDrift: false,
  maxConcurrencyPerExitIp: 4,
  minExitIpRequestIntervalMs: 250,
  minAccountRequestIntervalMs: 500,
  requestJitterMs: 300,
  maxWorkerSpawnsPerMinute: 12,
  quotaCooldownScope: 'family',
  excludeDefaultComponents: false,
  accountFailover: false,
  maxQuotaAccountSwitches: 1,
  policyBlockCooldownMs: 21_600_000,
  maxInternal429RetriesBeforeCancel: 2,
  sensitiveFilterEnabled: false,
  sensitiveWords: [],
  modelAccountBindings: [],
};

const CACHE_SETTLING_DELAY_MIN_MS = 0;
const CACHE_SETTLING_DELAY_MAX_MS = 5000;

function normalizeCacheSettlingDelayMs(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  const rounded = Math.round(value);
  return Math.min(CACHE_SETTLING_DELAY_MAX_MS, Math.max(CACHE_SETTLING_DELAY_MIN_MS, rounded));
}

function parseEnvCacheSettlingDelayMs(): number | null {
  const raw =
    process.env.AGY_CACHE_SETTLING_DELAY_MS ??
    process.env.ANTIGRAVITY_CACHE_SETTLING_DELAY_MS;
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  if (
    !Number.isFinite(parsed) ||
    parsed < CACHE_SETTLING_DELAY_MIN_MS ||
    parsed > CACHE_SETTLING_DELAY_MAX_MS
  ) {
    return null;
  }
  return Math.round(parsed);
}

const CONFIG_KEY = 'gateway_config';
let cachedConfig: GatewayConfig | null = null;

export function invalidateConfigCache(): void {
  cachedConfig = null;
}

export function getConfig(): GatewayConfig {
  if (cachedConfig) {
    return {
      ...cachedConfig,
      cooldownStepsMinutes: [...cachedConfig.cooldownStepsMinutes],
      sensitiveWords: cachedConfig.sensitiveWords.map((rule) => ({ ...rule })),
      modelAccountBindings: (cachedConfig.modelAccountBindings ?? []).map((b) => ({
        ...b,
        accountIds: [...b.accountIds],
      })),
    };
  }
  const saved = store.getConfigValue<Partial<GatewayConfig>>(CONFIG_KEY);
  const resolved: GatewayConfig = !saved
    ? {
        ...DEFAULT_CONFIG,
        cooldownStepsMinutes: [...DEFAULT_CONFIG.cooldownStepsMinutes],
        sensitiveWords: [],
        modelAccountBindings: [],
      }
    : {
        ...DEFAULT_CONFIG,
        ...saved,
        port: DEFAULT_CONFIG.port,
        host: normalizeString(saved.host, DEFAULT_CONFIG.host),
        agyPath: normalizeString(saved.agyPath, DEFAULT_CONFIG.agyPath),
        routingStrategy: normalizeRoutingStrategy(saved.routingStrategy, DEFAULT_CONFIG.routingStrategy),
        perAccountConcurrency: normalizePositiveInt(
          saved.perAccountConcurrency,
          DEFAULT_CONFIG.perAccountConcurrency,
        ),
        maxAccountSwitches: normalizeNonNegativeInt(
          saved.maxAccountSwitches,
          DEFAULT_CONFIG.maxAccountSwitches,
        ),
        queueWaitTimeoutMs: normalizeNonNegativeInt(
          saved.queueWaitTimeoutMs,
          DEFAULT_CONFIG.queueWaitTimeoutMs,
        ),
        softErrorCutoffMs: normalizeNonNegativeInt(
          saved.softErrorCutoffMs,
          DEFAULT_CONFIG.softErrorCutoffMs,
        ),
        cooldownStepsMinutes: normalizeCooldownStepsMinutes(
          saved.cooldownStepsMinutes,
          DEFAULT_CONFIG.cooldownStepsMinutes,
        ),
        maxImagesPerRequest: normalizePositiveInt(
          saved.maxImagesPerRequest,
          DEFAULT_CONFIG.maxImagesPerRequest,
        ),
        maxLogsRetained: normalizePositiveInt(
          saved.maxLogsRetained,
          DEFAULT_CONFIG.maxLogsRetained,
        ),
        streamThoughtImmediately:
          typeof saved.streamThoughtImmediately === 'boolean'
            ? saved.streamThoughtImmediately
            : DEFAULT_CONFIG.streamThoughtImmediately,
        streamThoughtEarlyReleaseMs:
          typeof saved.streamThoughtEarlyReleaseMs === 'number' &&
          Number.isFinite(saved.streamThoughtEarlyReleaseMs) &&
          saved.streamThoughtEarlyReleaseMs >= 0
            ? saved.streamThoughtEarlyReleaseMs
            : DEFAULT_CONFIG.streamThoughtEarlyReleaseMs,
        cacheSettlingDelayMs: normalizeCacheSettlingDelayMs(
          saved.cacheSettlingDelayMs,
          DEFAULT_CONFIG.cacheSettlingDelayMs,
        ),
        strictProxyBinding: normalizeBoolean(
          saved.strictProxyBinding,
          DEFAULT_CONFIG.strictProxyBinding,
        ),
        blockOnExitIpDrift: normalizeBoolean(
          saved.blockOnExitIpDrift,
          DEFAULT_CONFIG.blockOnExitIpDrift,
        ),
        maxConcurrencyPerExitIp: normalizeBoundedInt(
          saved.maxConcurrencyPerExitIp,
          RISK_CONTROL_LIMITS.maxConcurrencyPerExitIp.min,
          RISK_CONTROL_LIMITS.maxConcurrencyPerExitIp.max,
          DEFAULT_CONFIG.maxConcurrencyPerExitIp,
        ),
        minExitIpRequestIntervalMs: normalizeBoundedInt(
          saved.minExitIpRequestIntervalMs,
          RISK_CONTROL_LIMITS.minExitIpRequestIntervalMs.min,
          RISK_CONTROL_LIMITS.minExitIpRequestIntervalMs.max,
          DEFAULT_CONFIG.minExitIpRequestIntervalMs,
        ),
        minAccountRequestIntervalMs: normalizeBoundedInt(
          saved.minAccountRequestIntervalMs,
          RISK_CONTROL_LIMITS.minAccountRequestIntervalMs.min,
          RISK_CONTROL_LIMITS.minAccountRequestIntervalMs.max,
          DEFAULT_CONFIG.minAccountRequestIntervalMs,
        ),
        requestJitterMs: normalizeBoundedInt(
          saved.requestJitterMs,
          RISK_CONTROL_LIMITS.requestJitterMs.min,
          RISK_CONTROL_LIMITS.requestJitterMs.max,
          DEFAULT_CONFIG.requestJitterMs,
        ),
        maxWorkerSpawnsPerMinute: normalizeBoundedInt(
          saved.maxWorkerSpawnsPerMinute,
          RISK_CONTROL_LIMITS.maxWorkerSpawnsPerMinute.min,
          RISK_CONTROL_LIMITS.maxWorkerSpawnsPerMinute.max,
          DEFAULT_CONFIG.maxWorkerSpawnsPerMinute,
        ),
        quotaCooldownScope: normalizeQuotaCooldownScope(
          saved.quotaCooldownScope,
          DEFAULT_CONFIG.quotaCooldownScope,
        ),
        excludeDefaultComponents: normalizeBoolean(
          saved.excludeDefaultComponents,
          DEFAULT_CONFIG.excludeDefaultComponents,
        ),
        accountFailover: normalizeBoolean(
          saved.accountFailover,
          DEFAULT_CONFIG.accountFailover,
        ),
        maxQuotaAccountSwitches: normalizeBoundedInt(
          saved.maxQuotaAccountSwitches,
          RISK_CONTROL_LIMITS.maxQuotaAccountSwitches.min,
          RISK_CONTROL_LIMITS.maxQuotaAccountSwitches.max,
          DEFAULT_CONFIG.maxQuotaAccountSwitches,
        ),
        policyBlockCooldownMs: normalizeBoundedInt(
          saved.policyBlockCooldownMs,
          RISK_CONTROL_LIMITS.policyBlockCooldownMs.min,
          RISK_CONTROL_LIMITS.policyBlockCooldownMs.max,
          DEFAULT_CONFIG.policyBlockCooldownMs,
        ),
        maxInternal429RetriesBeforeCancel: normalizeBoundedInt(
          saved.maxInternal429RetriesBeforeCancel,
          RISK_CONTROL_LIMITS.maxInternal429RetriesBeforeCancel.min,
          RISK_CONTROL_LIMITS.maxInternal429RetriesBeforeCancel.max,
          DEFAULT_CONFIG.maxInternal429RetriesBeforeCancel,
        ),
        sensitiveFilterEnabled:
          typeof saved.sensitiveFilterEnabled === 'boolean'
            ? saved.sensitiveFilterEnabled
            : DEFAULT_CONFIG.sensitiveFilterEnabled,
        sensitiveWords: normalizeSensitiveWords(
          saved.sensitiveWords,
          DEFAULT_CONFIG.sensitiveWords,
        ),
        modelAccountBindings: Array.isArray(saved.modelAccountBindings)
          ? saved.modelAccountBindings
          : DEFAULT_CONFIG.modelAccountBindings,
      };
  const envDelay = parseEnvCacheSettlingDelayMs();
  if (envDelay !== null) {
    resolved.cacheSettlingDelayMs = envDelay;
  }
  cachedConfig = resolved;
  return {
    ...resolved,
    cooldownStepsMinutes: [...resolved.cooldownStepsMinutes],
    sensitiveWords: resolved.sensitiveWords.map((rule) => ({ ...rule })),
    modelAccountBindings: (resolved.modelAccountBindings ?? []).map((b) => ({
      ...b,
      accountIds: [...b.accountIds],
    })),
  };
}

export function updateConfig(patch: Partial<GatewayConfig>): GatewayConfig {
  const current = getConfig();
  const nextCacheSettlingDelayMs =
    'cacheSettlingDelayMs' in patch && patch.cacheSettlingDelayMs !== undefined
      ? normalizeCacheSettlingDelayMs(patch.cacheSettlingDelayMs, DEFAULT_CONFIG.cacheSettlingDelayMs)
      : current.cacheSettlingDelayMs;
  const nextSensitiveFilterEnabled =
    'sensitiveFilterEnabled' in patch && typeof patch.sensitiveFilterEnabled === 'boolean'
      ? patch.sensitiveFilterEnabled
      : current.sensitiveFilterEnabled;
  const nextSensitiveWords =
    'sensitiveWords' in patch && patch.sensitiveWords !== undefined
      ? normalizeSensitiveWords(patch.sensitiveWords, current.sensitiveWords)
      : current.sensitiveWords;
  const next: GatewayConfig = {
    ...current,
    ...patch,
    port: DEFAULT_CONFIG.port,
    host:
      'host' in patch && patch.host !== undefined
        ? normalizeString(patch.host, current.host)
        : current.host,
    agyPath:
      'agyPath' in patch && patch.agyPath !== undefined
        ? normalizeString(patch.agyPath, current.agyPath)
        : current.agyPath,
    apiKey:
      typeof patch.apiKey === 'string' && !isMaskedApiKey(patch.apiKey)
        ? patch.apiKey
        : current.apiKey,
    defaultProxy:
      typeof patch.defaultProxy === 'string' && !isMaskedProxyUrl(patch.defaultProxy)
        ? patch.defaultProxy
        : current.defaultProxy,
    routingStrategy: normalizeRoutingStrategy(patch.routingStrategy, current.routingStrategy),
    perAccountConcurrency:
      'perAccountConcurrency' in patch && patch.perAccountConcurrency !== undefined
        ? normalizePositiveInt(patch.perAccountConcurrency, current.perAccountConcurrency)
        : current.perAccountConcurrency,
    maxAccountSwitches:
      'maxAccountSwitches' in patch && patch.maxAccountSwitches !== undefined
        ? normalizeNonNegativeInt(patch.maxAccountSwitches, current.maxAccountSwitches)
        : current.maxAccountSwitches,
    queueWaitTimeoutMs:
      'queueWaitTimeoutMs' in patch && patch.queueWaitTimeoutMs !== undefined
        ? normalizeNonNegativeInt(patch.queueWaitTimeoutMs, current.queueWaitTimeoutMs)
        : current.queueWaitTimeoutMs,
    softErrorCutoffMs:
      'softErrorCutoffMs' in patch && patch.softErrorCutoffMs !== undefined
        ? normalizeNonNegativeInt(patch.softErrorCutoffMs, current.softErrorCutoffMs)
        : current.softErrorCutoffMs,
    cooldownStepsMinutes:
      'cooldownStepsMinutes' in patch && patch.cooldownStepsMinutes !== undefined
        ? normalizeCooldownStepsMinutes(patch.cooldownStepsMinutes, current.cooldownStepsMinutes)
        : [...current.cooldownStepsMinutes],
    maxImagesPerRequest:
      'maxImagesPerRequest' in patch && patch.maxImagesPerRequest !== undefined
        ? normalizePositiveInt(patch.maxImagesPerRequest, current.maxImagesPerRequest)
        : current.maxImagesPerRequest,
    maxLogsRetained:
      'maxLogsRetained' in patch && patch.maxLogsRetained !== undefined
        ? normalizePositiveInt(patch.maxLogsRetained, current.maxLogsRetained)
        : current.maxLogsRetained,
    streamThoughtImmediately:
      typeof patch.streamThoughtImmediately === 'boolean'
        ? patch.streamThoughtImmediately
        : current.streamThoughtImmediately,
    streamThoughtEarlyReleaseMs:
      typeof patch.streamThoughtEarlyReleaseMs === 'number' &&
      Number.isFinite(patch.streamThoughtEarlyReleaseMs) &&
      patch.streamThoughtEarlyReleaseMs >= 0
        ? patch.streamThoughtEarlyReleaseMs
        : current.streamThoughtEarlyReleaseMs,
    cacheSettlingDelayMs: nextCacheSettlingDelayMs,
    strictProxyBinding: normalizeBoolean(patch.strictProxyBinding, current.strictProxyBinding),
    blockOnExitIpDrift: normalizeBoolean(patch.blockOnExitIpDrift, current.blockOnExitIpDrift),
    maxConcurrencyPerExitIp:
      'maxConcurrencyPerExitIp' in patch && patch.maxConcurrencyPerExitIp !== undefined
        ? normalizeBoundedInt(
            patch.maxConcurrencyPerExitIp,
            RISK_CONTROL_LIMITS.maxConcurrencyPerExitIp.min,
            RISK_CONTROL_LIMITS.maxConcurrencyPerExitIp.max,
            current.maxConcurrencyPerExitIp,
          )
        : current.maxConcurrencyPerExitIp,
    minExitIpRequestIntervalMs:
      'minExitIpRequestIntervalMs' in patch && patch.minExitIpRequestIntervalMs !== undefined
        ? normalizeBoundedInt(
            patch.minExitIpRequestIntervalMs,
            RISK_CONTROL_LIMITS.minExitIpRequestIntervalMs.min,
            RISK_CONTROL_LIMITS.minExitIpRequestIntervalMs.max,
            current.minExitIpRequestIntervalMs,
          )
        : current.minExitIpRequestIntervalMs,
    minAccountRequestIntervalMs:
      'minAccountRequestIntervalMs' in patch && patch.minAccountRequestIntervalMs !== undefined
        ? normalizeBoundedInt(
            patch.minAccountRequestIntervalMs,
            RISK_CONTROL_LIMITS.minAccountRequestIntervalMs.min,
            RISK_CONTROL_LIMITS.minAccountRequestIntervalMs.max,
            current.minAccountRequestIntervalMs,
          )
        : current.minAccountRequestIntervalMs,
    requestJitterMs:
      'requestJitterMs' in patch && patch.requestJitterMs !== undefined
        ? normalizeBoundedInt(
            patch.requestJitterMs,
            RISK_CONTROL_LIMITS.requestJitterMs.min,
            RISK_CONTROL_LIMITS.requestJitterMs.max,
            current.requestJitterMs,
          )
        : current.requestJitterMs,
    maxWorkerSpawnsPerMinute:
      'maxWorkerSpawnsPerMinute' in patch && patch.maxWorkerSpawnsPerMinute !== undefined
        ? normalizeBoundedInt(
            patch.maxWorkerSpawnsPerMinute,
            RISK_CONTROL_LIMITS.maxWorkerSpawnsPerMinute.min,
            RISK_CONTROL_LIMITS.maxWorkerSpawnsPerMinute.max,
            current.maxWorkerSpawnsPerMinute,
          )
        : current.maxWorkerSpawnsPerMinute,
    quotaCooldownScope: normalizeQuotaCooldownScope(
      patch.quotaCooldownScope,
      current.quotaCooldownScope,
    ),
    excludeDefaultComponents: normalizeBoolean(
      patch.excludeDefaultComponents,
      current.excludeDefaultComponents,
    ),
    accountFailover: normalizeBoolean(
      patch.accountFailover,
      current.accountFailover,
    ),
    maxQuotaAccountSwitches:
      'maxQuotaAccountSwitches' in patch && patch.maxQuotaAccountSwitches !== undefined
        ? normalizeBoundedInt(
            patch.maxQuotaAccountSwitches,
            RISK_CONTROL_LIMITS.maxQuotaAccountSwitches.min,
            RISK_CONTROL_LIMITS.maxQuotaAccountSwitches.max,
            current.maxQuotaAccountSwitches,
          )
        : current.maxQuotaAccountSwitches,
    policyBlockCooldownMs:
      'policyBlockCooldownMs' in patch && patch.policyBlockCooldownMs !== undefined
        ? normalizeBoundedInt(
            patch.policyBlockCooldownMs,
            RISK_CONTROL_LIMITS.policyBlockCooldownMs.min,
            RISK_CONTROL_LIMITS.policyBlockCooldownMs.max,
            current.policyBlockCooldownMs,
          )
        : current.policyBlockCooldownMs,
    maxInternal429RetriesBeforeCancel:
      'maxInternal429RetriesBeforeCancel' in patch &&
      patch.maxInternal429RetriesBeforeCancel !== undefined
        ? normalizeBoundedInt(
            patch.maxInternal429RetriesBeforeCancel,
            RISK_CONTROL_LIMITS.maxInternal429RetriesBeforeCancel.min,
            RISK_CONTROL_LIMITS.maxInternal429RetriesBeforeCancel.max,
            current.maxInternal429RetriesBeforeCancel,
          )
        : current.maxInternal429RetriesBeforeCancel,
    sensitiveFilterEnabled: nextSensitiveFilterEnabled,
    sensitiveWords: nextSensitiveWords,
  };
  store.setConfigValue(CONFIG_KEY, next);
  cachedConfig = next;
  return {
    ...next,
    cooldownStepsMinutes: [...next.cooldownStepsMinutes],
    sensitiveWords: next.sensitiveWords.map((rule) => ({ ...rule })),
  };
}

export function maskApiKey(apiKey: string): string {
  if (!apiKey) return '';
  if (apiKey.length <= 8) return '***';
  return `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}`;
}

function isMaskedApiKey(value: string): boolean {
  return value === '***' || /^[\s\S]{4}\.\.\.[\s\S]{4}$/.test(value);
}

function isMaskedProxyUrl(value: string): boolean {
  try {
    const { username, password } = new URL(value);
    return username === '***' || password === '***';
  } catch {
    return value.includes('//***:***@');
  }
}

export function maskProxyUrl(proxyUrl: string): string {
  if (!proxyUrl) return '';
  try {
    const parsed = new URL(proxyUrl);
    if (parsed.username || parsed.password) {
      parsed.username = parsed.username ? '***' : '';
      parsed.password = parsed.password ? '***' : '';
      return parsed.toString();
    }
    return proxyUrl;
  } catch {
    return proxyUrl.replace(/\/\/([^:@]+):([^@]+)@/, '//***:***@');
  }
}

export function getPublicConfig(): GatewayConfig {
  const cfg = getConfig();
  return {
    ...cfg,
    apiKey: maskApiKey(cfg.apiKey),
    defaultProxy: maskProxyUrl(cfg.defaultProxy),
  };
}

export function resolveEffectiveProxy(
  accountProxyUrl?: string | null,
  config?: Pick<GatewayConfig, 'defaultProxy'>,
): string | undefined {
  const accountProxy = typeof accountProxyUrl === 'string' ? accountProxyUrl.trim() : '';
  if (accountProxy) {
    return accountProxy;
  }
  const fallbackSource = config ?? getConfig();
  const defaultProxy =
    typeof fallbackSource.defaultProxy === 'string' ? fallbackSource.defaultProxy.trim() : '';
  return defaultProxy || undefined;
}
