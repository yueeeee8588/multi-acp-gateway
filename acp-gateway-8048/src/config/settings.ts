import { store } from '../db/store';
import type {
  GatewayConfig,
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
  sensitiveFilterEnabled: false,
  sensitiveWords: [],
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
      sensitiveWords: cachedConfig.sensitiveWords.map((rule) => ({ ...rule })),
    };
  }
  const saved = store.getConfigValue<Partial<GatewayConfig>>(CONFIG_KEY);
  const resolved: GatewayConfig = !saved
    ? { ...DEFAULT_CONFIG, sensitiveWords: [] }
    : {
        ...DEFAULT_CONFIG,
        ...saved,
        port: DEFAULT_CONFIG.port,
        routingStrategy: normalizeRoutingStrategy(saved.routingStrategy, DEFAULT_CONFIG.routingStrategy),
        cooldownStepsMinutes: Array.isArray(saved.cooldownStepsMinutes)
          ? saved.cooldownStepsMinutes
          : DEFAULT_CONFIG.cooldownStepsMinutes,
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
        sensitiveFilterEnabled:
          typeof saved.sensitiveFilterEnabled === 'boolean'
            ? saved.sensitiveFilterEnabled
            : DEFAULT_CONFIG.sensitiveFilterEnabled,
        sensitiveWords: normalizeSensitiveWords(
          saved.sensitiveWords,
          DEFAULT_CONFIG.sensitiveWords,
        ),
      };
  const envDelay = parseEnvCacheSettlingDelayMs();
  if (envDelay !== null) {
    resolved.cacheSettlingDelayMs = envDelay;
  }
  cachedConfig = resolved;
  return {
    ...resolved,
    sensitiveWords: resolved.sensitiveWords.map((rule) => ({ ...rule })),
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
    apiKey:
      typeof patch.apiKey === 'string' && !isMaskedApiKey(patch.apiKey)
        ? patch.apiKey
        : current.apiKey,
    defaultProxy:
      typeof patch.defaultProxy === 'string' && !isMaskedProxyUrl(patch.defaultProxy)
        ? patch.defaultProxy
        : current.defaultProxy,
    routingStrategy: normalizeRoutingStrategy(patch.routingStrategy, current.routingStrategy),
    cooldownStepsMinutes: Array.isArray(patch.cooldownStepsMinutes)
      ? patch.cooldownStepsMinutes
      : current.cooldownStepsMinutes,
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
    sensitiveFilterEnabled: nextSensitiveFilterEnabled,
    sensitiveWords: nextSensitiveWords,
  };
  store.setConfigValue(CONFIG_KEY, next);
  cachedConfig = next;
  return {
    ...next,
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
