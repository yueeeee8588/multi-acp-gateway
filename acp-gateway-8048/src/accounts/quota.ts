import { execFileSync } from 'node:child_process';
import { resolveOfficialAgyBinary } from '../acp/env';
import { getConfig } from '../config/settings';
import { resolveEffectiveProxy } from './system-proxy';
import type {
  AccountQuotaSnapshot,
  AccountTier,
  PoolModelQuota,
  PoolQuotaSummary,
  QuotaPoolKey,
} from '../types';

const QUOTA_ENDPOINTS = [
  'https://daily-cloudcode-pa.googleapis.com',
  'https://daily-cloudcode-pa.sandbox.googleapis.com',
  'https://cloudcode-pa.googleapis.com',
] as const;

const CODE_ASSIST_CL = '1021519450';
const FALLBACK_AGY_VERSION = '1.5.9';
const QUOTA_FETCH_TIMEOUT_MS = 8000;

let cachedAgyVersion: string | null = null;

function resolveOsType(platform: NodeJS.Platform = process.platform): 'windows' | 'darwin' | 'linux' {
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'darwin';
  return 'linux';
}

function resolveArch(arch: string = process.arch): 'amd64' | 'arm64' {
  return arch === 'arm64' ? 'arm64' : 'amd64';
}

function detectAgyVersion(): string {
  if (cachedAgyVersion) {
    return cachedAgyVersion;
  }
  let bin = 'agy';
  try {
    const cfgPath = getConfig().agyPath?.trim();
    bin = resolveOfficialAgyBinary(cfgPath || undefined);
  } catch {
    bin = getConfig().agyPath?.trim() || 'agy';
  }
  try {
    const out = execFileSync(bin, ['--version'], {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true,
    });
    const match = out.trim().match(/\d+\.\d+\.\d+(?:[-+.\w]*)?/);
    if (match?.[0]) {
      cachedAgyVersion = match[0];
      return cachedAgyVersion;
    }
  } catch {
    // 回退到默认已知版本号，避免阻塞配额刷新
  }
  cachedAgyVersion = FALLBACK_AGY_VERSION;
  return cachedAgyVersion;
}

export function buildCodeAssistUserAgent(authMethod = 'oauth'): string {
  const version = detectAgyVersion();
  const osType = resolveOsType();
  const arch = resolveArch();
  return `antigravity/cli/${version} (aidev_client; os_type=${osType}; arch=${arch}; cl=${CODE_ASSIST_CL}; auth_method=${authMethod})`;
}

const POOL_LABELS: Record<QuotaPoolKey, string> = {
  gemini_flagship: 'G4 Argon',
  gemini_flash: 'Gemini',
  third_party: '第三方',
};

export type QuotaFetcher = typeof fetch;
let quotaFetcher: QuotaFetcher | undefined;

/** 仅用于测试替换网络层；传 undefined 恢复默认。 */
export function __setQuotaFetcherForTest(next?: QuotaFetcher): void {
  quotaFetcher = next;
}

function readText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function labelWords(value: unknown): string {
  return readText(value).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function readFraction(value: unknown, scale = 1): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value / scale))
    : null;
}

function toPercentage(fraction: number): number {
  const rounded = Math.round(fraction * 100);
  // 保留未耗尽的小额余量，避免整数取整将其误显示成 0%。
  return rounded === 0 && fraction > 0
    ? Math.max(0.01, Math.round(fraction * 10000) / 100)
    : rounded;
}

function readResetTime(value: unknown): string | null {
  const time = readText(value);
  return time && Number.isFinite(Date.parse(time)) ? time : null;
}

