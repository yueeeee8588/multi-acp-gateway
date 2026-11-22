import { useEffect, useState } from "react";
import { Cpu, Eye, Save, StopCircle, Trash2 } from "lucide-react";
import {
  Badge,
  Button,
  Empty,
  ErrorBox,
  Field,
  SearchInput,
  Toggle,
} from "../components";
import type { Notice } from "../components";
import {
  cancelRequest,
  clearAccountCooldown,
  fetchRequestBody,
  saveConfig,
} from "./api";
import type {
  AiStudioActiveRequest,
  AiStudioConfig,
  AiStudioConfigPatch,
  AiStudioCooldown,
  AiStudioModel,
} from "./types";

interface AiStudioModelsRequestsViewProps {
  models: AiStudioModel[];
  requests: AiStudioActiveRequest[];
  cooldowns: AiStudioCooldown[];
  config: AiStudioConfig | null;
  onSaveConfig?: (patch: AiStudioConfigPatch) => Promise<AiStudioConfig>;
  onRefresh: () => Promise<unknown>;
  notify: Notice;
}

const CHANNEL_LABELS: Record<string, string> = {
  playground: "Playground",
  build: "Build",
  assistant: "Build 对话",
};

function formatChannelLabel(channel: string): string {
  return CHANNEL_LABELS[channel] || channel;
}

function formatTokenLimit(limit?: number): string {
  if (limit === undefined || limit === 0) return "—";
  return limit.toLocaleString("en-US");
}

function getEffectiveOutputLimit(m: AiStudioModel): number | undefined {
  return m.capabilities?.output_continuation
    ? m.input_token_limit
    : m.output_token_limit;
}

function getHiddenReason(m: AiStudioModel): string | null {
  if (m.methods?.includes("createDecision")) {
    return "AI Studio 官网选中这个模型时只显示示例应用，不能直接对话；本服务可以直接使用它";
  }
  if (m.hidden) {
    return "AI Studio 官网还没有公开这个模型；服务确认账户可以使用后把它加入列表，官网公开后改用官网的模型信息";
  }
  return null;
}

function formatModelPricing(m: AiStudioModel): string {
  const first = m.details?.pricing?.[0];
  if (first?.text) return first.text;
  if (first && (typeof first.input === "number" || typeof first.output === "number")) {
    const parts: string[] = [];
    if (typeof first.input === "number") parts.push(`Input: $${first.input}`);
    if (typeof first.output === "number") parts.push(`Output: $${first.output}`);
    if (parts.length > 0) return parts.join(" / ");
  }
  return m.details?.summary || "—";
}

