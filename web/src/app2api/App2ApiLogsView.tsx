import { useEffect, useMemo, useState } from "react";
import type { MouseEvent } from "react";
import {
  Activity,
  AlertTriangle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  RefreshCw,
  ShieldAlert,
  Square,
  Trash2,
} from "lucide-react";
import { errorMessage, number as formatNumber, tokenCount } from "../api";
import { Badge, Button, Confirm, Empty, SearchInput, Select } from "../components";
import { useMinSpin } from "../useMinSpin";
import type {
  App2ApiAccount,
  App2ApiAuditRecord,
  App2ApiFailoverRecord,
  App2ApiOverview,
  App2ApiRequestAttempt,
  App2ApiRequestRecord,
} from "./types";
import type { App2ApiRefreshOptions } from "./useApp2ApiGateway";

export interface App2ApiLogsViewProps {
  requests: App2ApiRequestRecord[];
  overview: App2ApiOverview | null;
  accounts: App2ApiAccount[];
  sseConnected: boolean;
  onRefresh: (options?: App2ApiRefreshOptions) => Promise<void>;
  onCancelRequest: (id: string) => Promise<{ ok: boolean }>;
  onClearRequests: () => Promise<{ ok: boolean; cleared?: number }>;
  notify: (msg: string, kind?: "success" | "error") => void;
}

type LogViewTab = "requests" | "failovers" | "audit";

const QUICK_FILTERS = ["全部", "gemini-neon", "flash", "pro", "仅错误"] as const;
type QuickFilter = (typeof QUICK_FILTERS)[number];

const PAGE_SIZE_OPTIONS = [20, 50, 100] as const;

