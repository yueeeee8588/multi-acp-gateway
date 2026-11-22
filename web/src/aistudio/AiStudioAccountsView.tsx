import { useMemo, useState } from "react";
import {
  Chrome,
  Globe,
  KeyRound,
  LayoutGrid,
  List,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
} from "lucide-react";
import {
  Badge,
  Button,
  Empty,
  ErrorBox,
  SearchInput,
  Select,
} from "../components";
import type { Notice } from "../components";
import {
  AccountTaskModal,
  ChromeImportModal,
  CookieImportModal,
} from "./AiStudioAccountModals";
import {
  deleteAccount,
  deleteAccountTask,
  refreshAccount,
  reloginAccount,
  setAccountState,
} from "./api";
import type {
  AiStudioAccount,
  AiStudioAccountExit,
  AiStudioAccountTask,
} from "./types";

interface AiStudioAccountsViewProps {
  accounts: AiStudioAccount[];
  exits: AiStudioAccountExit[];
  exitsError?: string;
  tasks: AiStudioAccountTask[];
  onRefresh: () => Promise<unknown>;
  notify: Notice;
}

type StatusFilter =
  | "all"
  | "ready"
  | "busy"
  | "cooldown"
  | "auth_required"
  | "disabled";
type ViewMode = "card" | "table";

function effectiveState(acc: AiStudioAccount): string {
  return acc.enabled ? (acc.state || "unknown").toLowerCase() : "disabled";
}

function stateBadgeVariant(
  state: string,
  enabled: boolean,
): "green" | "amber" | "red" | "neutral" {
  if (!enabled) return "neutral";
  const s = state.toLowerCase();
  if (s === "ready" || s === "active") return "green";
  if (s === "busy" || s === "cooldown") return "amber";
  if (s === "auth_required" || s === "error" || s === "disabled") return "red";
  return "neutral";
}