export function AiStudioModelsRequestsView({
  models,
  requests,
  cooldowns,
  config,
  onSaveConfig,
  onRefresh,
  notify,
}: AiStudioModelsRequestsViewProps) {
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [selectedBody, setSelectedBody] = useState<{
    id: string;
    text: string;
  } | null>(null);

  const [modelMapping, setModelMapping] = useState(config?.model_mapping ?? "");
  const [modelAccounts, setModelAccounts] = useState(
    config?.model_accounts ?? "",
  );
  const [searchAliases, setSearchAliases] = useState(
    !!config?.search_model_aliases,
  );
  const [discoverHidden, setDiscoverHidden] = useState(
    !!config?.discover_hidden_models,
  );
  const [googleSearch, setGoogleSearch] = useState(!!config?.google_search);

  useEffect(() => {
    if (!config) return;
    setModelMapping(config.model_mapping ?? "");
    setModelAccounts(config.model_accounts ?? "");
    setSearchAliases(!!config.search_model_aliases);
    setDiscoverHidden(!!config.discover_hidden_models);
    setGoogleSearch(!!config.google_search);
  }, [config]);

  const filtered = models.filter((m) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return (
      m.id.toLowerCase().includes(q) ||
      (m.name || "").toLowerCase().includes(q)
    );
  });

  async function handleSaveModelConfig() {
    setBusy("save-models");
    setError("");
    try {
      const patch: AiStudioConfigPatch = {
        model_mapping: modelMapping,
        model_accounts: modelAccounts,
        search_model_aliases: searchAliases,
        discover_hidden_models: discoverHidden,
        google_search: googleSearch,
      };
      if (onSaveConfig) {
        await onSaveConfig(patch);
      } else {
        await saveConfig(patch, config);
      }
      notify("模型配置与开关已保存");
      await onRefresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      notify(msg, true);
    } finally {
      setBusy(null);
    }
  }

  async function handleCancelRequest(id: string) {
    setBusy(`cancel:${id}`);
    setError("");
    try {
      await cancelRequest(id);
      notify(`已取消请求 ${id}`);
      await onRefresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      notify(msg, true);
    } finally {
      setBusy(null);
    }
  }

  async function handleViewBody(id: string) {
    setBusy(`body:${id}`);
    setError("");
    try {
      const res = await fetchRequestBody(id);
      setSelectedBody({ id, text: JSON.stringify(res, null, 2) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      notify(msg, true);
    } finally {
      setBusy(null);
    }
  }

  async function handleClearCooldown(cd: AiStudioCooldown) {
    setBusy(`cd:${cd.account}:${cd.model}`);
    setError("");
    try {
      await clearAccountCooldown(cd.account, cd.model);
      notify(`已清除 ${cd.account} / ${cd.model} 冷却`);
      await onRefresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      notify(msg, true);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div style={{ display: "grid", gap: 18 }}>
      <div className="page-heading">
        <div>
          <div className="eyebrow">AI STUDIO · 模型与在途</div>
          <h1>
            模型目录与在途请求
            <span className="title-count">{models.length}</span>
          </h1>
          <p>监控实时在途推理、账号模型冷却状态、路由绑定及官方模型目录</p>
        </div>
      </div>

      <ErrorBox message={error} />

      <section className="data-section">
        <div className="list-toolbar">
          <div style={{ fontWeight: 700, fontSize: 14 }}>
            实时在途请求 ({requests.length})
          </div>
          <div className="toolbar-meta">
            <span>支持强制取消或查看请求体（需开启 request_body_log）</span>
          </div>
        </div>

        {requests.length === 0 ? (
          <Empty
            title="当前无在途请求"
            detail="有活跃调用时会在此实时显示并支持取消。"
          />
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="acp-accounts-table">
              <thead>
                <tr>
                  <th>请求 ID</th>
                  <th>模型</th>
                  <th>账号 / 通道</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {requests.map((r) => (
                  <tr key={r.id}>
                    <td className="mono">{r.id}</td>
                    <td className="mono">{r.model || "-"}</td>
                    <td>{r.account || r.channel || "-"}</td>
                    <td>
                      <Badge variant="amber" dot>
                        {r.state || "running"}
                      </Badge>
                    </td>
                    <td>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        <Button
                          type="button"
                          className="small-button"
                          busy={busy === `body:${r.id}`}
                          onClick={() => void handleViewBody(r.id)}
                        >
                          <Eye size={13} />
                          请求体
                        </Button>
                        <Button
                          type="button"
                          className="small-button danger"
                          busy={busy === `cancel:${r.id}`}
                          onClick={() => void handleCancelRequest(r.id)}
                        >
                          <StopCircle size={13} />
                          取消
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {selectedBody && (
          <div style={{ padding: "12px 18px", borderTop: "1px solid var(--line)", display: "grid", gap: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span className="mono" style={{ fontSize: 12, color: "var(--muted)" }}>
                请求体：{selectedBody.id}
              </span>
              <Button
                type="button"
                className="small-button"
                onClick={() => setSelectedBody(null)}
              >
                收起
              </Button>
            </div>
            <pre className="aistudio-pre">{selectedBody.text}</pre>
          </div>
        )}

        <div className="table-footer">
          <span>当前在途：{requests.length}</span>
          <span>冷却记录：{cooldowns.length}</span>
        </div>
      </section>

      {cooldowns.length > 0 && (
        <section className="data-section">
          <div className="list-toolbar">
            <div style={{ fontWeight: 700, fontSize: 14 }}>
              当前冷却队列 ({cooldowns.length})
            </div>
            <div className="toolbar-meta">
              <span>支持手动解除账号模型冷却</span>
            </div>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table className="acp-accounts-table">
              <thead>
                <tr>
                  <th>账号</th>
                  <th>模型</th>
                  <th>原因 / 截止时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {cooldowns.map((cd, idx) => (
                  <tr key={`${cd.account}-${cd.model}-${idx}`}>
                    <td>{cd.account}</td>
                    <td className="mono">{cd.model}</td>
                    <td>{cd.reason || cd.until || "-"}</td>
                    <td>
                      <Button
                        type="button"
                        className="small-button"
                        busy={busy === `cd:${cd.account}:${cd.model}`}
                        onClick={() => void handleClearCooldown(cd)}
                      >
                        <Trash2 size={13} />
                        解除冷却
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {config && (
        <section className="settings-section">
          <div className="settings-section-heading">
            <span className="settings-icon">
              <Cpu size={20} />
            </span>
            <div style={{ flex: 1 }}>
              <h2>模型路由与发现开关</h2>
              <p>配置别名映射、指定模型绑定账号，以及隐藏模型/Search 开关</p>
            </div>
            <Button
              type="button"
              className="primary"
              busy={busy === "save-models"}
              onClick={() => void handleSaveModelConfig()}
            >
              <Save size={14} />
              保存模型设置
            </Button>
          </div>
          <div className="settings-section-body">
            <div className="form-grid">
              <Field label="模型映射 (model_mapping)" optional>
                <input
                  className="mono"
                  value={modelMapping}
                  onChange={(e) => setModelMapping(e.target.value)}
                  placeholder="alias=target,..."
                />
              </Field>
              <Field label="模型绑定账号 (model_accounts)" optional>
                <input
                  className="mono"
                  value={modelAccounts}
                  onChange={(e) => setModelAccounts(e.target.value)}
                  placeholder="model=acc1|acc2,..."
                />
              </Field>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "14px 24px", marginTop: 6 }}>
              <Toggle
                checked={searchAliases}
                onChange={setSearchAliases}
                label="搜索模型别名 (search_model_aliases)"
              />
              <Toggle
                checked={discoverHidden}
                onChange={setDiscoverHidden}
                label="发现隐藏模型 (discover_hidden_models)"
              />
              <Toggle
                checked={googleSearch}
                onChange={setGoogleSearch}
                label="启用 Google Search (google_search)"
              />
            </div>
          </div>
        </section>
      )}

      <section className="data-section">
        <div className="list-toolbar" style={{ flexWrap: "wrap", gap: "10px 14px" }}>
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder="搜索模型 ID 或名称..."
          />
          <div className="toolbar-meta">
            <span>
              显示 {filtered.length} / {models.length} 个模型
            </span>
          </div>
        </div>

        {filtered.length === 0 ? (
          <Empty
            title="未匹配到模型"
            detail="请调整搜索关键词或刷新模型目录。"
          />
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="acp-accounts-table">
              <thead>
                <tr>
                  <th>模型 ID</th>
                  <th>名称</th>
                  <th>通道</th>
                  <th style={{ textAlign: "right" }}>输入上限</th>
                  <th style={{ textAlign: "right" }}>输出上限</th>
                  <th>Thinking Levels</th>
                  <th>能力 / 价格</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((m) => {
                  const hiddenReason = getHiddenReason(m);
                  const hasRisk = m.channels?.includes("assistant") ?? false;
                  const effectiveOutput = getEffectiveOutputLimit(m);
                  return (
                    <tr key={m.id}>
                      <td className="mono" style={{ fontWeight: 700 }}>
                        {m.id}
                      </td>
                      <td>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                          <span>{m.name}</span>
                          {m.paid && <Badge variant="amber">付费</Badge>}
                          {hiddenReason && (
                            <span title={hiddenReason}>
                              <Badge variant="amber">官网隐藏</Badge>
                            </span>
                          )}
                          {hasRisk && (
                            <span title="这个模型由 Build 写代码助手回答，会在账户中创建 Build 应用；使用后账户有被 Google 限制使用 AI Studio 的风险">
                              <Badge variant="red">风控风险</Badge>
                            </span>
                          )}
                        </div>
                      </td>
                      <td>
                        {m.channels && m.channels.length > 0 ? (
                          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                            {m.channels.map((ch) => (
                              <Badge key={ch} variant="green">
                                {formatChannelLabel(ch)}
                              </Badge>
                            ))}
                          </div>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="mono" style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                        {formatTokenLimit(m.input_token_limit)}
                      </td>
                      <td
                        className="mono"
                        style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}
                        title={
                          m.capabilities?.output_continuation
                            ? `开启输出续写 (output_continuation)：原始单次输出上限 ${formatTokenLimit(m.output_token_limit)}，有效输出上限与输入上限一致`
                            : undefined
                        }
                      >
                        {formatTokenLimit(effectiveOutput)}
                      </td>
                      <td>
                        {m.thinking_levels && m.thinking_levels.length > 0
                          ? m.thinking_levels.join(", ")
                          : "—"}
                      </td>
                      <td style={{ fontSize: 12, color: "var(--ink-soft)" }}>
                        {formatModelPricing(m)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="table-footer">
          <span>可用模型总数：{models.length}</span>
          <span>当前展示：{filtered.length}</span>
        </div>
      </section>
    </div>
  );
}
