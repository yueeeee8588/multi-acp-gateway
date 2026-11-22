import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent } from "react";
import {
  Activity,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  Eye,
  RefreshCw,
  Square,
  Terminal,
  Trash2,
} from "lucide-react";
import { number as formatNumber, tokenCount } from "../api";
import { Badge, Button, Empty, ErrorBox, SearchInput, Select } from "../components";
import type { Notice } from "../components";
import { useMinSpin } from "../useMinSpin";
import {
  cancelRequest,
  clearAccountCooldown,
  downloadUsageCsv,
  fetchRequestBody,
  fetchUsage,
  fetchUsageRecords,
} from "./api";
import type {
  AiStudioActiveRequest,
  AiStudioCooldown,
  AiStudioLogEntry,
  AiStudioUsageRecord,
  AiStudioUsageSummary,
} from "./types";
import type { AiStudioRefreshResult } from "./useAiStudioGateway";

type RangePreset = "24h" | "7d" | "30d";
type QuickFilter = "全部" | "成功" | "失败" | "限流";

const QUICK_FILTERS: readonly QuickFilter[] = ["全部", "成功", "失败", "限流"];
const PAGE_SIZE_OPTIONS = [20, 50, 100] as const;

export interface AiStudioLogsViewProps {
  requests: AiStudioActiveRequest[];
  cooldowns: AiStudioCooldown[];
  logs: AiStudioLogEntry[];
  sseConnected: boolean;
  onRefresh: (
    onComplete?: (res: AiStudioRefreshResult) => void,
  ) => Promise<AiStudioRefreshResult>;
  onClearLogs: () => Promise<void>;
  notify: Notice;
}

function buildWindow(preset: RangePreset): { from: string; to: string } {
  const now = new Date();
  const hours = preset === "24h" ? 24 : preset === "7d" ? 24 * 7 : 24 * 30;
  const from = new Date(now.getTime() - hours * 3600 * 1000);
  return { from: from.toISOString(), to: now.toISOString() };
}

