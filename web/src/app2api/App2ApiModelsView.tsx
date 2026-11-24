import { useCallback, useMemo } from "react";
import { Cpu, Globe, Layers, Link2 } from "lucide-react";
import { Badge, CopyButton } from "../components";
import type { Notice } from "../components";
import type {
  App2ApiModelItem,
  App2ApiModelTelemetry,
  App2ApiModelTelemetrySnapshot,
  App2ApiOverview,
} from "./types";

export interface App2ApiModelsViewProps {
  overview: App2ApiOverview | null;
  notify: (msg: string, kind?: "success" | "error") => void;
}

const DEFAULT_BASE_URL = "http://127.0.0.1:8049";

const FALLBACK_MODELS: App2ApiModelItem[] = [
  {
    id: "gemini-neon",
    displayName: "Gemini Neon",
    description: "主力旗舰推理模型，兼顾复杂多步任务与工具调用",
    contextWindow: 1_048_576,
    outputTokenLimit: 65_536,
    protocols: ["openai", "anthropic", "gemini"],
  },
  {
    id: "gemini-hydrogen",
    displayName: "Gemini Hydrogen",
    description: "均衡型高速模型，适合日常对话、代码与常规工作流",
    contextWindow: 1_048_576,
    outputTokenLimit: 65_536,
    protocols: ["openai", "anthropic", "gemini"],
  },
  {
    id: "gemini-flash-lite",
    displayName: "Gemini Flash Lite",
    description: "超低延迟轻量模型，适合高并发摘要、分类与快速响应",
    contextWindow: 1_048_576,
    outputTokenLimit: 32_768,
    protocols: ["openai", "anthropic", "gemini"],
  },
];

const PROTOCOL_ENDPOINTS = [
  {
    name: "OpenAI 协议",
    badge: "chat / responses",
    variant: "green" as const,
    baseUrl: `${DEFAULT_BASE_URL}/v1`,
    paths: ["/v1/chat/completions", "/v1/responses"],
    curl: `curl ${DEFAULT_BASE_URL}/v1/chat/completions -H "Authorization: Bearer <KEY>" -H "Content-Type: application/json" -d '{"model":"gemini-neon","messages":[{"role":"user","content":"Hello"}]}'`,
  },
  {
    name: "Google / Anthropic 协议",
    badge: "messages",
    variant: "amber" as const,
    baseUrl: DEFAULT_BASE_URL,
    paths: ["/v1/messages"],
    curl: `curl ${DEFAULT_BASE_URL}/v1/messages -H "x-api-key: <KEY>" -H "Content-Type: application/json" -d '{"model":"gemini-neon","max_tokens":1024,"messages":[{"role":"user","content":"Hello"}]}'`,
  },
  {
    name: "Gemini 原生协议",
    badge: "v1beta",
    variant: "neutral" as const,
    baseUrl: `${DEFAULT_BASE_URL}/v1beta`,
    paths: ["/v1beta/models/{model}:generateContent"],
    curl: `curl "${DEFAULT_BASE_URL}/v1beta/models/gemini-neon:generateContent?key=<KEY>" -H "Content-Type: application/json" -d '{"contents":[{"parts":[{"text":"Hello"}]}]}'`,
  },
];

const FALLBACK_MODELS_BY_ID = new Map<string, App2ApiModelItem>(
  FALLBACK_MODELS.map((m) => [m.id, m])
);

function normalizeModelItem(
  raw: string | App2ApiModelItem
): App2ApiModelItem | null {
  if (typeof raw === "string") {
    const id = raw.trim();
    if (!id) return null;
    const fallback = FALLBACK_MODELS_BY_ID.get(id);
    return fallback ? { ...fallback } : { id };
  }
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id || raw.name || "").trim();
  if (!id) return null;
  const fallback = FALLBACK_MODELS_BY_ID.get(id);
  return {
    id,
    name: raw.name ?? fallback?.name,
    displayName: raw.displayName ?? fallback?.displayName,
    description: raw.description ?? fallback?.description,
    contextWindow: raw.contextWindow ?? fallback?.contextWindow,
    inputTokenLimit: raw.inputTokenLimit ?? fallback?.inputTokenLimit,
    outputTokenLimit: raw.outputTokenLimit ?? fallback?.outputTokenLimit,
    protocols:
      Array.isArray(raw.protocols) && raw.protocols.length > 0
        ? raw.protocols
        : fallback?.protocols,
    aliases: raw.aliases ?? fallback?.aliases,
  };
}

