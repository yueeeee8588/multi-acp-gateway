import { useCallback, useEffect, useMemo, useState } from "react";
import type { MouseEvent } from "react";
import {
  ChevronDown,
  ChevronRight,
  Cpu,
  MessageSquareText,
  RefreshCw,
} from "lucide-react";
import {
  Badge,
  Button,
  CopyButton,
  Empty,
  ErrorBox,
  Field,
  SearchInput,
  Select,
} from "../components";
import type { Notice } from "../components";
import { useMinSpin } from "../useMinSpin";
import { fetchAcpModelCatalog, updateModelLimits } from "./api";
import type { GeminiModelItem } from "./types";

export interface AcpModelsViewProps {
  onTryModel?: (modelId: string) => void;
  notify: (msg: string, kind?: "success" | "error") => void;
}

interface LimitDraft {
  inputTokenLimit: string;
  outputTokenLimit: string;
}

const METHOD_OPTIONS = [
  { value: "all", label: "全部方法" },
  { value: "generateContent", label: "generateContent" },
  { value: "streamGenerateContent", label: "streamGenerateContent" },
  { value: "countTokens", label: "countTokens" },
] as const;

function normalizeId(name: string): string {
  return name.replace(/^models\//, "");
}

function detectFamily(model: GeminiModelItem): {
  label: string;
  variant: "green" | "neutral" | "amber";
} {
  const id = normalizeId(model.name).toLowerCase();
  const display = (model.displayName || "").toLowerCase();
  if (id.includes("claude") || display.includes("claude")) {
    return { label: "Claude", variant: "amber" };
  }
  if (id.includes("gemini") || display.includes("gemini")) {
    return { label: "Gemini", variant: "green" };
  }
  if (id.includes("gpt") || id.includes("oss") || display.includes("oss")) {
    return { label: "OSS", variant: "neutral" };
  }
  return { label: "Model", variant: "neutral" };
}

function formatNumber(val?: number): string {
  if (typeof val !== "number" || !Number.isFinite(val)) return "-";
  return val.toLocaleString("en-US");
}

function toDraft(item: GeminiModelItem): LimitDraft {
  return {
    inputTokenLimit:
      typeof item.inputTokenLimit === "number" ? String(item.inputTokenLimit) : "",
    outputTokenLimit:
      typeof item.outputTokenLimit === "number" ? String(item.outputTokenLimit) : "",
  };
}

function parseLimit(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("输入和输出上限非空时必须为正整数");
  }
  return parsed;
}

