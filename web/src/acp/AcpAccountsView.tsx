import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  BadgeCheck,
  Clock,
  Copy,
  ExternalLink,
  FolderInput,
  Gauge,
  Globe,
  KeyRound,
  LayoutGrid,
  List,
  Network,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import {
  Badge,
  Button,
  Confirm,
  Empty,
  IconButton,
  SearchInput,
  Select,
} from "../components";
import { useMinSpin } from "../useMinSpin";
import { AcpAccountErrorModal } from "./AcpAccountErrorModal";
import {
  AccountEditModal,
  BatchProxyModal,
  BatchTokenImportModal,
  ChromeScanModal,
} from "./AcpAccountModals";
import { AcpExitsBar } from "./AcpExitsBar";
import {
  ATTENTION_CATEGORY_LABELS,
  ATTENTION_CATEGORY_ORDER,
  isAttentionAccount,
  resolveAttentionInfo,
  type AttentionCategory,
  type AttentionInfo,
} from "./accountAttention";
import {
  clearAccountCooldown,
  deleteAccount,
  detectAccountTiers,
  importLocalAccounts,
  loginAccount,
  openAccountUrlInChrome,
  refreshAccount,
  refreshAccountQuota,
  refreshAllAccountQuotas,
  updateAccount,
} from "./api";
import type {
  AccountQuotaSnapshot,
  AccountRecord,
  AccountStatus,
  AccountTier,
  CooldownRecord,
  ExitGroup,
  PoolQuotaSummary,
  QuotaPoolKey,
} from "./types";

export interface AcpAccountsViewProps {
  accounts: AccountRecord[];
  exits: ExitGroup[];
  cooldowns: CooldownRecord[];
  onRefresh: () => Promise<void>;
  notify: (msg: string, kind?: "success" | "error") => void;
}

type StatusFilter = "all" | "ready" | "cooldown" | "attention";
type AccountTierBucket = "pro_flagship" | "pro_special" | "standard";
type TierFilter = "all" | AccountTierBucket;

function hasFlagshipModelAccess(acc: AccountRecord): boolean {
  if (Boolean(acc.quota?.pools?.gemini_flagship)) return true;
  const flashModels = acc.quota?.pools?.gemini_flash?.models;
  if (!Array.isArray(flashModels)) return false;
  return flashModels.some(
    (m) => Boolean(m) && (/argon/i.test(m.id) || /argon/i.test(m.displayName ?? ""))
  );
}

function getAccountTierBucket(acc: AccountRecord): AccountTierBucket {
  if (acc.tier !== "pro") return "standard";
  return hasFlagshipModelAccess(acc) ? "pro_flagship" : "pro_special";
}

function renderTierBadge(tierBucket: AccountTierBucket) {
  if (tierBucket === "pro_flagship") {
    return <Badge variant="amber">PRO</Badge>;
  }
  if (tierBucket === "pro_special") {
    return (
      <span
        className="badge"
        style={{
          background: "#f5f0e6",
          borderColor: "rgba(180, 140, 80, 0.28)",
          color: "#8a6d3b",
        }}
      >
        PRO(特价)
      </span>
    );
  }
  return <Badge variant="neutral">普通</Badge>;
}
type GlobalAction = "refresh" | "quota" | "tiers" | "batch";
type RowAction = "account" | "quota";

interface PendingActions {
  global: GlobalAction | null;
  rows: ReadonlyMap<string, RowAction>;
}

function MinSpinRefreshIcon({ active, size }: { active: boolean; size: number }) {
  const spinning = useMinSpin(active);
  return <RefreshCw size={size} className={spinning ? "spin" : undefined} />;
}

function MinSpinGaugeIcon({ active, size }: { active: boolean; size: number }) {
  const spinning = useMinSpin(active);
  return <Gauge size={size} className={spinning ? "spin" : undefined} />;
}