function toTimestamp(val?: string | number | null): number {
  if (typeof val === "number" && Number.isFinite(val)) return val;
  if (typeof val === "string" && val.trim()) {
    const asNum = Number(val);
    if (Number.isFinite(asNum) && asNum > 0) return asNum;
    const parsed = Date.parse(val);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
}

function formatTime(ts?: number | null): string {
  if (!ts || !Number.isFinite(ts)) return "—";
  return new Date(ts).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function formatDuration(ms?: number | null): string {
  if (ms === undefined || ms === null || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${formatNumber(Math.round(ms))} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  return `${(ms / 60_000).toFixed(2)} min`;
}

function shortId(id?: string | null): string {
  if (!id) return "—";
  return id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

function buildAccountMap(accounts: App2ApiAccount[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const acc of accounts) {
    if (!acc.id) continue;
    const display = acc.email?.trim() || acc.label?.trim() || acc.id;
    map.set(acc.id, display);
  }
  return map;
}

function resolveAccountName(
  accountLabel: string | null | undefined,
  accountId: string | null | undefined,
  accountMap: Map<string, string>
): string {
  if (accountLabel?.trim()) return accountLabel.trim();
  if (accountId?.trim()) {
    return accountMap.get(accountId) || shortId(accountId);
  }
  return "—";
}

function getReqId(row: App2ApiRequestRecord): string {
  return row.id || row.requestId || "";
}

function getStartedAt(row: App2ApiRequestRecord): number {
  return toTimestamp(row.startedAt ?? row.at ?? row.timestamp ?? row.createdAt);
}

function isErrorLog(row: App2ApiRequestRecord): boolean {
  if (row.state === "running" || row.state === "cancelled") return false;
  if (row.state === "failed") return true;
  if (row.ok === false) return true;
  if (typeof row.status === "number" && row.status >= 400) return true;
  if (row.errorCode || row.error) return true;
  return false;
}

function getRowTone(row: App2ApiRequestRecord): "green" | "amber" | "red" {
  if (isErrorLog(row)) return "red";
  if (row.state === "running" || row.state === "cancelled") return "amber";
  return "green";
}

function getStateMeta(row: App2ApiRequestRecord): {
  label: string;
  variant: "green" | "amber" | "red" | "neutral";
} {
  if (row.state === "running") {
    return { label: "进行中", variant: "amber" };
  }
  if (row.state === "cancelled") {
    return {
      label: row.status ? `${row.status} 已取消` : "已取消",
      variant: "amber",
    };
  }
  if (isErrorLog(row)) {
    return {
      label: row.status ? `${row.status} 失败` : "失败",
      variant: "red",
    };
  }
  return {
    label: row.status ? `${row.status} 成功` : "200 成功",
    variant: "green",
  };
}

function getAttemptStatusMeta(status: App2ApiRequestAttempt["status"]): {
  label: string;
  variant: "green" | "amber" | "red";
} {
  if (status === "success") return { label: "成功", variant: "green" };
  if (status === "running") return { label: "进行中", variant: "amber" };
  if (status === "cancelled") return { label: "已取消", variant: "amber" };
  return { label: "失败", variant: "red" };
}

function formatDiagnosticJson(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function Metric({
  label,
  value,
  tone = "neutral",
  title,
}: {
  label: string;
  value: string;
  tone?: "neutral" | "green" | "blue" | "amber" | "purple";
  title?: string;
}) {
  return (
    <span className={`log-metric log-metric-${tone}`} title={title}>
      <span>{label}</span>
      <strong>{value}</strong>
    </span>
  );
}

function AttemptItem({
  attempt,
  accountMap,
  fallbackModel,
  failureEvidence,
}: {
  attempt: App2ApiRequestAttempt;
  accountMap: Map<string, string>;
  fallbackModel?: string;
  failureEvidence?: unknown;
}) {
  const [showDiagnostic, setShowDiagnostic] = useState(false);
  const statusMeta = getAttemptStatusMeta(attempt.status);
  const accountDisplay = resolveAccountName(
    attempt.accountLabel,
    attempt.accountId,
    accountMap
  );
  const requestedModel = attempt.requestedModel?.trim() || fallbackModel || "—";
  const actualModel = attempt.actualModel?.trim();
  const hasDiagnostic = Boolean(attempt.rawError || failureEvidence);

  return (
    <li
      style={{
        padding: "10px 12px",
        border: "1px solid var(--line)",
        borderRadius: "var(--radius-sm)",
        background: "var(--surface)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: "8px 12px",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "6px 8px",
            minWidth: 0,
          }}
        >
          <span
            className="mono"
            style={{ fontSize: 12, fontWeight: 700, color: "var(--ink-soft)" }}
          >
            #{attempt.index + 1}
          </span>
          <span
            className="mono"
            style={{ fontSize: 12, fontWeight: 700, color: "var(--ink)" }}
            title={attempt.accountId || undefined}
          >
            {accountDisplay}
          </span>
          <Badge variant={statusMeta.variant} dot>
            {statusMeta.label}
            {attempt.httpStatus ? ` (${attempt.httpStatus})` : ""}
          </Badge>
          {attempt.failoverReason && (
            <Badge variant="amber">故障转移: {attempt.failoverReason}</Badge>
          )}
          {(attempt.reasonCode || attempt.reasonText) && (
            <span style={{ fontSize: 12, color: "var(--rose)" }}>
              {[attempt.reasonCode, attempt.reasonText].filter(Boolean).join(" · ")}
            </span>
          )}
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 11,
            color: "var(--muted)",
          }}
        >
          {typeof attempt.firstEventMs === "number" && (
            <span className="mono">首字 {formatDuration(attempt.firstEventMs)}</span>
          )}
          {typeof attempt.durationMs === "number" && (
            <span className="mono">耗时 {formatDuration(attempt.durationMs)}</span>
          )}
          {hasDiagnostic && (
            <button
              type="button"
              className="button"
              style={{ height: 26, padding: "0 10px", fontSize: 11 }}
              onClick={() => setShowDiagnostic((prev) => !prev)}
            >
              {showDiagnostic ? "收起诊断" : "原始报错 / 诊断证据"}
            </button>
          )}
        </div>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "6px 12px",
          marginTop: 7,
          fontSize: 11,
          color: "var(--muted)",
        }}
      >
        <span>
          请求模型{" "}
          <span className="mono" style={{ color: "var(--ink-soft)" }}>
            {requestedModel}
          </span>
        </span>
        {actualModel && (
          <span>
            实际模型{" "}
            <span className="mono" style={{ color: "var(--ink-soft)" }}>
              {actualModel}
            </span>
          </span>
        )}
        {attempt.startedAt > 0 && (
          <span className="mono">开始 {formatTime(attempt.startedAt)}</span>
        )}
      </div>

      {hasDiagnostic && showDiagnostic && (
        <div className="log-error-detail" style={{ marginTop: 10 }}>
          <strong>原始报错 / 诊断证据（Attempt #{attempt.index + 1}）</strong>
          {attempt.rawError && <pre>{attempt.rawError}</pre>}
          {failureEvidence !== undefined && failureEvidence !== null && (
            <pre>{formatDiagnosticJson(failureEvidence)}</pre>
          )}
        </div>
      )}
    </li>
  );
}

function App2ApiLogRow({
  row,
  expanded,
  onToggle,
  cancelling,
  onCancel,
  accountMap,
}: {
  row: App2ApiRequestRecord;
  expanded: boolean;
  onToggle: () => void;
  cancelling: boolean;
  onCancel: (id: string) => void;
  accountMap: Map<string, string>;
}) {
  const [showTopDiagnostic, setShowTopDiagnostic] = useState(false);
  const reqId = getReqId(row);
  const startedAt = getStartedAt(row);
  const tone = getRowTone(row);
  const stateMeta = getStateMeta(row);
  const attempts = Array.isArray(row.attempts) ? row.attempts : [];
  const lastAttempt = attempts[attempts.length - 1];

  const hitAccount = resolveAccountName(
    row.accountLabel ?? lastAttempt?.accountLabel,
    row.accountId ?? lastAttempt?.accountId,
    accountMap
  );

  const switchCount =
    typeof row.switchCount === "number"
      ? row.switchCount
      : Math.max(0, attempts.length - 1);

  const hasInputTokens =
    typeof row.inputTokens === "number" && Number.isFinite(row.inputTokens);
  const hasOutputTokens =
    typeof row.outputTokens === "number" && Number.isFinite(row.outputTokens);
  const hasCachedTokens =
    typeof row.cachedTokens === "number" && Number.isFinite(row.cachedTokens);
  const totalTokens =
    hasInputTokens || hasOutputTokens
      ? (row.inputTokens ?? 0) + (row.outputTokens ?? 0)
      : undefined;
  const hasCache = Boolean(row.cacheHit) || (row.cachedTokens ?? 0) > 0;
  const hasTokenMetrics =
    hasInputTokens || hasOutputTokens || hasCachedTokens || Boolean(row.cacheHit);

  const firstEventMs =
    typeof row.firstEventMs === "number"
      ? row.firstEventMs
      : lastAttempt?.firstEventMs ?? null;
  const hasFirstEvent =
    typeof firstEventMs === "number" && Number.isFinite(firstEventMs);
  const hasDuration =
    typeof row.durationMs === "number" && Number.isFinite(row.durationMs);
  const hasToolCalls =
    typeof row.toolCalls === "number" && row.toolCalls > 0;

  const routeLabel = [row.protocol, row.path].filter(Boolean).join(" · ");

  function handleStopClick(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (reqId) onCancel(reqId);
  }

  return (
    <li>
      <details
        className={`request-log-row request-log-${tone}`}
        open={expanded}
        onToggle={(event) => {
          if (event.currentTarget.open !== expanded) {
            onToggle();
          }
        }}
      >
        <summary className="request-log-summary">
          <span className="request-log-overview">
            <time
              className="log-time mono"
              dateTime={startedAt > 0 ? new Date(startedAt).toISOString() : undefined}
            >
              {formatTime(startedAt)}
            </time>
            <strong className="log-model" title={row.model || "未指定模型"}>
              {row.model || "未指定模型"}
            </strong>
            {routeLabel && <Badge>{routeLabel}</Badge>}
            <Badge>{row.stream ? "SSE 流式" : "非流式"}</Badge>
            <Badge variant={stateMeta.variant} dot>
              {stateMeta.label}
            </Badge>
            {switchCount > 0 && (
              <Badge variant="amber">换号 {formatNumber(switchCount)} 次</Badge>
            )}
            {hasCache && (
              <Badge variant="green">
                缓存命中
                {hasCachedTokens && (row.cachedTokens ?? 0) > 0
                  ? ` ${tokenCount(row.cachedTokens ?? 0)}`
                  : ""}
              </Badge>
            )}
            <span className="log-source" title={`命中账号：${hitAccount}`}>
              {hitAccount}
            </span>
            {row.state === "running" && reqId && (
              <button
                type="button"
                className="button danger"
                style={{ height: 24, padding: "0 9px", fontSize: 11 }}
                disabled={cancelling}
                onClick={handleStopClick}
              >
                <Square size={11} />
                {cancelling ? "停止中" : "停止"}
              </button>
            )}
            <ChevronDown className="log-expand-icon" size={15} aria-hidden="true" />
            <span className="visually-hidden">
              展开或收起 8049 请求 {reqId} 的详情
            </span>
          </span>

          {(hasTokenMetrics || hasFirstEvent || hasDuration || hasToolCalls) && (
            <span className="request-log-metrics">
              {hasTokenMetrics && (
                <span className="log-metric-group" aria-label="Token 用量与缓存">
                  {totalTokens !== undefined && (
                    <Metric
                      label="Token"
                      value={tokenCount(totalTokens)}
                      title={`合计 ${formatNumber(totalTokens)} Token`}
                    />
                  )}
                  {hasInputTokens && (
                    <Metric
                      label="输入"
                      value={tokenCount(row.inputTokens ?? 0)}
                      tone="green"
                    />
                  )}
                  {hasOutputTokens && (
                    <Metric
                      label="输出"
                      value={tokenCount(row.outputTokens ?? 0)}
                      tone="blue"
                    />
                  )}
                  {(hasCachedTokens || row.cacheHit) && (
                    <Metric
                      label="缓存"
                      value={
                        hasCachedTokens
                          ? tokenCount(row.cachedTokens ?? 0)
                          : "命中"
                      }
                      tone={hasCache ? "green" : "neutral"}
                    />
                  )}
                </span>
              )}
              {(hasFirstEvent || hasDuration || hasToolCalls) && (
                <span className="log-metric-group" aria-label="耗时与工具">
                  {hasFirstEvent && (
                    <Metric
                      label="首字"
                      value={formatDuration(firstEventMs)}
                      tone="purple"
                    />
                  )}
                  {hasDuration && (
                    <Metric label="总耗时" value={formatDuration(row.durationMs)} />
                  )}
                  {hasToolCalls && (
                    <Metric
                      label="工具"
                      value={formatNumber(row.toolCalls ?? 0)}
                      tone="amber"
                    />
                  )}
                </span>
              )}
            </span>
          )}
        </summary>

        <div className="request-log-detail">
          <dl className="log-detail-grid">
            <div>
              <dt>请求 ID</dt>
              <dd className="mono">{reqId || "—"}</dd>
            </div>
            <div>
              <dt>开始时间</dt>
              <dd>{formatTime(startedAt)}</dd>
            </div>
            <div>
              <dt>路径 / 协议</dt>
              <dd className="mono">
                {[row.method, row.path, row.protocol].filter(Boolean).join(" · ") || "—"}
              </dd>
            </div>
            <div>
              <dt>请求模型</dt>
              <dd className="mono">{row.model || "—"}</dd>
            </div>
            <div>
              <dt>命中账号</dt>
              <dd>
                {hitAccount}
                {row.accountId && hitAccount !== row.accountId && (
                  <span className="log-detail-id mono">{row.accountId}</span>
                )}
              </dd>
            </div>
            <div>
              <dt>传输 / 状态</dt>
              <dd>
                {row.stream ? "SSE 流式" : "非流式"} · {stateMeta.label}
                {row.continued ? " · 续接" : ""}
              </dd>
            </div>
            <div>
              <dt>换号次数</dt>
              <dd>
                {formatNumber(switchCount)} 次
                {typeof row.providerAttempts === "number"
                  ? `（总尝试 ${formatNumber(row.providerAttempts)} 次）`
                  : ""}
              </dd>
            </div>
            <div>
              <dt>Token 统计（输入 / 输出 / 缓存）</dt>
              <dd>
                {hasInputTokens ? formatNumber(row.inputTokens ?? 0) : "—"} /{" "}
                {hasOutputTokens ? formatNumber(row.outputTokens ?? 0) : "—"} /{" "}
                {hasCachedTokens ? formatNumber(row.cachedTokens ?? 0) : "—"}
              </dd>
            </div>
            <div>
              <dt>首字 / 总耗时</dt>
              <dd>
                {formatDuration(firstEventMs)} / {formatDuration(row.durationMs)}
              </dd>
            </div>
            <div>
              <dt>Prompt 字节 / 消息数 / 工具数</dt>
              <dd>
                {typeof row.promptBytes === "number"
                  ? `${formatNumber(row.promptBytes)} B`
                  : "—"}{" "}
                /{" "}
                {typeof row.inputMessages === "number"
                  ? `${formatNumber(row.inputMessages)} 条`
                  : "—"}{" "}
                /{" "}
                {typeof row.declaredTools === "number"
                  ? `${formatNumber(row.declaredTools)} 声明`
                  : "—"}
                {hasToolCalls ? ` · ${formatNumber(row.toolCalls ?? 0)} 次调用` : ""}
              </dd>
            </div>
            {(row.errorCode || row.error) && (
              <div>
                <dt>错误码 / 摘要</dt>
                <dd style={{ color: "var(--rose)" }}>
                  {[row.errorCode, row.error].filter(Boolean).join(" · ")}
                </dd>
              </div>
            )}
          </dl>

          {(row.error || row.nativeEvidence !== undefined) && (
            <div style={{ marginTop: 12 }}>
              <button
                type="button"
                className="button"
                style={{ height: 28, padding: "0 12px", fontSize: 11 }}
                onClick={() => setShowTopDiagnostic((prev) => !prev)}
              >
                {showTopDiagnostic ? "收起请求诊断证据" : "查看原始报错 / 诊断证据"}
              </button>
              {showTopDiagnostic && (
                <div className="log-error-detail" style={{ marginTop: 8 }}>
                  <strong>请求级报错与诊断证据</strong>
                  {row.error && <pre>{row.error}</pre>}
                  {row.nativeEvidence !== undefined && row.nativeEvidence !== null && (
                    <pre>{formatDiagnosticJson(row.nativeEvidence)}</pre>
                  )}
                </div>
              )}
            </div>
          )}

          <div style={{ marginTop: 16 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: 8,
              }}
            >
              <strong style={{ fontSize: 12, color: "var(--ink)" }}>
                重试与换号时间线（{attempts.length} 次尝试）
              </strong>
            </div>

            {attempts.length > 0 ? (
              <ol
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                  margin: 0,
                  padding: 0,
                  listStyle: "none",
                }}
              >
                {attempts.map((attempt, idx) => {
                  const matchedFailure = row.providerFailures?.[idx]?.nativeEvidence;
                  return (
                    <AttemptItem
                      key={`${reqId}-att-${attempt.index}`}
                      attempt={attempt}
                      accountMap={accountMap}
                      fallbackModel={row.model}
                      failureEvidence={matchedFailure}
                    />
                  );
                })}
              </ol>
            ) : (
              <p style={{ margin: 0, fontSize: 12, color: "var(--muted)" }}>
                暂无尝试明细
              </p>
            )}
          </div>
        </div>
      </details>
    </li>
  );
}