function formatBytes(bytes?: number): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${Math.round(bytes)} B`;
}

function formatCtx(num?: number): string {
  if (typeof num !== "number" || !Number.isFinite(num)) return "—";
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(num % 1_000_000 === 0 ? 0 : 1)}M`;
  if (num >= 1_000) return `${Math.round(num / 1_000)}K`;
  return String(num);
}

export function App2ApiModelsView({
  overview,
  notify,
}: App2ApiModelsViewProps) {
  const copyNotify: Notice = useCallback(
    (text, isErr) => notify(text, isErr ? "error" : "success"),
    [notify]
  );

  const models = useMemo(() => {
    const remote = Array.isArray(overview?.models) ? overview.models : [];
    if (remote.length === 0) return FALLBACK_MODELS;
    const seen = new Set<string>();
    const normalized: App2ApiModelItem[] = [];
    for (const item of remote) {
      const m = normalizeModelItem(item);
      if (!m || seen.has(m.id)) continue;
      seen.add(m.id);
      normalized.push(m);
    }
    return normalized.length > 0 ? normalized : FALLBACK_MODELS;
  }, [overview?.models]);

  const telemetryMap = useMemo(() => {
    const map = new Map<string, App2ApiModelTelemetry>();
    const raw = overview?.modelTelemetry;
    if (!raw) return map;
    if (Array.isArray(raw)) {
      for (const item of raw) {
        if (item && typeof item === "object" && item.model) {
          map.set(item.model, item);
        }
      }
      return map;
    }
    if (typeof raw === "object") {
      const snapshot = raw as App2ApiModelTelemetrySnapshot;
      if (snapshot.byModel && typeof snapshot.byModel === "object" && !Array.isArray(snapshot.byModel)) {
        for (const [modelId, entry] of Object.entries(snapshot.byModel)) {
          if (entry && typeof entry === "object" && !Array.isArray(entry)) {
            map.set(entry.model || modelId, entry);
          }
        }
        return map;
      }
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (v && typeof v === "object" && !Array.isArray(v)) {
          const entry = v as App2ApiModelTelemetry;
          map.set(entry.model || k, entry);
        }
      }
    }
    return map;
  }, [overview?.modelTelemetry]);

  return (
    <>
      <div className="app2api-two-col">
        <section className="panel" style={{ padding: "18px 20px" }}>
          <div className="app2api-panel-head">
            <div>
              <h3 style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Globe size={16} />
                8049 直连三协议端点
              </h3>
              <p className="cell-secondary">
                原生兼容 OpenAI、Google/Anthropic Messages 与 Gemini v1beta 三套协议
              </p>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <code className="app2api-code-chip">{DEFAULT_BASE_URL}</code>
              <CopyButton
                value={DEFAULT_BASE_URL}
                notify={copyNotify}
                title="复制 Base URL"
              />
            </div>
          </div>

          <div className="app2api-endpoint-grid">
            {PROTOCOL_ENDPOINTS.map((ep) => (
              <div key={ep.name} className="app2api-endpoint-card">
                <div className="app2api-endpoint-top">
                  <strong>{ep.name}</strong>
                  <Badge variant={ep.variant}>{ep.badge}</Badge>
                </div>
                <div className="app2api-endpoint-paths">
                  {ep.paths.map((p) => (
                    <div key={p} className="app2api-endpoint-row">
                      <code className="app2api-code-chip">{p}</code>
                      <CopyButton
                        value={`${DEFAULT_BASE_URL}${p}`}
                        notify={copyNotify}
                        title={`复制完整地址 ${DEFAULT_BASE_URL}${p}`}
                      />
                    </div>
                  ))}
                </div>
                <div className="app2api-endpoint-foot">
                  <span className="cell-secondary">Base: {ep.baseUrl}</span>
                  <CopyButton
                    value={ep.curl}
                    notify={copyNotify}
                    title="复制 curl 测试命令"
                  />
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="panel" style={{ padding: "18px 20px" }}>
          <div className="app2api-panel-head">
            <div>
              <h3 style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Link2 size={16} />
                接入 8046 上游池指引
              </h3>
              <p className="cell-secondary">
                在 Multi-ACP Gateway (8046) 的「账号管理」或「服务提供商」中添加 8049 作为上游节点
              </p>
            </div>
          </div>

          <div className="app2api-guide-list">
            <div className="app2api-guide-item">
              <span className="app2api-guide-label">上游地址 (Endpoint)</span>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <code className="app2api-code-chip">{DEFAULT_BASE_URL}</code>
                <CopyButton
                  value={DEFAULT_BASE_URL}
                  notify={copyNotify}
                  title="复制上游地址"
                />
              </div>
            </div>
            <div className="app2api-guide-item">
              <span className="app2api-guide-label">支持勾选协议</span>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                <Badge variant="green">chat</Badge>
                <Badge variant="amber">Google</Badge>
                <Badge variant="neutral">gemini</Badge>
              </div>
            </div>
            <div className="app2api-guide-item">
              <span className="app2api-guide-label">鉴权密钥 (API Key)</span>
              <span className="cell-secondary">
                在「API 密钥」标签页创建密钥后复制填入 8046 上游 Key 字段即可
              </span>
            </div>
          </div>
        </section>
      </div>

      <section className="panel">
        <div className="list-toolbar">
          <div className="list-summary">
            <Cpu size={16} style={{ color: "var(--pink-600)" }} />
            <strong>支持模型目录与遥测</strong>
            <Badge variant="neutral">{models.length} 个模型</Badge>
          </div>
          <span className="cell-secondary">
            {overview?.models?.length
              ? "已同步 8049 实时模型目录"
              : "当前展示默认模型预设（8049 在线后自动同步实时目录）"}
          </span>
        </div>

        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>模型 ID</th>
                <th>上下文 / 输出上限</th>
                <th>兼容协议</th>
                <th>遥测统计</th>
                <th style={{ textAlign: "right" }}>复制 ID</th>
              </tr>
            </thead>
            <tbody>
              {models.map((m) => {
                const id = m.id || m.name || "";
                const ctx = m.contextWindow ?? m.inputTokenLimit;
                const tel = telemetryMap.get(id);
                return (
                  <tr key={id}>
                    <td>
                      <strong>{id}</strong>
                      {(m.displayName || m.description) && (
                        <span className="cell-secondary">
                          {m.displayName && m.displayName !== id
                            ? `${m.displayName} · `
                            : ""}
                          {m.description || ""}
                        </span>
                      )}
                    </td>
                    <td>
                      <span>上下文 {formatCtx(ctx)}</span>
                      {typeof m.outputTokenLimit === "number" && (
                        <span className="cell-secondary">
                          输出上限 {formatCtx(m.outputTokenLimit)}
                        </span>
                      )}
                    </td>
                    <td>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                        {(m.protocols && m.protocols.length > 0
                          ? m.protocols
                          : ["openai", "anthropic", "gemini"]
                        ).map((p) => (
                          <Badge key={p} variant="neutral">
                            <Layers size={11} style={{ marginRight: 2 }} />
                            {p}
                          </Badge>
                        ))}
                      </div>
                    </td>
                    <td>
                      {tel ? (
                        (() => {
                          const reqs = typeof tel.requests === "number" ? tel.requests : 0;
                          const ok = typeof tel.successes === "number" ? tel.successes : 0;
                          const fail = typeof tel.failures === "number" ? tel.failures : 0;
                          const inFlight = typeof tel.inFlight === "number" ? tel.inFlight : 0;
                          const retries = typeof tel.retries === "number" ? tel.retries : 0;
                          const outputBytes =
                            typeof tel.outputBytes === "number" ? tel.outputBytes : 0;
                          const successRate =
                            reqs > 0 ? Math.round((ok / reqs) * 100) : null;
                          const metaParts: string[] = [];
                          if (successRate !== null) metaParts.push(`成功率 ${successRate}%`);
                          if (outputBytes > 0) metaParts.push(`输出 ${formatBytes(outputBytes)}`);
                          if (retries > 0) metaParts.push(`重试 ${retries}`);
                          if (typeof tel.avgLatencyMs === "number") {
                            metaParts.push(`平均延迟 ${Math.round(tel.avgLatencyMs)} ms`);
                          }
                          return (
                            <div>
                              <span>
                                请求 {reqs} · 成功 {ok}
                                {fail > 0 ? ` · 失败 ${fail}` : ""}
                                {inFlight > 0 ? ` · 进行中 ${inFlight}` : ""}
                              </span>
                              {metaParts.length > 0 && (
                                <span className="cell-secondary">
                                  {metaParts.join(" · ")}
                                </span>
                              )}
                            </div>
                          );
                        })()
                      ) : (
                        <span className="cell-secondary">暂无调用遥测</span>
                      )}
                    </td>
                    <td>
                      <div className="row-actions">
                        <CopyButton
                          value={id}
                          notify={copyNotify}
                          title={`复制模型 ID ${id}`}
                        />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