export function AiStudioAccountsView({
  accounts,
  exits,
  exitsError,
  tasks,
  onRefresh,
  notify,
}: AiStudioAccountsViewProps) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [exitFilter, setExitFilter] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    const saved = localStorage.getItem("aistudio-accounts-view");
    return saved === "table" ? "table" : "card";
  });

  const [showCookieModal, setShowCookieModal] = useState(false);
  const [showChromeModal, setShowChromeModal] = useState(false);
  const [showTaskModal, setShowTaskModal] = useState(false);

  function handleSetViewMode(mode: ViewMode) {
    setViewMode(mode);
    localStorage.setItem("aistudio-accounts-view", mode);
  }

  async function runAction(
    id: string,
    fn: () => Promise<string | void>,
    defaultOkMsg: string,
  ) {
    setBusyId(id);
    setActionError("");
    try {
      const customMsg = await fn();
      notify(customMsg || defaultOkMsg);
      await onRefresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setActionError(msg);
      notify(msg, true);
    } finally {
      setBusyId(null);
    }
  }

  const counts = useMemo(() => {
    let ready = 0;
    let busy = 0;
    let cooldown = 0;
    let authRequired = 0;
    let disabled = 0;
    for (const acc of accounts) {
      const st = effectiveState(acc);
      if (st === "ready" || st === "active") ready++;
      else if (st === "busy") busy++;
      else if (st === "cooldown") cooldown++;
      else if (st === "auth_required") authRequired++;
      else if (st === "disabled") disabled++;
    }
    return { ready, busy, cooldown, authRequired, disabled };
  }, [accounts]);

  const filteredAccounts = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return accounts.filter((acc) => {
      const st = effectiveState(acc);
      if (statusFilter !== "all" && st !== statusFilter) return false;

      if (exitFilter) {
        const accExit = (acc.egress || acc.proxy || "").trim();
        if (accExit !== exitFilter) return false;
      }

      if (!q) return true;
      return (
        (acc.id || "").toLowerCase().includes(q) ||
        (acc.label || "").toLowerCase().includes(q) ||
        (acc.message || "").toLowerCase().includes(q) ||
        (acc.egress || acc.proxy || "").toLowerCase().includes(q)
      );
    });
  }, [accounts, exitFilter, searchQuery, statusFilter]);

  return (
    <div>
      <div className="page-heading" style={{ flexWrap: "wrap" }}>
        <div>
          <div className="eyebrow">AI STUDIO · 账号池</div>
          <h1>
            AI Studio 账号池
            <span className="title-count">{accounts.length}</span>
          </h1>
          <p>多账号池调度、出口 IP 聚合、状态刷新与无头导入任务管理</p>
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
            type="button"
            onClick={() => setShowTaskModal(true)}
            disabled={busyId !== null}
          >
            <Plus size={15} />
            新增登录任务
          </Button>
          <Button
            type="button"
            onClick={() => setShowChromeModal(true)}
            disabled={busyId !== null}
          >
            <Chrome size={15} />
            扫描 Chrome
          </Button>
          <Button
            type="button"
            className="primary"
            onClick={() => setShowCookieModal(true)}
            disabled={busyId !== null}
          >
            <KeyRound size={15} />
            Cookie 导入
          </Button>
        </div>
      </div>

      <ErrorBox message={actionError} />
      {exitsError && <ErrorBox message={`出口节点探测失败：${exitsError}`} />}

      {exits.length > 0 && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "8px",
            marginBottom: "18px",
            padding: "12px 16px",
            borderRadius: "var(--radius-lg)",
            border: "1.5px solid #fff",
            background: "var(--surface)",
            boxShadow: "var(--shadow-sm)",
          }}
        >
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              fontSize: "12px",
              fontWeight: 700,
              color: "var(--muted)",
              marginRight: "4px",
            }}
          >
            <Globe size={14} />
            出口节点:
          </span>

          {exits.map((ex, idx) => {
            const key = (ex.proxy || "").trim();
            const isSelected = exitFilter === key && key !== "";
            return (
              <button
                key={`${key}-${ex.ip}-${idx}`}
                type="button"
                onClick={() => {
                  if (!key) return;
                  setExitFilter(isSelected ? "" : key);
                }}
                title={key ? `点击按出口 ${key} 筛选账号` : "默认直连"}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                  minHeight: "28px",
                  padding: "3px 11px",
                  borderRadius: "var(--pill)",
                  border: `1.5px solid ${isSelected ? "var(--pink-500)" : "var(--line)"}`,
                  background: isSelected ? "var(--pink-100)" : "var(--pink-50)",
                  color: isSelected ? "var(--pink-700)" : "var(--ink-soft)",
                  fontSize: "12px",
                  fontWeight: 700,
                  cursor: key ? "pointer" : "default",
                }}
              >
                <span className="mono" style={{ color: "var(--ink)", fontWeight: 700 }}>
                  {ex.ip || ex.proxy || "直连"}
                </span>
                {ex.country && (
                  <span style={{ color: "var(--muted)", fontWeight: 600 }}>
                    / {ex.country}
                  </span>
                )}
                {ex.proxy && (
                  <span className="mono" style={{ color: "var(--muted)", fontWeight: 500 }}>
                    ({ex.proxy})
                  </span>
                )}
              </button>
            );
          })}
          {exitFilter && (
            <Button
              type="button"
              className="small-button"
              onClick={() => setExitFilter("")}
            >
              清除出口筛选
            </Button>
          )}
        </div>
      )}

      <section className="data-section acp-accounts-list">
        <div
          className="list-toolbar"
          style={{ flexWrap: "wrap", gap: "10px 14px" }}
        >
          <SearchInput
            value={searchQuery}
            onChange={setSearchQuery}
            placeholder="搜索邮箱、标签、出口或状态消息..."
          />

          <div
            className="toolbar-meta"
            style={{ flexWrap: "wrap", gap: "8px" }}
          >
            <Select
              aria-label="按状态筛选"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            >
              <option value="all">全部状态 ({accounts.length})</option>
              <option value="ready">ready ({counts.ready})</option>
              <option value="busy">busy ({counts.busy})</option>
              <option value="cooldown">cooldown ({counts.cooldown})</option>
              <option value="auth_required">auth_required ({counts.authRequired})</option>
              <option value="disabled">disabled ({counts.disabled})</option>
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
                  fontWeight: 600,
                }}
              >
                <LayoutGrid size={13} />
                卡片
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
                  fontWeight: 600,
                }}
              >
                <List size={13} />
                表格
              </button>
            </div>
          </div>
        </div>

        {filteredAccounts.length === 0 ? (
          <Empty
            title={accounts.length === 0 ? "暂无 AI Studio 账号" : "无匹配账号"}
            detail={
              accounts.length === 0
                ? "请点击右上角「Cookie 导入」「扫描 Chrome」或「新增登录任务」添加账号。"
                : "请尝试调整搜索关键词、状态筛选或出口筛选。"
            }
          />
        ) : viewMode === "card" ? (
          <div className="aistudio-card-grid">
            {filteredAccounts.map((acc) => (
              <article key={acc.id} className="aistudio-account-card">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 13.5, wordBreak: "break-all" }}>
                      {acc.label || acc.id}
                    </div>
                    {acc.label && acc.label !== acc.id && (
                      <div className="mono" style={{ fontSize: 11.5, color: "var(--muted)", wordBreak: "break-all" }}>
                        {acc.id}
                      </div>
                    )}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                    {acc.benefit_tier && <Badge variant="amber">{acc.benefit_tier}</Badge>}
                    <Badge variant={stateBadgeVariant(acc.state, acc.enabled)} dot>
                      {acc.enabled ? acc.state : "disabled"}
                    </Badge>
                  </div>
                </div>

                <div style={{ display: "flex", flexWrap: "wrap", gap: "8px 14px", fontSize: 12, color: "var(--ink-soft)" }}>
                  <span>
                    出口：<span className="mono">{acc.egress || acc.proxy || "直连"}</span>
                  </span>
                  <span>模型：{acc.models?.length ?? 0}</span>
                  <span>在途：{acc.active_requests ?? 0}</span>
                </div>

                {acc.cooldown_until && (
                  <div style={{ fontSize: 11.5, color: "var(--amber)" }}>
                    冷却至 {acc.cooldown_until}
                  </div>
                )}

                {acc.message && (
                  <div style={{ fontSize: 12, color: "var(--rose)", wordBreak: "break-word" }}>
                    {acc.message}
                  </div>
                )}

                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, paddingTop: 4, borderTop: "1px solid var(--line)" }}>
                  <Button
                    type="button"
                    className="small-button"
                    busy={busyId === `toggle:${acc.id}`}
                    onClick={() =>
                      void runAction(
                        `toggle:${acc.id}`,
                        async () => {
                          await setAccountState(
                            acc.id,
                            acc.enabled ? "disabled" : "enabled",
                          );
                        },
                        acc.enabled ? "已禁用账号" : "已启用账号",
                      )
                    }
                  >
                    {acc.enabled ? "禁用" : "启用"}
                  </Button>
                  <Button
                    type="button"
                    className="small-button"
                    busy={busyId === `refresh:${acc.id}`}
                    onClick={() =>
                      void runAction(
                        `refresh:${acc.id}`,
                        async () => {
                          await refreshAccount(acc.id);
                        },
                        "已触发账号刷新测试",
                      )
                    }
                  >
                    <RefreshCw size={13} />
                    刷新
                  </Button>
                  <Button
                    type="button"
                    className="small-button"
                    busy={busyId === `relogin:${acc.id}`}
                    onClick={() =>
                      void runAction(
                        `relogin:${acc.id}`,
                        async () => {
                          const res = await reloginAccount(acc.id);
                          return res?.task
                            ? "重登任务已受理/排队中，请在下方任务队列查看进度"
                            : "已发起重登";
                        },
                        "重登任务已受理",
                      )
                    }
                  >
                    <RotateCcw size={13} />
                    重登
                  </Button>
                  <Button
                    type="button"
                    className="small-button danger"
                    busy={busyId === `del:${acc.id}`}
                    onClick={() =>
                      void runAction(
                        `del:${acc.id}`,
                        async () => {
                          await deleteAccount(acc.id);
                        },
                        "已删除账号",
                      )
                    }
                  >
                    <Trash2 size={13} />
                    删除
                  </Button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="acp-accounts-table">
              <thead>
                <tr>
                  <th>账号 / 标签</th>
                  <th>状态</th>
                  <th>等级</th>
                  <th>出口代理</th>
                  <th>模型数</th>
                  <th>在途</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {filteredAccounts.map((acc) => (
                  <tr key={acc.id}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{acc.label || acc.id}</div>
                      {acc.label && acc.label !== acc.id && (
                        <div className="mono" style={{ fontSize: 11.5, color: "var(--muted)" }}>
                          {acc.id}
                        </div>
                      )}
                      {acc.message && (
                        <div style={{ fontSize: 12, color: "var(--rose)", marginTop: 2 }}>
                          {acc.message}
                        </div>
                      )}
                    </td>
                    <td>
                      <Badge variant={stateBadgeVariant(acc.state, acc.enabled)} dot>
                        {acc.enabled ? acc.state : "disabled"}
                      </Badge>
                      {acc.cooldown_until && (
                        <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 3 }}>
                          冷却至 {acc.cooldown_until}
                        </div>
                      )}
                    </td>
                    <td>{acc.benefit_tier || "-"}</td>
                    <td className="mono">{acc.egress || acc.proxy || "直连"}</td>
                    <td>{acc.models?.length ?? 0}</td>
                    <td>{acc.active_requests ?? 0}</td>
                    <td>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                        <Button
                          type="button"
                          className="small-button"
                          busy={busyId === `toggle:${acc.id}`}
                          onClick={() =>
                            void runAction(
                              `toggle:${acc.id}`,
                              async () => {
                                await setAccountState(
                                  acc.id,
                                  acc.enabled ? "disabled" : "enabled",
                                );
                              },
                              acc.enabled ? "已禁用账号" : "已启用账号",
                            )
                          }
                        >
                          {acc.enabled ? "禁用" : "启用"}
                        </Button>
                        <Button
                          type="button"
                          className="small-button"
                          busy={busyId === `refresh:${acc.id}`}
                          onClick={() =>
                            void runAction(
                              `refresh:${acc.id}`,
                              async () => {
                                await refreshAccount(acc.id);
                              },
                              "已触发账号刷新测试",
                            )
                          }
                        >
                          <RefreshCw size={13} />
                          刷新
                        </Button>
                        <Button
                          type="button"
                          className="small-button"
                          busy={busyId === `relogin:${acc.id}`}
                          onClick={() =>
                            void runAction(
                              `relogin:${acc.id}`,
                              async () => {
                                const res = await reloginAccount(acc.id);
                                return res?.task
                                  ? "重登任务已受理/排队中，请在下方任务队列查看进度"
                                  : "已发起重登";
                              },
                              "重登任务已受理",
                            )
                          }
                        >
                          <RotateCcw size={13} />
                          重登
                        </Button>
                        <Button
                          type="button"
                          className="small-button danger"
                          busy={busyId === `del:${acc.id}`}
                          onClick={() =>
                            void runAction(
                              `del:${acc.id}`,
                              async () => {
                                await deleteAccount(acc.id);
                              },
                              "已删除账号",
                            )
                          }
                        >
                          <Trash2 size={13} />
                          删除
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="table-footer">
          <span>
            共 {accounts.length} 个账号 · ready {counts.ready} · cooldown {counts.cooldown} · auth_required {counts.authRequired} · disabled {counts.disabled}
          </span>
          <span>当前筛选显示 {filteredAccounts.length} 项</span>
        </div>
      </section>

      <section className="data-section" style={{ marginTop: 18 }}>
        <div className="list-toolbar">
          <div style={{ fontWeight: 700, fontSize: 14 }}>
            异步登录与导入任务 ({tasks.length})
          </div>
          <div className="toolbar-meta">
            <span>通过 SSE /api/events 实时同步后台任务终态</span>
          </div>
        </div>

        {tasks.length === 0 ? (
          <div style={{ padding: "18px", fontSize: 13, color: "var(--muted)" }}>
            当前无进行中或待清理的后台登录/导入任务。
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="acp-accounts-table">
              <thead>
                <tr>
                  <th>任务 ID</th>
                  <th>类型</th>
                  <th>目标账号 / 标签</th>
                  <th>状态</th>
                  <th>消息</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((t) => {
                  const taskState = t.state ?? t.status ?? "unknown";
                  const normalizedState = taskState.toLowerCase();
                  const badgeVariant =
                    normalizedState === "done" || normalizedState === "completed"
                      ? "green"
                      : normalizedState === "failed" || normalizedState === "error"
                        ? "red"
                        : "amber";
                  return (
                    <tr key={t.id}>
                      <td className="mono">{t.id}</td>
                      <td>{t.kind || t.type || "-"}</td>
                      <td>
                        {t.items?.[0]?.label ||
                          t.items?.[0]?.email ||
                          t.label ||
                          t.account_id ||
                          "-"}
                      </td>
                      <td>
                        <Badge variant={badgeVariant}>{taskState}</Badge>
                      </td>
                      <td>{t.items?.[0]?.error || t.error || t.message || "-"}</td>
                      <td>
                        <Button
                          type="button"
                          className="small-button"
                          busy={busyId === `task-del:${t.id}`}
                          onClick={() =>
                            void runAction(
                              `task-del:${t.id}`,
                              async () => {
                                await deleteAccountTask(t.id);
                              },
                              "已取消/清理任务",
                            )
                          }
                        >
                          清理
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {showCookieModal && (
        <CookieImportModal
          onClose={() => setShowCookieModal(false)}
          onImported={onRefresh}
          notify={notify}
        />
      )}

      {showChromeModal && (
        <ChromeImportModal
          onClose={() => setShowChromeModal(false)}
          onImported={onRefresh}
          notify={notify}
        />
      )}

      {showTaskModal && (
        <AccountTaskModal
          onClose={() => setShowTaskModal(false)}
          onCreated={onRefresh}
          notify={notify}
        />
      )}
    </div>
  );
}