export function App2ApiLogsView({
  requests,
  overview,
  accounts,
  sseConnected,
  onRefresh,
  onCancelRequest,
  onClearRequests,
  notify,
}: App2ApiLogsViewProps) {
  const [view, setView] = useState<LogViewTab>("requests");
  const [searchQuery, setSearchQuery] = useState("");
  const [accountFilter, setAccountFilter] = useState("");
  const [quickFilter, setQuickFilter] = useState<QuickFilter>("全部");
  const [pageSize, setPageSize] = useState<number>(20);
  const [page, setPage] = useState(1);
  const [refreshing, setRefreshing] = useState(false);
  const refreshSpinning = useMinSpin(refreshing);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [cancellingIds, setCancellingIds] = useState<Set<string>>(() => new Set());
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearError, setClearError] = useState("");

  const effectiveRequests = useMemo(() => {
    if (requests.length > 0) return requests;
    return overview?.requests ?? [];
  }, [requests, overview?.requests]);

  const failovers = useMemo<App2ApiFailoverRecord[]>(
    () => overview?.failovers ?? [],
    [overview?.failovers]
  );

  const audits = useMemo<App2ApiAuditRecord[]>(
    () => overview?.audit ?? [],
    [overview?.audit]
  );

  const accountMap = useMemo(() => buildAccountMap(accounts), [accounts]);

  const runningCount = useMemo(
    () => effectiveRequests.filter((log) => log.state === "running").length,
    [effectiveRequests]
  );

  const errorCount = useMemo(
    () => effectiveRequests.filter(isErrorLog).length,
    [effectiveRequests]
  );

  const accountOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const acc of accounts) {
      if (!acc.id) continue;
      map.set(acc.id, acc.email?.trim() || acc.label?.trim() || acc.id);
    }
    for (const log of effectiveRequests) {
      if (log.accountId && !map.has(log.accountId)) {
        map.set(
          log.accountId,
          log.accountLabel?.trim() || shortId(log.accountId)
        );
      }
      for (const att of log.attempts ?? []) {
        if (att.accountId && !map.has(att.accountId)) {
          map.set(
            att.accountId,
            att.accountLabel?.trim() || shortId(att.accountId)
          );
        }
      }
    }
    return [...map.entries()]
      .map(([id, label]) => ({ id, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [accounts, effectiveRequests]);

  const filteredRequests = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return effectiveRequests.filter((log) => {
      if (accountFilter) {
        const hitTop = log.accountId === accountFilter;
        const hitAttempt = (log.attempts ?? []).some(
          (a) => a.accountId === accountFilter
        );
        if (!hitTop && !hitAttempt) return false;
      }
      if (quickFilter === "仅错误" && !isErrorLog(log)) {
        return false;
      }
      if (
        quickFilter !== "全部" &&
        quickFilter !== "仅错误" &&
        !(log.model ?? "").toLowerCase().includes(quickFilter)
      ) {
        return false;
      }
      if (!query) return true;
      const candidates = [
        log.model,
        log.id,
        log.requestId,
        log.path,
        log.protocol,
        log.accountLabel,
        log.accountId,
        log.accountId ? accountMap.get(log.accountId) : undefined,
        log.errorCode,
        log.error,
        ...(log.attempts ?? []).flatMap((a) => [
          a.accountLabel,
          a.accountId,
          a.accountId ? accountMap.get(a.accountId) : undefined,
          a.reasonCode,
          a.reasonText,
          a.failoverReason,
        ]),
      ];
      return candidates.some((text) => text?.toLowerCase().includes(query));
    });
  }, [effectiveRequests, accountFilter, quickFilter, searchQuery, accountMap]);

  const filteredFailovers = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const sorted = [...failovers].sort(
      (a, b) =>
        toTimestamp(b.timestamp ?? b.createdAt) -
        toTimestamp(a.timestamp ?? a.createdAt)
    );
    if (!query) return sorted;
    return sorted.filter((item) =>
      [
        item.model,
        item.fromAccountId,
        item.fromAccountId ? accountMap.get(item.fromAccountId) : undefined,
        item.toAccountId,
        item.toAccountId ? accountMap.get(item.toAccountId) : undefined,
        item.reason,
        item.status !== undefined ? String(item.status) : undefined,
      ].some((text) => text?.toLowerCase().includes(query))
    );
  }, [failovers, searchQuery, accountMap]);

  const filteredAudits = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const sorted = [...audits].sort(
      (a, b) =>
        toTimestamp(b.timestamp ?? b.createdAt) -
        toTimestamp(a.timestamp ?? a.createdAt)
    );
    if (!query) return sorted;
    return sorted.filter((item) =>
      [item.action, item.actor, item.target, item.detail].some((text) =>
        text?.toLowerCase().includes(query)
      )
    );
  }, [audits, searchQuery]);

  const totalPages = Math.max(1, Math.ceil(filteredRequests.length / pageSize));
  const safePage = Math.min(page, totalPages);

  useEffect(() => {
    setPage(1);
  }, [searchQuery, accountFilter, quickFilter, pageSize]);

  useEffect(() => {
    if (page > totalPages) {
      setPage(totalPages);
    }
  }, [page, totalPages]);

  const pagedRequests = useMemo(() => {
    const start = (safePage - 1) * pageSize;
    return filteredRequests.slice(start, start + pageSize);
  }, [filteredRequests, safePage, pageSize]);

  const pageStart =
    filteredRequests.length > 0 ? (safePage - 1) * pageSize + 1 : 0;
  const pageEnd = Math.min(safePage * pageSize, filteredRequests.length);

  function toggleRow(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleRefresh() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await onRefresh({
        onComplete: ({ ok, error }) => {
          if (ok) {
            notify("已刷新 8049 实时日志", "success");
          } else {
            notify(error || "刷新 8049 实时日志失败", "error");
          }
        },
      });
    } catch (err) {
      notify(errorMessage(err) || "刷新 8049 实时日志失败", "error");
    } finally {
      setRefreshing(false);
    }
  }

  async function handleCancel(id: string) {
    setCancellingIds((prev) => new Set(prev).add(id));
    try {
      await onCancelRequest(id);
      notify("已发送停止请求", "success");
    } catch (err) {
      notify(errorMessage(err) || "停止请求失败", "error");
    } finally {
      setCancellingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  function handleExportJson() {
    const payload = {
      exportedAt: new Date().toISOString(),
      total: filteredRequests.length,
      requests: filteredRequests,
    };
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(payload, null, 2)], {
        type: "application/json;charset=utf-8",
      })
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `app2api-requests-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    notify(`已导出 ${formatNumber(filteredRequests.length)} 条请求日志`, "success");
  }

  async function handleConfirmClear() {
    setClearing(true);
    setClearError("");
    try {
      const res = await onClearRequests();
      setConfirmClear(false);
      setExpandedIds(new Set());
      setPage(1);
      const countText =
        typeof res.cleared === "number" ? `（共 ${formatNumber(res.cleared)} 条）` : "";
      notify(`已清空 8049 请求日志${countText}`, "success");
    } catch (err) {
      setClearError(errorMessage(err) || "清空请求日志失败");
    } finally {
      setClearing(false);
    }
  }

  return (
    <>
      <section
        className="request-logs-section"
        aria-label="8049 实时请求与审计"
        style={{
          borderColor: runningCount > 0 ? "var(--honey-300)" : undefined,
        }}
      >
        <div
          className="log-section-heading"
          style={{
            background: runningCount > 0 ? "var(--honey-50)" : undefined,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              flexWrap: "wrap",
              gap: "8px 10px",
            }}
          >
            <h2 style={{ margin: 0 }}>
              <Activity size={17} />
              8049 实时请求与审计
            </h2>
            <Badge variant={sseConnected ? "green" : "amber"} dot>
              {sseConnected ? "SSE 已连接" : "SSE 重连中"}
            </Badge>
            {runningCount > 0 ? (
              <Badge variant="amber" dot>
                进行中 {formatNumber(runningCount)}
              </Badge>
            ) : (
              <Badge variant="neutral">进行中 0</Badge>
            )}
            <Badge variant={errorCount > 0 ? "red" : "neutral"}>
              失败 {formatNumber(errorCount)}
            </Badge>
            <Badge variant="neutral">
              总计 {formatNumber(effectiveRequests.length)}
            </Badge>
          </div>

          <div
            className="segmented small"
            role="tablist"
            aria-label="8049 日志视图切换"
          >
            <button
              type="button"
              role="tab"
              aria-selected={view === "requests"}
              className={view === "requests" ? "selected" : ""}
              onClick={() => setView("requests")}
            >
              请求日志 ({formatNumber(effectiveRequests.length)})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === "failovers"}
              className={view === "failovers" ? "selected" : ""}
              onClick={() => setView("failovers")}
            >
              故障转移 ({formatNumber(failovers.length)})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === "audit"}
              className={view === "audit" ? "selected" : ""}
              onClick={() => setView("audit")}
            >
              审计记录 ({formatNumber(audits.length)})
            </button>
          </div>
        </div>

        {view === "requests" && (
          <>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 10,
                padding: "14px 20px",
                borderBottom: "1px solid var(--line)",
                background: "var(--surface)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: 8,
                }}
              >
                <div style={{ flex: "1 1 240px", minWidth: 200 }}>
                  <SearchInput
                    value={searchQuery}
                    onChange={setSearchQuery}
                    placeholder="搜索模型、请求 ID、路径、账号或错误码..."
                  />
                </div>

                <Select
                  aria-label="按账号筛选"
                  value={accountFilter}
                  onChange={(event) => setAccountFilter(event.target.value)}
                >
                  <option value="">全部账号</option>
                  {accountOptions.map((acc) => (
                    <option key={acc.id} value={acc.id}>
                      {acc.label}
                    </option>
                  ))}
                </Select>

                <Button
                  type="button"
                  disabled={refreshing}
                  onClick={() => void handleRefresh()}
                  style={{ height: 38, padding: "0 14px", fontSize: 12 }}
                >
                  <RefreshCw
                    size={14}
                    className={refreshSpinning ? "spin" : undefined}
                  />
                  刷新
                </Button>

                <Button
                  type="button"
                  disabled={filteredRequests.length === 0}
                  onClick={handleExportJson}
                  style={{ height: 38, padding: "0 14px", fontSize: 12 }}
                >
                  <Download size={14} />
                  导出 JSON
                </Button>

                <Button
                  type="button"
                  className="danger"
                  disabled={effectiveRequests.length === 0 || clearing}
                  onClick={() => {
                    setClearError("");
                    setConfirmClear(true);
                  }}
                  style={{ height: 38, padding: "0 14px", fontSize: 12 }}
                >
                  <Trash2 size={14} />
                  清空历史
                </Button>
              </div>

              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: 6,
                }}
                role="group"
                aria-label="快捷筛选标签"
              >
                {QUICK_FILTERS.map((tag) => {
                  const active = quickFilter === tag;
                  return (
                    <button
                      key={tag}
                      type="button"
                      className={`button ${active ? "primary" : ""}`}
                      aria-pressed={active}
                      onClick={() => setQuickFilter(tag)}
                      style={{ height: 28, padding: "0 12px", fontSize: 12 }}
                    >
                      {tag}
                    </button>
                  );
                })}
              </div>
            </div>

            {pagedRequests.length > 0 ? (
              <ol className="request-log-list">
                {pagedRequests.map((row, idx) => {
                  const key = getReqId(row) || `req-${idx}`;
                  return (
                    <App2ApiLogRow
                      key={key}
                      row={row}
                      expanded={expandedIds.has(key)}
                      onToggle={() => toggleRow(key)}
                      cancelling={cancellingIds.has(key)}
                      onCancel={(id) => void handleCancel(id)}
                      accountMap={accountMap}
                    />
                  );
                })}
              </ol>
            ) : (
              <Empty
                title="暂无匹配的 8049 请求记录"
                detail={
                  effectiveRequests.length > 0
                    ? "请调整搜索关键词、账号或快捷筛选条件"
                    : "当前尚无通过 8049 Gemini App 网关的实时日志"
                }
              />
            )}

            <div className="log-pagination">
              <span className="log-pagination-count" aria-live="polite">
                {filteredRequests.length > 0
                  ? `第 ${pageStart}–${pageEnd} 条，共 ${formatNumber(filteredRequests.length)} 条`
                  : "共 0 条"}
              </span>

              <div className="log-pagination-controls">
                <Select
                  aria-label="每页条数"
                  value={pageSize}
                  onChange={(event) => setPageSize(Number(event.target.value))}
                >
                  {PAGE_SIZE_OPTIONS.map((size) => (
                    <option key={size} value={size}>
                      {size} 条/页
                    </option>
                  ))}
                </Select>

                <Button
                  type="button"
                  disabled={safePage <= 1}
                  onClick={() => setPage((prev) => Math.max(1, prev - 1))}
                >
                  <ChevronLeft size={15} />
                  上一页
                </Button>
                <span className="mono" style={{ fontSize: 12, color: "var(--muted)" }}>
                  {safePage} / {totalPages}
                </span>
                <Button
                  type="button"
                  disabled={safePage >= totalPages}
                  onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))}
                >
                  下一页
                  <ChevronRight size={15} />
                </Button>
              </div>
            </div>
          </>
        )}

        {view === "failovers" && (
          <>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "14px 20px",
                borderBottom: "1px solid var(--line)",
                background: "var(--surface)",
              }}
            >
              <div style={{ flex: "1 1 240px" }}>
                <SearchInput
                  value={searchQuery}
                  onChange={setSearchQuery}
                  placeholder="搜索模型、账号或故障转移原因..."
                />
              </div>
              <Button
                type="button"
                disabled={refreshing}
                onClick={() => void handleRefresh()}
                style={{ height: 38, padding: "0 14px", fontSize: 12 }}
              >
                <RefreshCw
                  size={14}
                  className={refreshSpinning ? "spin" : undefined}
                />
                刷新
              </Button>
            </div>

            {filteredFailovers.length === 0 ? (
              <Empty
                title="暂无故障转移记录"
                detail="8049 网关发生账号切换或故障转移时，记录会显示在这里"
              />
            ) : (
              <div className="app2api-log-list">
                {filteredFailovers.map((item, idx) => {
                  const ts = toTimestamp(item.timestamp ?? item.createdAt);
                  const fromName = item.fromAccountId
                    ? resolveAccountName(null, item.fromAccountId, accountMap)
                    : "";
                  const toName = item.toAccountId
                    ? resolveAccountName(null, item.toAccountId, accountMap)
                    : "";
                  return (
                    <div key={item.id || `fo-${idx}`} className="app2api-log-row">
                      <div className="app2api-log-icon">
                        <AlertTriangle size={15} />
                      </div>
                      <div className="app2api-log-main">
                        <div className="app2api-log-top">
                          <strong>
                            故障转移{item.model ? ` · ${item.model}` : ""}
                          </strong>
                          <Badge variant="amber">
                            {item.status ? `HTTP ${item.status}` : "Failover"}
                          </Badge>
                          <span className="app2api-log-time">
                            {formatTime(ts)}
                          </span>
                        </div>
                        {(fromName || toName) && (
                          <div className="cell-secondary">
                            {[
                              fromName ? `从 ${fromName}` : "",
                              toName ? `切换至 ${toName}` : "",
                            ]
                              .filter(Boolean)
                              .join(" → ")}
                          </div>
                        )}
                        {item.reason && (
                          <div className="app2api-log-detail">{item.reason}</div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}

        {view === "audit" && (
          <>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "14px 20px",
                borderBottom: "1px solid var(--line)",
                background: "var(--surface)",
              }}
            >
              <div style={{ flex: "1 1 240px" }}>
                <SearchInput
                  value={searchQuery}
                  onChange={setSearchQuery}
                  placeholder="搜索操作动作、操作者、目标或详情..."
                />
              </div>
              <Button
                type="button"
                disabled={refreshing}
                onClick={() => void handleRefresh()}
                style={{ height: 38, padding: "0 14px", fontSize: 12 }}
              >
                <RefreshCw
                  size={14}
                  className={refreshSpinning ? "spin" : undefined}
                />
                刷新
              </Button>
            </div>

            {filteredAudits.length === 0 ? (
              <Empty
                title="暂无审计记录"
                detail="执行账号、密钥或配置管理操作后，审计记录会显示在这里"
              />
            ) : (
              <div className="app2api-log-list">
                {filteredAudits.map((item, idx) => {
                  const ts = toTimestamp(item.timestamp ?? item.createdAt);
                  return (
                    <div key={item.id || `aud-${idx}`} className="app2api-log-row">
                      <div className="app2api-log-icon">
                        <ShieldAlert size={15} />
                      </div>
                      <div className="app2api-log-main">
                        <div className="app2api-log-top">
                          <strong>{item.action || "管理审计"}</strong>
                          <Badge variant={item.ok === false ? "red" : "neutral"}>
                            {item.ok === false ? "失败" : "审计"}
                          </Badge>
                          <span className="app2api-log-time">
                            {formatTime(ts)}
                          </span>
                        </div>
                        {(item.actor || item.target) && (
                          <div className="cell-secondary">
                            {[
                              item.actor ? `操作者 ${item.actor}` : "",
                              item.target ? `目标 ${item.target}` : "",
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </div>
                        )}
                        {item.detail && (
                          <div className="app2api-log-detail">{item.detail}</div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </section>

      {confirmClear && (
        <Confirm
          title="清空 8049 请求日志"
          message="确认清空全部 8049 请求历史？此操作不可撤销。需要保留记录时，请先导出 JSON。"
          busy={clearing}
          error={clearError}
          onClose={() => setConfirmClear(false)}
          onConfirm={() => void handleConfirmClear()}
        />
      )}
    </>
  );
}
