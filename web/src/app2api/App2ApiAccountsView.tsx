import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  CheckCircle2,
  Download,
  ExternalLink,
  Gauge,
  Globe,
  KeyRound,
  Play,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Upload,
  Users,
  X,
} from "lucide-react";
import {
  Badge,
  Button,
  Confirm,
  CopyButton,
  Empty,
  ErrorBox,
  Field,
  IconButton,
  SearchInput,
  Select,
  Toggle,
} from "../components";
import type { Notice } from "../components";
import { useMinSpin } from "../useMinSpin";
import {
  acceptAccountTerms,
  cancelAccountLogin,
  deleteAccount,
  exportAccounts,
  fetchAccountQuota,
  pollAccountLogin,
  pollQuotaRefreshJob,
  startAccountLogin,
  startQuotaRefreshAll,
  submitLoginCallback,
  testAccount,
  updateAccount,
} from "./api";
import {
  App2ApiBatchTokenImportModal,
  App2ApiChromeScanModal,
} from "./App2ApiAccountModals";
import type {
  App2ApiAccount,
  App2ApiLoginFlow,
  App2ApiOverview,
  App2ApiQuotaRefreshJob,
} from "./types";

export interface App2ApiAccountsViewProps {
  overview: App2ApiOverview | null;
  accounts: App2ApiAccount[];
  keyCount: number;
  online: boolean;
  onRefresh: () => Promise<void>;
  notify: (msg: string, kind?: "success" | "error") => void;
}

type StatusFilter = "all" | "ready" | "disabled" | "attention";

