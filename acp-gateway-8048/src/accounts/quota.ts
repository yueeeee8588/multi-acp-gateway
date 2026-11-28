import { execFileSync } from 'node:child_process';
import { buildIsolatedAgyEnv, getDataRoot, resolveOfficialAgyBinary } from '../acp/env';
import { getConfig } from '../config/settings';
import { checkProxyReachable } from './exit-probe';
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

const OPUS_55_MODEL_RE = /opus[-_\s]*5[.\-_ ]*5/i;

function isAggregateUsageModelEntry(model: { id?: string; displayName?: string } | null | undefined): boolean {
  if (!model || typeof model !== 'object') return true;
  const id = typeof model.id === 'string' ? model.id.trim() : '';
  const displayName = typeof model.displayName === 'string' ? model.displayName.trim() : '';
  if (!id) return true;
  if (/^(?:claude|gemini|third_party|gpt)$/i.test(id)) return true;
  if (/claude\s+and\s+gpt\s+models/i.test(displayName)) return true;
  return false;
}

function hasDetailedModels(models?: Array<{ id?: string; displayName?: string }> | null): boolean {
  return Array.isArray(models) && models.length > 0 && models.some((m) => !isAggregateUsageModelEntry(m));
}

/**
 * `/usage` 只吐聚合百分比，不含细粒度模型明细。写回新快照时保留旧快照中已采集到的
 * 细粒度模型列表（如 claude-opus-5-5、gemini-4-argon），避免把正常 Pro 误洗成 PRO(特价)。
 */
export function mergeUsageSnapshotWithPreviousModels(
  previous: AccountQuotaSnapshot | null | undefined,
  next: AccountQuotaSnapshot
): AccountQuotaSnapshot {
  if (!previous?.pools || !next?.pools) return next;
  const mergePool = (key: 'gemini_flash' | 'third_party') => {
    const prevPool = previous.pools[key];
    const nextPool = next.pools[key];
    if (!nextPool || !prevPool) return nextPool;
    if (hasDetailedModels(nextPool.models) || !hasDetailedModels(prevPool.models)) {
      return nextPool;
    }
    return {
      ...nextPool,
      modelCount: prevPool.models.length,
      bottleneckModel: nextPool.bottleneckModel && !/^(?:claude|gemini)$/i.test(nextPool.bottleneckModel)
        ? nextPool.bottleneckModel
        : prevPool.bottleneckModel,
      models: prevPool.models.map((m) => ({ ...m })),
    };
  };
  return {
    ...next,
    pools: {
      gemini_flagship: next.pools.gemini_flagship,
      gemini_flash: mergePool('gemini_flash'),
      third_party: mergePool('third_party'),
    },
  };
}