function classifyName(name: string): QuotaPoolKey | null {
  const cleaned = name.replace(/^models\//i, '').trim();
  const words = labelWords(cleaned);
  if (!words || /\bembeddings?\b/.test(words)) return null;
  if (/(?:claude|opus|sonnet|haiku|gpt)/i.test(cleaned)) return 'third_party';
  if (/^(?:gemini|image|imagen)\b/.test(words)) return 'gemini_flash';
  return null;
}

/** 仅含明确关键字的模型归池（用于指纹匹配前的最高优先级判定）。 */
function classifyExplicitPool(
  modelId: string,
  modelInfo?: { modelProvider?: string; displayName?: string }
): QuotaPoolKey | null {
  const displayName = readText(modelInfo?.displayName);
  if (/\bembeddings?\b/.test(labelWords(modelId)) || /\bembeddings?\b/.test(labelWords(displayName))) {
    return null;
  }
  const provider = readText(modelInfo?.modelProvider).toUpperCase();
  if (['MODEL_PROVIDER_ANTHROPIC', 'MODEL_PROVIDER_OPENAI', 'ANTHROPIC', 'OPENAI'].includes(provider)) {
    return 'third_party';
  }
  for (const name of [modelId, displayName]) {
    const cleaned = name.replace(/^models\//i, '').trim();
    if (!cleaned) continue;
    if (/(?:claude|opus|sonnet|haiku|gpt)/i.test(cleaned)) return 'third_party';
  }
  return null;
}

/** 判断账号配额快照中是否包含旗舰模型（Argon）访问权限。 */
export function hasFlagshipModelAccess(quota?: AccountQuotaSnapshot | null): boolean {
  const flagship = quota?.pools?.gemini_flagship;
  if (flagship !== null && flagship !== undefined && typeof flagship === 'object' && !Array.isArray(flagship)) {
    return true;
  }
  const flashModels = quota?.pools?.gemini_flash?.models;
  if (Array.isArray(flashModels)) {
    return flashModels.some(
      (model) =>
        (typeof model?.id === 'string' && /argon/i.test(model.id)) ||
        (typeof model?.displayName === 'string' && /argon/i.test(model.displayName))
    );
  }
  return false;
}

/** 将模型 ID 或展示名称归类到三号池之一。 */
export function classifyModelPool(
  modelId: string,
  modelInfo?: { modelProvider?: string; displayName?: string }
): QuotaPoolKey | null {
  const displayName = readText(modelInfo?.displayName);
  if (/\bembeddings?\b/.test(labelWords(modelId)) || /\bembeddings?\b/.test(labelWords(displayName))) {
    return null;
  }
  const provider = readText(modelInfo?.modelProvider).toUpperCase();
  if (['MODEL_PROVIDER_ANTHROPIC', 'MODEL_PROVIDER_OPENAI', 'ANTHROPIC', 'OPENAI'].includes(provider)) {
    return 'third_party';
  }
  return classifyName(modelId) ?? classifyName(displayName);
}

function parseCodeAssistTierFromPayload(payload: Record<string, unknown>): AccountTier | null {
  if (!payload || typeof payload !== 'object') return null;

  const readTierId = (value: unknown): string | null => {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (value && typeof value === 'object') {
      const id = (value as Record<string, unknown>).id;
      if (typeof id === 'string' && id.trim()) return id.trim();
    }
    return null;
  };

  let tierId: string | null = null;
  for (const key of ['paidTier', 'paid_tier'] as const) {
    tierId = readTierId(payload[key]);
    if (tierId) break;
  }
  if (!tierId) {
    for (const key of ['currentTier', 'current_tier'] as const) {
      tierId = readTierId(payload[key]);
      if (tierId) break;
    }
  }

  if (!tierId) return null;
  const lowered = tierId.toLowerCase();
  return lowered.includes('pro') || lowered.includes('ultra') ? 'pro' : 'standard';
}

function extractProjectIdFromPayload(payload: Record<string, unknown>): string | undefined {
  const candidates = [
    payload.cloudaicompanionProject,
    payload.cloudaicompanion_project,
    payload.projectId,
    payload.project_id,
    payload.project,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
    if (candidate && typeof candidate === 'object') {
      const id = (candidate as Record<string, unknown>).id;
      if (typeof id === 'string' && id.trim()) {
        return id.trim();
      }
    }
  }
  return undefined;
}

interface QuotaLimit {
  remainingFraction: number;
  resetTime: string | null;
}

type Window = '5h' | 'weekly';
type BucketScope = QuotaPoolKey | 'gemini';
type WindowLimits = Partial<Record<Window, QuotaLimit>>;

function tighterLimit(current: QuotaLimit | null | undefined, next: QuotaLimit): QuotaLimit {
  if (!current || next.remainingFraction < current.remainingFraction) return next;
  if (next.remainingFraction === current.remainingFraction && next.resetTime) {
    if (!current.resetTime || Date.parse(next.resetTime) > Date.parse(current.resetTime)) return next;
  }
  return current;
}

function bucketScope(value: unknown): BucketScope | null {
  const words = labelWords(value);
  if (!words) return null;
  if (/\bargon\b/.test(words)) return 'gemini_flagship';
  if (/\b(?:3p|third party|3rd party|anthropic|openai)\b/.test(words) || /(?:claude|opus|sonnet|haiku|gpt)/.test(words)) {
    return 'third_party';
  }
  if (/\b(?:flash|hydrogen)\b/.test(words)) return 'gemini_flash';
  if (/\bflagship\b/.test(words)) return 'gemini_flagship';
  if (/\bgemini\b/.test(words)) return 'gemini';
  return null;
}

function readScope(values: unknown[]): BucketScope | null {
  const scopes = values.map(bucketScope);
  return scopes.find((scope) => scope && scope !== 'gemini') ?? scopes.find(Boolean) ?? null;
}

function readWindow(bucket: Record<string, unknown>): Window | null {
  const labels = [bucket.window, bucket.windowType, bucket.period, bucket.duration, bucket.resetPeriod,
    bucket.bucketId, bucket.bucket_id, bucket.id, bucket.displayName, bucket.label, bucket.type];
  for (const value of labels) {
    const words = labelWords(value);
    if (/\b(?:5\s*(?:h|hrs?|hours?)|five hours?|pt5h|18000s)\b/.test(words)) return '5h';
    if (/\b(?:weekly|week|7\s*d(?:ays?)?|168\s*h(?:ours?)?|p7d|604800s)\b/.test(words)) return 'weekly';
  }
  for (const duration of [bucket.windowDuration, bucket.durationSeconds, bucket.duration]) {
    if (duration === 18000 || duration === '18000' || duration === '18000s') return '5h';
    if (duration === 604800 || duration === '604800' || duration === '604800s') return 'weekly';
  }
  return null;
}

function parseSummaryConstraints(summaryResponse?: Record<string, unknown> | null) {
  const limits: Partial<Record<BucketScope, WindowLimits>> = {};
  const groups = summaryResponse?.groups;
  if (!Array.isArray(groups)) return limits;

  for (const rawGroup of groups) {
    const group = asRecord(rawGroup);
    if (!group) continue;
    const groupScope = readScope([group.groupName, group.displayName, group.name, group.id, group.label, group.modelGroup]);
    const scopes = new Set<BucketScope>();
    if (groupScope) {
      scopes.add(groupScope);
    } else {
      for (const ids of [group.models, group.modelIds]) {
        if (!Array.isArray(ids)) continue;
        for (const id of ids) {
          const pool = classifyModelPool(readText(id));
          if (pool) scopes.add(pool);
        }
      }
    }
    const buckets = Array.isArray(group.buckets) ? group.buckets : group.quotaBuckets;
    if (!Array.isArray(buckets)) continue;
    for (const rawBucket of buckets) {
      const bucket = asRecord(rawBucket);
      if (!bucket) continue;
      const window = readWindow(bucket);
      const fraction = readFraction(bucket.remainingFraction ?? bucket.remaining_fraction)
        ?? readFraction(bucket.remainingPercentage ?? bucket.percentage, 100);
      if (!window || fraction === null) continue;
      const explicitScope = readScope([bucket.bucketId, bucket.bucket_id, bucket.id, bucket.displayName]);
      // 通用桶 ID 不能覆盖父组更明确的归属，例如 Gemini Argon 组内的 gemini-5h。
      const targetScopes = explicitScope && (explicitScope !== 'gemini' || scopes.size === 0)
        ? [explicitScope]
        : scopes;
      const limit = {
        remainingFraction: fraction,
        resetTime: readResetTime(bucket.resetTime ?? bucket.reset_time),
      };
      for (const scope of targetScopes) {
        const windows = (limits[scope] ??= {});
        windows[window] = tighterLimit(windows[window], limit);
      }
    }
  }
  return limits;
}

interface BucketFingerprint {
  pool: QuotaPoolKey;
  remainingFraction: number;
  resetTimeMs: number | null;
}

const FINGERPRINT_FRACTION_TOLERANCE = 0.002;
const FINGERPRINT_RESET_TIME_TOLERANCE_MS = 5000;
const WEEKLY_BUCKET_THRESHOLD_MS = 24 * 3600 * 1000;

function extractBucketFingerprints(summaryResponse?: Record<string, unknown> | null): BucketFingerprint[] {
  const fingerprints: BucketFingerprint[] = [];
  const groups = summaryResponse?.groups;
  if (!Array.isArray(groups)) return fingerprints;

  for (const rawGroup of groups) {
    const group = asRecord(rawGroup);
    if (!group) continue;
    const groupScope = readScope([group.groupName, group.displayName, group.name, group.id, group.label, group.modelGroup]);
    const scopes = new Set<BucketScope>();
    if (groupScope) {
      scopes.add(groupScope);
    } else {
      for (const ids of [group.models, group.modelIds]) {
        if (!Array.isArray(ids)) continue;
        for (const id of ids) {
          const pool = classifyModelPool(readText(id));
          if (pool) scopes.add(pool);
        }
      }
    }
    const buckets = Array.isArray(group.buckets) ? group.buckets : group.quotaBuckets;
    if (!Array.isArray(buckets)) continue;
    for (const rawBucket of buckets) {
      const bucket = asRecord(rawBucket);
      if (!bucket) continue;
      const fraction = readFraction(bucket.remainingFraction ?? bucket.remaining_fraction)
        ?? readFraction(bucket.remainingPercentage ?? bucket.percentage, 100);
      if (fraction === null) continue;
      const resetTime = readResetTime(bucket.resetTime ?? bucket.reset_time);
      const parsedReset = resetTime ? Date.parse(resetTime) : NaN;
      const resetTimeMs = Number.isFinite(parsedReset) ? parsedReset : null;
      const explicitScope = readScope([bucket.bucketId, bucket.bucket_id, bucket.id, bucket.displayName]);
      const targetScopes = explicitScope && (explicitScope !== 'gemini' || scopes.size === 0)
        ? [explicitScope]
        : scopes;
      for (const scope of targetScopes) {
        fingerprints.push({
          pool: scope === 'gemini' ? 'gemini_flash' : scope,
          remainingFraction: fraction,
          resetTimeMs,
        });
      }
    }
  }
  return fingerprints;
}

function isFingerprintMatch(
  fraction: number,
  resetTimeMs: number | null,
  fp: { remainingFraction: number; resetTimeMs: number | null }
): boolean {
  if (Math.abs(fraction - fp.remainingFraction) > FINGERPRINT_FRACTION_TOLERANCE) {
    return false;
  }
  if (resetTimeMs !== null && fp.resetTimeMs !== null) {
    return Math.abs(resetTimeMs - fp.resetTimeMs) <= FINGERPRINT_RESET_TIME_TOLERANCE_MS;
  }
  return true;
}

function matchBucketFingerprint(
  fraction: number | null,
  resetTime: string | null,
  fingerprints: BucketFingerprint[],
  preferredPool?: QuotaPoolKey | null
): QuotaPoolKey | null {
  if (fraction === null || !Number.isFinite(fraction) || fingerprints.length === 0) return null;
  const parsedReset = resetTime ? Date.parse(resetTime) : NaN;
  const resetTimeMs = Number.isFinite(parsedReset) ? parsedReset : null;

  const matchedPools = new Set<QuotaPoolKey>();
  for (const fp of fingerprints) {
    if (isFingerprintMatch(fraction, resetTimeMs, fp)) {
      matchedPools.add(fp.pool);
    }
  }
  if (matchedPools.size === 0) return null;
  if (matchedPools.size === 1) return matchedPools.values().next().value ?? null;
  if (preferredPool && matchedPools.has(preferredPool)) return preferredPool;
  return null;
}

function readModels(rawModels: unknown): Array<[string, unknown]> {
  if (Array.isArray(rawModels)) return rawModels.map((info) => ['', info]);
  const record = asRecord(rawModels);
  return record ? Object.entries(record) : [];
}

const LEGACY_MODEL_ID = /^gemini-(?:2\.5-|3\.5-|3\.1-flash-lite(?:-|$)|3-flash$)/i;
const THINKING_TIERS = 'low|medium|high|xhigh|minimal|thinking|tiered|sonar';
const MODEL_ID_TIER_SUFFIXES = new RegExp(`(?:-(?:${THINKING_TIERS}))+$`, 'i');
const DISPLAY_NAME_TIER_SUFFIXES = new RegExp(`(?:\\s*[（(]\\s*(?:${THINKING_TIERS})\\s*[）)])+$`, 'i');

function readModelId(value: unknown): string {
  return readText(value).replace(/^models\//i, '');
}

function readDeprecatedModelIds(value: unknown): Set<string> {
  const ids = Array.isArray(value) ? value : Object.keys(asRecord(value) ?? {});
  return new Set(ids.map((id) => readModelId(id).toLowerCase()).filter(Boolean));
}

function stripDisplayNameTiers(displayName: string): string {
  return displayName.replace(DISPLAY_NAME_TIER_SUFFIXES, '').trim();
}

/**
 * 根据 fetchAvailableModels 与可选 retrieveUserQuotaSummary 计算三号池配额快照。
 */
export function computeAccountQuotaSnapshot(params: {
  modelsResponse: Record<string, unknown>;
  summaryResponse?: Record<string, unknown> | null;
  projectId?: string;
  fetchedAt?: number;
}): AccountQuotaSnapshot {
  const fetchedAt = params.fetchedAt ?? Date.now();
  const deprecatedIds = readDeprecatedModelIds(
    params.modelsResponse?.deprecatedModelIds ?? params.modelsResponse?.deprecated_model_ids,
  );
  const eligibleScopes: Record<QuotaPoolKey, Set<BucketScope>> = {
    gemini_flagship: new Set(), gemini_flash: new Set(), third_party: new Set(),
  };

  const fingerprints = extractBucketFingerprints(params.summaryResponse);
  const regularGeminiFingerprints: Array<{ remainingFraction: number; resetTimeMs: number | null }> = fingerprints
    .filter((fp) => fp.pool === 'gemini_flash')
    .map(({ remainingFraction, resetTimeMs }) => ({ remainingFraction, resetTimeMs }));

  interface PendingModel extends QuotaLimit {
    baseModelId: string;
    displayName: string;
    legacy: boolean;
    resetTimeMs: number | null;
    basePool: QuotaPoolKey | null;
    resolvedPool: QuotaPoolKey | null;
    isGeminiName: boolean;
  }
  const pendingModels: PendingModel[] = [];

  for (const [key, rawInfo] of readModels(params.modelsResponse?.models)) {
    const info = asRecord(rawInfo);
    if (!info || info.disabled === true) continue;
    const candidates = [key, info.id, info.model, info.name].map(readModelId).filter(Boolean);
    const displayName = readText(info.displayName);
    const matchedId = candidates.find((name) => classifyName(name) !== null);
    const modelId = matchedId ?? candidates[0] ?? displayName;
    if (!modelId) continue;
    if (/\bembeddings?\b/.test(labelWords(modelId)) || /\bembeddings?\b/.test(labelWords(displayName))) {
      continue;
    }

    const modelProvider = readText(info.modelProvider);
    const basePool = classifyModelPool(modelId, { modelProvider, displayName });
    const quotaInfo = asRecord(info.quotaInfo ?? info.quota_info);
    const remainingFraction = readFraction(quotaInfo?.remainingFraction ?? quotaInfo?.remaining_fraction);
    if (remainingFraction === null) {
      if (basePool) {
        eligibleScopes[basePool].add(basePool);
        if (basePool === 'gemini_flash') eligibleScopes[basePool].add('gemini');
      }
      continue;
    }

    const resetTime = readResetTime(quotaInfo?.resetTime ?? quotaInfo?.reset_time);
    const parsedReset = resetTime ? Date.parse(resetTime) : NaN;
    const resetTimeMs = Number.isFinite(parsedReset) ? parsedReset : null;

    // 1. 明确关键字 -> 2. 指纹命中上游 groups 桶
    const explicitPool = classifyExplicitPool(modelId, { modelProvider, displayName });
    const fpPool = explicitPool ? null : matchBucketFingerprint(remainingFraction, resetTime, fingerprints, basePool);
    const resolvedPool = explicitPool ?? fpPool;
    const isGeminiName = /^gemini\b/.test(labelWords(modelId)) || /^gemini\b/.test(labelWords(displayName));

    if (
      resolvedPool !== 'gemini_flagship' &&
      resolvedPool !== 'third_party' &&
      isGeminiName &&
      resetTimeMs !== null &&
      resetTimeMs - fetchedAt <= WEEKLY_BUCKET_THRESHOLD_MS
    ) {
      regularGeminiFingerprints.push({ remainingFraction, resetTimeMs });
    }

    const baseModelId = stripDisplayNameTiers(modelId.replace(MODEL_ID_TIER_SUFFIXES, '')) || modelId;
    pendingModels.push({
      baseModelId,
      displayName: stripDisplayNameTiers(displayName) || baseModelId,
      legacy: LEGACY_MODEL_ID.test(baseModelId) || candidates.some((id) => deprecatedIds.has(id.toLowerCase())),
      remainingFraction,
      resetTime,
      resetTimeMs,
      basePool,
      resolvedPool,
      isGeminiName,
    });
  }

  const groupedModels: Record<QuotaPoolKey, PendingModel[]> = {
    gemini_flagship: [], gemini_flash: [], third_party: [],
  };
  for (const entry of pendingModels) {
    let pool = entry.resolvedPool;
    // 3. 独立周桶自动发现：未知新代号 gemini* 模型重置时间 > 24h 且与常规 gemini_flash 桶/模型指纹明显不同 -> gemini_flagship
    if (
      !pool &&
      entry.isGeminiName &&
      entry.resetTimeMs !== null &&
      entry.resetTimeMs - fetchedAt > WEEKLY_BUCKET_THRESHOLD_MS &&
      regularGeminiFingerprints.some((fp) => !isFingerprintMatch(entry.remainingFraction, entry.resetTimeMs, fp))
    ) {
      pool = 'gemini_flagship';
    }
    // 4. 其余 gemini* / image* / imagen* 兜底归入 gemini_flash
    if (!pool) pool = entry.basePool;
    if (!pool) continue;

    eligibleScopes[pool].add(pool);
    // 普通 Gemini 的共享桶不约束 Argon 专属额度。
    if (pool === 'gemini_flash') eligibleScopes[pool].add('gemini');

    groupedModels[pool].push(entry);
  }

  const summaryLimits = parseSummaryConstraints(params.summaryResponse);
  const pools: Record<QuotaPoolKey, PoolQuotaSummary | null> = {
    gemini_flagship: null, gemini_flash: null, third_party: null,
  };

  for (const pool of ['gemini_flagship', 'gemini_flash', 'third_party'] as const) {
    const allModels = groupedModels[pool];
    const currentModels = allModels.filter((model) => !model.legacy);
    // 上游只返回旧代号时保留该池的配额，并同样合并思考档位。
    const modelsById = new Map<string, PoolModelQuota>();
    for (const { baseModelId, displayName, remainingFraction, resetTime } of currentModels.length ? currentModels : allModels) {
      const model = {
        id: baseModelId,
        displayName,
        percentage: toPercentage(remainingFraction),
        remainingFraction,
        resetTime,
      };
      const current = modelsById.get(baseModelId);
      if (tighterLimit(current, model) === model) modelsById.set(baseModelId, model);
    }
    const models = [...modelsById.values()];
    let bottleneck: PoolModelQuota | undefined;
    for (const model of models) {
      if (!bottleneck || model.remainingFraction < bottleneck.remainingFraction) bottleneck = model;
    }

    let fiveHour: QuotaLimit | undefined;
    let weekly: QuotaLimit | undefined;
    for (const scope of eligibleScopes[pool]) {
      const windows = summaryLimits[scope];
      if (windows?.['5h']) fiveHour = tighterLimit(fiveHour, windows['5h']);
      if (windows?.weekly) weekly = tighterLimit(weekly, windows.weekly);
    }

    let limit: QuotaLimit | undefined = bottleneck;
    if (fiveHour) limit = tighterLimit(limit, fiveHour);
    if (weekly) {
      const effectiveWeekly = weekly.remainingFraction <= 0.001 ? { ...weekly, remainingFraction: 0 } : weekly;
      limit = tighterLimit(limit, effectiveWeekly);
    }
    if (!limit) continue;

    pools[pool] = {
      pool,
      label: POOL_LABELS[pool],
      percentage: toPercentage(limit.remainingFraction),
      remainingFraction: limit.remainingFraction,
      resetTime: limit.resetTime,
      modelCount: models.length,
      bottleneckModel: bottleneck?.id ?? null,
      window5h: fiveHour ? toPercentage(fiveHour.remainingFraction) : null,
      windowWeekly: weekly ? toPercentage(weekly.remainingFraction) : null,
      window5hResetTime: fiveHour?.resetTime ?? null,
      windowWeeklyResetTime: weekly?.resetTime ?? null,
      models,
    };
  }

  return {
    fetchedAt,
    ...(params.projectId ? { projectId: params.projectId } : {}),
    pools,
  };
}

async function postCodeAssistJson(
  url: string,
  accessToken: string,
  body: Record<string, unknown>,
  proxyUrl?: string
): Promise<{ ok: boolean; status: number; json: Record<string, any> | null; error?: string }> {
  const init: RequestInit & { proxy?: string } = {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent': buildCodeAssistUserAgent(),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(QUOTA_FETCH_TIMEOUT_MS),
  };
  if (proxyUrl) init.proxy = proxyUrl;

  try {
    const resp = await (quotaFetcher ?? fetch)(url, init);
    const json = (await resp.json().catch(() => null)) as Record<string, any> | null;
    if (!resp.ok) {
      const detail =
        typeof json?.error?.message === 'string' ? json.error.message : `HTTP ${resp.status}`;
      return { ok: false, status: resp.status, json, error: detail };
    }
    if (!json || typeof json !== 'object') {
      return { ok: false, status: resp.status, json: null, error: 'Empty JSON response' };
    }
    return { ok: true, status: resp.status, json };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      json: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * 从 Google Cloud Code 上游拉取账号三号池配额并计算快照。
 * 端点按 daily-cloudcode-pa -> daily-cloudcode-pa.sandbox -> cloudcode-pa 顺序回退。
 */
export async function fetchAccountQuota(params: {
  accessToken: string;
  proxyUrl?: string;
  projectId?: string;
}): Promise<{
  snapshot: AccountQuotaSnapshot;
  detectedTier?: AccountTier | null;
  accessTokenRejected?: boolean;
}> {
  const token = params.accessToken?.trim();
  const emptyPools: Record<QuotaPoolKey, PoolQuotaSummary | null> = {
    gemini_flagship: null,
    gemini_flash: null,
    third_party: null,
  };

  if (!token) {
    return {
      snapshot: {
        fetchedAt: Date.now(),
        ...(params.projectId ? { projectId: params.projectId } : {}),
        pools: emptyPools,
        error: 'Missing access token',
      },
      detectedTier: null,
    };
  }

  const effectiveProxy = resolveEffectiveProxy(params.proxyUrl);
  let resolvedProjectId = params.projectId?.trim() || undefined;
  let detectedTier: AccountTier | null = null;
  let accessTokenRejected = false;
  let lastError = 'All quota endpoints failed';

  for (const baseUrl of QUOTA_ENDPOINTS) {
    const loadRes = await postCodeAssistJson(
      `${baseUrl}/v1internal:loadCodeAssist`,
      token,
      { metadata: { ideType: 'ANTIGRAVITY' } },
      effectiveProxy
    );
    if (loadRes.ok && loadRes.json) {
      resolvedProjectId = extractProjectIdFromPayload(loadRes.json) ?? resolvedProjectId;
      detectedTier = parseCodeAssistTierFromPayload(loadRes.json) ?? detectedTier;
    } else if (loadRes.error) {
      lastError = `loadCodeAssist(${baseUrl}): ${loadRes.error}`;
    }

    const modelsRes = await postCodeAssistJson(
      `${baseUrl}/v1internal:fetchAvailableModels`,
      token,
      resolvedProjectId ? { project: resolvedProjectId } : {},
      effectiveProxy
    );
    if (!modelsRes.ok || !modelsRes.json) {
      if (modelsRes.status === 401) accessTokenRejected = true;
      if (modelsRes.error) {
        lastError = `fetchAvailableModels(${baseUrl}): ${modelsRes.error}`;
      }
      continue;
    }

    // best-effort 拉取 retrieveUserQuotaSummary，失败不阻断
    const summaryRes = await postCodeAssistJson(
      `${baseUrl}/v1internal:retrieveUserQuotaSummary`,
      token,
      resolvedProjectId ? { project: resolvedProjectId } : {},
      effectiveProxy
    );

    const snapshot = computeAccountQuotaSnapshot({
      modelsResponse: modelsRes.json,
      summaryResponse: summaryRes.ok ? summaryRes.json : null,
      projectId: resolvedProjectId,
      fetchedAt: Date.now(),
    });

    if (Object.values(snapshot.pools).some((pool) => pool !== null)) {
      return { snapshot, detectedTier };
    }
    lastError = 'Upstream did not report quota for any managed model';
  }

  return {
    snapshot: {
      fetchedAt: Date.now(),
      ...(resolvedProjectId ? { projectId: resolvedProjectId } : {}),
      pools: emptyPools,
      error: lastError.slice(0, 300),
    },
    detectedTier,
    accessTokenRejected,
  };
}