function formatUptime(seconds?: number): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
    return "—";
  }
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function formatDateTime(val?: string | number | null): string {
  if (val === undefined || val === null || val === "") return "—";
  const d = new Date(val);
  if (Number.isNaN(d.getTime())) return String(val);
  return d.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function isAccountReady(acc: App2ApiAccount): boolean {
  if (!acc.enabled) return false;
  const st = (acc.status || "ready").toLowerCase();
  return st === "ready" || st === "active" || st === "ok";
}

function isAccountAttention(acc: App2ApiAccount): boolean {
  const st = (acc.status || "").toLowerCase();
  return (
    acc.termsAccepted === false ||
    st === "auth_required" ||
    st === "terms_required" ||
    st === "restricted" ||
    st === "error"
  );
}

function getStatusBadge(acc: App2ApiAccount) {
  if (!acc.enabled) {
    return <Badge variant="neutral">已停用</Badge>;
  }
  const st = (acc.status || "ready").toLowerCase();
  if (st === "ready" || st === "active" || st === "ok") {
    return (
      <Badge variant="green" dot>
        就绪
      </Badge>
    );
  }
  if (st === "terms_required" || acc.termsAccepted === false) {
    return <Badge variant="amber">待同意条款</Badge>;
  }
  if (st === "auth_required") {
    return <Badge variant="red">需重新登录</Badge>;
  }
  if (st === "restricted" || st === "error") {
    return <Badge variant="red">{st === "restricted" ? "受限" : "异常"}</Badge>;
  }
  return <Badge variant="neutral">{acc.status}</Badge>;
}

function formatRemainingPercent(pct: number): string {
  const clamped = Math.max(0, Math.min(100, pct));
  const rounded = Math.round(clamped * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}%` : `${rounded.toFixed(1)}%`;
}

function getRemainingQuotaColor(remainingPct: number): string {
  if (remainingPct >= 40) return "var(--mint)";
  if (remainingPct >= 15) return "var(--amber)";
  return "var(--rose)";
}

function formatUsageRowLabel(label?: string | null): string {
  const raw = (label ?? "").trim();
  const lower = raw.toLowerCase();
  if (lower === "current usage") return "5小时剩余";
  if (lower === "weekly limit") return "每周剩余";
  return raw || "剩余";
}

function formatQuotaRefreshTime(ts?: string | number | null): string | null {
  if (ts === undefined || ts === null || ts === "") return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  const diffMs = d.getTime() - Date.now();
  if (diffMs > 0 && diffMs < 24 * 3600_000) {
    const totalMins = Math.max(1, Math.round(diffMs / 60_000));
    const hours = Math.floor(totalMins / 60);
    const mins = totalMins % 60;
    return hours > 0 ? `${hours}h${mins}m后刷新` : `${mins}m后刷新`;
  }
  if (diffMs >= 24 * 3600_000) {
    return `${formatDateTime(ts)} 刷新`;
  }
  return formatDateTime(ts);
}

function getSubscriptionBadge(acc: App2ApiAccount): {
  label: string;
  variant: "neutral" | "green" | "amber" | "red";
} | null {
  const sub = acc.subscription;
  let rawTier = "";
  if (typeof sub === "string") {
    rawTier = sub.trim();
  } else if (sub && typeof sub === "object") {
    rawTier =
      (typeof sub.tier === "string" && sub.tier.trim()) ||
      (typeof sub.plan === "string" && sub.plan.trim()) ||
      "";
  }
  if (!rawTier || rawTier.toLowerCase() === "unknown") {
    const fallback = [acc.tier, acc.quota?.tier, acc.quota?.plan].find(
      (v): v is string =>
        typeof v === "string" &&
        v.trim().length > 0 &&
        v.trim().toLowerCase() !== "unknown"
    );
    rawTier = fallback ? fallback.trim() : "";
  }
  if (!rawTier || rawTier.toLowerCase() === "unknown") return null;

  const key = rawTier.toLowerCase();
  if (key === "free") return { label: "Free", variant: "neutral" };
  if (key === "plus") return { label: "Plus", variant: "green" };
  if (key === "pro") return { label: "Pro", variant: "green" };
  if (key === "ultra") return { label: "Ultra", variant: "amber" };
  if (key === "ultra_neon") return { label: "Ultra Neon", variant: "amber" };
  return {
    label: rawTier.replace(/_/g, " "),
    variant: "neutral",
  };
}

function getModelTelemetryQuotaErrors(acc: App2ApiAccount): number {
  const mt = acc.modelTelemetry;
  if (!mt || typeof mt !== "object") return 0;
  let total = 0;
  for (const item of Object.values(mt)) {
    if (item && typeof item.quotaErrors === "number" && Number.isFinite(item.quotaErrors)) {
      total += item.quotaErrors;
    }
  }
  return total;
}

function renderAccountQuotaContent(acc: App2ApiAccount) {
  const subBadge = getSubscriptionBadge(acc);
  const q = acc.quota;
  const usageRows = Array.isArray(q?.usageRows) ? q.usageRows : [];
  const budgets = Array.isArray(q?.budgets) ? q.budgets : [];
  const quotaErrors = getModelTelemetryQuotaErrors(acc);

  const validBudgets = budgets.filter((b) => {
    if (!b || typeof b !== "object") return false;
    return (
      typeof b.remainingPercent === "number" ||
      (typeof b.available === "number" && typeof b.max === "number" && b.max > 0) ||
      (typeof b.used === "number" && typeof b.limit === "number" && b.limit > 0)
    );
  });

  let body: React.ReactNode = null;

  if (usageRows.length > 0) {
    body = (
      <div className="app2api-quota-list">
        {usageRows.map((row, idx) => {
          const rawPct =
            typeof row.providerPercent === "number" && Number.isFinite(row.providerPercent)
              ? Math.max(0, Math.min(100, row.providerPercent))
              : null;
          const isRemaining = row.percentMeaning === "remaining";
          const remainingPct =
            rawPct === null
              ? null
              : Math.max(0, Math.min(100, isRemaining ? rawPct : 100 - rawPct));
          const label = formatUsageRowLabel(row.label);
          const pctText =
            remainingPct !== null ? formatRemainingPercent(remainingPct) : "—";
          const displayLabel = label.includes("剩余")
            ? `${label} ${pctText}`
            : `${label} 剩余 ${pctText}`;
          const refreshText = formatQuotaRefreshTime(row.providerTimestamp);

          return (
            <div key={`${row.label ?? "row"}-${idx}`} className="app2api-quota-row">
              <div className="app2api-quota-row-head">
                <strong>{displayLabel}</strong>
                {refreshText && <span className="app2api-quota-meta">{refreshText}</span>}
              </div>
              {remainingPct !== null && (
                <div className="acp-quota-track">
                  <div
                    className="acp-quota-meter"
                    style={{
                      width: `${remainingPct}%`,
                      background: getRemainingQuotaColor(remainingPct),
                    }}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  } else if (validBudgets.length > 0) {
    body = (
      <div className="app2api-quota-list">
        {validBudgets.map((b, idx) => {
          let remainingPct: number | null = null;
          if (typeof b.remainingPercent === "number" && Number.isFinite(b.remainingPercent)) {
            remainingPct = Math.max(0, Math.min(100, b.remainingPercent));
          } else if (
            typeof b.available === "number" &&
            typeof b.max === "number" &&
            b.max > 0
          ) {
            remainingPct = Math.max(0, Math.min(100, (b.available / b.max) * 100));
          } else if (
            typeof b.used === "number" &&
            typeof b.limit === "number" &&
            b.limit > 0
          ) {
            remainingPct = Math.max(0, Math.min(100, ((b.limit - b.used) / b.limit) * 100));
          }
          const label = (b.label || b.model || "预算").trim();
          const pctText =
            remainingPct !== null ? formatRemainingPercent(remainingPct) : "—";

          return (
            <div key={`${label}-${idx}`} className="app2api-quota-row">
              <div className="app2api-quota-row-head">
                <strong>
                  {label} 剩余 {pctText}
                </strong>
                <span className="app2api-quota-meta">被动观测</span>
              </div>
              {remainingPct !== null && (
                <div className="acp-quota-track">
                  <div
                    className="acp-quota-meter"
                    style={{
                      width: `${remainingPct}%`,
                      background: getRemainingQuotaColor(remainingPct),
                    }}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  } else if (q?.status === "error") {
    body = (
      <span className="cell-secondary" style={{ color: "var(--rose)" }}>
        查询失败{q.errorCode ? ` (${q.errorCode})` : ""}
      </span>
    );
  } else if (q?.status === "unqueried" || (!q && !acc.quotaSummary)) {
    body = <span className="cell-secondary">未查询（点「查配额」获取）</span>;
  } else if (q?.status === "missing" || q?.status === "ok") {
    body = <span className="cell-secondary">官方未返回用量</span>;
  } else if (acc.quotaSummary || q?.summary) {
    body = <span className="cell-secondary">{acc.quotaSummary || q?.summary}</span>;
  } else {
    body = <span className="cell-secondary">未查询（点「查配额」获取）</span>;
  }

  return (
    <>
      {subBadge && <Badge variant={subBadge.variant}>{subBadge.label}</Badge>}
      {body}
      {quotaErrors > 0 && (
        <span className="cell-secondary" style={{ color: "var(--rose)" }}>
          本机 429: {quotaErrors} 次
        </span>
      )}
    </>
  );
}

function getAccountErrorText(
  lastError: App2ApiAccount["lastError"]
): string | null {
  if (!lastError) return null;
  if (typeof lastError === "string") {
    const trimmed = lastError.trim();
    return trimmed || null;
  }
  if (typeof lastError === "object") {
    const code = typeof lastError.code === "string" ? lastError.code.trim() : "";
    const msg =
      (typeof lastError.message === "string" && lastError.message.trim()) ||
      (typeof lastError.nativeEvidence?.upstreamMessage === "string" &&
        lastError.nativeEvidence.upstreamMessage.trim()) ||
      "";
    if (code && msg && msg !== code) return `${code}: ${msg}`;
    if (msg) return msg;
    if (code) return code;
    if (typeof lastError.status === "number") return `HTTP ${lastError.status}`;
  }
  return null;
}

const TEST_MODELS = ["gemini-neon", "gemini-hydrogen", "gemini-flash-lite"] as const;

export function App2ApiAccountsView({
  overview,
  accounts,
  keyCount,
  online,
  onRefresh,
  notify,
}: App2ApiAccountsViewProps) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [testModel, setTestModel] = useState<string>(TEST_MODELS[0]);

  // OAuth Login state
  const [loginPanelOpen, setLoginPanelOpen] = useState(false);
  const [loginLabel, setLoginLabel] = useState("");
  const [acceptTermsOnLogin, setAcceptTermsOnLogin] = useState(true);
  const [startingLogin, setStartingLogin] = useState(false);
  const [loginFlow, setLoginFlow] = useState<App2ApiLoginFlow | null>(null);
  const [loginError, setLoginError] = useState("");
  const [callbackUrl, setCallbackUrl] = useState("");
  const [submittingCallback, setSubmittingCallback] = useState(false);
  const loginPollRef = useRef<number | null>(null);

  // Import / Export / Chrome scan modals
  const [chromeModalOpen, setChromeModalOpen] = useState(false);
  const [tokenModalOpen, setTokenModalOpen] = useState(false);
  const [exporting, setExporting] = useState(false);

  // Batch quota refresh state
  const [quotaJob, setQuotaJob] = useState<App2ApiQuotaRefreshJob | null>(null);
  const [startingQuotaAll, setStartingQuotaAll] = useState(false);
  const quotaAllSpin = useMinSpin(
    startingQuotaAll ||
      quotaJob?.status === "pending" ||
      quotaJob?.status === "running"
  );
  const quotaPollRef = useRef<number | null>(null);

  // Row actions
  const [busyRows, setBusyRows] = useState<Record<string, string>>({});
  const [deleteTarget, setDeleteTarget] = useState<App2ApiAccount | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  const copyNotify: Notice = useCallback(
    (text, isErr) => notify(text, isErr ? "error" : "success"),
    [notify]
  );

  // Cleanup polls on unmount
  useEffect(() => {
    return () => {
      if (loginPollRef.current !== null) window.clearInterval(loginPollRef.current);
      if (quotaPollRef.current !== null) window.clearInterval(quotaPollRef.current);
    };
  }, []);

  // Poll OAuth login flow
  useEffect(() => {
    if (loginPollRef.current !== null) {
      window.clearInterval(loginPollRef.current);
      loginPollRef.current = null;
    }
    if (!loginFlow?.flowId) return;
    const st = (loginFlow.status ?? "").toLowerCase();
    if (st === "completed" || st === "failed" || st === "cancelled" || st === "expired") {
      return;
    }

    const flowId = loginFlow.flowId;
    loginPollRef.current = window.setInterval(() => {
      void pollAccountLogin(flowId)
        .then((next) => {
          setLoginFlow((prev) => {
            const authorizationUrl =
              prev?.authorizationUrl ?? prev?.authUrl ?? prev?.url;
            return {
              ...prev,
              ...next,
              flowId: next.flowId || prev?.flowId || flowId,
              status: next.status || prev?.status || "pending",
              authorizationUrl,
            };
          });
          const nextSt = (next.status ?? "").toLowerCase();
          if (nextSt === "completed") {
            if (loginPollRef.current !== null) {
              window.clearInterval(loginPollRef.current);
              loginPollRef.current = null;
            }
            notify("Google 账号授权成功，已加入 8049 账号池", "success");
            void onRefresh();
          } else if (nextSt === "failed" || nextSt === "expired") {
            if (loginPollRef.current !== null) {
              window.clearInterval(loginPollRef.current);
              loginPollRef.current = null;
            }
            setLoginError(
              next.error || next.errorCode || `登录状态：${next.status || nextSt}`
            );
          } else if (nextSt === "cancelled") {
            if (loginPollRef.current !== null) {
              window.clearInterval(loginPollRef.current);
              loginPollRef.current = null;
            }
          }
        })
        .catch((err) => {
          setLoginError(err instanceof Error ? err.message : "轮询登录状态失败");
        });
    }, 2000);

    return () => {
      if (loginPollRef.current !== null) {
        window.clearInterval(loginPollRef.current);
        loginPollRef.current = null;
      }
    };
  }, [loginFlow?.flowId, loginFlow?.status, notify, onRefresh]);

  // Poll batch quota job
  useEffect(() => {
    if (quotaPollRef.current !== null) {
      window.clearInterval(quotaPollRef.current);
      quotaPollRef.current = null;
    }
    const activeJobId = quotaJob?.id || quotaJob?.jobId;
    if (!activeJobId) return;
    const st = (quotaJob?.status ?? "").toLowerCase();
    if (st === "completed" || st === "failed" || st === "cancelled") return;

    quotaPollRef.current = window.setInterval(() => {
      void pollQuotaRefreshJob(activeJobId)
        .then((next) => {
          setQuotaJob(next);
          const nextSt = (next.status ?? "").toLowerCase();
          if (nextSt === "completed") {
            if (quotaPollRef.current !== null) {
              window.clearInterval(quotaPollRef.current);
              quotaPollRef.current = null;
            }
            notify(
              `批量配额刷新完成（更新 ${next.updated ?? 0}，缺失 ${next.missing ?? 0}，跳过 ${next.skipped ?? 0}，失败 ${next.failed ?? 0}）`,
              "success"
            );
            void onRefresh();
          } else if (nextSt === "cancelled") {
            if (quotaPollRef.current !== null) {
              window.clearInterval(quotaPollRef.current);
              quotaPollRef.current = null;
            }
            notify(
              next.reason
                ? `批量配额刷新已取消（${next.reason}）`
                : "批量配额刷新已取消",
              "error"
            );
          } else if (nextSt === "failed") {
            if (quotaPollRef.current !== null) {
              window.clearInterval(quotaPollRef.current);
              quotaPollRef.current = null;
            }
            notify(next.reason || next.error || "批量刷新配额失败", "error");
          }
        })
        .catch(() => {
          // ignore transient poll error
        });
    }, 1800);

    return () => {
      if (quotaPollRef.current !== null) {
        window.clearInterval(quotaPollRef.current);
        quotaPollRef.current = null;
      }
    };
  }, [quotaJob?.id, quotaJob?.jobId, quotaJob?.status, notify, onRefresh]);

  const handleStartLogin = async () => {
    setStartingLogin(true);
    setLoginError("");
    setCallbackUrl("");
    try {
      const flow = await startAccountLogin({
        label: loginLabel.trim() || undefined,
        acceptTerms: acceptTermsOnLogin,
      });
      setLoginFlow(flow);
      notify("已生成 Google OAuth 授权链接", "success");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "启动 Google 登录失败";
      setLoginError(msg);
      notify(msg, "error");
    } finally {
      setStartingLogin(false);
    }
  };

  const handleSubmitCallback = async () => {
    if (!loginFlow?.flowId) return;
    const trimmed = callbackUrl.trim();
    if (!trimmed) {
      setLoginError("请粘贴浏览器跳转后的回调 URL");
      return;
    }
    setSubmittingCallback(true);
    setLoginError("");
    try {
      const res = await submitLoginCallback(loginFlow.flowId, trimmed);
      const nextFlow = res.flow;
      setLoginFlow((prev) => ({
        ...prev,
        ...nextFlow,
        authorizationUrl:
          nextFlow.authorizationUrl ??
          nextFlow.authUrl ??
          nextFlow.url ??
          prev?.authorizationUrl ??
          prev?.authUrl ??
          prev?.url,
      }));
      const nextSt = (nextFlow.status ?? "").toLowerCase();
      if (nextSt === "completed" || res.ok) {
        if (loginPollRef.current !== null) {
          window.clearInterval(loginPollRef.current);
          loginPollRef.current = null;
        }
        setCallbackUrl("");
        notify("Google 账号授权成功，已加入 8049 账号池", "success");
        await onRefresh();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "提交回调 URL 失败";
      setLoginError(msg);
      notify(msg, "error");
    } finally {
      setSubmittingCallback(false);
    }
  };

  const handleExportAccounts = async () => {
    setExporting(true);
    try {
      const data = await exportAccounts();
      const datePart = new Date().toISOString().slice(0, 10);
      const filename = `gemini-app2api-accounts-${datePart}.json`;
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json;charset=utf-8",
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      notify(`已导出 ${data.accounts.length} 个账号备份 (${filename})`, "success");
    } catch (err) {
      notify(err instanceof Error ? err.message : "导出账号备份失败", "error");
    } finally {
      setExporting(false);
    }
  };

  const handleCancelLogin = async () => {
    if (!loginFlow?.flowId) {
      setLoginPanelOpen(false);
      return;
    }
    try {
      await cancelAccountLogin(loginFlow.flowId);
      setLoginFlow((prev) => (prev ? { ...prev, status: "cancelled" } : null));
      notify("已取消当前登录流程", "success");
    } catch (err) {
      notify(err instanceof Error ? err.message : "取消登录失败", "error");
    }
  };

  const handleBatchQuotaRefresh = async () => {
    setStartingQuotaAll(true);
    try {
      const job = await startQuotaRefreshAll();
      setQuotaJob(job);
      notify("已触发全量配额刷新任务", "success");
      if ((job.status ?? "").toLowerCase() === "completed") {
        await onRefresh();
      }
    } catch (err) {
      notify(err instanceof Error ? err.message : "触发批量配额刷新失败", "error");
    } finally {
      setStartingQuotaAll(false);
    }
  };

  const setRowBusy = (id: string, action: string | null) => {
    setBusyRows((prev) => {
      const next = { ...prev };
      if (action) next[id] = action;
      else delete next[id];
      return next;
    });
  };

  const handleToggleEnabled = async (acc: App2ApiAccount, nextEnabled: boolean) => {
    setRowBusy(acc.id, "toggle");
    try {
      await updateAccount(acc.id, { enabled: nextEnabled });
      notify(nextEnabled ? "已启用账号" : "已停用账号", "success");
      await onRefresh();
    } catch (err) {
      notify(err instanceof Error ? err.message : "更新账号状态失败", "error");
    } finally {
      setRowBusy(acc.id, null);
    }
  };

  const handleAcceptTerms = async (acc: App2ApiAccount) => {
    setRowBusy(acc.id, "terms");
    try {
      await acceptAccountTerms(acc.id);
      notify(`已为 ${acc.email || acc.label || acc.id} 确认服务条款`, "success");
      await onRefresh();
    } catch (err) {
      notify(err instanceof Error ? err.message : "确认服务条款失败", "error");
    } finally {
      setRowBusy(acc.id, null);
    }
  };

  const handleTestAccount = async (acc: App2ApiAccount) => {
    setRowBusy(acc.id, "test");
    try {
      const res = await testAccount(acc.id, testModel);
      if (res.ok === false) {
        notify(res.error || res.message || "账号测试未通过", "error");
      } else {
        const latency = typeof res.latencyMs === "number" ? ` (${res.latencyMs}ms)` : "";
        notify(`账号测试通过${latency}`, "success");
      }
      await onRefresh();
    } catch (err) {
      notify(err instanceof Error ? err.message : "账号测试失败", "error");
    } finally {
      setRowBusy(acc.id, null);
    }
  };

  const handleFetchQuota = async (acc: App2ApiAccount) => {
    setRowBusy(acc.id, "quota");
    try {
      await fetchAccountQuota(acc.id);
      notify(`已刷新 ${acc.email || acc.label || acc.id} 配额`, "success");
      await onRefresh();
    } catch (err) {
      notify(err instanceof Error ? err.message : "查询配额失败", "error");
    } finally {
      setRowBusy(acc.id, null);
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError("");
    try {
      await deleteAccount(deleteTarget.id);
      notify(`已移除账号 ${deleteTarget.email || deleteTarget.label || deleteTarget.id}`, "success");
      setDeleteTarget(null);
      await onRefresh();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "删除账号失败");
    } finally {
      setDeleting(false);
    }
  };

  const filteredAccounts = useMemo(() => {
    const q = search.trim().toLowerCase();
    return accounts.filter((acc) => {
      if (statusFilter === "ready" && !isAccountReady(acc)) return false;
      if (statusFilter === "disabled" && acc.enabled) return false;
      if (statusFilter === "attention" && !isAccountAttention(acc)) return false;
      if (!q) return true;
      const hay = `${acc.email ?? ""} ${acc.label ?? ""} ${acc.id}`.toLowerCase();
      return hay.includes(q);
    });
  }, [accounts, search, statusFilter]);

  const readyCount = accounts.filter(isAccountReady).length;
  const enabledCount = accounts.filter((a) => a.enabled).length;
  const attentionCount = accounts.filter(isAccountAttention).length;
  const totalRequests = overview?.metrics?.totalRequests ?? overview?.requests?.length ?? 0;
  const failoverCount = overview?.failovers?.length ?? 0;
  const effectiveKeyCount = overview?.keyCount ?? keyCount;
  const authUrl =
    loginFlow?.authorizationUrl || loginFlow?.authUrl || loginFlow?.url || "";

  return (
    <>
      <div className="throughput-strip">
        <div>
          <span className="strip-icon">
            <Activity size={17} />
          </span>
          <span>
            8049 服务状态
            <strong>
              {online ? (overview?.ready === false ? "未就绪" : "在线") : "离线"}
              <small>
                {overview?.version ? `v${overview.version} · ` : ""}
                {formatUptime(overview?.uptimeSeconds)}
              </small>
            </strong>
          </span>
        </div>

        <div>
          <span className="strip-icon">
            <Users size={17} />
          </span>
          <span>
            可用账号
            <strong>
              {readyCount} / {accounts.length}
              <small>启用 {enabledCount} · 关注 {attentionCount}</small>
            </strong>
          </span>
        </div>

        <div>
          <span className="strip-icon">
            <KeyRound size={17} />
          </span>
          <span>
            API 密钥
            <strong>
              {effectiveKeyCount} 个
              <small>供 8046 / 直连</small>
            </strong>
          </span>
        </div>

        <div>
          <span className="strip-icon">
            <Gauge size={17} />
          </span>
          <span>
            请求 / 故障转移
            <strong>
              {totalRequests} 次
              <small>故障转移 {failoverCount} 次</small>
            </strong>
          </span>
        </div>
      </div>

      {loginPanelOpen && (
        <section className="panel app2api-oauth-panel">
          <div className="app2api-panel-head">
            <div>
              <h3>Google OAuth 登录授权</h3>
              <p className="cell-secondary">
                生成授权链接并在浏览器完成 Google 登录，控制台将自动轮询直到账号入池
              </p>
            </div>
            <IconButton
              title="关闭登录面板"
              onClick={() => setLoginPanelOpen(false)}
            >
              <X size={16} />
            </IconButton>
          </div>

          <div className="app2api-oauth-form">
            <Field label="账号备注" optional>
              <input
                value={loginLabel}
                onChange={(e) => setLoginLabel(e.target.value)}
                placeholder="例如：主力号 / 备用号-01"
                disabled={startingLogin}
              />
            </Field>
            <div className="app2api-oauth-actions">
              <Toggle
                checked={acceptTermsOnLogin}
                onChange={setAcceptTermsOnLogin}
                label="登录后自动同意条款"
              />
              <Button
                type="button"
                className="primary"
                busy={startingLogin}
                onClick={() => void handleStartLogin()}
              >
                <Plus size={15} />
                {loginFlow ? "重新生成链接" : "生成授权链接"}
              </Button>
            </div>
          </div>

          {loginFlow && (
            <div className="app2api-oauth-flow">
              <div className="app2api-oauth-status-row">
                <Badge
                  variant={
                    loginFlow.status === "completed"
                      ? "green"
                      : loginFlow.status === "failed" || loginFlow.status === "expired"
                        ? "red"
                        : loginFlow.status === "cancelled"
                          ? "neutral"
                          : "amber"
                  }
                  dot
                >
                  {loginFlow.status === "completed"
                    ? "授权完成"
                    : loginFlow.status === "cancelled"
                      ? "已取消"
                      : loginFlow.status === "failed"
                        ? "授权失败"
                        : loginFlow.status === "expired"
                          ? "已过期"
                          : "等待浏览器授权中…"}
                </Badge>
                <span className="cell-secondary">Flow: {loginFlow.flowId}</span>
                {loginFlow.status !== "completed" &&
                  loginFlow.status !== "cancelled" && (
                    <Button
                      type="button"
                      className="small-button"
                      style={{ marginLeft: "auto" }}
                      onClick={() => void handleCancelLogin()}
                    >
                      取消登录
                    </Button>
                  )}
              </div>

              {authUrl && (
                <div className="app2api-url-bar">
                  <input readOnly value={authUrl} aria-label="Google 授权链接" />
                  <CopyButton value={authUrl} notify={copyNotify} title="复制授权链接" />
                  <Button
                    type="button"
                    className="small-button primary"
                    onClick={() =>
                      window.open(authUrl, "_blank", "noopener,noreferrer")
                    }
                  >
                    <ExternalLink size={14} />
                    打开授权页
                  </Button>
                </div>
              )}

              {loginFlow.status !== "completed" &&
                loginFlow.status !== "cancelled" &&
                loginFlow.status !== "failed" &&
                loginFlow.status !== "expired" && (
                  <div className="app2api-callback-box">
                    <span className="app2api-callback-label">
                      无法自动回调？手动粘贴回调 URL
                    </span>
                    <div className="app2api-url-bar">
                      <input
                        className="mono"
                        value={callbackUrl}
                        onChange={(e) => setCallbackUrl(e.target.value)}
                        placeholder="http://localhost:18765/?code=...&state=..."
                        aria-label="手动回调 URL"
                        disabled={submittingCallback}
                      />
                      <Button
                        type="button"
                        className="small-button primary"
                        busy={submittingCallback}
                        disabled={!callbackUrl.trim()}
                        onClick={() => void handleSubmitCallback()}
                      >
                        提交回调
                      </Button>
                    </div>
                  </div>
                )}
            </div>
          )}

          <ErrorBox message={loginError} />
        </section>
      )}

      <section className="data-section">
        <div className="list-toolbar">
          <div className="list-summary">
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder="搜索邮箱、备注或账号 ID"
            />
            <Select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
              aria-label="筛选账号状态"
            >
              <option value="all">全部状态</option>
              <option value="ready">仅就绪</option>
              <option value="disabled">已停用</option>
              <option value="attention">需关注 / 待条款</option>
            </Select>
            <Select
              value={testModel}
              onChange={(e) => setTestModel(e.target.value)}
              aria-label="测试模型"
              title="点击行内测试按钮时使用的模型"
            >
              {TEST_MODELS.map((m) => (
                <option key={m} value={m}>
                  测试: {m}
                </option>
              ))}
            </Select>
          </div>

          <div className="row-actions">
            <Button
              type="button"
              className="primary"
              onClick={() => setLoginPanelOpen((v) => !v)}
            >
              <Plus size={15} />
              Google 登录
            </Button>
            <Button
              type="button"
              onClick={() => setChromeModalOpen(true)}
            >
              <Globe size={15} />
              Chrome 扫描导入
            </Button>
            <Button
              type="button"
              onClick={() => setTokenModalOpen(true)}
            >
              <Upload size={15} />
              导入 Token
            </Button>
            <Button
              type="button"
              busy={exporting}
              onClick={() => void handleExportAccounts()}
            >
              <Download size={15} />
              导出备份
            </Button>
            <Button
              type="button"
              onClick={() => void handleBatchQuotaRefresh()}
              disabled={
                startingQuotaAll ||
                quotaJob?.status === "pending" ||
                quotaJob?.status === "running"
              }
            >
              <RefreshCw
                size={15}
                className={quotaAllSpin ? "spin" : undefined}
              />
              {quotaJob?.status === "running" || quotaJob?.status === "pending"
                ? `刷新中 ${quotaJob.completed ?? 0}/${quotaJob.total ?? "?"}`
                : "批量刷新配额"}
            </Button>
          </div>
        </div>

        {filteredAccounts.length === 0 ? (
          <Empty
            title={accounts.length === 0 ? "暂无 8049 账号" : "没有匹配的账号"}
            detail={
              accounts.length === 0
                ? "点击右上角「Google 登录」添加首个 Gemini App 账号"
                : "尝试清空搜索关键词或切换状态筛选"
            }
            action={
              accounts.length === 0 ? (
                <Button
                  type="button"
                  className="primary"
                  onClick={() => setLoginPanelOpen(true)}
                >
                  <Plus size={15} />
                  立即 Google 登录
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>账号 / 备注</th>
                  <th>状态</th>
                  <th>订阅 / 配额</th>
                  <th>启用</th>
                  <th style={{ textAlign: "right" }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {filteredAccounts.map((acc) => {
                  const busy = busyRows[acc.id];
                  const errorText = getAccountErrorText(acc.lastError);
                  const needsTerms =
                    acc.termsAccepted === false ||
                    acc.status === "terms_required";

                  return (
                    <tr key={acc.id}>
                      <td>
                        <strong>{acc.email || acc.label || acc.id}</strong>
                        <span className="cell-secondary">
                          {acc.label && acc.email ? `${acc.label} · ` : ""}
                          ID: {acc.id}
                          {acc.lastTestedAt
                            ? ` · 最近测试 ${formatDateTime(acc.lastTestedAt)}`
                            : ""}
                        </span>
                        {errorText && (
                          <span
                            className="cell-secondary"
                            style={{ color: "var(--rose)" }}
                          >
                            {errorText}
                          </span>
                        )}
                      </td>
                      <td>
                        <div className="app2api-status-cell">
                          {getStatusBadge(acc)}
                          {acc.termsAccepted === false && (
                            <span className="cell-secondary">未确认服务条款</span>
                          )}
                          {typeof acc.statusReason === "string" && acc.statusReason && (
                            <span className="cell-secondary">{acc.statusReason}</span>
                          )}
                        </div>
                      </td>
                      <td>
                        <div className="app2api-quota-cell">
                          {renderAccountQuotaContent(acc)}
                        </div>
                      </td>
                      <td>
                        <Toggle
                          checked={acc.enabled}
                          onChange={(checked) => void handleToggleEnabled(acc, checked)}
                          label={acc.enabled ? "启用" : "停用"}
                        />
                      </td>
                      <td>
                        <div className="row-actions">
                          {needsTerms && (
                            <Button
                              type="button"
                              className="small-button"
                              busy={busy === "terms"}
                              disabled={Boolean(busy)}
                              onClick={() => void handleAcceptTerms(acc)}
                            >
                              <ShieldCheck size={14} />
                              同意条款
                            </Button>
                          )}
                          <Button
                            type="button"
                            className="small-button"
                            busy={busy === "test"}
                            disabled={Boolean(busy)}
                            onClick={() => void handleTestAccount(acc)}
                          >
                            <Play size={14} />
                            测试
                          </Button>
                          <Button
                            type="button"
                            className="small-button"
                            busy={busy === "quota"}
                            disabled={Boolean(busy)}
                            onClick={() => void handleFetchQuota(acc)}
                          >
                            <CheckCircle2 size={14} />
                            查配额
                          </Button>
                          <IconButton
                            title="删除账号"
                            disabled={Boolean(busy)}
                            onClick={() => {
                              setDeleteError("");
                              setDeleteTarget(acc);
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
      </section>

      {deleteTarget && (
        <Confirm
          title="删除 8049 账号"
          message={`确定移除账号「${deleteTarget.email || deleteTarget.label || deleteTarget.id}」？移除后需要重新通过 Google OAuth 登录才能恢复。`}
          onClose={() => setDeleteTarget(null)}
          onConfirm={() => void handleConfirmDelete()}
          busy={deleting}
          error={deleteError}
        />
      )}

      {chromeModalOpen && (
        <App2ApiChromeScanModal
          onClose={() => setChromeModalOpen(false)}
          onAuthorized={onRefresh}
          notify={notify}
        />
      )}

      {tokenModalOpen && (
        <App2ApiBatchTokenImportModal
          onClose={() => setTokenModalOpen(false)}
          onImported={onRefresh}
          notify={notify}
        />
      )}
    </>
  );
}