/** 判断账号配额快照中是否包含完整 Pro 旗舰资格（third_party 含 Opus 5.5、gemini_flagship 桶或 Argon）。 */
export function hasFlagshipModelAccess(quota?: AccountQuotaSnapshot | null): boolean {
  const flagship = quota?.pools?.gemini_flagship;
  if (flagship !== null && flagship !== undefined && typeof flagship === 'object' && !Array.isArray(flagship)) {
    return true;
  }
  const thirdPartyModels = quota?.pools?.third_party?.models;
  if (
    Array.isArray(thirdPartyModels) &&
    thirdPartyModels.some(
      (model) =>
        (typeof model?.id === 'string' && OPUS_55_MODEL_RE.test(model.id)) ||
        (typeof model?.displayName === 'string' && OPUS_55_MODEL_RE.test(model.displayName))
    )
  ) {
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

export interface Quota403Restriction {
  kind: 'validation_required' | 'tos_violation';
  message: string;
  validationUrl?: string;
}

function extractValidationUrl(rawError: string | undefined, json: unknown): string | undefined {
  const seen = new Set<unknown>();
  const walk = (node: unknown): string | undefined => {
    if (!node || typeof node !== 'object' || seen.has(node)) return undefined;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = walk(item);
        if (found) return found;
      }
      return undefined;
    }
    const record = node as Record<string, unknown>;
    for (const key of ['validation_url', 'validationUrl']) {
      const val = readText(record[key]);
      if (val && /^https?:\/\//i.test(val)) return val;
    }
    for (const val of Object.values(record)) {
      const found = walk(val);
      if (found) return found;
    }
    return undefined;
  };

  const fromJson = walk(json);
  if (fromJson) return fromJson;

  if (rawError) {
    const match = rawError.match(/["']?validation_url["']?\s*[:=]\s*["']?(https?:\/\/[^\s"',}]+)/i);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

/**
 * 仅当 HTTP 403 时分类高置信风控/封禁信号，区分需人工验证与 ToS 封禁；
 * 通用 403（如普通 GCP/Vertex 权限不足）返回 null，保持优雅降级。
 */
export function classifyQuota403Error(
  status: number | undefined,
  rawError?: string,
  json?: unknown
): Quota403Restriction | null {
  if (status !== 403) return null;

  let jsonText = '';
  if (json !== undefined && json !== null) {
    if (typeof json === 'string') {
      jsonText = json;
    } else {
      try {
        jsonText = JSON.stringify(json);
      } catch {
        jsonText = '';
      }
    }
  }

  const combined = [rawError ?? '', jsonText].filter(Boolean).join('\n');
  const lower = combined.toLowerCase();
  const jsonObj = asRecord(json);
  const jsonErrObj = asRecord(jsonObj?.error);
  const message =
    readText(jsonErrObj?.message) ||
    readText(jsonObj?.message) ||
    readText(rawError) ||
    'HTTP 403';
  const validationUrl = extractValidationUrl(rawError, json);

  if (
    lower.includes('validation_required') ||
    lower.includes('verify your account') ||
    lower.includes('verification required') ||
    lower.includes('validation_url') ||
    Boolean(validationUrl)
  ) {
    return {
      kind: 'validation_required',
      message,
      ...(validationUrl ? { validationUrl } : {}),
    };
  }

  if (
    lower.includes('tos_violation') ||
    lower.includes('violation of terms') ||
    lower.includes('account_disabled_refused') ||
    lower.includes('account has been disabled') ||
    lower.includes('service has been disabled') ||
    lower.includes('account suspended') ||
    lower.includes('account banned') ||
    lower.includes('submit an appeal')
  ) {
    return {
      kind: 'tos_violation',
      message,
    };
  }

  return null;
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
  restriction?: Quota403Restriction;
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
    } else {
      const loadRestriction = classifyQuota403Error(loadRes.status, loadRes.error, loadRes.json);
      if (loadRestriction) {
        return {
          snapshot: {
            fetchedAt: Date.now(),
            ...(resolvedProjectId ? { projectId: resolvedProjectId } : {}),
            pools: emptyPools,
            error: loadRestriction.message.slice(0, 300),
          },
          detectedTier,
          restriction: loadRestriction,
        };
      }
      if (loadRes.error) {
        lastError = `loadCodeAssist(${baseUrl}): ${loadRes.error}`;
      }
    }

    const modelsRes = await postCodeAssistJson(
      `${baseUrl}/v1internal:fetchAvailableModels`,
      token,
      resolvedProjectId ? { project: resolvedProjectId } : {},
      effectiveProxy
    );
    if (!modelsRes.ok || !modelsRes.json) {
      const modelsRestriction = classifyQuota403Error(
        modelsRes.status,
        modelsRes.error,
        modelsRes.json
      );
      if (modelsRestriction) {
        return {
          snapshot: {
            fetchedAt: Date.now(),
            ...(resolvedProjectId ? { projectId: resolvedProjectId } : {}),
            pools: emptyPools,
            error: modelsRestriction.message.slice(0, 300),
          },
          detectedTier,
          restriction: modelsRestriction,
        };
      }
      if (modelsRes.status === 401) accessTokenRejected = true;
      if (modelsRes.error) {
        lastError = `fetchAvailableModels(${baseUrl}): ${modelsRes.error}`;
      }
      continue;
    }

    // best-effort 拉取 retrieveUserQuotaSummary；若返回高置信 403 验证/封禁则立即短路
    const summaryRes = await postCodeAssistJson(
      `${baseUrl}/v1internal:retrieveUserQuotaSummary`,
      token,
      resolvedProjectId ? { project: resolvedProjectId } : {},
      effectiveProxy
    );
    if (!summaryRes.ok) {
      const summaryRestriction = classifyQuota403Error(
        summaryRes.status,
        summaryRes.error,
        summaryRes.json
      );
      if (summaryRestriction) {
        return {
          snapshot: {
            fetchedAt: Date.now(),
            ...(resolvedProjectId ? { projectId: resolvedProjectId } : {}),
            pools: emptyPools,
            error: summaryRestriction.message.slice(0, 300),
          },
          detectedTier,
          restriction: summaryRestriction,
        };
      }
    }

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

// ============================================================================
// P0-3: agy -p /usage 配额读取（防封 + 2 分钟临期保护 + 45s/17s 竞态 + late 缓存）
// ============================================================================

export const USAGE_TOKEN_EXPIRY_WINDOW_MS = 2 * 60 * 1000;
export const DEFAULT_USAGE_BG_TIMEOUT_MS = 45_000;
export const MAX_USAGE_BG_TIMEOUT_MS = 120_000;
export const DEFAULT_USAGE_FG_WAIT_MS = 17_000;
export const DEFAULT_USAGE_LATE_TTL_MS = 3 * 60 * 1000;
export const DEFAULT_USAGE_COOLDOWN_MS = 60 * 1000;

export type UsageReadStatus =
  | 'ok'
  | 'STILL_READING'
  | 'DUE_FOR_RENEWAL'
  | 'COOLDOWN'
  | 'ERROR';

export interface UsageReadResult {
  status: UsageReadStatus;
  snapshot?: AccountQuotaSnapshot;
  error?: string;
  message?: string;
  fromLateCache?: boolean;
  /** Present on a foreground timeout while the underlying usage check is still running. */
  backgroundCompletion?: Promise<UsageReadResult>;
}

export interface UsageOAuthCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number | null;
}

export interface UsageExecOptions {
  binaryPath: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
}

export interface UsageExecOutput {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export type UsageCommandExecutor = (opts: UsageExecOptions) => Promise<UsageExecOutput>;

export interface UsageReadRequest {
  accountId: string;
  homeDir: string;
  proxyUrl?: string;
  projectId?: string;
  strictProxyBinding?: boolean;
  agyPath?: string;
  credentials?: UsageOAuthCredentials | null;
}

export interface CreateUsageReaderOptions {
  backgroundTimeoutMs?: number;
  foregroundWaitMs?: number;
  lateCacheTtlMs?: number;
  timeoutCooldownMs?: number;
  tokenExpiryWindowMs?: number;
  now?: () => number;
  executor?: UsageCommandExecutor;
  checkProxy?: typeof checkProxyReachable;
  resolveBinary?: (agyPath?: string) => string;
  readCredentials?: (homeDir: string) => UsageOAuthCredentials | null;
}

export interface UsageReader {
  readUsage(req: UsageReadRequest): Promise<UsageReadResult>;
}

/** 遗留直连 cloudcode-pa 调试开关，默认关闭。 */
export function isLegacyDirectQuotaEnabled(): boolean {
  return process.env.AGY_LEGACY_DIRECT_QUOTA === 'true';
}

export function resolveUsageBackgroundTimeoutMs(overrideMs?: number): number {
  if (typeof overrideMs === 'number' && Number.isFinite(overrideMs) && overrideMs > 0) {
    return Math.min(MAX_USAGE_BG_TIMEOUT_MS, Math.trunc(overrideMs));
  }
  const raw = process.env.AGY_USAGE_TIMEOUT_MS?.trim();
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.min(MAX_USAGE_BG_TIMEOUT_MS, Math.trunc(parsed));
    }
  }
  return DEFAULT_USAGE_BG_TIMEOUT_MS;
}

const ANSI_ESCAPE_RE = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]/g;

function stripAnsi(input: string): string {
  return input.replace(ANSI_ESCAPE_RE, '').replace(/\r/g, '');
}

function parseRelativeResetTime(text: string, fetchedAt: number): string | null {
  const relMatch = text.match(/(?:resets?\s*(?:in\s+)?|重置[^0-9]*)((?:\d+\s*[dhms]\s*)+)/i);
  if (!relMatch?.[1]) return null;
  const chunk = relMatch[1];
  let deltaMs = 0;
  for (const part of chunk.matchAll(/(\d+)\s*([dhms])/gi)) {
    const value = Number(part[1]);
    const unit = part[2].toLowerCase();
    if (!Number.isFinite(value)) continue;
    if (unit === 'd') deltaMs += value * 86_400_000;
    else if (unit === 'h') deltaMs += value * 3_600_000;
    else if (unit === 'm') deltaMs += value * 60_000;
    else if (unit === 's') deltaMs += value * 1000;
  }
  return deltaMs > 0 ? new Date(fetchedAt + deltaMs).toISOString() : null;
}

function extractUsageResetTime(text: string, fetchedAt: number): string | null {
  const isoMatch = text.match(/\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)\b/);
  if (isoMatch?.[1]) {
    const ts = Date.parse(isoMatch[1]);
    if (Number.isFinite(ts) && ts > 0) return new Date(ts).toISOString();
    return null;
  }
  return parseRelativeResetTime(text, fetchedAt);
}

function detectPoolHeader(line: string): QuotaPoolKey | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  if (/\b(?:g4\s*argon|gemini\s*(?:4\s*)?argon|gemini_flagship|flagship)\b/i.test(trimmed)) {
    return 'gemini_flagship';
  }
  if (/(?:3rd\s*party|third\s*party|third_party|第三方|claude\s+and\s+gpt)/i.test(trimmed)) {
    return 'third_party';
  }
  if (/^(?:gemini(?:\s+models|\s+flash)?|gemini_flash)(?=$|[\s:|])/i.test(trimmed)) {
    return 'gemini_flash';
  }
  return null;
}

function extractModelCandidate(prefix: string): { id: string; displayName: string; pool: QuotaPoolKey | null } | null {
  const cleaned = prefix
    .replace(/\[[█▓▒░#\-\s.=]*\]/g, ' ')
    .replace(/\b(?:5h|5-hour|5\s*hours?|five[\s-]+hours?|weekly|week|7d|7-day|window|session|remaining|left|used|available)\b/gi, ' ')
    .replace(/[:|│•·\-]+$/g, '')
    .trim();
  if (!cleaned) return null;

  // 优先识别标准模型 ID（如 gemini-4-argon, claude-sonnet-4-6, gpt-oss-120b）
  const idMatch = cleaned.match(/\b((?:gemini|claude|gpt|image|imagen)[a-z0-9._-]*)\b/i);
  if (idMatch?.[1]) {
    const rawId = idMatch[1].replace(/^models\//i, '');
    const pool = classifyModelPool(rawId, { displayName: cleaned });
    if (pool) {
      const baseId = rawId.replace(MODEL_ID_TIER_SUFFIXES, '') || rawId;
      return { id: baseId, displayName: cleaned, pool };
    }
  }

  // 其次识别展示名称（如 Gemini 4 Hydrogen, Claude Opus 5.5, GPT OSS 120B）
  if (/\b(?:claude|opus|sonnet|haiku|gpt)\b/i.test(cleaned)) {
    return {
      id: cleaned.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
      displayName: cleaned,
      pool: 'third_party',
    };
  }
  if (/\b(?:gemini|hydrogen|argon|imagen)\b/i.test(cleaned)) {
    const pool = /\bargon\b/i.test(cleaned) ? 'gemini_flagship' : 'gemini_flash';
    return {
      id: cleaned.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
      displayName: cleaned,
      pool,
    };
  }
  return null;
}

/**
 * 解析 `agy -p /usage` 的 stdout 文本为 AccountQuotaSnapshot。
 * Fail-Fast：空输出或未解析到任何有效配额条目时直接抛出异常。
 */
export function parseUsageOutput(
  rawOutput: string,
  opts?: { fetchedAt?: number; projectId?: string }
): AccountQuotaSnapshot {
  const fetchedAt = opts?.fetchedAt ?? Date.now();
  let text = stripAnsi(rawOutput ?? '').trim();
  if (!text) {
    throw new Error('Failed to parse agy /usage output: empty output');
  }

  // 若 --output-format json 包裹了 { response } / { result }，解包其中的文本
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (typeof parsed.response === 'string' && parsed.response.trim()) {
        text = stripAnsi(parsed.response).trim();
      } else if (typeof parsed.result === 'string' && parsed.result.trim()) {
        text = stripAnsi(parsed.result).trim();
      } else if (parsed.models && typeof parsed.models === 'object') {
        const snapshot = computeAccountQuotaSnapshot({
          modelsResponse: parsed,
          projectId: opts?.projectId,
          fetchedAt,
        });
        if (Object.values(snapshot.pools).some((p) => p !== null)) {
          return snapshot;
        }
      }
    } catch {
      // 非 JSON，按纯文本继续解析
    }
  }

  interface PoolAccumulator {
    directPercentages: number[];
    resetTimes: string[];
    window5h: number | null;
    windowWeekly: number | null;
    window5hResetTime: string | null;
    windowWeeklyResetTime: string | null;
    models: Map<string, PoolModelQuota>;
  }

  const acc: Record<QuotaPoolKey, PoolAccumulator> = {
    gemini_flagship: { directPercentages: [], resetTimes: [], window5h: null, windowWeekly: null, window5hResetTime: null, windowWeeklyResetTime: null, models: new Map() },
    gemini_flash: { directPercentages: [], resetTimes: [], window5h: null, windowWeekly: null, window5hResetTime: null, windowWeeklyResetTime: null, models: new Map() },
    third_party: { directPercentages: [], resetTimes: [], window5h: null, windowWeekly: null, window5hResetTime: null, windowWeeklyResetTime: null, models: new Map() },
  };

  let activePool: QuotaPoolKey | null = null;
  let parsedEntries = 0;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    const pctMatch = line.match(/(\d+(?:\.\d+)?)\s*%/);
    const headerPool = detectPoolHeader(line);

    if (!pctMatch) {
      // 无百分比的标题行，切换当前上下文池
      if (headerPool) {
        activePool = headerPool;
      } else {
        const modelOnly = extractModelCandidate(line);
        if (modelOnly?.pool) activePool = modelOnly.pool;
      }
      continue;
    }

    const rawPct = Number(pctMatch[1]);
    if (!Number.isFinite(rawPct)) continue;

    const isUsed = /\bused\b|已用/i.test(line);
    const remainingPct = Math.max(0, Math.min(100, isUsed ? 100 - rawPct : rawPct));
    const remainingFraction = Math.round((remainingPct / 100) * 10000) / 10000;
    const resetTime = extractUsageResetTime(line, fetchedAt);

    const prefix = line.slice(0, pctMatch.index).trim();
    const is5h = /\b(?:5h|5-hour|5\s*hours?|five[\s-]+hours?|session|hourly)\b/i.test(line);
    const isWeekly = /\b(?:weekly|week|7d|7-day)\b/i.test(line);

    const model = headerPool ? null : extractModelCandidate(prefix);
    const targetPool: QuotaPoolKey | null = headerPool ?? model?.pool ?? activePool;
    if (!targetPool) continue;

    if (headerPool) activePool = headerPool;

    const bucket = acc[targetPool];
    parsedEntries++;
    if (resetTime) bucket.resetTimes.push(resetTime);

    if (is5h) {
      bucket.window5h = bucket.window5h === null ? remainingPct : Math.min(bucket.window5h, remainingPct);
      if (resetTime) bucket.window5hResetTime = resetTime;
    } else if (isWeekly) {
      bucket.windowWeekly = bucket.windowWeekly === null ? remainingPct : Math.min(bucket.windowWeekly, remainingPct);
      if (resetTime) bucket.windowWeeklyResetTime = resetTime;
    }

    if (model && !headerPool) {
      const existing = bucket.models.get(model.id);
      if (!existing || remainingPct < existing.percentage) {
        bucket.models.set(model.id, {
          id: model.id,
          displayName: model.displayName,
          percentage: remainingPct,
          remainingFraction,
          resetTime,
        });
      }
    } else {
      bucket.directPercentages.push(remainingPct);
    }
  }

  if (parsedEntries === 0) {
    throw new Error(`Failed to parse agy /usage output: no quota entries found (${text.slice(0, 120)})`);
  }

  const pools: Record<QuotaPoolKey, PoolQuotaSummary | null> = {
    gemini_flagship: null,
    gemini_flash: null,
    third_party: null,
  };

  for (const poolKey of ['gemini_flagship', 'gemini_flash', 'third_party'] as const) {
    const b = acc[poolKey];
    const models = [...b.models.values()];
    const candidates: number[] = [
      ...b.directPercentages,
      ...models.map((m) => m.percentage),
      ...(b.window5h !== null ? [b.window5h] : []),
      ...(b.windowWeekly !== null ? [b.windowWeekly] : []),
    ];
    if (candidates.length === 0) continue;

    const percentage = Math.min(...candidates);
    const remainingFraction = Math.round((percentage / 100) * 10000) / 10000;

    let bottleneckModel: string | null = null;
    let bottleneckReset: string | null = null;
    if (models.length > 0) {
      const tightest = models.reduce((min, m) => (m.percentage < min.percentage ? m : min), models[0]);
      bottleneckModel = tightest.id;
      bottleneckReset = tightest.resetTime;
    }

    const windowLimitingReset =
      b.windowWeekly !== null && b.windowWeekly <= percentage && b.windowWeeklyResetTime
        ? b.windowWeeklyResetTime
        : b.window5h !== null && b.window5h <= percentage && b.window5hResetTime
          ? b.window5hResetTime
          : null;

    pools[poolKey] = {
      pool: poolKey,
      label: POOL_LABELS[poolKey],
      percentage,
      remainingFraction,
      resetTime: windowLimitingReset ?? bottleneckReset ?? b.resetTimes[0] ?? null,
      modelCount: models.length,
      bottleneckModel,
      window5h: b.window5h,
      windowWeekly: b.windowWeekly,
      ...(b.window5hResetTime ? { window5hResetTime: b.window5hResetTime } : {}),
      ...(b.windowWeeklyResetTime ? { windowWeeklyResetTime: b.windowWeeklyResetTime } : {}),
      models,
    };
  }

  if (!Object.values(pools).some((p) => p !== null)) {
    throw new Error('Failed to parse agy /usage output: no pools populated');
  }

  return {
    fetchedAt,
    ...(opts?.projectId ? { projectId: opts.projectId } : {}),
    pools,
  };
}

export async function defaultUsageExecutor(opts: UsageExecOptions): Promise<UsageExecOutput> {
  const cmd =
    process.platform === 'win32' && /\.(cmd|bat)$/i.test(opts.binaryPath)
      ? ['cmd.exe', '/c', opts.binaryPath, ...opts.args]
      : [opts.binaryPath, ...opts.args];

  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: opts.env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    windowsHide: true,
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {}
      resolve('timeout');
    }, opts.timeoutMs);
  });

  try {
    const stdoutPromise = new Response(proc.stdout).text().catch(() => '');
    const stderrPromise = new Response(proc.stderr).text().catch(() => '');
    const settled = await Promise.race([
      Promise.all([proc.exited, stdoutPromise, stderrPromise]),
      timeoutPromise,
    ]);

    if (settled === 'timeout') {
      try {
        proc.kill('SIGKILL');
      } catch {}
      const [stdout, stderr] = await Promise.race([
        Promise.all([stdoutPromise, stderrPromise]),
        Bun.sleep(500).then(() => ['', ''] as [string, string]),
      ]);
      return { exitCode: null, stdout, stderr, timedOut: true };
    }

    const [exitCode, stdout, stderr] = settled;
    return { exitCode, stdout, stderr, timedOut: false };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createUsageReader(options: CreateUsageReaderOptions = {}): UsageReader {
  const backgroundTimeoutMs = resolveUsageBackgroundTimeoutMs(options.backgroundTimeoutMs);
  const foregroundWaitMs =
    typeof options.foregroundWaitMs === 'number' && options.foregroundWaitMs > 0
      ? Math.trunc(options.foregroundWaitMs)
      : DEFAULT_USAGE_FG_WAIT_MS;
  const lateCacheTtlMs =
    typeof options.lateCacheTtlMs === 'number' && options.lateCacheTtlMs > 0
      ? Math.trunc(options.lateCacheTtlMs)
      : DEFAULT_USAGE_LATE_TTL_MS;
  const timeoutCooldownMs =
    typeof options.timeoutCooldownMs === 'number' && options.timeoutCooldownMs > 0
      ? Math.trunc(options.timeoutCooldownMs)
      : DEFAULT_USAGE_COOLDOWN_MS;
  const tokenExpiryWindowMs =
    typeof options.tokenExpiryWindowMs === 'number' && options.tokenExpiryWindowMs >= 0
      ? Math.trunc(options.tokenExpiryWindowMs)
      : USAGE_TOKEN_EXPIRY_WINDOW_MS;

  const now = options.now ?? (() => Date.now());
  const executor = options.executor ?? defaultUsageExecutor;
  const checkProxy = options.checkProxy ?? checkProxyReachable;
  const resolveBinary = options.resolveBinary ?? ((agyPath?: string) => resolveOfficialAgyBinary(agyPath));

  const pending = new Map<string, { promise: Promise<UsageReadResult>; waiting: number }>();
  const late = new Map<string, { result: UsageReadResult; expiresAt: number }>();
  const cooldownUntil = new Map<string, number>();

  const runBackground = async (req: UsageReadRequest, effectiveProxy?: string): Promise<UsageReadResult> => {
    try {
      const cfg = getConfig();
      const binaryPath = resolveBinary(req.agyPath ?? cfg.agyPath);
      const cwd = getDataRoot();
      const env = buildIsolatedAgyEnv({
        homeDir: req.homeDir,
        proxyUrl: effectiveProxy,
        agyPath: binaryPath,
      });

      const out = await executor({
        binaryPath,
        args: ['-p', '/usage'],
        cwd,
        env,
        timeoutMs: backgroundTimeoutMs,
      });

      if (out.timedOut) {
        cooldownUntil.set(req.accountId, now() + timeoutCooldownMs);
        return {
          status: 'ERROR',
          error: `agy -p /usage timed out after ${backgroundTimeoutMs}ms`,
        };
      }

      if (out.exitCode !== 0) {
        const detail = (out.stderr || out.stdout || '').trim().slice(0, 300);
        return {
          status: 'ERROR',
          error: `agy -p /usage exited with code ${out.exitCode}${detail ? `: ${detail}` : ''}`,
        };
      }

      const snapshot = parseUsageOutput(out.stdout, {
        fetchedAt: now(),
        projectId: req.projectId,
      });
      return { status: 'ok', snapshot };
    } catch (err) {
      return {
        status: 'ERROR',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };

  return {
    async readUsage(req: UsageReadRequest): Promise<UsageReadResult> {
      const cached = late.get(req.accountId);
      if (cached) {
        late.delete(req.accountId);
        if (now() < cached.expiresAt) {
          return { ...cached.result, fromLateCache: true };
        }
      }

      let entry = pending.get(req.accountId);
      if (!entry) {
        const until = cooldownUntil.get(req.accountId);
        if (until !== undefined) {
          if (now() < until) {
            return {
              status: 'COOLDOWN',
              error: `Usage reader in cooldown after timeout (${Math.ceil((until - now()) / 1000)}s remaining)`,
            };
          }
          cooldownUntil.delete(req.accountId);
        }

        const credentials =
          req.credentials !== undefined
            ? req.credentials
            : options.readCredentials
              ? options.readCredentials(req.homeDir)
              : null;

        if (!credentials) {
          return { status: 'ERROR', error: 'Missing OAuth token' };
        }

        const isExpiringSoon =
          credentials.expiresAt !== null && credentials.expiresAt <= now() + tokenExpiryWindowMs;
        if (credentials.refreshToken && (isExpiringSoon || !credentials.accessToken)) {
          return {
            status: 'DUE_FOR_RENEWAL',
            message: 'DUE_FOR_RENEWAL: access token expired or expiring within 2 minutes',
          };
        }
        if (!credentials.accessToken) {
          return { status: 'ERROR', error: 'Missing OAuth access token' };
        }

        const effectiveProxy = resolveEffectiveProxy(req.proxyUrl);
        const strictProxyBinding = req.strictProxyBinding ?? getConfig().strictProxyBinding;
        const newEntry: { promise: Promise<UsageReadResult>; waiting: number } = {
          waiting: 0,
          promise: Promise.resolve().then(async (): Promise<UsageReadResult> => {
            if (effectiveProxy && strictProxyBinding) {
              const reach = await checkProxy(effectiveProxy);
              if (!reach.ok) {
                return {
                  status: 'ERROR',
                  error: `Proxy unreachable (strictProxyBinding=true): ${reach.error ?? effectiveProxy}`,
                };
              }
            }
            return runBackground(req, effectiveProxy);
          }),
        };
        newEntry.promise = newEntry.promise.then((result) => {
          if (newEntry.waiting === 0 && result.status === 'ok') {
            late.set(req.accountId, {
              result,
              expiresAt: now() + lateCacheTtlMs,
            });
          }
          return result;
        }).finally(() => {
          if (pending.get(req.accountId) === newEntry) pending.delete(req.accountId);
        });
        pending.set(req.accountId, newEntry);
        entry = newEntry;
      }

      entry.waiting++;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const raceResult = await Promise.race([
          entry.promise.then((res) => ({ kind: 'done' as const, res })),
          new Promise<{ kind: 'timeout' }>((resolve) => {
            timer = setTimeout(() => resolve({ kind: 'timeout' }), foregroundWaitMs);
          }),
        ]);

        if (raceResult.kind === 'timeout') {
          return {
            status: 'STILL_READING',
            message: 'STILL_READING: usage check continuing in background',
            backgroundCompletion: entry.promise,
          };
        }
        return raceResult.res;
      } finally {
        if (timer) clearTimeout(timer);
        entry.waiting = Math.max(0, entry.waiting - 1);
      }
    },
  };
}
