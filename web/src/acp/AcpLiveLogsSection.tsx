import { useEffect, useMemo, useState } from "react";
import type { MouseEvent } from "react";
import {
  Activity,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Square,
} from "lucide-react";
import { errorMessage, number as formatNumber, tokenCount } from "../api";
import { Badge, Button, Empty, SearchInput, Select } from "../components";
import { cancelRequest } from "./api";
import type { CooldownRecord, RequestAttempt, RequestLog } from "./types";

export interface AcpLiveLogsSectionProps {
  requests: RequestLog[];
  cooldowns: CooldownRecord[];
  sseConnected: boolean;
  onRefresh: () => Promise<void>;
  notify: (msg: string, kind?: "success" | "error") => void;
  defaultOpen?: boolean;
}

const QUICK_FILTERS = ["全部", "gemini-4", "claude", "flash", "pro", "仅错误"] as const;
type QuickFilter = (typeof QUICK_FILTERS)[number];

const PAGE_SIZE_OPTIONS = [20, 50, 100] as const;

function getLastAttempt(log: RequestLog): RequestAttempt | undefined {
  return log.attempts[log.attempts.length - 1];
}

function isErrorLog(log: RequestLog): boolean {
  return log.state === "failed" || (log.httpStatus ?? 0) >= 400;
}

function getRowTone(log: RequestLog): "green" | "amber" | "red" {
  if (isErrorLog(log)) return "red";
  if (log.state === "running" || log.state === "cancelled") return "amber";
  return "green";
}

function getStateMeta(log: RequestLog): {
  label: string;
  variant: "green" | "amber" | "red" | "neutral";
} {
  if (log.state === "running") {
    return { label: "进行中", variant: "amber" };
  }
  if (log.state === "cancelled") {
    return {
      label: log.httpStatus ? `${log.httpStatus} 已取消` : "已取消",
      variant: "amber",
    };
  }
  if (isErrorLog(log)) {
    return {
      label: log.httpStatus ? `${log.httpStatus} 失败` : "失败",
      variant: "red",
    };
  }
  return {
    label: log.httpStatus ? `${log.httpStatus} 成功` : "成功",
    variant: "green",
  };
}

function getAttemptOutcomeMeta(outcome: RequestAttempt["outcome"]): {
  label: string;
  variant: "green" | "amber" | "red";
} {
  if (outcome === "success") return { label: "成功", variant: "green" };
  if (outcome === "cancelled") return { label: "已取消", variant: "amber" };
  return { label: "失败", variant: "red" };
}