function formatDuration(ms?: number | null): string {
  if (ms === undefined || ms === null || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${formatNumber(Math.round(ms))} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  return `${(ms / 60_000).toFixed(2)} min`;
}

function formatTime(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function formatOptionalTokens(value?: number): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return "—";
  return tokenCount(value);
}

function isErrorRecord(rec: AiStudioUsageRecord): boolean {
  return rec.state === "failed" || rec.status >= 400 || Boolean(rec.error);
}

function isRateLimitedRecord(rec: AiStudioUsageRecord): boolean {
  return rec.status === 429 || rec.state === "rate_limited";
}

function getRecordTone(rec: AiStudioUsageRecord): "green" | "amber" | "red" {
  if (isRateLimitedRecord(rec) || rec.state === "cancelled") return "amber";
  if (isErrorRecord(rec)) return "red";
  return "green";
}

function getRecordStateMeta(rec: AiStudioUsageRecord): {
  label: string;
  variant: "green" | "amber" | "red" | "neutral";
} {
  if (rec.state === "cancelled") {
    return {
      label: rec.status ? `${rec.status} 已取消` : "已取消",
      variant: "amber",
    };
  }
  if (isRateLimitedRecord(rec)) {
    return { label: "429 限流", variant: "amber" };
  }
  if (isErrorRecord(rec)) {
    return {
      label: rec.status ? `${rec.status} 失败` : "失败",
      variant: "red",
    };
  }
  return {
    label: rec.status ? `${rec.status} 成功` : "成功",
    variant: "green",
  };
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

function AiStudioLogRow({
  row,
  expanded,
  onToggle,
  bodyState,
  onFetchBody,
}: {
  row: AiStudioUsageRecord;
  expanded: boolean;
  onToggle: () => void;
  bodyState?: { loading: boolean; text?: string; error?: string };
  onFetchBody: (id: string) => void;
}) {
  const tone = getRecordTone(row);
  const stateMeta = getRecordStateMeta(row);
  const attempts = row.attempts ?? [];
  const hasCache = (row.cached_tokens ?? 0) > 0;

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
            <time className="log-time mono" dateTime={row.time}>
              {formatTime(row.time)}
            </time>
            <strong className="log-model" title={row.model || "未指定模型"}>
              {row.model || "未指定模型"}
            </strong>
            <Badge>{row.protocol || "http"}</Badge>
            {row.channel && <Badge variant="neutral">{row.channel}</Badge>}
            <Badge variant={stateMeta.variant} dot>
              {stateMeta.label}
            </Badge>
            {attempts.length > 0 && (
              <Badge variant="amber">尝试 {attempts.length} 次</Badge>
            )}
            {hasCache && (
              <Badge variant="green">缓存 {tokenCount(row.cached_tokens)}</Badge>
            )}
            <span className="log-source" title={`账号：${row.account || "—"}`}>
              {row.account || "—"}
            </span>
            <ChevronDown className="log-expand-icon" size={15} aria-hidden="true" />
          </span>

          <span className="request-log-metrics">
            <span className="log-metric-group" aria-label="Token 用量">
              <Metric
                label="Token"
                value={formatOptionalTokens(row.total_tokens)}
                title={`合计 ${formatNumber(row.total_tokens)} Token`}
              />
              <Metric label="输入" value={formatOptionalTokens(row.input_tokens)} tone="green" />
              <Metric label="输出" value={formatOptionalTokens(row.reply_tokens)} tone="blue" />
              {row.reasoning_tokens > 0 && (
                <Metric
                  label="推理"
                  value={formatOptionalTokens(row.reasoning_tokens)}
                  tone="amber"
                />
              )}
              {row.cached_tokens > 0 && (
                <Metric
                  label="缓存"
                  value={formatOptionalTokens(row.cached_tokens)}
                  tone="green"
                />
              )}
            </span>
            <span className="log-metric-group" aria-label="耗时分布">
              <Metric label="首字" value={formatDuration(row.first_event_ms)} tone="purple" />
              <Metric label="排队" value={formatDuration(row.queue_ms)} />
              {typeof row.proof_ms === "number" && (
                <Metric label="Proof" value={formatDuration(row.proof_ms)} />
              )}
              <Metric label="总耗时" value={formatDuration(row.duration_ms)} />
            </span>
          </span>
        </summary>

        <div className="request-log-detail">
          <dl className="log-detail-grid">
            <div>
              <dt>请求 ID</dt>
              <dd className="mono">{row.id}</dd>
            </div>
            <div>
              <dt>请求时间</dt>
              <dd>{formatTime(row.time)}</dd>
            </div>
            <div>
              <dt>协议 / 路径</dt>
              <dd className="mono">
                {row.protocol || "—"} · {row.path || "—"}
              </dd>
            </div>
            <div>
              <dt>通道 / 命中账号</dt>
              <dd>
                {row.channel || "—"} · {row.account || "—"}
              </dd>
            </div>
            <div>
              <dt>HTTP 状态 / 结果</dt>
              <dd>
                {row.status} · {row.state} · 工具调用 {row.tool_calls}
              </dd>
            </div>
            <div>
              <dt>Token 分解（输入 / 缓存 / 推理 / 输出）</dt>
              <dd className="mono">
                {formatNumber(row.input_tokens)} / {formatNumber(row.cached_tokens)} /{" "}
                {formatNumber(row.reasoning_tokens)} / {formatNumber(row.reply_tokens)}
              </dd>
            </div>
            <div>
              <dt>耗时分解（首字 / 排队 / Proof / 总耗时）</dt>
              <dd className="mono">
                {formatDuration(row.first_event_ms)} / {formatDuration(row.queue_ms)} /{" "}
                {formatDuration(row.proof_ms)} / {formatDuration(row.duration_ms)}
              </dd>
            </div>
            {row.proof_phases && (
              <div>
                <dt>Proof 阶段（lock / interaction / refresh / compute）</dt>
                <dd className="mono">
                  {row.proof_phases.lock_ms}ms / {row.proof_phases.interaction_ms}ms /{" "}
                  {row.proof_phases.refresh_ms}ms / {row.proof_phases.compute_ms}ms
                </dd>
              </div>
            )}
          </dl>

          <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <Button
              type="button"
              className="small-button"
              busy={bodyState?.loading}
              disabled={row.has_body === false}
              onClick={() => onFetchBody(row.id)}
            >
              <Eye size={13} />
              {row.has_body === false ? "未留存请求体" : "查看请求体"}
            </Button>
            {row.has_body === false && (
              <span style={{ fontSize: 12, color: "var(--muted)" }}>
                该请求未开启或未留存请求体（需开启 request_body_log）
              </span>
            )}
          </div>

          {bodyState?.error && (
            <div className="log-error-detail" style={{ marginTop: 10 }}>
              <strong>获取请求体失败</strong>
              <pre>{bodyState.error}</pre>
            </div>
          )}

          {bodyState?.text && (
            <div style={{ marginTop: 10 }}>
              <pre className="aistudio-pre">{bodyState.text}</pre>
            </div>
          )}

          {attempts.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <strong style={{ display: "block", fontSize: 12, color: "var(--ink)", marginBottom: 8 }}>
                尝试与重试链路（{attempts.length} 次尝试）
              </strong>
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
                {attempts.map((attempt, idx) => (
                  <li key={`${row.id}-att-${idx}`} className="aistudio-attempt-item">
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        flexWrap: "wrap",
                        gap: 8,
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        <Badge variant="neutral">Attempt #{idx + 1}</Badge>
                        <span style={{ fontSize: 12.5, fontWeight: 700 }}>
                          {attempt.account || "—"}
                        </span>
                        {attempt.channel && <Badge>{attempt.channel}</Badge>}
                      </div>
                      {typeof attempt.duration_ms === "number" && (
                        <span className="mono" style={{ fontSize: 11.5, color: "var(--muted)" }}>
                          耗时 {formatDuration(attempt.duration_ms)}
                        </span>
                      )}
                    </div>
                    {attempt.error && (
                      <div className="log-error-detail" style={{ marginTop: 8 }}>
                        <pre style={{ marginTop: 0 }}>{attempt.error}</pre>
                      </div>
                    )}
                  </li>
                ))}
              </ol>
            </div>
          )}

          {row.error && (
            <div className="log-error-detail">
              <strong>错误信息</strong>
              <pre>{row.error}</pre>
            </div>
          )}
        </div>
      </details>
    </li>
  );
}