function formatTime(ts: number | null): string {
  if (!ts) return "未验证";
  const d = new Date(ts);
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes()
  ).padStart(2, "0")}`;
}

function formatCooldownRemaining(untilMs: number): string {
  const diff = Math.max(0, Math.ceil((untilMs - Date.now()) / 1000));
  if (diff < 60) return `${diff}s`;
  const m = Math.floor(diff / 60);
  const s = diff % 60;
  return s > 0 ? `${m}m${s}s` : `${m}m`;
}

const QUOTA_POOLS: Array<{ key: QuotaPoolKey; shortLabel: string }> = [
  { key: "gemini_flash", shortLabel: "Gemini" },
  { key: "third_party", shortLabel: "第三方" },
  { key: "gemini_flagship", shortLabel: "G4 Argon" },
];

function useIsCompact(maxWidth = 768): boolean {
  const [compact, setCompact] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(`(max-width: ${maxWidth}px)`).matches
      : false
  );

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(`(max-width: ${maxWidth}px)`);
    const update = () => setCompact(mql.matches);
    update();
    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", update);
      return () => mql.removeEventListener("change", update);
    }
    mql.addListener(update);
    return () => mql.removeListener(update);
  }, [maxWidth]);

  return compact;
}

const quotaNumber = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });

function isQuotaPercentage(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}

function formatQuotaPercentage(value: unknown): string {
  if (!isQuotaPercentage(value)) return "—";
  if (value > 0 && value < 0.01) return "<0.01%";
  return `${quotaNumber.format(value)}%`;
}

function quotaColors(percentage: number): { bar: string; text: string } {
  if (percentage >= 50) return { bar: "#10b981", text: "#059669" };
  if (percentage >= 20) return { bar: "#f59e0b", text: "#d97706" };
  return { bar: "#f43f5e", text: "#e11d48" };
}

function formatCompactResetCountdown(resetTime: string | null | undefined, now: number): string | null {
  const targetMs = resetTime ? Date.parse(resetTime) : NaN;
  if (!Number.isFinite(targetMs)) return null;
  const diffMs = targetMs - now;
  if (diffMs <= 0) return "0h 0m";
  const diffHrs = Math.floor(diffMs / 3_600_000);
  const diffMins = Math.floor((diffMs % 3_600_000) / 60_000);
  if (diffHrs >= 24) {
    return `${Math.floor(diffHrs / 24)}d ${diffHrs % 24}h`;
  }
  return `${diffHrs}h ${diffMins}m`;
}

function compactResetColor(resetTime: string | null | undefined, now: number): string {
  const targetMs = resetTime ? Date.parse(resetTime) : NaN;
  if (!Number.isFinite(targetMs)) return "#9ca3af";
  const diffHrs = (targetMs - now) / 3_600_000;
  if (diffHrs < 1) return "#059669";
  if (diffHrs < 6) return "#d97706";
  return "#64748b";
}

function PoolGlyph({ poolKey }: { poolKey: QuotaPoolKey }) {
  if (poolKey === "third_party") {
    return <Sparkles size={11} aria-hidden="true" style={{ flexShrink: 0, color: "#6366f1" }} />;
  }
  const fill = poolKey === "gemini_flagship" ? "#4f46e5" : "#0ea5e9";
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      <path
        d="M12 2C12.6 7.4 16.6 11.4 22 12C16.6 12.6 12.6 16.6 12 22C11.4 16.6 7.4 12.6 2 12C7.4 11.4 11.4 7.4 12 2Z"
        fill={fill}
      />
    </svg>
  );
}

function formatResetCountdown(resetTime: string | null, now: number): string {
  const targetMs = resetTime ? Date.parse(resetTime) : NaN;
  if (!Number.isFinite(targetMs)) return "重置时间未知";
  const diffMs = targetMs - now;
  if (diffMs <= 0) return "即将重置";
  const minutes = Math.ceil(diffMs / 60000);
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${minutes} 分钟后重置`;
  if (hours < 24) return `${hours} 小时 ${minutes % 60} 分后重置`;
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时后重置`;
}

function getQuotaPools(quota?: AccountQuotaSnapshot | null) {
  return QUOTA_POOLS.map(({ key, shortLabel }) => {
    const pool = quota?.pools?.[key];
    return { key, shortLabel, pool: pool && isQuotaPercentage(pool.percentage) ? pool : null };
  });
}

function describePool(pool: PoolQuotaSummary, fallback: string, now: number): string {
  const lines = [
    `${pool.label || fallback} · 剩余 ${formatQuotaPercentage(pool.percentage)}`,
    formatResetCountdown(pool.resetTime, now),
  ];
  if (pool.bottleneckModel) lines.push(`短板模型：${pool.bottleneckModel}`);
  if (pool.window5h != null || pool.windowWeekly != null) {
    lines.push(`5h 窗口 ${formatQuotaPercentage(pool.window5h)} · 周窗口 ${formatQuotaPercentage(pool.windowWeekly)}`);
  }
  if (Array.isArray(pool.models) && pool.models.length > 0) {
    lines.push("模型明细");
    for (const model of pool.models) {
      if (!model) continue;
      const reset = model.resetTime ? ` · ${formatResetCountdown(model.resetTime, now)}` : "";
      lines.push(`${model.displayName || model.id} · ${formatQuotaPercentage(model.percentage)}${reset}`);
    }
  }
  return lines.join("\n");
}

function AcpQuotaCell({
  quota,
  now,
  fillWidth,
}: {
  quota?: AccountQuotaSnapshot | null;
  now: number;
  fillWidth?: boolean;
}) {
  const isCompact = useIsCompact(768);
  const items = getQuotaPools(quota)
    .filter((item): item is { key: QuotaPoolKey; shortLabel: string; pool: PoolQuotaSummary } => item.pool !== null)
    .map((item) => ({
      ...item,
      detail: describePool(item.pool, item.shortLabel, now),
    }));
  const hasQuota = items.length > 0;
  const refreshError = quota?.error;
  const lastSample = refreshError && hasQuota && quota ? `上次采集 ${formatTime(quota.fetchedAt)}` : "";

  if (!hasQuota && !refreshError) {
    return <span style={{ color: "#94a3b8", fontSize: "12px" }}>—</span>;
  }

  return (
    <>
      {hasQuota && (
        <div
          aria-label="配额池剩余用量"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
            gap: "6px",
            minWidth: fillWidth || isCompact ? undefined : "308px",
            maxWidth: fillWidth ? "100%" : "360px",
            width: fillWidth ? "100%" : undefined,
          }}
        >
          {items.map(({ key, shortLabel, pool, detail }) => {
            const has5h = key === "gemini_flash" && isQuotaPercentage(pool.window5h);
            const hasWeekly = key === "gemini_flash" && isQuotaPercentage(pool.windowWeekly);
            const showWeeklySubrow = has5h && hasWeekly;
            const mainLabel = has5h ? `${shortLabel} 5H` : shortLabel;
            const mainResetTime = has5h ? (pool.window5hResetTime ?? pool.resetTime) : pool.resetTime;
            const mainPercentage = has5h && isQuotaPercentage(pool.window5h) ? pool.window5h : pool.percentage;
            const colors = quotaColors(mainPercentage);
            const resetLabel = formatCompactResetCountdown(mainResetTime, now);
            const resetColor = compactResetColor(mainResetTime, now);
            const weeklyResetLabel = showWeeklySubrow
              ? formatCompactResetCountdown(pool.windowWeeklyResetTime, now)
              : null;
            const weeklyColors = showWeeklySubrow && isQuotaPercentage(pool.windowWeekly)
              ? quotaColors(pool.windowWeekly)
              : null;
            const isFullWidth = key === "gemini_flagship";

            const mainRowContent = (
              <>
                <span
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "3px",
                    flex: "1 1 0%",
                    minWidth: 0,
                    color: "#475569",
                    fontWeight: 600,
                  }}
                >
                  <PoolGlyph poolKey={key} />
                  <span
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {mainLabel}
                  </span>
                </span>

                {resetLabel && (
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "2px",
                      flexShrink: 0,
                      fontSize: "10px",
                      fontFamily: "var(--font-mono)",
                      fontWeight: 500,
                      color: resetColor,
                      whiteSpace: "nowrap",
                    }}
                  >
                    <Clock size={10} aria-hidden="true" style={{ flexShrink: 0 }} />
                    <span>{resetLabel}</span>
                  </span>
                )}

                <strong
                  className="mono"
                  style={{
                    flexShrink: 0,
                    marginLeft: "2px",
                    fontSize: "10.5px",
                    fontWeight: 700,
                    color: colors.text,
                    whiteSpace: "nowrap",
                  }}
                >
                  {formatQuotaPercentage(mainPercentage)}
                </strong>
              </>
            );

            return (
              <div
                key={key}
                title={detail}
                style={{
                  position: "relative",
                  overflow: "hidden",
                  gridColumn: isFullWidth ? "1 / -1" : undefined,
                  display: "flex",
                  flexDirection: showWeeklySubrow ? "column" : "row",
                  alignItems: showWeeklySubrow ? "stretch" : "center",
                  justifyContent: showWeeklySubrow ? "center" : undefined,
                  gap: showWeeklySubrow ? "2px" : "5px",
                  height: showWeeklySubrow ? "auto" : "24px",
                  minHeight: "24px",
                  padding: showWeeklySubrow ? "3px 8px 4px" : "0 8px 2px",
                  borderRadius: "6px",
                  border: "1px solid rgba(26, 26, 26, 0.09)",
                  background: "rgba(255, 255, 255, 0.78)",
                  fontSize: "10.5px",
                  lineHeight: 1,
                  minWidth: 0,
                }}
              >
                {showWeeklySubrow ? (
                  <>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "5px",
                        minWidth: 0,
                      }}
                    >
                      {mainRowContent}
                    </div>

                    <div
                      aria-hidden="true"
                      style={{
                        height: "2px",
                        borderRadius: "999px",
                        background: "rgba(26, 26, 26, 0.06)",
                        overflow: "hidden",
                      }}
                    >
                      <div
                        style={{
                          height: "100%",
                          width: `${Math.max(0, Math.min(100, mainPercentage))}%`,
                          background: colors.bar,
                          transition: "width 0.35s ease",
                        }}
                      />
                    </div>

                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "4px",
                        padding: "2px 0 0",
                        fontSize: "10px",
                        lineHeight: 1,
                        color: "#64748b",
                        minWidth: 0,
                      }}
                    >
                      <span
                        style={{
                          flex: "1 1 0%",
                          minWidth: 0,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        周配额
                      </span>
                      {weeklyResetLabel && (
                        <span
                          style={{
                            flexShrink: 0,
                            fontFamily: "var(--font-mono)",
                            fontSize: "9.5px",
                            color: "#94a3b8",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {weeklyResetLabel}
                        </span>
                      )}
                      {weeklyColors && (
                        <strong
                          className="mono"
                          style={{
                            flexShrink: 0,
                            fontSize: "10px",
                            fontWeight: 700,
                            color: weeklyColors.text,
                            whiteSpace: "nowrap",
                          }}
                        >
                          {formatQuotaPercentage(pool.windowWeekly)}
                        </strong>
                      )}
                    </div>

                    {weeklyColors && isQuotaPercentage(pool.windowWeekly) && (
                      <div
                        aria-hidden="true"
                        style={{
                          position: "absolute",
                          left: 0,
                          right: 0,
                          bottom: 0,
                          height: "1.5px",
                          background: "rgba(26, 26, 26, 0.06)",
                        }}
                      >
                        <div
                          style={{
                            height: "100%",
                            width: `${Math.max(0, Math.min(100, pool.windowWeekly))}%`,
                            background: weeklyColors.bar,
                            transition: "width 0.35s ease",
                          }}
                        />
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    {mainRowContent}
                    <div
                      aria-hidden="true"
                      style={{
                        position: "absolute",
                        left: 0,
                        right: 0,
                        bottom: 0,
                        height: "2.5px",
                        background: "rgba(26, 26, 26, 0.06)",
                      }}
                    >
                      <div
                        style={{
                          height: "100%",
                          width: `${Math.max(0, Math.min(100, mainPercentage))}%`,
                          background: colors.bar,
                          transition: "width 0.35s ease",
                        }}
                      />
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
      {refreshError && (
        <span className="acp-quota-error" title={refreshError}>
          <AlertTriangle size={12} aria-hidden="true" />
          {hasQuota ? `更新失败 · ${lastSample}` : "用量获取失败"}
        </span>
      )}
      {isCompact && (hasQuota || refreshError) && (
        <details className="acp-quota-details">
          <summary>用量明细</summary>
          <div className="acp-quota-detail-body">
            {refreshError && <p>{refreshError}</p>}
            {items.map(({ key, detail }) => <p key={key}>{detail}</p>)}
          </div>
        </details>
      )}
    </>
  );
}

function statusBadgeMeta(status: AccountStatus): {
  label: string;
  variant: "green" | "neutral" | "amber" | "red";
  dot: boolean;
} {
  switch (status) {
    case "ready":
      return { label: "就绪", variant: "green", dot: true };
    case "disabled":
      return { label: "已停用", variant: "neutral", dot: false };
    case "auth_required":
      return { label: "需重新登录", variant: "amber", dot: true };
    case "restricted":
      return { label: "受限", variant: "red", dot: true };
    default:
      return { label: status, variant: "neutral", dot: false };
  }
}

export function AcpAccountsView({
  accounts,
  exits,
  cooldowns,
  onRefresh,
  notify,
}: AcpAccountsViewProps) {
  const [viewMode, setViewMode] = useState<"card" | "table">(() => {
    if (typeof window !== "undefined") {
      try {
        const saved = window.localStorage.getItem("acp_accounts_view_mode");
        if (saved === "table" || saved === "card") return saved;
      } catch {}
    }
    return "card";
  });

  const handleSetViewMode = (mode: "card" | "table") => {
    setViewMode(mode);
    try {
      window.localStorage.setItem("acp_accounts_view_mode", mode);
    } catch {}
  };

  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [attentionCategoryFilter, setAttentionCategoryFilter] = useState<
    "all" | AttentionCategory
  >("all");
  const [tierFilter, setTierFilter] = useState<TierFilter>("all");
  const [exitFilter, setExitFilter] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());

  const [actions, setActions] = useState<PendingActions>(() => ({ global: null, rows: new Map() }));
  const actionsRef = useRef(actions);
  const [batchActionKind, setBatchActionKind] = useState<"enable" | "disable" | "refresh" | null>(null);
  const [refreshProgress, setRefreshProgress] = useState<{ done: number; total: number } | null>(null);
  const globalBusy = actions.global !== null;
  const batchBlocked = globalBusy || actions.rows.size > 0;
  const refreshingQuotas = actions.global === "quota";
  const detectingTiers = actions.global === "tiers";
  const refreshAllSpinning = useMinSpin(actions.global === "refresh");
  const refreshQuotasSpinning = useMinSpin(refreshingQuotas);
  const batchRefreshSpinning = useMinSpin(
    actions.global === "batch" && batchActionKind === "refresh"
  );
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  // Modals
  const [editingModal, setEditingModal] = useState<
    "new" | AccountRecord | null
  >(null);
  const [errorModalAccount, setErrorModalAccount] =
    useState<AccountRecord | null>(null);
  const [showTokenModal, setShowTokenModal] = useState(false);
  const [showChromeModal, setShowChromeModal] = useState(false);
  const [showProxyModal, setShowProxyModal] = useState(false);

  // Confirm delete (single or batch)
  const [deletingAccount, setDeletingAccount] = useState<AccountRecord | null>(
    null
  );
  const [confirmBatchDelete, setConfirmBatchDelete] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  const { proFlagshipCount, proSpecialCount, standardCount } = useMemo(() => {
    let flagship = 0;
    let special = 0;
    let standard = 0;
    for (const acc of accounts) {
      const bucket = getAccountTierBucket(acc);
      if (bucket === "pro_flagship") flagship += 1;
      else if (bucket === "pro_special") special += 1;
      else standard += 1;
    }
    return {
      proFlagshipCount: flagship,
      proSpecialCount: special,
      standardCount: standard,
    };
  }, [accounts]);

  const cooldownsByAccount = useMemo(() => {
    const map = new Map<string, CooldownRecord[]>();
    for (const cd of cooldowns) {
      if (cd.untilMs <= now) continue;
      const list = map.get(cd.accountId) ?? [];
      list.push(cd);
      map.set(cd.accountId, list);
    }
    return map;
  }, [cooldowns, now]);

  const readyCount = useMemo(
    () => accounts.filter((acc) => acc.status === "ready").length,
    [accounts]
  );
  const cooldownCount = useMemo(
    () =>
      accounts.filter(
        (acc) => (cooldownsByAccount.get(acc.id) ?? []).length > 0
      ).length,
    [accounts, cooldownsByAccount]
  );
  const attentionCount = useMemo(
    () => accounts.filter((acc) => isAttentionAccount(acc)).length,
    [accounts]
  );

  const attentionCategoryCounts = useMemo(() => {
    const counts = new Map<AttentionCategory, number>();
    for (const acc of accounts) {
      if (!isAttentionAccount(acc)) continue;
      const cat = resolveAttentionInfo(acc).category;
      counts.set(cat, (counts.get(cat) ?? 0) + 1);
    }
    return counts;
  }, [accounts]);

  const activeErrorModalAccount = useMemo(() => {
    if (!errorModalAccount) return null;
    return (
      accounts.find((acc) => acc.id === errorModalAccount.id) ??
      errorModalAccount
    );
  }, [accounts, errorModalAccount]);

  const exitOptions = useMemo(() => {
    const seen = new Set<string>();
    const list: Array<{ value: string; label: string }> = [];
    for (const ex of exits) {
      if (!ex.ip || ex.ip.trim().toLowerCase() === "unknown") continue;
      const val = ex.ip.trim();
      if (seen.has(val)) continue;
      seen.add(val);
      const countryPart = ex.country ? ` (${ex.country})` : "";
      list.push({
        value: val,
        label: `${val}${countryPart} · ${ex.count}`,
      });
    }
    return list;
  }, [exits]);

  useEffect(() => {
    if (exitFilter !== "" && !exitOptions.some((opt) => opt.value === exitFilter)) {
      setExitFilter("");
    }
  }, [exitFilter, exitOptions]);

  useEffect(() => {
    if (attentionCategoryFilter === "all") return;
    if (
      statusFilter !== "attention" ||
      (attentionCategoryCounts.get(attentionCategoryFilter) ?? 0) === 0
    ) {
      setAttentionCategoryFilter("all");
    }
  }, [statusFilter, attentionCategoryFilter, attentionCategoryCounts]);

  const filteredAccounts = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return accounts.filter((acc) => {
      const tierBucket = getAccountTierBucket(acc);
      if (tierFilter !== "all" && tierBucket !== tierFilter) return false;

      const accExit = (acc.exitIp || "").trim() || "unknown";
      if (exitFilter && accExit !== exitFilter) return false;

      const cds = cooldownsByAccount.get(acc.id) ?? [];
      if (statusFilter === "ready" && acc.status !== "ready") return false;
      if (statusFilter === "cooldown" && cds.length === 0) return false;
      if (statusFilter === "attention") {
        if (!isAttentionAccount(acc)) return false;
        if (
          attentionCategoryFilter !== "all" &&
          resolveAttentionInfo(acc).category !== attentionCategoryFilter
        ) {
          return false;
        }
      }

      if (!q) return true;
      return (
        (acc.email || "").toLowerCase().includes(q) ||
        (acc.label || "").toLowerCase().includes(q) ||
        (acc.source || "").toLowerCase().includes(q) ||
        (acc.exitIp || "").toLowerCase().includes(q)
      );
    });
  }, [
    accounts,
    attentionCategoryFilter,
    cooldownsByAccount,
    exitFilter,
    searchQuery,
    statusFilter,
    tierFilter,
  ]);

  const allFilteredSelected = useMemo(() => {
    if (filteredAccounts.length === 0) return false;
    return filteredAccounts.every((acc) => selectedIds.has(acc.id));
  }, [filteredAccounts, selectedIds]);

  const selectedCount = selectedIds.size;

  function updateActions(next: PendingActions) {
    actionsRef.current = next;
    setActions(next);
  }

  function beginGlobalAction(action: GlobalAction): boolean {
    const current = actionsRef.current;
    if (current.global || current.rows.size > 0) return false;
    updateActions({ ...current, global: action });
    return true;
  }

  function finishGlobalAction() {
    updateActions({ ...actionsRef.current, global: null });
  }

  function beginRowAction(id: string, action: RowAction = "account"): boolean {
    const current = actionsRef.current;
    if (current.global || current.rows.has(id)) return false;
    const rows = new Map(current.rows);
    rows.set(id, action);
    updateActions({ ...current, rows });
    return true;
  }

  function finishRowAction(id: string) {
    const current = actionsRef.current;
    const rows = new Map(current.rows);
    rows.delete(id);
    updateActions({ ...current, rows });
  }

  function toggleSelectAll() {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) {
        for (const acc of filteredAccounts) next.delete(acc.id);
      } else {
        for (const acc of filteredAccounts) next.add(acc.id);
      }
      return next;
    });
  }

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleRefreshAll() {
    if (!beginGlobalAction("refresh")) return;
    try {
      const enabledAccounts = accounts.filter((acc) => acc.status !== "disabled");
      if (enabledAccounts.length === 0) {
        notify("没有可刷新的启用账号");
        return;
      }
      setRefreshProgress({ done: 0, total: enabledAccounts.length });
      let succeeded = 0;
      let failed = 0;
      let lastError = "";
      let nextIndex = 0;
      const concurrency = Math.min(4, enabledAccounts.length);

      async function worker() {
        while (true) {
          const idx = nextIndex;
          nextIndex += 1;
          if (idx >= enabledAccounts.length) return;
          const acc = enabledAccounts[idx];
          try {
            await refreshAccount(acc.id);
            succeeded += 1;
          } catch (err) {
            failed += 1;
            lastError = err instanceof Error ? err.message : "刷新失败";
          } finally {
            setRefreshProgress((prev) =>
              prev ? { ...prev, done: prev.done + 1 } : prev
            );
          }
        }
      }

      await Promise.all(Array.from({ length: concurrency }, () => worker()));

      if (failed === 0) {
        notify(`已完成全部账号刷新（共 ${succeeded} 个）`, "success");
      } else {
        notify(
          `账号刷新完成 · 成功 ${succeeded} 个 · 失败 ${failed} 个${lastError ? `（${lastError}）` : ""}`,
          "error"
        );
      }
      await onRefresh();
    } catch (err) {
      notify(err instanceof Error ? err.message : "刷新全部账号失败", "error");
    } finally {
      setRefreshProgress(null);
      finishGlobalAction();
    }
  }

  async function handleRefreshAllQuotas() {
    if (!beginGlobalAction("quota")) return;
    try {
      const { refreshed, failed } = await refreshAllAccountQuotas();
      if (refreshed === 0 && failed === 0) {
        notify("没有可刷新的启用账号");
      } else {
        notify(`用量刷新完成 · 成功 ${refreshed} 个 · 失败 ${failed} 个`, failed > 0 ? "error" : "success");
      }
      await onRefresh();
    } catch (err) {
      notify(err instanceof Error ? err.message : "刷新剩余用量失败", "error");
    } finally {
      finishGlobalAction();
    }
  }

  async function handleRefreshAccountQuota(acc: AccountRecord) {
    if (!beginRowAction(acc.id, "quota")) return;
    try {
      const updated = await refreshAccountQuota(acc.id);
      const name = acc.email || acc.label;
      if (updated.quota?.error || !getQuotaPools(updated.quota).some(({ pool }) => pool !== null)) {
        const reason = updated.quota?.error || "上游未返回可用额度";
        notify(`${name} 用量更新失败 · ${reason}`, "error");
      } else {
        notify(`已刷新 ${name} 剩余用量`, "success");
      }
      await onRefresh();
    } catch (err) {
      notify(err instanceof Error ? err.message : "刷新剩余用量失败", "error");
    } finally {
      finishRowAction(acc.id);
    }
  }

  async function handleDetectTiers() {
    if (!beginGlobalAction("tiers")) return;
    try {
      const res = await detectAccountTiers();
      const failedPart = res.failed > 0 ? `（失败 ${res.failed}）` : "";
      notify(
        `已识别：Pro ${res.pro} 个 / 普通 ${res.standard} 个${failedPart}`,
        res.failed > 0 && res.updated === 0 ? "error" : "success"
      );
      await onRefresh();
    } catch (err) {
      notify(
        err instanceof Error ? err.message : "识别账号等级失败",
        "error"
      );
    } finally {
      finishGlobalAction();
    }
  }

  async function handleImportLocal() {
    if (!beginGlobalAction("batch")) return;
    try {
      const res = await importLocalAccounts();
      notify(`已导入 ${res.imported} 个本地账号`, "success");
      await onRefresh();
    } catch (err) {
      notify(
        err instanceof Error ? err.message : "导入本地账号失败",
        "error"
      );
    } finally {
      finishGlobalAction();
    }
  }

  async function handleRefreshOne(acc: AccountRecord) {
    if (!beginRowAction(acc.id)) return;
    try {
      await refreshAccount(acc.id);
      notify(`已刷新 ${acc.email || acc.label}`, "success");
      await onRefresh();
    } catch (err) {
      notify(err instanceof Error ? err.message : "刷新失败", "error");
    } finally {
      finishRowAction(acc.id);
    }
  }

  async function handleLogin(acc: AccountRecord) {
    if (!beginRowAction(acc.id)) return;
    try {
      const res = await loginAccount(acc.id);
      notify(
        res.message || `已触发 ${acc.email || acc.label} CLI 登录`,
        "success"
      );
      await onRefresh();
    } catch (err) {
      notify(err instanceof Error ? err.message : "CLI 登录失败", "error");
    } finally {
      finishRowAction(acc.id);
    }
  }

  async function handleToggleTier(acc: AccountRecord) {
    if (!beginRowAction(acc.id)) return;
    try {
      const tier: AccountTier = acc.tier === "pro" ? "standard" : "pro";
      await updateAccount(acc.id, { tier });
      notify(`已切换为${tier === "pro" ? " Pro" : "普通"}账号`, "success");
      await onRefresh();
    } catch (err) {
      notify(
        err instanceof Error ? err.message : "账号类型切换失败",
        "error"
      );
    } finally {
      finishRowAction(acc.id);
    }
  }

  async function handleToggleDisable(acc: AccountRecord) {
    if (!beginRowAction(acc.id)) return;
    try {
      const nextStatus: AccountStatus =
        acc.status === "disabled" ? "ready" : "disabled";
      await updateAccount(acc.id, { status: nextStatus });
      notify(
        nextStatus === "disabled" ? "已停用账户" : "已启用账户",
        "success"
      );
      await onRefresh();
    } catch (err) {
      notify(err instanceof Error ? err.message : "操作失败", "error");
    } finally {
      finishRowAction(acc.id);
    }
  }

  async function handleClearCooldown(accountId: string, scope: string) {
    try {
      const result = await clearAccountCooldown(accountId, scope);
      const family = scope.slice(0, scope.lastIndexOf(":"));
      if (result.deleted === true) {
        notify(`已清除 ${family} 冷却`, "success");
      } else {
        notify(result.deleted === false ? "冷却记录不存在或已过期" : "服务未确认删除结果", "error");
      }
      await onRefresh();
    } catch (err) {
      notify(err instanceof Error ? err.message : "清除冷却失败", "error");
    }
  }

  async function handleBatchAction(
    action: "enable" | "disable" | "refresh"
  ) {
    const ids = Array.from(selectedIds);
    if (ids.length === 0 || !beginGlobalAction("batch")) return;
    setBatchActionKind(action);
    const actionLabel =
      action === "enable"
        ? "批量启用"
        : action === "disable"
          ? "批量停用"
          : "批量刷新";
    try {
      let succeeded = 0;
      let failed = 0;
      let lastError = "";
      for (const id of ids) {
        try {
          if (action === "enable") {
            await updateAccount(id, { status: "ready" });
          } else if (action === "disable") {
            await updateAccount(id, { status: "disabled" });
          } else if (action === "refresh") {
            await refreshAccount(id);
          }
          succeeded += 1;
        } catch (err) {
          failed += 1;
          lastError = err instanceof Error ? err.message : "请求失败";
        }
      }
      if (failed === 0) {
        notify(`已完成${actionLabel}（共 ${succeeded} 个）`, "success");
      } else {
        notify(
          `${actionLabel}完成 · 成功 ${succeeded} 个 · 失败 ${failed} 个${lastError ? `（${lastError}）` : ""}`,
          "error"
        );
      }
      await onRefresh();
    } catch (err) {
      notify(err instanceof Error ? err.message : `${actionLabel}失败`, "error");
    } finally {
      setBatchActionKind(null);
      finishGlobalAction();
    }
  }

  async function confirmSingleDelete() {
    if (!deletingAccount || !beginRowAction(deletingAccount.id)) return;
    setDeleteBusy(true);
    setDeleteError("");
    try {
      await deleteAccount(deletingAccount.id);
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(deletingAccount.id);
        return next;
      });
      notify(
        `已删除 ${deletingAccount.email || deletingAccount.label}`,
        "success"
      );
      setDeletingAccount(null);
      await onRefresh();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "删除失败");
    } finally {
      setDeleteBusy(false);
      finishRowAction(deletingAccount.id);
    }
  }

  async function confirmBatchDeleteAction() {
    const ids = Array.from(selectedIds);
    if (ids.length === 0 || !beginGlobalAction("batch")) return;
    setDeleteBusy(true);
    setDeleteError("");
    try {
      let failed = 0;
      for (const id of ids) {
        try {
          await deleteAccount(id);
        } catch {
          failed += 1;
        }
      }
      setSelectedIds(new Set());
      setConfirmBatchDelete(false);
      notify(
        failed > 0
          ? `批量删除完成，成功 ${ids.length - failed} 个，失败 ${failed} 个`
          : `已删除选中的 ${ids.length} 个账号`,
        failed > 0 ? "error" : "success"
      );
      await onRefresh();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "批量删除失败");
    } finally {
      setDeleteBusy(false);
      finishGlobalAction();
    }
  }

  const hasFilters =
    searchQuery.trim() !== "" ||
    statusFilter !== "all" ||
    attentionCategoryFilter !== "all" ||
    tierFilter !== "all" ||
    exitFilter !== "";

  async function handleOpenAccountUrl(
    acc: AccountRecord,
    url: string,
    actionLabel?: string
  ) {
    try {
      const res = await openAccountUrlInChrome(acc.id, url);
      if (res.launched) {
        notify(
          `已在 Chrome「${res.profileName || res.profileDir}」中打开${actionLabel || "链接"}`,
          "success"
        );
        return;
      }
      window.open(url, "_blank", "noopener,noreferrer");
      notify(
        `未在 Chrome 中找到 ${acc.email || "该账号"} 的登录配置，已在当前浏览器打开`
      );
    } catch {
      window.open(url, "_blank", "noopener,noreferrer");
      notify(
        "网关暂未启用 Chrome 直达，已在当前浏览器打开（重启 8048 即可支持按账号直达 Chrome）"
      );
    }
  }

  function handleQuickAttentionAction(
    acc: AccountRecord,
    info: AttentionInfo
  ) {
    if (info.actionKind === "external_url" && info.actionUrl) {
      const targetLabel =
        info.category === "violation_blocked"
          ? "申诉页面"
          : info.category === "validation_required"
            ? "验证页面"
            : info.actionLabel;
      void handleOpenAccountUrl(acc, info.actionUrl, targetLabel);
      return;
    }
    if (info.actionKind === "relogin") {
      void handleLogin(acc);
      return;
    }
    if (info.actionKind === "enable") {
      void handleToggleDisable(acc);
      return;
    }
    if (info.actionKind === "refresh") {
      void handleRefreshOne(acc);
      return;
    }
    setErrorModalAccount(acc);
  }

  return (
    <div>
      <div className="page-heading" style={{ flexWrap: "wrap" }}>
        <div>
          <div className="eyebrow">ACP · 账号池与风控</div>
          <h1>
            账号与风控
            <span className="title-count">{accounts.length}</span>
          </h1>
          <p>多账号池调度、出口 IP 聚合与模型家族冷却管理</p>
        </div>

        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "8px",
          }}
        >
          <Button
            onClick={() => void handleRefreshAll()}
            disabled={batchBlocked}
          >
            <RefreshCw size={15} className={refreshAllSpinning ? "spin" : undefined} />
            {actions.global === "refresh" && refreshProgress
              ? `刷新中 (${refreshProgress.done}/${refreshProgress.total})`
              : "刷新全部"}
          </Button>
          <Button
            onClick={() => void handleRefreshAllQuotas()}
            aria-busy={refreshingQuotas}
            disabled={batchBlocked}
            title="采集全部启用账号的三号池剩余用量"
          >
            <Gauge size={15} className={refreshQuotasSpinning ? "spin" : undefined} />
            {refreshingQuotas ? "刷新用量中…" : "刷新用量"}
          </Button>
          <Button
            onClick={() => void handleDetectTiers()}
            busy={detectingTiers}
            disabled={batchBlocked}
            title="调用官方 loadCodeAssist 接口真实探测每个账号等级"
          >
            <BadgeCheck size={15} />
            探测账号等级
          </Button>
          <Button onClick={() => void handleImportLocal()} disabled={batchBlocked}>
            <FolderInput size={15} />
            导入本地
          </Button>
          <Button onClick={() => setShowChromeModal(true)} disabled={batchBlocked}>
            <Globe size={15} />
            Chrome 扫描授权
          </Button>
          <Button onClick={() => setShowProxyModal(true)} disabled={batchBlocked}>
            <Network size={15} />
            设置出口代理
          </Button>
          <Button onClick={() => setShowTokenModal(true)} disabled={batchBlocked}>
            <KeyRound size={15} />
            批量导入 Token
          </Button>
          <Button
            className="primary"
            onClick={() => setEditingModal("new")}
            disabled={batchBlocked}
          >
            <Plus size={15} />
            新建账号
          </Button>
        </div>
      </div>

      <AcpExitsBar
        exits={exits}
        selectedIp={exitFilter}
        onSelect={setExitFilter}
      />

      <section className="data-section acp-accounts-list">
        <div
          className="list-toolbar"
          style={{ flexWrap: "wrap", gap: "10px 14px" }}
        >
          <label className="acp-account-select-all">
            <input type="checkbox" checked={allFilteredSelected} onChange={toggleSelectAll} disabled={filteredAccounts.length === 0} />
            全选当前列表
          </label>
          <SearchInput
            value={searchQuery}
            onChange={setSearchQuery}
            placeholder="搜索邮箱、标签、来源或出口 IP..."
          />

          <div
            className="toolbar-meta"
            style={{ flexWrap: "wrap", gap: "8px" }}
          >
            <Select
              aria-label="按状态筛选"
              value={statusFilter}
              onChange={(e) => {
                const next = e.target.value as StatusFilter;
                setStatusFilter(next);
                if (next !== "attention") {
                  setAttentionCategoryFilter("all");
                }
              }}
            >
              <option value="all">全部状态 ({accounts.length})</option>
              <option value="ready">就绪 ({readyCount})</option>
              <option value="cooldown">冷却中 ({cooldownCount})</option>
              <option value="attention">需关注 ({attentionCount})</option>
            </Select>

            <Select
              aria-label="按等级筛选"
              value={tierFilter}
              onChange={(e) => setTierFilter(e.target.value as TierFilter)}
            >
              <option value="all">全部等级</option>
              <option value="pro_flagship">PRO ({proFlagshipCount})</option>
              <option value="pro_special">PRO(特价) ({proSpecialCount})</option>
              <option value="standard">普通 ({standardCount})</option>
            </Select>

            <Select
              aria-label="按出口筛选"
              value={exitOptions.some((opt) => opt.value === exitFilter) ? exitFilter : ""}
              onChange={(e) => setExitFilter(e.target.value)}
            >
              <option value="">全部出口</option>
              {exitOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </Select>

            <span>
              显示 {filteredAccounts.length} / {accounts.length}
            </span>

            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                padding: "2px",
                borderRadius: "8px",
                border: "1px solid var(--line)",
                background: "rgba(255, 255, 255, 0.7)",
                gap: "2px",
                marginLeft: "4px",
              }}
              role="radiogroup"
              aria-label="视图模式"
            >
              <button
                type="button"
                role="radio"
                aria-checked={viewMode === "card"}
                onClick={() => handleSetViewMode("card")}
                title="卡片视图"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "4px",
                  height: "24px",
                  padding: "0 8px",
                  fontSize: "12px",
                  borderRadius: "6px",
                  border: "none",
                  cursor: "pointer",
                  background: viewMode === "card" ? "var(--pink-500)" : "transparent",
                  color: viewMode === "card" ? "#fff" : "var(--ink-soft)",
                  fontWeight: viewMode === "card" ? 600 : 500,
                  transition: "all 0.15s ease",
                }}
              >
                <LayoutGrid size={13} />
                <span>卡片</span>
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={viewMode === "table"}
                onClick={() => handleSetViewMode("table")}
                title="表格视图"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "4px",
                  height: "24px",
                  padding: "0 8px",
                  fontSize: "12px",
                  borderRadius: "6px",
                  border: "none",
                  cursor: "pointer",
                  background: viewMode === "table" ? "var(--pink-500)" : "transparent",
                  color: viewMode === "table" ? "#fff" : "var(--ink-soft)",
                  fontWeight: viewMode === "table" ? 600 : 500,
                  transition: "all 0.15s ease",
                }}
              >
                <List size={13} />
                <span>表格</span>
              </button>
            </div>
          </div>
        </div>

        {statusFilter === "attention" && attentionCount > 0 && (
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: "6px",
              padding: "8px 18px 10px",
              borderTop: "1px dashed var(--line)",
              background: "var(--cream)",
            }}
          >
            <button
              type="button"
              onClick={() => setAttentionCategoryFilter("all")}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "4px",
                padding: "4px 10px",
                borderRadius: "var(--pill)",
                border:
                  attentionCategoryFilter === "all"
                    ? "1px solid var(--pink-500)"
                    : "1px solid var(--line)",
                background:
                  attentionCategoryFilter === "all"
                    ? "var(--pink-500)"
                    : "var(--surface)",
                color:
                  attentionCategoryFilter === "all" ? "#fff" : "var(--ink-soft)",
                fontSize: "11.5px",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              全部需关注 ({attentionCount})
            </button>
            {ATTENTION_CATEGORY_ORDER.map((cat) => {
              const count = attentionCategoryCounts.get(cat) ?? 0;
              if (count === 0) return null;
              const active = attentionCategoryFilter === cat;
              return (
                <button
                  key={cat}
                  type="button"
                  onClick={() => setAttentionCategoryFilter(cat)}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "4px",
                    padding: "4px 10px",
                    borderRadius: "var(--pill)",
                    border: active
                      ? "1px solid var(--pink-500)"
                      : "1px solid var(--line)",
                    background: active ? "var(--pink-50)" : "var(--surface)",
                    color: active ? "var(--pink-700)" : "var(--ink-soft)",
                    fontSize: "11.5px",
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  {ATTENTION_CATEGORY_LABELS[cat]} ({count})
                </button>
              );
            })}
          </div>
        )}

        {selectedCount > 0 && (
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "10px",
              padding: "10px 18px",
              borderTop: "1px dashed var(--line)",
              background: "var(--pink-50)",
            }}
          >
            <span
              style={{
                fontSize: "12.5px",
                fontWeight: 700,
                color: "var(--pink-700)",
              }}
            >
              已选中 {selectedCount} 个账号
            </span>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
              <Button
                className="small-button"
                disabled={batchBlocked}
                onClick={() => void handleBatchAction("enable")}
              >
                批量启用
              </Button>
              <Button
                className="small-button"
                disabled={batchBlocked}
                onClick={() => void handleBatchAction("disable")}
              >
                批量停用
              </Button>
              <Button
                className="small-button"
                disabled={batchBlocked}
                onClick={() => void handleBatchAction("refresh")}
              >
                <RefreshCw size={15} className={batchRefreshSpinning ? "spin" : undefined} />
                批量刷新
              </Button>
              <Button
                className="small-button danger"
                disabled={batchBlocked}
                onClick={() => {
                  setDeleteError("");
                  setConfirmBatchDelete(true);
                }}
              >
                批量删除
              </Button>
            </div>
          </div>
        )}

        {filteredAccounts.length === 0 ? (
          <Empty
            title={accounts.length === 0 ? "还没有 ACP 账号" : "没有匹配的账号"}
            detail={
              accounts.length === 0
                ? "可导入本地凭据、扫描 Chrome 授权或手动创建账号。"
                : "尝试调整搜索关键词或状态、等级、出口筛选条件。"
            }
            action={
              hasFilters ? (
                <Button
                  onClick={() => {
                    setSearchQuery("");
                    setStatusFilter("all");
                    setAttentionCategoryFilter("all");
                    setTierFilter("all");
                    setExitFilter("");
                  }}
                >
                  重置筛选
                </Button>
              ) : (
                <Button
                  className="primary"
                  onClick={() => setEditingModal("new")}
                >
                  <Plus size={15} />
                  新建账号
                </Button>
              )
            }
          />
        ) : viewMode === "card" ? (
          <div
            className="acp-accounts-card-grid"
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(330px, 1fr))",
              gap: "12px",
              padding: "14px 18px",
            }}
          >
            {filteredAccounts.map((acc) => {
              const rowAction = actions.rows.get(acc.id);
              const rowBusy = globalBusy || rowAction !== undefined;
              const quotaBusy = rowAction === "quota" || (refreshingQuotas && acc.status !== "disabled");
              const cds = cooldownsByAccount.get(acc.id) ?? [];
              const statusMeta = statusBadgeMeta(acc.status);
              const attentionInfo = isAttentionAccount(acc)
                ? resolveAttentionInfo(acc)
                : null;
              const isPro = acc.tier === "pro";
              const tierBucket = getAccountTierBucket(acc);
              const isSelected = selectedIds.has(acc.id);

              return (
                <div
                  key={acc.id}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "10px",
                    padding: "12px 14px",
                    borderRadius: "10px",
                    border: isSelected
                      ? "1.5px solid var(--pink-400)"
                      : "1px solid rgba(26, 26, 26, 0.08)",
                    background: isSelected
                      ? "rgba(253, 242, 248, 0.75)"
                      : "rgba(255, 255, 255, 0.92)",
                    boxShadow: isSelected
                      ? "0 2px 8px rgba(236, 72, 153, 0.15)"
                      : "0 1px 3px rgba(0, 0, 0, 0.03)",
                    transition: "border-color 0.15s ease, background 0.15s ease",
                  }}
                >
                  {/* 1. 头部：复选框 + 邮箱/标签 + 验证时间与轻量复制 */}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: "8px",
                    }}
                  >
                    <label
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "8px",
                        minWidth: 0,
                        cursor: "pointer",
                        flex: "1 1 0%",
                      }}
                    >
                      <input
                        type="checkbox"
                        aria-label={`选择 ${acc.email || acc.label}`}
                        checked={isSelected}
                        onChange={() => toggleSelect(acc.id)}
                        style={{
                          width: "16px",
                          height: "16px",
                          cursor: "pointer",
                          accentColor: "var(--pink-500)",
                          flexShrink: 0,
                        }}
                      />
                      <strong
                        className="mono"
                        title={acc.email || acc.label}
                        style={{
                          fontSize: "13px",
                          fontWeight: 700,
                          color: "var(--ink)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {acc.email || acc.label}
                      </strong>
                    </label>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "4px",
                        flexShrink: 0,
                      }}
                    >
                      {acc.lastVerifiedAt ? (
                        <span
                          className="cell-secondary"
                          style={{ fontSize: "11px", color: "var(--ink-soft)" }}
                          title={`上次验证：${formatTime(acc.lastVerifiedAt)}`}
                        >
                          {formatTime(acc.lastVerifiedAt)}
                        </span>
                      ) : null}
                      <IconButton
                        title="复制邮箱"
                        onClick={(e) => {
                          e.stopPropagation();
                          const text = acc.email || acc.label;
                          if (text) {
                            navigator.clipboard?.writeText(text);
                            notify("已复制邮箱到剪贴板", "success");
                          }
                        }}
                        style={{
                          width: "22px",
                          height: "22px",
                          padding: 0,
                          borderRadius: "4px",
                        }}
                      >
                        <Copy size={12} />
                      </IconButton>
                    </div>
                  </div>

                  {/* 2. 标签行：PRO/普通、refresh-token、状态、并发、出口、冷却 */}
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      alignItems: "center",
                      gap: "5px",
                    }}
                  >
                    <button
                      type="button"
                      disabled={rowBusy}
                      onClick={() => void handleToggleTier(acc)}
                      title={
                        isPro
                          ? "Pro 账号，点击切换为普通账号"
                          : "普通账号，点击切换为 Pro 账号"
                      }
                      aria-label={`${acc.email || acc.label}：${isPro ? "Pro" : "普通"}`}
                      style={{
                        padding: 0,
                        border: 0,
                        background: "transparent",
                        cursor: rowBusy ? "not-allowed" : "pointer",
                      }}
                    >
                      {renderTierBadge(tierBucket)}
                    </button>

                    {attentionInfo ? (
                      <>
                        {attentionInfo.isDisabled && (
                          <Badge variant="neutral">已停用</Badge>
                        )}
                        {(!attentionInfo.isDisabled ||
                          attentionInfo.category !== "manual_disabled") && (
                          <Badge
                            variant={
                              attentionInfo.tone === "danger"
                                ? "red"
                                : attentionInfo.tone === "warning"
                                  ? "amber"
                                  : "neutral"
                            }
                            dot
                          >
                            {attentionInfo.label}
                          </Badge>
                        )}
                      </>
                    ) : (
                      <Badge variant={statusMeta.variant} dot={statusMeta.dot}>
                        {statusMeta.label}
                      </Badge>
                    )}

                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        padding: "2px 6px",
                        borderRadius: "4px",
                        fontSize: "10.5px",
                        fontFamily: "var(--font-mono)",
                        background: "rgba(26, 26, 26, 0.05)",
                        color: "var(--ink-soft)",
                        lineHeight: 1,
                      }}
                      title={`并发使用量：当前 ${acc.activeWorkers} / 上限 ${acc.concurrencyLimit}`}
                    >
                      并发 {acc.activeWorkers}/{acc.concurrencyLimit}
                    </span>

                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "3px",
                        padding: "2px 6px",
                        borderRadius: "4px",
                        fontSize: "10.5px",
                        fontFamily: "var(--font-mono)",
                        background: "rgba(26, 26, 26, 0.05)",
                        color: "var(--ink-soft)",
                        lineHeight: 1,
                        maxWidth: "180px",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                      title={acc.proxyUrl ? `代理出口: ${acc.exitIp || "未知"} | 上游: ${acc.proxyUrl}` : `出口: ${acc.exitIp || "未知"}`}
                    >
                      <Globe size={10} style={{ flexShrink: 0 }} />
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {acc.exitIp || "未知"}{acc.exitCountry ? ` (${acc.exitCountry})` : ""}
                      </span>
                    </span>

                    {cds.map((cd) => (
                      <button
                        key={`${cd.accountId}-${cd.family}-${cd.scopeType}`}
                        type="button"
                        onClick={() =>
                          void handleClearCooldown(
                            acc.id,
                            `${cd.family}:${cd.scopeType || "family"}`
                          )
                        }
                        title={`点击清除冷却：${cd.reason || cd.family}`}
                        style={{
                          padding: 0,
                          border: 0,
                          background: "transparent",
                          cursor: "pointer",
                        }}
                      >
                        <Badge variant="amber">
                          <span className="mono">
                            {cd.family} {formatCooldownRemaining(cd.untilMs)}
                          </span>
                          <X size={10} style={{ marginLeft: "2px" }} />
                        </Badge>
                      </button>
                    ))}
                  </div>

                  {attentionInfo &&
                    (acc.statusReason ||
                      attentionInfo.category !== "manual_disabled") && (
                      <div
                        role="button"
                        tabIndex={0}
                        onClick={() => setErrorModalAccount(acc)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            setErrorModalAccount(acc);
                          }
                        }}
                        title={
                          attentionInfo.parsedMessage ||
                          acc.statusReason ||
                          attentionInfo.summary
                        }
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: "8px",
                          padding: "5px 8px",
                          borderRadius: "6px",
                          background:
                            attentionInfo.tone === "danger"
                              ? "var(--rose-bg)"
                              : attentionInfo.tone === "warning"
                                ? "var(--amber-bg)"
                                : "var(--pnl-soft)",
                          border:
                            attentionInfo.tone === "danger"
                              ? "1px solid rgba(180, 95, 80, 0.22)"
                              : attentionInfo.tone === "warning"
                                ? "1px solid var(--honey-200)"
                                : "1px solid var(--line)",
                          cursor: "pointer",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "5px",
                            minWidth: 0,
                            flex: "1 1 0%",
                            fontSize: "11px",
                            fontWeight: 600,
                            color:
                              attentionInfo.tone === "danger"
                                ? "var(--rose)"
                                : attentionInfo.tone === "warning"
                                  ? "var(--amber)"
                                  : "var(--ink-soft)",
                          }}
                        >
                          <AlertTriangle size={12} style={{ flexShrink: 0 }} />
                          <span
                            style={{
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {attentionInfo.parsedMessage ||
                              attentionInfo.summary}
                          </span>
                        </div>
                        <button
                          type="button"
                          disabled={rowBusy}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleQuickAttentionAction(acc, attentionInfo);
                          }}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "3px",
                            flexShrink: 0,
                            padding: "2px 7px",
                            borderRadius: "4px",
                            border: "1px solid rgba(26, 26, 26, 0.12)",
                            background: "rgba(255, 255, 255, 0.88)",
                            color: "var(--ink)",
                            fontSize: "10.5px",
                            fontWeight: 600,
                            cursor: rowBusy ? "not-allowed" : "pointer",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {attentionInfo.actionKind === "external_url" && (
                            <ExternalLink size={10} />
                          )}
                          {attentionInfo.actionLabel}
                        </button>
                      </div>
                    )}

                  {/* 3. 三号池配额区 */}
                  <div style={{ width: "100%" }}>
                    <AcpQuotaCell quota={acc.quota} now={now} fillWidth />
                  </div>

                  {/* 4. 底部操作区：紧凑水平一排，绝对不竖排 */}
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns:
                        acc.status === "auth_required" || acc.status === "restricted"
                          ? "repeat(6, 1fr)"
                          : "repeat(5, 1fr)",
                      gap: "6px",
                      marginTop: "auto",
                      paddingTop: "8px",
                      borderTop: "1px dashed rgba(26, 26, 26, 0.08)",
                    }}
                  >
                    {(acc.status === "auth_required" || acc.status === "restricted") && (
                      <button
                        type="button"
                        disabled={rowBusy}
                        onClick={() => void handleLogin(acc)}
                        title="CLI 登录"
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                          gap: "3px",
                          height: "26px",
                          padding: "0 4px",
                          fontSize: "11px",
                          fontWeight: 500,
                          borderRadius: "5px",
                          border: "1px solid rgba(26, 26, 26, 0.1)",
                          background: "rgba(255, 255, 255, 0.8)",
                          color: "var(--ink)",
                          cursor: rowBusy ? "not-allowed" : "pointer",
                          opacity: rowBusy ? 0.6 : 1,
                          whiteSpace: "nowrap",
                        }}
                      >
                        <KeyRound size={12} />
                        <span>登录</span>
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={rowBusy}
                      aria-busy={quotaBusy}
                      onClick={() => void handleRefreshAccountQuota(acc)}
                      title="刷新剩余用量"
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: "3px",
                        height: "26px",
                        padding: "0 4px",
                        fontSize: "11px",
                        fontWeight: 500,
                        borderRadius: "5px",
                        border: "1px solid rgba(26, 26, 26, 0.1)",
                        background: "rgba(255, 255, 255, 0.8)",
                        color: "var(--ink)",
                        cursor: rowBusy ? "not-allowed" : "pointer",
                        opacity: rowBusy ? 0.6 : 1,
                        whiteSpace: "nowrap",
                      }}
                    >
                      <MinSpinGaugeIcon active={quotaBusy} size={12} />
                      <span>用量</span>
                    </button>
                    <button
                      type="button"
                      disabled={rowBusy}
                      onClick={() => void handleRefreshOne(acc)}
                      title="刷新账号"
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: "3px",
                        height: "26px",
                        padding: "0 4px",
                        fontSize: "11px",
                        fontWeight: 500,
                        borderRadius: "5px",
                        border: "1px solid rgba(26, 26, 26, 0.1)",
                        background: "rgba(255, 255, 255, 0.8)",
                        color: "var(--ink)",
                        cursor: rowBusy ? "not-allowed" : "pointer",
                        opacity: rowBusy ? 0.6 : 1,
                        whiteSpace: "nowrap",
                      }}
                    >
                      <MinSpinRefreshIcon active={rowAction === "account"} size={12} />
                      <span>刷新</span>
                    </button>
                    <button
                      type="button"
                      disabled={rowBusy}
                      onClick={() => setEditingModal(acc)}
                      title="编辑账号"
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: "3px",
                        height: "26px",
                        padding: "0 4px",
                        fontSize: "11px",
                        fontWeight: 500,
                        borderRadius: "5px",
                        border: "1px solid rgba(26, 26, 26, 0.1)",
                        background: "rgba(255, 255, 255, 0.8)",
                        color: "var(--ink)",
                        cursor: rowBusy ? "not-allowed" : "pointer",
                        opacity: rowBusy ? 0.6 : 1,
                        whiteSpace: "nowrap",
                      }}
                    >
                      <Pencil size={12} />
                      <span>编辑</span>
                    </button>
                    <button
                      type="button"
                      disabled={rowBusy}
                      onClick={() => void handleToggleDisable(acc)}
                      title={acc.status === "disabled" ? "启用账号" : "停用账号"}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: "3px",
                        height: "26px",
                        padding: "0 4px",
                        fontSize: "11px",
                        fontWeight: 500,
                        borderRadius: "5px",
                        border: "1px solid rgba(26, 26, 26, 0.1)",
                        background: "rgba(255, 255, 255, 0.8)",
                        color: "var(--ink)",
                        cursor: rowBusy ? "not-allowed" : "pointer",
                        opacity: rowBusy ? 0.6 : 1,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {acc.status === "disabled" ? <Play size={12} /> : <Pause size={12} />}
                      <span>{acc.status === "disabled" ? "启用" : "停用"}</span>
                    </button>
                    <button
                      type="button"
                      disabled={rowBusy}
                      onClick={() => {
                        setDeleteError("");
                        setDeletingAccount(acc);
                      }}
                      title="删除账号"
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: "3px",
                        height: "26px",
                        padding: "0 4px",
                        fontSize: "11px",
                        fontWeight: 500,
                        borderRadius: "5px",
                        border: "1px solid rgba(244, 63, 94, 0.25)",
                        background: "rgba(255, 241, 242, 0.6)",
                        color: "#e11d48",
                        cursor: rowBusy ? "not-allowed" : "pointer",
                        opacity: rowBusy ? 0.6 : 1,
                        whiteSpace: "nowrap",
                      }}
                    >
                      <Trash2 size={12} />
                      <span>删除</span>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="table-scroll">
            <table className="acp-accounts-table" role="table" aria-label="ACP 账号与风控">
              <thead>
                <tr>
                  <th style={{ width: 42 }}>
                    <input
                      type="checkbox"
                      aria-label="全选当前列表账号"
                      checked={allFilteredSelected}
                      onChange={toggleSelectAll}
                      style={{
                        width: "16px",
                        height: "16px",
                        cursor: "pointer",
                        accentColor: "var(--pink-500)",
                      }}
                    />
                  </th>
                  <th>账号 / 邮箱</th>
                  <th>等级</th>
                  <th>剩余用量</th>
                  <th>状态与冷却</th>
                  <th>并发</th>
                  <th>代理出口</th>
                  <th className="action-cell" style={{ minWidth: 160 }}>操作</th>
                </tr>
              </thead>
              <tbody role="rowgroup">
                {filteredAccounts.map((acc) => {
                  const rowAction = actions.rows.get(acc.id);
                  const rowBusy = globalBusy || rowAction !== undefined;
                  const quotaBusy = rowAction === "quota" || (refreshingQuotas && acc.status !== "disabled");
                  const cds = cooldownsByAccount.get(acc.id) ?? [];
                  const statusMeta = statusBadgeMeta(acc.status);
                  const attentionInfo = isAttentionAccount(acc)
                    ? resolveAttentionInfo(acc)
                    : null;
                  const isPro = acc.tier === "pro";
                  const tierBucket = getAccountTierBucket(acc);

                  return (
                    <tr key={acc.id} role="row">
                      <td className="acp-account-select" role="cell">
                        <input
                          type="checkbox"
                          aria-label={`选择 ${acc.email || acc.label}`}
                          checked={selectedIds.has(acc.id)}
                          onChange={() => toggleSelect(acc.id)}
                          style={{
                            width: "16px",
                            height: "16px",
                            cursor: "pointer",
                            accentColor: "var(--pink-500)",
                          }}
                        />
                      </td>

                      <td className="acp-account-identity" role="cell">
                        <div className="entity-cell">
                          <div style={{ minWidth: 0 }}>
                            <div
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: "8px",
                                flexWrap: "wrap",
                              }}
                            >
                              <strong className="mono" title={acc.email || acc.label}>
                                {acc.email || acc.label}
                              </strong>
                            </div>
                            <span className="cell-secondary">
                              {acc.email && acc.label && acc.email !== acc.label
                                ? `${acc.label} · `
                                : ""}
                              验证 {formatTime(acc.lastVerifiedAt)}
                            </span>
                          </div>
                        </div>
                      </td>

                      <td className="acp-account-tier" role="cell">
                        <button
                          type="button"
                          disabled={rowBusy}
                          onClick={() => void handleToggleTier(acc)}
                          title={
                            isPro
                              ? "Pro 账号，点击切换为普通账号"
                              : "普通账号，点击切换为 Pro 账号"
                          }
                          aria-label={`${acc.email || acc.label}：${
                            isPro
                              ? "Pro，点击切换为普通账号"
                              : "普通，点击切换为 Pro 账号"
                          }`}
                          style={{
                            padding: 0,
                            border: 0,
                            background: "transparent",
                            cursor: rowBusy ? "not-allowed" : "pointer",
                          }}
                        >
                          {renderTierBadge(tierBucket)}
                        </button>
                      </td>

                      <td className="acp-account-quota" role="cell">
                        <AcpQuotaCell quota={acc.quota} now={now} />
                      </td>

                      <td className="acp-account-status" role="cell">
                        <div
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            alignItems: "flex-start",
                            gap: "5px",
                          }}
                        >
                          <div
                            style={{
                              display: "flex",
                              flexWrap: "wrap",
                              alignItems: "center",
                              gap: "5px",
                            }}
                          >
                            {attentionInfo ? (
                              <>
                                {attentionInfo.isDisabled && (
                                  <Badge variant="neutral">已停用</Badge>
                                )}
                                {(!attentionInfo.isDisabled ||
                                  attentionInfo.category !==
                                    "manual_disabled") && (
                                  <Badge
                                    variant={
                                      attentionInfo.tone === "danger"
                                        ? "red"
                                        : attentionInfo.tone === "warning"
                                          ? "amber"
                                          : "neutral"
                                    }
                                    dot
                                  >
                                    {attentionInfo.label}
                                  </Badge>
                                )}
                              </>
                            ) : (
                              <Badge
                                variant={statusMeta.variant}
                                dot={statusMeta.dot}
                              >
                                {statusMeta.label}
                              </Badge>
                            )}
                            {cds.map((cd) => (
                              <button
                                key={`${cd.accountId}-${cd.family}-${cd.scopeType}`}
                                type="button"
                                onClick={() =>
                                  void handleClearCooldown(
                                    acc.id,
                                    `${cd.family}:${cd.scopeType || "family"}`
                                  )
                                }
                                title={`点击清除冷却：${cd.reason || cd.family}`}
                                style={{
                                  padding: 0,
                                  border: 0,
                                  background: "transparent",
                                  cursor: "pointer",
                                }}
                              >
                                <Badge variant="amber">
                                  <span className="mono">
                                    {cd.family}{" "}
                                    {formatCooldownRemaining(cd.untilMs)}
                                  </span>
                                  <X size={11} />
                                </Badge>
                              </button>
                            ))}
                          </div>
                          {attentionInfo &&
                            (acc.statusReason ||
                              attentionInfo.category !== "manual_disabled") && (
                              <div
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: "6px",
                                  maxWidth: "280px",
                                }}
                              >
                                <button
                                  type="button"
                                  onClick={() => setErrorModalAccount(acc)}
                                  title={
                                    attentionInfo.parsedMessage ||
                                    acc.statusReason ||
                                    attentionInfo.summary
                                  }
                                  style={{
                                    padding: 0,
                                    border: 0,
                                    background: "transparent",
                                    color:
                                      attentionInfo.tone === "danger"
                                        ? "var(--rose)"
                                        : attentionInfo.tone === "warning"
                                          ? "var(--amber)"
                                          : "var(--ink-soft)",
                                    fontSize: "11px",
                                    fontWeight: 600,
                                    textAlign: "left",
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    whiteSpace: "nowrap",
                                    cursor: "pointer",
                                    textDecoration: "underline",
                                  }}
                                >
                                  {attentionInfo.parsedMessage ||
                                    attentionInfo.summary}
                                </button>
                                <button
                                  type="button"
                                  disabled={rowBusy}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleQuickAttentionAction(
                                      acc,
                                      attentionInfo
                                    );
                                  }}
                                  style={{
                                    flexShrink: 0,
                                    padding: "1px 6px",
                                    borderRadius: "4px",
                                    border: "1px solid var(--line)",
                                    background: "var(--surface)",
                                    color: "var(--ink)",
                                    fontSize: "10.5px",
                                    fontWeight: 600,
                                    cursor: rowBusy ? "not-allowed" : "pointer",
                                    whiteSpace: "nowrap",
                                  }}
                                >
                                  {attentionInfo.actionLabel}
                                </button>
                              </div>
                            )}
                        </div>
                      </td>

                      <td className="acp-account-load" role="cell">
                        <span className="acp-account-field-label">并发 </span>
                        <span className="mono">{acc.activeWorkers}/{acc.concurrencyLimit}</span>
                      </td>

                      <td className="acp-account-exit" role="cell">
                        <div>
                          <span className="acp-account-field-label">出口 </span>
                          <span className="mono">
                            {acc.exitIp || "未知"}
                            {acc.exitCountry ? ` (${acc.exitCountry})` : ""}
                          </span>
                          {acc.proxyUrl && (
                            <span className="cell-secondary mono">
                              代理 {acc.proxyUrl}
                            </span>
                          )}
                        </div>
                      </td>

                      <td className="action-cell acp-account-actions" role="cell" style={{ minWidth: 160 }}>
                        <div
                          className="row-actions"
                          style={{
                            display: "flex",
                            flexWrap: "nowrap",
                            alignItems: "center",
                            justifyContent: "flex-end",
                            gap: "4px",
                          }}
                        >
                          {(acc.status === "auth_required" ||
                            acc.status === "restricted") && (
                            <Button
                              className="small-button"
                              disabled={rowBusy}
                              onClick={() => void handleLogin(acc)}
                            >
                              CLI 登录
                            </Button>
                          )}
                          <IconButton
                            title="刷新剩余用量"
                            aria-label={`刷新 ${acc.email || acc.label} 剩余用量`}
                            aria-busy={quotaBusy}
                            disabled={rowBusy}
                            onClick={() => void handleRefreshAccountQuota(acc)}
                          >
                            <MinSpinGaugeIcon active={quotaBusy} size={15} />
                          </IconButton>
                          <IconButton
                            title="刷新"
                            disabled={rowBusy}
                            onClick={() => void handleRefreshOne(acc)}
                          >
                            <MinSpinRefreshIcon active={rowAction === "account"} size={15} />
                          </IconButton>
                          <IconButton
                            title="编辑"
                            disabled={rowBusy}
                            onClick={() => setEditingModal(acc)}
                          >
                            <Pencil size={15} />
                          </IconButton>
                          <IconButton
                            title={acc.status === "disabled" ? "启用" : "停用"}
                            disabled={rowBusy}
                            onClick={() => void handleToggleDisable(acc)}
                          >
                            {acc.status === "disabled" ? (
                              <Play size={15} />
                            ) : (
                              <Pause size={15} />
                            )}
                          </IconButton>
                          <IconButton
                            title="删除"
                            className="destructive"
                            disabled={rowBusy}
                            onClick={() => {
                              setDeleteError("");
                              setDeletingAccount(acc);
                            }}
                          >
                            <Trash2 size={15} />
                          </IconButton>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="table-footer">
          <span>
            {filteredAccounts.length === accounts.length
              ? `共 ${accounts.length} 个账号`
              : `筛选到 ${filteredAccounts.length} / ${accounts.length} 个账号`}
          </span>
          <span>
            PRO {proFlagshipCount} · PRO(特价) {proSpecialCount} · 普通 {standardCount}
          </span>
        </div>
      </section>

      {activeErrorModalAccount && (
        <AcpAccountErrorModal
          account={activeErrorModalAccount}
          busy={
            globalBusy || actions.rows.has(activeErrorModalAccount.id)
          }
          onClose={() => setErrorModalAccount(null)}
          onRelogin={handleLogin}
          onToggleDisable={handleToggleDisable}
          onRefresh={handleRefreshOne}
          onOpenUrl={handleOpenAccountUrl}
          notify={notify}
        />
      )}

      {editingModal !== null && (
        <AccountEditModal
          account={editingModal === "new" ? null : editingModal}
          onClose={() => setEditingModal(null)}
          onSaved={onRefresh}
          notify={notify}
        />
      )}

      {showTokenModal && (
        <BatchTokenImportModal
          onClose={() => setShowTokenModal(false)}
          onImported={onRefresh}
          notify={notify}
        />
      )}

      {showChromeModal && (
        <ChromeScanModal
          onClose={() => setShowChromeModal(false)}
          onAuthorized={onRefresh}
          notify={notify}
        />
      )}

      {showProxyModal && (
        <BatchProxyModal
          open={showProxyModal}
          totalCount={accounts.length}
          selectedIds={selectedIds}
          accounts={accounts}
          onClose={() => setShowProxyModal(false)}
          onDone={onRefresh}
          notify={notify}
        />
      )}

      {deletingAccount && (
        <Confirm
          title="删除账号"
          message={`确认删除“${
            deletingAccount.email || deletingAccount.label
          }”？此操作不可撤销，该账号将停止参与请求调度。`}
          busy={deleteBusy}
          error={deleteError}
          onClose={() => setDeletingAccount(null)}
          onConfirm={() => void confirmSingleDelete()}
        />
      )}

      {confirmBatchDelete && (
        <Confirm
          title="批量删除账号"
          message={`确认删除已选中的 ${selectedCount} 个账号？此操作不可撤销。`}
          busy={deleteBusy}
          error={deleteError}
          onClose={() => setConfirmBatchDelete(false)}
          onConfirm={() => void confirmBatchDeleteAction()}
        />
      )}
    </div>
  );
}