function formatDuration(ms?: number | null): string {
  if (ms === undefined || ms === null || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${formatNumber(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  return `${(ms / 60_000).toFixed(2)} min`;
}

function formatTime(ts: number): string {
  if (!Number.isFinite(ts)) return "—";
  return new Date(ts).toLocaleString("zh-CN", {
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

function formatCacheRate(log: RequestLog): string {
  if (
    typeof log.inputTokens !== "number" ||
    log.inputTokens <= 0 ||
    typeof log.cachedTokens !== "number"
  ) {
    return "—";
  }
  return `${Math.min(100, (log.cachedTokens / log.inputTokens) * 100).toFixed(1)}%`;
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

function getAttemptModelMeta(
  attempt?: RequestAttempt,
  fallbackRequestedModel?: string
): {
  requested: string;
  actualText: string;
  statusLabel: string;
  variant: "green" | "amber" | "neutral";
} {
  const requested =
    attempt?.requestedModel?.trim() || fallbackRequestedModel?.trim() || "—";
  const confirmed = attempt?.confirmedModel?.trim();
  if (attempt?.reasonCode === "MODEL_SELECTION_FAILED") {
    return {
      requested,
      actualText: confirmed || "未报告",
      statusLabel: "切换未通过",
      variant: "amber",
    };
  }
  if (confirmed) {
    return {
      requested,
      actualText: confirmed,
      statusLabel: "ACP 明确确认",
      variant: "green",
    };
  }
  if (attempt?.modelSelectionAcknowledged) {
    return {
      requested,
      actualText: "未返回模型 ID",
      statusLabel: "只确认设置命令",
      variant: "amber",
    };
  }
  return {
    requested,
    actualText: "未确认",
    statusLabel: "未确认",
    variant: "neutral",
  };
}

function AttemptItem({
  attempt,
  cooling,
  fallbackRequestedModel,
}: {
  attempt: RequestAttempt;
  cooling: boolean;
  fallbackRequestedModel?: string;
}) {
  const [showRawError, setShowRawError] = useState(false);
  const outcomeMeta = getAttemptOutcomeMeta(attempt.outcome);
  const timings = attempt.phaseTimingsMs;
  const modelMeta = getAttemptModelMeta(attempt, fallbackRequestedModel);
  const phaseItems = [
    { key: "queue", label: "等账号", value: timings?.queue },
    { key: "workerAcquire", label: "取 Worker", value: timings?.workerAcquire },
    { key: "mcpSetup", label: "MCP", value: timings?.mcpSetup },
    { key: "spawnMs", label: "启动 ACP", value: timings?.spawnMs },
    { key: "initializeMs", label: "初始化", value: timings?.initializeMs },
    { key: "sessionSetupMs", label: "创建或恢复会话", value: timings?.sessionSetupMs },
    { key: "setModelMs", label: "切换模型", value: timings?.setModelMs },
    {
      key: "promptToFirstEventMs",
      label: "发送到 ACP 后首个事件",
      value: timings?.promptToFirstEventMs,
    },
    { key: "firstEvent", label: "收到首个响应片段", value: timings?.firstEvent },
  ].filter(
    (item): item is { key: string; label: string; value: number } =>
      typeof item.value === "number" && Number.isFinite(item.value)
  );

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
          >
            {attempt.accountLabel || attempt.accountId || "未知账号"}
          </span>
          {cooling && <Badge variant="amber">冷却中</Badge>}
          <Badge variant={outcomeMeta.variant} dot>
            {outcomeMeta.label}
            {attempt.upstreamStatus ? ` (${attempt.upstreamStatus})` : ""}
          </Badge>
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
          {typeof timings?.total === "number" && (
            <span className="mono">本次尝试 {formatDuration(timings.total)}</span>
          )}
          {attempt.rawError && (
            <button
              type="button"
              className="button"
              style={{ height: 26, padding: "0 10px", fontSize: 11 }}
              onClick={() => setShowRawError((prev) => !prev)}
            >
              {showRawError ? "收起原始报错" : "原始报错"}
            </button>
          )}
        </div>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "6px 10px",
          marginTop: 7,
          fontSize: 11,
          color: "var(--muted)",
        }}
      >
        <span>
          请求模型{" "}
          <span className="mono" style={{ color: "var(--ink-soft)" }}>
            {modelMeta.requested}
          </span>
        </span>
        <span>
          上游报告模型{" "}
          <span className="mono" style={{ color: "var(--ink-soft)" }}>
            {modelMeta.actualText}
          </span>
        </span>
        <Badge variant={modelMeta.variant}>{modelMeta.statusLabel}</Badge>
        {timings?.coldStart === true && <Badge variant="neutral">冷启动</Badge>}
        {timings?.sessionResumed === true && <Badge variant="neutral">恢复会话</Badge>}
      </div>

      {phaseItems.length > 0 && (
        <div
          className="mono"
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "4px 14px",
            marginTop: 7,
            fontSize: 11,
            color: "var(--muted)",
          }}
        >
          {phaseItems.map((item) => (
            <span key={item.key}>
              {item.label} {formatDuration(item.value)}
            </span>
          ))}
        </div>
      )}

      {attempt.rawError && showRawError && (
        <div className="log-error-detail" style={{ marginTop: 10 }}>
          <strong>原始报错（Attempt #{attempt.index + 1}）</strong>
          <pre>{attempt.rawError}</pre>
        </div>
      )}
    </li>
  );
}

function AcpLogRow({
  row,
  expanded,
  onToggle,
  cancelling,
  onCancel,
  cooldownAccountIds,
}: {
  row: RequestLog;
  expanded: boolean;
  onToggle: () => void;
  cancelling: boolean;
  onCancel: (id: string) => void;
  cooldownAccountIds: Set<string>;
}) {
  const tone = getRowTone(row);
  const stateMeta = getStateMeta(row);
  const lastAttempt = getLastAttempt(row);
  const hitAccount = lastAttempt?.accountLabel || lastAttempt?.accountId || "—";
  const cachedTokens = row.cachedTokens ?? 0;
  const hasCache = Boolean(row.cacheHit) || cachedTokens > 0;
  const cacheRate = formatCacheRate(row);
  const totalTokens =
    typeof row.inputTokens === "number" || typeof row.outputTokens === "number"
      ? (row.inputTokens ?? 0) + (row.outputTokens ?? 0)
      : undefined;
  const firstEventMs = lastAttempt?.phaseTimingsMs?.firstEvent;
  const lastAttemptModelMeta = getAttemptModelMeta(lastAttempt, row.model);

  function handleStopClick(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    onCancel(row.id);
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
            <time className="log-time mono" dateTime={new Date(row.startedAt).toISOString()}>
              {formatTime(row.startedAt)}
            </time>
            <strong className="log-model" title={row.model || "未指定模型"}>
              {row.model || "未指定模型"}
            </strong>
            <Badge>{row.stream ? "SSE 流式" : "非流式"}</Badge>
            <Badge variant={stateMeta.variant} dot>
              {stateMeta.label}
            </Badge>
            {row.switchCount > 0 && (
              <Badge variant="amber">换号 {formatNumber(row.switchCount)} 次</Badge>
            )}
            {hasCache && (
              <Badge variant="green">
                缓存命中{cachedTokens > 0 ? ` ${tokenCount(cachedTokens)}` : ""}
              </Badge>
            )}
            <span className="log-source" title={`命中账号：${hitAccount}`}>
              {hitAccount}
            </span>
            {row.state === "running" && (
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
            <span className="visually-hidden">展开或收起 ACP 请求 {row.id} 的详情</span>
          </span>

          <span className="request-log-metrics">
            <span className="log-metric-group" aria-label="Token 用量与缓存">
              <Metric
                label="Token"
                value={formatOptionalTokens(totalTokens)}
                title={
                  totalTokens !== undefined ? `合计 ${formatNumber(totalTokens)} Token` : undefined
                }
              />
              <Metric label="输入" value={formatOptionalTokens(row.inputTokens)} tone="green" />
              <Metric label="输出" value={formatOptionalTokens(row.outputTokens)} tone="blue" />
              <Metric
                label="缓存"
                value={
                  row.cachedTokens !== undefined
                    ? tokenCount(row.cachedTokens)
                    : row.cacheHit
                      ? "命中"
                      : "—"
                }
                tone={hasCache ? "green" : "neutral"}
                title={cacheRate !== "—" ? `命中率 ${cacheRate}` : undefined}
              />
              {cacheRate !== "—" && <Metric label="命中率" value={cacheRate} />}
            </span>
            <span className="log-metric-group" aria-label="耗时">
              <Metric label="首字" value={formatDuration(firstEventMs)} tone="purple" />
              <Metric label="总耗时" value={formatDuration(row.durationMs)} />
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
              <dt>开始时间</dt>
              <dd>{formatTime(row.startedAt)}</dd>
            </div>
            <div>
              <dt>请求模型 / 家族</dt>
              <dd>
                {lastAttemptModelMeta.requested} / {row.family || "—"}
              </dd>
            </div>
            <div>
              <dt>实际模型状态</dt>
              <dd
                style={{
                  display: "flex",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: 6,
                }}
              >
                <span className="mono">{lastAttemptModelMeta.actualText}</span>
                <Badge variant={lastAttemptModelMeta.variant}>
                  {lastAttemptModelMeta.statusLabel}
                </Badge>
              </dd>
            </div>
            <div>
              <dt>Endpoint</dt>
              <dd className="mono">{row.endpoint || "—"}</dd>
            </div>
            <div>
              <dt>传输 / 状态</dt>
              <dd>
                {row.stream ? "SSE 流式" : "非流式"} · {stateMeta.label}
              </dd>
            </div>
            <div>
              <dt>换号次数 / 命中账号</dt>
              <dd>
                {formatNumber(row.switchCount)} 次 · {hitAccount}
              </dd>
            </div>
            <div>
              <dt>输入 / 输出 / 缓存 Token</dt>
              <dd>
                {row.inputTokens !== undefined ? formatNumber(row.inputTokens) : "—"} /{" "}
                {row.outputTokens !== undefined ? formatNumber(row.outputTokens) : "—"} /{" "}
                {row.cachedTokens !== undefined ? formatNumber(row.cachedTokens) : "—"}
                {cacheRate !== "—" ? `（命中率 ${cacheRate}）` : ""}
              </dd>
            </div>
            <div>
              <dt>首字 / 总耗时</dt>
              <dd>
                {formatDuration(firstEventMs)} / {formatDuration(row.durationMs)}
              </dd>
            </div>
          </dl>

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
                重试与阶段时间线（{row.attempts.length} 次尝试）
              </strong>
            </div>

            {row.attempts.length > 0 ? (
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
                {row.attempts.map((attempt) => (
                  <AttemptItem
                    key={`${row.id}-${attempt.index}`}
                    attempt={attempt}
                    cooling={cooldownAccountIds.has(attempt.accountId)}
                    fallbackRequestedModel={row.model}
                  />
                ))}
              </ol>
            ) : (
              <p style={{ margin: 0, fontSize: 12, color: "var(--muted)" }}>
                暂无尝试记录（请求可能仍在排队中）
              </p>
            )}
          </div>
        </div>
      </details>
    </li>
  );
}

export function AcpLiveLogsSection({
  requests,
  cooldowns,
  sseConnected,
  onRefresh,
  notify,
  defaultOpen,
}: AcpLiveLogsSectionProps) {
  const [sectionOpen, setSectionOpen] = useState(defaultOpen ?? false);
  const [searchQuery, setSearchQuery] = useState("");
  const [accountFilter, setAccountFilter] = useState("");
  const [quickFilter, setQuickFilter] = useState<QuickFilter>("全部");
  const [pageSize, setPageSize] = useState<number>(20);
  const [page, setPage] = useState(1);
  const [refreshing, setRefreshing] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [cancellingIds, setCancellingIds] = useState<Set<string>>(() => new Set());

  const cooldownAccountIds = useMemo(
    () => new Set(cooldowns.map((item) => item.accountId)),
    [cooldowns]
  );

  const runningCount = useMemo(
    () => requests.filter((log) => log.state === "running").length,
    [requests]
  );
  const errorCount = useMemo(
    () => requests.filter(isErrorLog).length,
    [requests]
  );

  const accountOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const log of requests) {
      for (const attempt of log.attempts) {
        if (!attempt.accountId) continue;
        if (!map.has(attempt.accountId)) {
          map.set(attempt.accountId, attempt.accountLabel || attempt.accountId);
        }
      }
    }
    return [...map.entries()]
      .map(([id, label]) => ({ id, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [requests]);

  const filteredRequests = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return requests.filter((log) => {
      if (accountFilter) {
        const matchedAccount = log.attempts.some((a) => a.accountId === accountFilter);
        if (!matchedAccount) return false;
      }
      if (quickFilter === "仅错误" && !isErrorLog(log)) {
        return false;
      }
      if (
        quickFilter !== "全部" &&
        quickFilter !== "仅错误" &&
        !log.model.toLowerCase().includes(quickFilter)
      ) {
        return false;
      }
      if (!query) return true;
      const candidates = [
        log.model,
        log.id,
        log.endpoint,
        log.family,
        ...log.attempts.flatMap((a) => [a.accountLabel, a.accountId]),
      ];
      return candidates.some((text) => text?.toLowerCase().includes(query));
    });
  }, [requests, accountFilter, quickFilter, searchQuery]);

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

  const pageStart = filteredRequests.length > 0 ? (safePage - 1) * pageSize + 1 : 0;
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
      await onRefresh();
    } catch (err) {
      notify(errorMessage(err), "error");
    } finally {
      setRefreshing(false);
    }
  }

  async function handleCancel(id: string) {
    setCancellingIds((prev) => new Set(prev).add(id));
    try {
      await cancelRequest(id);
      notify("已发送停止请求", "success");
    } catch (err) {
      notify(errorMessage(err), "error");
    } finally {
      setCancellingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  return (
    <section
      className="request-logs-section"
      aria-label="8048 ACP 实时与重试明细"
      style={{
        marginTop: 18,
        borderColor: runningCount > 0 ? "var(--honey-300)" : undefined,
      }}
    >
      <div
        className="log-section-heading"
        style={{
          borderBottom: sectionOpen ? undefined : "none",
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
            8048 ACP 实时与重试明细
          </h2>
          <Badge variant={sseConnected ? "green" : "amber"} dot>
            {sseConnected ? "已连接" : "重连中"}
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
          <Badge variant="neutral">总计 {formatNumber(requests.length)}</Badge>
          {cooldowns.length > 0 && (
            <Badge variant="amber">冷却账号 {formatNumber(cooldowns.length)}</Badge>
          )}
        </div>

        <Button
          type="button"
          aria-expanded={sectionOpen}
          onClick={() => setSectionOpen((prev) => !prev)}
          style={{ height: 34, padding: "0 14px", fontSize: 12 }}
        >
          <ChevronDown
            size={15}
            style={{
              transform: sectionOpen ? "rotate(180deg)" : "rotate(0deg)",
              transition: "transform 180ms ease",
            }}
          />
          {sectionOpen ? "收起" : "展开"}
        </Button>
      </div>

      {sectionOpen && (
        <>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 10,
              padding: "12px 16px",
              borderBottom: "1.5px dashed var(--line)",
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
                  placeholder="搜索模型、请求 ID、Endpoint 或账号..."
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
                    {cooldownAccountIds.has(acc.id) ? " (冷却中)" : ""}
                  </option>
                ))}
              </Select>

              <Button
                type="button"
                disabled={refreshing}
                onClick={() => void handleRefresh()}
                style={{ height: 38, padding: "0 14px", fontSize: 12 }}
              >
                <RefreshCw size={14} className={refreshing ? "spin" : ""} />
                刷新
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
              {pagedRequests.map((row) => (
                <AcpLogRow
                  key={row.id}
                  row={row}
                  expanded={expandedIds.has(row.id)}
                  onToggle={() => toggleRow(row.id)}
                  cancelling={cancellingIds.has(row.id)}
                  onCancel={(id) => void handleCancel(id)}
                  cooldownAccountIds={cooldownAccountIds}
                />
              ))}
            </ol>
          ) : (
            <Empty
              title="暂无匹配的 ACP 请求记录"
              detail={
                requests.length > 0
                  ? "请调整搜索关键词、账号或快捷筛选条件"
                  : "当前尚无通过 8048 ACP 网关的实时日志"
              }
            />
          )}

          <div className="log-pagination">
            <span className="log-pagination-count" aria-live="polite">
              {filteredRequests.length > 0
                ? `第 ${pageStart}–${pageEnd} 条，共 ${formatNumber(filteredRequests.length)} 条`
                : `共 0 条`}
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
    </section>
  );
}