export function AiStudioLogsView({
  requests,
  cooldowns,
  logs,
  sseConnected,
  onRefresh,
  onClearLogs,
  notify,
}: AiStudioLogsViewProps) {
  const [range, setRange] = useState<RangePreset>("24h");
  const [windowRange, setWindowRange] = useState(() => buildWindow("24h"));
  const [summary, setSummary] = useState<AiStudioUsageSummary | null>(null);
  const [records, setRecords] = useState<AiStudioUsageRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [clearingLogs, setClearingLogs] = useState(false);
  const [error, setError] = useState("");
  const [autoFollow, setAutoFollow] = useState(true);

  const [searchQuery, setSearchQuery] = useState("");
  const [accountFilter, setAccountFilter] = useState("");
  const [quickFilter, setQuickFilter] = useState<QuickFilter>("全部");
  const [pageSize, setPageSize] = useState<number>(20);
  const [page, setPage] = useState(1);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [cancellingIds, setCancellingIds] = useState<Set<string>>(() => new Set());
  const [clearingCdKeys, setClearingCdKeys] = useState<Set<string>>(() => new Set());
  const [bodyMap, setBodyMap] = useState<
    Record<string, { loading: boolean; text?: string; error?: string }>
  >({});

  const runtimeLogListRef = useRef<HTMLUListElement | null>(null);
  const refreshSpin = useMinSpin(loading);

  const loadLogs = useCallback(
    async (preset: RangePreset) => {
      const nextWin = buildWindow(preset);
      setWindowRange(nextWin);
      setLoading(true);
      setError("");
      try {
        const [u, r] = await Promise.all([
          fetchUsage(nextWin.from, nextWin.to),
          fetchUsageRecords(nextWin.from, nextWin.to, 200),
        ]);
        setSummary(u);
        setRecords(r);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        notify(msg, true);
      } finally {
        setLoading(false);
      }
    },
    [notify],
  );

  useEffect(() => {
    void loadLogs(range);
  }, [range, loadLogs]);

  useEffect(() => {
    if (!autoFollow || !runtimeLogListRef.current) return;
    runtimeLogListRef.current.scrollTop = runtimeLogListRef.current.scrollHeight;
  }, [logs.length, autoFollow]);

  const cooldownAccounts = useMemo(
    () => new Set(cooldowns.map((c) => c.account)),
    [cooldowns],
  );

  const accountOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of records) {
      if (r.account) set.add(r.account);
    }
    for (const c of cooldowns) {
      if (c.account) set.add(c.account);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [records, cooldowns]);

  const filteredRecords = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return records.filter((rec) => {
      if (accountFilter && rec.account !== accountFilter) return false;
      if (quickFilter === "成功" && isErrorRecord(rec)) return false;
      if (quickFilter === "失败" && !isErrorRecord(rec)) return false;
      if (quickFilter === "限流" && !isRateLimitedRecord(rec)) return false;
      if (!q) return true;
      return [
        rec.id,
        rec.model,
        rec.account,
        rec.path,
        rec.protocol,
        rec.channel,
        rec.error,
      ].some((v) => v?.toLowerCase().includes(q));
    });
  }, [records, accountFilter, quickFilter, searchQuery]);

  const totalPages = Math.max(1, Math.ceil(filteredRecords.length / pageSize));
  const safePage = Math.min(page, totalPages);

  useEffect(() => {
    setPage(1);
  }, [searchQuery, accountFilter, quickFilter, pageSize]);

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const pagedRecords = useMemo(() => {
    const start = (safePage - 1) * pageSize;
    return filteredRecords.slice(start, start + pageSize);
  }, [filteredRecords, safePage, pageSize]);

  const pageStart = filteredRecords.length > 0 ? (safePage - 1) * pageSize + 1 : 0;
  const pageEnd = Math.min(safePage * pageSize, filteredRecords.length);

  const errorCount = useMemo(() => records.filter(isErrorRecord).length, [records]);

  function toggleRow(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleRefreshAll() {
    await Promise.all([loadLogs(range), onRefresh()]);
  }

  async function handleExportCsv() {
    setExporting(true);
    setError("");
    try {
      await downloadUsageCsv(windowRange.from, windowRange.to);
      notify("已导出请求日志 CSV");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      notify(msg, true);
    } finally {
      setExporting(false);
    }
  }

  async function handleFetchBody(id: string) {
    setBodyMap((prev) => ({ ...prev, [id]: { loading: true } }));
    try {
      const res = await fetchRequestBody(id);
      setBodyMap((prev) => ({
        ...prev,
        [id]: { loading: false, text: JSON.stringify(res, null, 2) },
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setBodyMap((prev) => ({ ...prev, [id]: { loading: false, error: msg } }));
    }
  }

  async function handleCancelActive(event: MouseEvent<HTMLButtonElement>, id: string) {
    event.preventDefault();
    event.stopPropagation();
    setCancellingIds((prev) => new Set(prev).add(id));
    try {
      await cancelRequest(id);
      notify(`已发送取消请求 ${id}`);
      await onRefresh();
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), true);
    } finally {
      setCancellingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  async function handleClearCooldown(cd: AiStudioCooldown) {
    const key = `${cd.account}:${cd.model}`;
    setClearingCdKeys((prev) => new Set(prev).add(key));
    try {
      await clearAccountCooldown(cd.account, cd.model);
      notify(`已清除 ${cd.account} / ${cd.model} 冷却`);
      await onRefresh();
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), true);
    } finally {
      setClearingCdKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }

  async function handleClearRuntimeLogs() {
    setClearingLogs(true);
    try {
      await onClearLogs();
      notify("已清空运行日志");
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), true);
    } finally {
      setClearingLogs(false);
    }
  }

  const totals = summary?.totals;
  const successRate =
    totals && totals.requests > 0
      ? `${((totals.succeeded / totals.requests) * 100).toFixed(1)}%`
      : "—";

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div className="page-heading log-page-heading" style={{ flexWrap: "wrap" }}>
        <div>
          <div className="eyebrow">AI STUDIO · 实时与历史日志</div>
          <h1>请求日志与冷却状态</h1>
          <p>
            对齐 8048 日志视图：支持时间窗口筛选、状态胶囊、尝试链路展开、请求体查看与 CSV 导出
          </p>
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
          <div className="segmented" role="tablist" aria-label="日志时间范围">
            {(["24h", "7d", "30d"] as const).map((preset) => (
              <button
                key={preset}
                type="button"
                role="tab"
                aria-selected={range === preset}
                className={range === preset ? "selected" : ""}
                onClick={() => setRange(preset)}
              >
                {preset === "24h" ? "近 24 小时" : preset === "7d" ? "近 7 天" : "近 30 天"}
              </button>
            ))}
          </div>
          <Button
            type="button"
            className={autoFollow ? "primary" : ""}
            onClick={() => setAutoFollow((v) => !v)}
          >
            {autoFollow ? "自动跟随：开" : "自动跟随：关"}
          </Button>
          <Button type="button" disabled={loading} onClick={() => void handleRefreshAll()}>
            <RefreshCw size={14} className={refreshSpin ? "spin" : undefined} />
            刷新
          </Button>
          <Button
            type="button"
            className="primary"
            busy={exporting}
            onClick={() => void handleExportCsv()}
          >
            <Download size={14} />
            导出 CSV
          </Button>
        </div>
      </div>

      <ErrorBox message={error} />

      <div className="aistudio-summary-strip" aria-label="周期汇总指标">
        <span className="aistudio-summary-chip">
          <span>总请求</span>
          <strong>{totals ? formatNumber(totals.requests) : "—"}</strong>
        </span>
        <span className="aistudio-summary-chip">
          <span>成功率</span>
          <strong>{successRate}</strong>
        </span>
        <span className="aistudio-summary-chip">
          <span>首字 P50 / P95</span>
          <strong>
            {totals
              ? `${Math.round(totals.first_event.p50_ms)} / ${Math.round(totals.first_event.p95_ms)} ms`
              : "—"}
          </strong>
        </span>
        <span className="aistudio-summary-chip">
          <span>总耗时 P50</span>
          <strong>{totals ? `${Math.round(totals.duration.p50_ms)} ms` : "—"}</strong>
        </span>
        <span
          className="aistudio-summary-chip"
          title={
            totals
              ? `输入 ${formatNumber(totals.input_tokens)} · 缓存 ${formatNumber(totals.cached_tokens)} · 推理 ${formatNumber(totals.reasoning_tokens)} · 输出 ${formatNumber(totals.reply_tokens)}`
              : undefined
          }
        >
          <span>Token 消耗</span>
          <strong>{totals ? tokenCount(totals.total_tokens) : "—"}</strong>
        </span>
        <span className="aistudio-summary-chip">
          <span>参考成本</span>
          <strong>${(summary?.cost ?? 0).toFixed(4)}</strong>
        </span>
      </div>

      <section className="request-logs-section" aria-label="AI Studio 请求日志">
        <div className="log-section-heading">
          <h2>
            <Activity size={17} />
            AI Studio 请求日志
          </h2>
          <span>
            SSE {sseConnected ? "已连接" : "重连中"} · 在途 {requests.length} · 异常{" "}
            {errorCount} · 冷却 {cooldowns.length}
          </span>
        </div>

        <div
          className="list-toolbar"
          style={{
            flexDirection: "column",
            alignItems: "stretch",
            gap: 10,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
            <div style={{ flex: "1 1 240px", minWidth: 200 }}>
              <SearchInput
                value={searchQuery}
                onChange={setSearchQuery}
                placeholder="搜索模型、请求 ID、路径、账号或错误..."
              />
            </div>
            <Select
              aria-label="按账号筛选"
              value={accountFilter}
              onChange={(e) => setAccountFilter(e.target.value)}
            >
              <option value="">全部账号</option>
              {accountOptions.map((acc) => (
                <option key={acc} value={acc}>
                  {acc}
                  {cooldownAccounts.has(acc) ? " (冷却中)" : ""}
                </option>
              ))}
            </Select>
          </div>

          <div
            style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6 }}
            role="group"
            aria-label="快捷状态筛选"
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

        {requests.length > 0 && (
          <ol className="request-log-list" style={{ paddingBottom: 0 }}>
            {requests.map((req) => (
              <li key={`active-${req.id}`}>
                <div className="request-log-row request-log-amber">
                  <div className="request-log-summary" style={{ cursor: "default" }}>
                    <span className="request-log-overview">
                      <time className="log-time mono">{formatTime(req.started_at)}</time>
                      <strong className="log-model">{req.model || "未指定模型"}</strong>
                      {req.channel && <Badge>{req.channel}</Badge>}
                      <Badge variant="amber" dot>
                        {req.state || "running"}（在途）
                      </Badge>
                      <span className="log-source">{req.account || "—"}</span>
                      <button
                        type="button"
                        className="button danger"
                        style={{ height: 24, padding: "0 9px", fontSize: 11 }}
                        disabled={cancellingIds.has(req.id)}
                        onClick={(e) => void handleCancelActive(e, req.id)}
                      >
                        <Square size={11} />
                        {cancellingIds.has(req.id) ? "停止中" : "停止"}
                      </button>
                    </span>
                  </div>
                </div>
              </li>
            ))}
          </ol>
        )}

        {pagedRecords.length > 0 ? (
          <ol className="request-log-list">
            {pagedRecords.map((row) => (
              <AiStudioLogRow
                key={row.id}
                row={row}
                expanded={expandedIds.has(row.id)}
                onToggle={() => toggleRow(row.id)}
                bodyState={bodyMap[row.id]}
                onFetchBody={(id) => void handleFetchBody(id)}
              />
            ))}
          </ol>
        ) : (
          <Empty
            title="暂无匹配的请求日志"
            detail={
              records.length > 0
                ? "请调整搜索关键词、账号或快捷状态筛选条件"
                : "当前时间窗口内尚无请求记录，可切换至近 7 天或近 30 天"
            }
          />
        )}

        <div className="log-pagination">
          <span className="log-pagination-count" aria-live="polite">
            {filteredRecords.length > 0
              ? `第 ${pageStart}–${pageEnd} 条，共 ${formatNumber(filteredRecords.length)} 条`
              : "共 0 条"}
          </span>
          <div className="log-pagination-controls">
            <Select
              aria-label="每页条数"
              value={pageSize}
              onChange={(e) => setPageSize(Number(e.target.value))}
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
              onClick={() => setPage((p) => Math.max(1, p - 1))}
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
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              下一页
              <ChevronRight size={15} />
            </Button>
          </div>
        </div>
      </section>

      {cooldowns.length > 0 && (
        <section className="data-section" aria-label="账号模型冷却列表">
          <div className="list-toolbar">
            <div style={{ fontWeight: 700, fontSize: 14 }}>
              当前冷却状态 ({cooldowns.length})
            </div>
            <div className="toolbar-meta">
              <span>触发风控或 429 限流的账号-模型冷却队列</span>
            </div>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table className="acp-accounts-table">
              <thead>
                <tr>
                  <th>账号</th>
                  <th>模型</th>
                  <th>恢复时间</th>
                  <th>原因</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {cooldowns.map((cd) => {
                  const key = `${cd.account}:${cd.model}`;
                  return (
                    <tr key={key}>
                      <td>{cd.account}</td>
                      <td className="mono">{cd.model}</td>
                      <td className="mono">{formatTime(cd.until)}</td>
                      <td style={{ fontSize: 12, color: "var(--ink-soft)" }}>
                        {cd.reason || "—"}
                      </td>
                      <td>
                        <Button
                          type="button"
                          className="small-button"
                          busy={clearingCdKeys.has(key)}
                          onClick={() => void handleClearCooldown(cd)}
                        >
                          清除冷却
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="data-section" aria-label="实时运行日志">
        <div className="list-toolbar">
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 700, fontSize: 14 }}>
            <Terminal size={15} />
            SSE 实时运行日志 ({logs.length})
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="toolbar-meta">
              来自 /api/events（type=log），最多保留最近 512 条
            </span>
            <Button
              type="button"
              className="small-button"
              busy={clearingLogs}
              onClick={() => void handleClearRuntimeLogs()}
            >
              <Trash2 size={13} />
              清空日志
            </Button>
          </div>
        </div>

        {logs.length === 0 ? (
          <Empty
            title="暂无 SSE 运行日志"
            detail="2048 后端有新的运行事件推送时会实时显示于此（不预填充模拟数据）。"
          />
        ) : (
          <ul ref={runtimeLogListRef} className="aistudio-runtime-log-list">
            {logs.map((entry, idx) => {
              const lvl = (entry.level || "INFO").toUpperCase();
              const badgeVar =
                lvl === "ERROR" ? "red" : lvl === "WARN" ? "amber" : "neutral";
              return (
                <li key={entry.id || `log-${idx}`} className="aistudio-runtime-log-item">
                  <span style={{ color: "var(--muted)" }}>
                    {formatTime(entry.time || entry.timestamp)}
                  </span>
                  <Badge variant={badgeVar}>{lvl}</Badge>
                  {entry.source && (
                    <span style={{ color: "var(--pink-700)", fontWeight: 700 }}>
                      [{entry.source}]
                    </span>
                  )}
                  <span>{entry.message || entry.event || JSON.stringify(entry)}</span>
                  {entry.fields && entry.fields.length > 0 && (
                    <span style={{ color: "var(--muted)" }}>
                      {entry.fields.map((f) => `${f.key}=${f.value}`).join(" ")}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