export function AcpModelsView({
  onTryModel,
  notify,
}: AcpModelsViewProps) {
  const [models, setModels] = useState<GeminiModelItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const refreshSpinning = useMinSpin(manualRefreshing);
  const [errorMsg, setErrorMsg] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedMethod, setSelectedMethod] = useState<string>("all");
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [limitDrafts, setLimitDrafts] = useState<Record<string, LimitDraft>>({});
  const [savingLimits, setSavingLimits] = useState<Set<string>>(() => new Set());

  const copyNotify: Notice = useCallback(
    (text, error) => {
      notify(text, error ? "error" : "success");
    },
    [notify]
  );

  const loadModels = useCallback(
    async (options?: {
      forceRefresh?: boolean;
      notifyOnSuccess?: boolean;
      manual?: boolean;
    }): Promise<GeminiModelItem[] | null> => {
      setLoading(true);
      if (options?.manual) setManualRefreshing(true);
      setErrorMsg("");
      try {
        const list = await fetchAcpModelCatalog({
          refresh: options?.forceRefresh,
        });
        setModels(list);
        if (options?.notifyOnSuccess) {
          notify(`已刷新模型目录，共 ${list.length} 个模型`, "success");
        }
        return list;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "加载模型目录失败";
        setErrorMsg(msg);
        notify(msg, "error");
        return null;
      } finally {
        setLoading(false);
        if (options?.manual) setManualRefreshing(false);
      }
    },
    [notify]
  );

  useEffect(() => {
    void loadModels();
  }, [loadModels]);

  const filteredModels = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return models.filter((m) => {
      const id = normalizeId(m.name).toLowerCase();
      const display = (m.displayName || "").toLowerCase();
      const desc = (m.description || "").toLowerCase();
      const methods = m.supportedGenerationMethods || [];

      if (selectedMethod !== "all" && !methods.includes(selectedMethod)) {
        return false;
      }

      if (!q) return true;

      return (
        id.includes(q) ||
        display.includes(q) ||
        desc.includes(q) ||
        methods.some((item) => item.toLowerCase().includes(q))
      );
    });
  }, [models, searchQuery, selectedMethod]);

  const toggleExpand = useCallback(
    (item: GeminiModelItem) => {
      setExpandedIds((prev) => {
        const next = new Set(prev);
        if (next.has(item.name)) {
          next.delete(item.name);
        } else {
          next.add(item.name);
          setLimitDrafts((drafts) => ({
            ...drafts,
            [item.name]: drafts[item.name] ?? toDraft(item),
          }));
        }
        return next;
      });
    },
    []
  );

  const updateDraftField = useCallback(
    (modelName: string, field: keyof LimitDraft, value: string, fallback: GeminiModelItem) => {
      setLimitDrafts((prev) => ({
        ...prev,
        [modelName]: {
          ...(prev[modelName] ?? toDraft(fallback)),
          [field]: value,
        },
      }));
    },
    []
  );

  const handleSaveLimits = useCallback(
    async (item: GeminiModelItem, clear = false) => {
      if (savingLimits.has(item.name)) return;
      try {
        const draft = limitDrafts[item.name] ?? toDraft(item);
        const body = clear
          ? { inputTokenLimit: null, outputTokenLimit: null }
          : {
              inputTokenLimit: parseLimit(draft.inputTokenLimit),
              outputTokenLimit: parseLimit(draft.outputTokenLimit),
            };

        setSavingLimits((prev) => {
          const next = new Set(prev);
          next.add(item.name);
          return next;
        });

        await updateModelLimits(normalizeId(item.name), body);

        if (clear) {
          setLimitDrafts((prev) => ({
            ...prev,
            [item.name]: { inputTokenLimit: "", outputTokenLimit: "" },
          }));
        }

        const refreshed = await loadModels();
        if (refreshed) {
          const updated = refreshed.find((m) => m.name === item.name);
          if (updated) {
            setLimitDrafts((prev) => ({
              ...prev,
              [item.name]: toDraft(updated),
            }));
          }
          notify(clear ? "模型限制已清空" : "模型限制已保存", "success");
        } else {
          notify("限制已更新，但目录刷新失败，请手动刷新", "error");
        }
      } catch (err) {
        notify(
          err instanceof Error ? err.message : "更新模型限制失败",
          "error"
        );
      } finally {
        setSavingLimits((prev) => {
          const next = new Set(prev);
          next.delete(item.name);
          return next;
        });
      }
    },
    [limitDrafts, loadModels, notify, savingLimits]
  );

  const stopPropagation = (e: MouseEvent) => {
    e.stopPropagation();
  };

  return (
    <div>
      <div className="page-heading">
        <div>
          <div className="eyebrow">ACP · /v1beta/models</div>
          <h1>
            模型目录
            <span className="title-count">{models.length}</span>
          </h1>
          <p>查看 ACP Worker 支持的 Gemini 原生模型目录，支持筛选与 Token 上限覆盖配置</p>
        </div>
        <Button
          onClick={() =>
            void loadModels({ forceRefresh: true, notifyOnSuccess: true, manual: true })
          }
          disabled={loading}
        >
          <RefreshCw size={15} className={refreshSpinning ? "spin" : undefined} />
          刷新目录
        </Button>
      </div>

      {errorMsg && (
        <div className="inline-error">
          <ErrorBox message={errorMsg} />
          <Button
            onClick={() =>
              void loadModels({ forceRefresh: true, notifyOnSuccess: true, manual: true })
            }
            disabled={loading}
          >
            <RefreshCw size={15} className={refreshSpinning ? "spin" : undefined} />
            重试
          </Button>
        </div>
      )}

      <section className="data-section">
        <div className="list-toolbar">
          <SearchInput
            value={searchQuery}
            onChange={setSearchQuery}
            placeholder="搜索模型 ID、名称、描述或支持方法..."
          />
          <div className="toolbar-meta">
            <Select
              aria-label="按支持方法筛选"
              value={selectedMethod}
              onChange={(e) => setSelectedMethod(e.target.value)}
            >
              {METHOD_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </Select>
            <span>
              显示 {filteredModels.length} / {models.length}
            </span>
          </div>
        </div>

        {filteredModels.length === 0 ? (
          <Empty
            title={loading ? "正在加载模型目录..." : "暂无匹配的模型"}
            detail={
              models.length === 0 && !loading
                ? "当前网关未返回可用模型，请检查账号或点击右上角刷新。"
                : "尝试调整搜索关键词或切换方法筛选条件。"
            }
            action={
              searchQuery || selectedMethod !== "all" ? (
                <Button
                  onClick={() => {
                    setSearchQuery("");
                    setSelectedMethod("all");
                  }}
                >
                  重置筛选
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>模型 ID / 名称</th>
                  <th>家族 / 来源</th>
                  <th className="numeric">输入上限</th>
                  <th className="numeric">输出上限</th>
                  <th className="action-cell">操作</th>
                </tr>
              </thead>
              <tbody>
                {filteredModels.map((item) => {
                  const modelId = normalizeId(item.name);
                  const expanded = expandedIds.has(item.name);
                  const saving = savingLimits.has(item.name);
                  const family = detectFamily(item);
                  const draft = limitDrafts[item.name] ?? toDraft(item);
                  const methods = item.supportedGenerationMethods || [];

                  return (
                    <ModelRow
                      key={item.name}
                      item={item}
                      modelId={modelId}
                      expanded={expanded}
                      saving={saving}
                      family={family}
                      draft={draft}
                      methods={methods}
                      copyNotify={copyNotify}
                      onToggle={() => toggleExpand(item)}
                      onStopPropagation={stopPropagation}
                      onDraftChange={(field, value) =>
                        updateDraftField(item.name, field, value, item)
                      }
                      onSave={(clear) => void handleSaveLimits(item, clear)}
                      onTryModel={onTryModel}
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="table-footer">
          <span>点击任意模型行可展开详情并配置 Token 上限</span>
          <span className="mono">/acp-api/api/models/catalog</span>
        </div>
      </section>
    </div>
  );
}

interface ModelRowProps {
  item: GeminiModelItem;
  modelId: string;
  expanded: boolean;
  saving: boolean;
  family: { label: string; variant: "green" | "neutral" | "amber" };
  draft: LimitDraft;
  methods: string[];
  copyNotify: Notice;
  onToggle: () => void;
  onStopPropagation: (e: MouseEvent) => void;
  onDraftChange: (field: keyof LimitDraft, value: string) => void;
  onSave: (clear?: boolean) => void;
  onTryModel?: (modelId: string) => void;
}

function ModelRow({
  item,
  modelId,
  expanded,
  saving,
  family,
  draft,
  methods,
  copyNotify,
  onToggle,
  onStopPropagation,
  onDraftChange,
  onSave,
  onTryModel,
}: ModelRowProps) {
  return (
    <>
      <tr
        onClick={onToggle}
        style={{
          cursor: "pointer",
          background: expanded ? "var(--pink-50)" : undefined,
        }}
      >
        <td>
          <div className="entity-cell">
            <span className="entity-icon">
              <Cpu size={17} />
            </span>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <strong className="mono">{modelId}</strong>
                <span onClick={onStopPropagation}>
                  <CopyButton
                    value={modelId}
                    notify={copyNotify}
                    title={`复制模型 ID: ${modelId}`}
                  />
                </span>
              </div>
              {item.displayName && (
                <span className="cell-secondary">{item.displayName}</span>
              )}
            </div>
          </div>
        </td>
        <td>
          <div className="model-badges">
            <Badge variant={family.variant}>{family.label}</Badge>
            <Badge variant="green" dot>
              ACP Worker
            </Badge>
          </div>
        </td>
        <td className="numeric mono">{formatNumber(item.inputTokenLimit)}</td>
        <td className="numeric mono">{formatNumber(item.outputTokenLimit)}</td>
        <td className="action-cell">
          <div className="row-actions">
            <span
              className="muted"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                fontSize: 12,
                fontWeight: 700,
              }}
            >
              {expanded ? "收起" : "详情"}
              {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
            </span>
          </div>
        </td>
      </tr>

      {expanded && (
        <tr>
          <td
            colSpan={5}
            style={{
              padding: "16px 22px 20px",
              background: "var(--cream)",
              whiteSpace: "normal",
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {item.description && (
                <p
                  style={{
                    fontSize: 13,
                    lineHeight: 1.65,
                    color: "var(--ink-soft)",
                  }}
                >
                  {item.description}
                </p>
              )}

              <div
                onClick={onStopPropagation}
                style={{
                  padding: "14px 16px",
                  border: "1.5px solid var(--line)",
                  borderRadius: "var(--radius)",
                  background: "var(--surface)",
                  display: "flex",
                  flexDirection: "column",
                  gap: 12,
                }}
              >
                <strong style={{ fontSize: 13, color: "var(--ink)" }}>
                  Token 上限配置
                </strong>
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    alignItems: "flex-end",
                    gap: 12,
                  }}
                >
                  <div style={{ width: 210 }}>
                    <Field label="输入上限（留空不限）">
                      <input
                        type="number"
                        min={1}
                        step={1}
                        placeholder="留空不限"
                        value={draft.inputTokenLimit}
                        disabled={saving}
                        onChange={(e) =>
                          onDraftChange("inputTokenLimit", e.target.value)
                        }
                      />
                    </Field>
                  </div>
                  <div style={{ width: 210 }}>
                    <Field label="输出上限（留空不限）">
                      <input
                        type="number"
                        min={1}
                        step={1}
                        placeholder="留空不限"
                        value={draft.outputTokenLimit}
                        disabled={saving}
                        onChange={(e) =>
                          onDraftChange("outputTokenLimit", e.target.value)
                        }
                      />
                    </Field>
                  </div>
                  <Button
                    type="button"
                    className="primary small-button"
                    busy={saving}
                    onClick={() => onSave(false)}
                  >
                    {saving ? "提交中..." : "保存限制"}
                  </Button>
                  <Button
                    type="button"
                    className="small-button"
                    disabled={saving}
                    onClick={() => onSave(true)}
                  >
                    清空留空
                  </Button>
                </div>
              </div>

              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  <span
                    className="muted"
                    style={{ fontSize: 12, fontWeight: 700, marginRight: 4 }}
                  >
                    支持方法:
                  </span>
                  {methods.length > 0 ? (
                    methods.map((method) => (
                      <Badge key={method} variant="neutral">
                        <span className="mono">{method}</span>
                      </Badge>
                    ))
                  ) : (
                    <span className="muted">-</span>
                  )}
                </div>

                {onTryModel && (
                  <Button
                    type="button"
                    className="primary small-button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onTryModel(modelId);
                    }}
                  >
                    <MessageSquareText size={14} />
                    去聊天试用
                  </Button>
                )}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
