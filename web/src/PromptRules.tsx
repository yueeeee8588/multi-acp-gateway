import { useCallback, useEffect, useState } from "react";
import { Plus, RotateCcw, Save, ShieldCheck, Sparkles, Trash2 } from "lucide-react";
import { api, errorMessage } from "./api";
import { Badge, Button, ErrorBox, Field, Toggle } from "./components";

export type ArmorMode = "standard" | "aggressive" | "pure_cache";

export type SensitiveWordRule = {
  pattern: string;
  replace: string;
  case_insensitive: boolean;
  enabled: boolean;
};

export type PromptTemplateItem = {
  id: string;
  name: string;
  default_instruction: string;
  effective_instruction: string;
  customized: boolean;
};

export type PromptRulesState = {
  armor_mode: ArmorMode;
  global_prompt: string;
  custom_template_prompts: Record<string, string>;
  templates: PromptTemplateItem[];
  sensitive_filter_enabled: boolean;
  sensitive_words: SensitiveWordRule[];
};

const MODE_OPTIONS: { id: ArmorMode; title: string; desc: string }[] = [
  {
    id: "standard",
    title: "系统层注入（保缓存）",
    desc: "按分组策略与全局提示词注入系统级指令，保持跨轮前缀稳定。",
  },
  {
    id: "aggressive",
    title: "双层注入（系统 + 轮次）",
    desc: "在系统级指令之外，于最新一条 user 消息头部额外注入执行锚点。",
  },
  {
    id: "pure_cache",
    title: "纯透传模式",
    desc: "不注入任何系统提示词与 Turn 锚点，保持原始前缀透传以最大化命中上游隐式缓存（仍可执行风控敏感词过滤）。",
  },
];

export function PromptRulesPage({
  revision,
  notify,
}: {
  revision: number;
  notify: (message: string, err?: boolean) => void;
}) {
  const [data, setData] = useState<PromptRulesState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const [armorMode, setArmorMode] = useState<ArmorMode>("standard");
  const [selectedKey, setSelectedKey] = useState<string>("__global__");
  const [globalPrompt, setGlobalPrompt] = useState("");
  const [templateDraft, setTemplateDraft] = useState("");

  const [filterEnabled, setFilterEnabled] = useState(false);
  const [rules, setRules] = useState<SensitiveWordRule[]>([]);
  const [newPattern, setNewPattern] = useState("");
  const [newReplace, setNewReplace] = useState("");
  const [newCaseInsensitive, setNewCaseInsensitive] = useState(false);
  const [testText, setTestText] = useState("");
  const [testResult, setTestResult] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await api<PromptRulesState>("/prompt-rules");
      setData(res);
      setArmorMode(res.armor_mode || "standard");
      setGlobalPrompt(res.global_prompt || "");
      setFilterEnabled(Boolean(res.sensitive_filter_enabled));
      setRules(Array.isArray(res.sensitive_words) ? res.sensitive_words : []);
      if (selectedKey !== "__global__") {
        const hit = (res.templates || []).find((t) => t.id === selectedKey);
        if (hit) setTemplateDraft(hit.effective_instruction || "");
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [selectedKey]);

  useEffect(() => {
    void load();
  }, [load, revision]);

  const currentTemplate = data?.templates.find((t) => t.id === selectedKey);

  const onSelectPromptKey = (key: string) => {
    setSelectedKey(key);
    if (key === "__global__") return;
    const hit = data?.templates.find((t) => t.id === key);
    setTemplateDraft(hit?.effective_instruction || "");
  };

  const switchMode = async (mode: ArmorMode) => {
    setSaving(true);
    try {
      const res = await api<PromptRulesState>("/prompt-rules", "PUT", { armor_mode: mode });
      setData(res);
      setArmorMode(res.armor_mode);
      notify(
        mode === "pure_cache"
          ? "已切换到：纯透传模式"
          : mode === "aggressive"
            ? "已切换到：双层注入（系统 + 轮次）"
            : "已切换到：系统层注入（保缓存）",
      );
    } catch (e) {
      notify(errorMessage(e), true);
    } finally {
      setSaving(false);
    }
  };

  const savePrompt = async () => {
    setSaving(true);
    try {
      const body =
        selectedKey === "__global__"
          ? { global_prompt: globalPrompt }
          : { custom_template_prompts: { [selectedKey]: templateDraft } };
      const res = await api<PromptRulesState>("/prompt-rules", "PUT", body);
      setData(res);
      if (selectedKey === "__global__") {
        setGlobalPrompt(res.global_prompt || "");
      } else {
        const hit = res.templates.find((t) => t.id === selectedKey);
        if (hit) setTemplateDraft(hit.effective_instruction || "");
      }
      notify("提示词已保存并热更新生效");
    } catch (e) {
      notify(errorMessage(e), true);
    } finally {
      setSaving(false);
    }
  };

  const resetPrompt = async () => {
    setSaving(true);
    try {
      const body =
        selectedKey === "__global__"
          ? { global_prompt: "" }
          : { reset_template_id: selectedKey };
      const res = await api<PromptRulesState>("/prompt-rules", "PUT", body);
      setData(res);
      if (selectedKey === "__global__") {
        setGlobalPrompt("");
      } else {
        const hit = res.templates.find((t) => t.id === selectedKey);
        if (hit) setTemplateDraft(hit.effective_instruction || "");
      }
      notify(selectedKey === "__global__" ? "已清空全局自定义提示词" : "已恢复该模板内置默认提示词");
    } catch (e) {
      notify(errorMessage(e), true);
    } finally {
      setSaving(false);
    }
  };

  const addRule = () => {
    const pat = newPattern.trim();
    if (!pat) {
      notify("请先输入需要过滤的敏感词", true);
      return;
    }
    setRules((prev) => [
      ...prev,
      { pattern: pat, replace: newReplace, case_insensitive: newCaseInsensitive, enabled: true },
    ]);
    setNewPattern("");
    setNewReplace("");
    setNewCaseInsensitive(false);
  };

  const saveSensitiveRules = async () => {
    setSaving(true);
    try {
      const res = await api<PromptRulesState>("/prompt-rules", "PUT", {
        sensitive_filter_enabled: filterEnabled,
        sensitive_words: rules,
      });
      setData(res);
      setFilterEnabled(Boolean(res.sensitive_filter_enabled));
      setRules(Array.isArray(res.sensitive_words) ? res.sensitive_words : []);
      notify("风控敏感词过滤规则已保存并热更新");
    } catch (e) {
      notify(errorMessage(e), true);
    } finally {
      setSaving(false);
    }
  };

  const runLocalPreview = () => {
    let out = testText;
    for (const r of rules) {
      if (!r.enabled || !r.pattern) continue;
      if (r.case_insensitive) {
        const escaped = r.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        out = out.replace(new RegExp(escaped, "gi"), r.replace || "");
      } else {
        out = out.split(r.pattern).join(r.replace || "");
      }
    }
    setTestResult(out);
  };

  return (
    <div style={{ display: "grid", gap: "18px" }}>
      <div className="page-heading">
        <div>
          <div className="eyebrow">PROMPT &amp; RISK CONTROL</div>
          <h1>提示词与风控</h1>
        </div>
        <Button onClick={() => void load()} disabled={loading || saving}>
          刷新
        </Button>
      </div>

      {error && <ErrorBox message={error} />}

      <section className="panel" style={{ padding: "18px 20px", display: "grid", gap: "14px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
          <div>
            <h2 style={{ margin: 0, fontSize: "16px" }}>注入模式与缓存策略</h2>
            <p style={{ margin: "4px 0 0", fontSize: "12.5px", opacity: 0.72 }}>选择全局提示词注入模式或切换到「纯透传模式」</p>
          </div>
          <Badge variant={armorMode === "pure_cache" ? "green" : armorMode === "aggressive" ? "amber" : "neutral"}>
            {armorMode === "pure_cache" ? "纯透传模式" : armorMode === "aggressive" ? "双层注入" : "系统层注入"}
          </Badge>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "12px" }}>
          {MODE_OPTIONS.map((opt) => {
            const active = armorMode === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                disabled={saving}
                onClick={() => void switchMode(opt.id)}
                style={{
                  textAlign: "left",
                  padding: "12px 14px",
                  borderRadius: "10px",
                  border: active ? "2px solid var(--accent, #1e3a5f)" : "1px solid var(--border, #e2e8f0)",
                  background: active ? "rgba(30, 58, 95, 0.06)" : "transparent",
                  cursor: "pointer",
                  display: "grid",
                  gap: "6px",
                }}
              >
                <div style={{ fontWeight: 600, fontSize: "14px", display: "flex", alignItems: "center", gap: "6px" }}>
                  <Sparkles size={15} />
                  {opt.title}
                </div>
                <div style={{ fontSize: "12.5px", opacity: 0.78, lineHeight: 1.5 }}>{opt.desc}</div>
              </button>
            );
          })}
        </div>
      </section>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(380px, 1fr))", gap: "18px", alignItems: "start" }}>
        <section className="panel" style={{ padding: "18px 20px", display: "grid", gap: "12px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "10px", flexWrap: "wrap" }}>
            <div>
              <h2 style={{ margin: 0, fontSize: "16px" }}>全局注入提示词</h2>
              <p style={{ margin: "4px 0 0", fontSize: "12.5px", opacity: 0.72 }}>
                {armorMode === "pure_cache"
                  ? "当前处于「纯透传模式」，以下系统提示词不会注入到请求中。"
                  : "选择「全局自定义覆盖」或任意内置模板，查看并修改其注入提示词。"}
              </p>
            </div>
            {selectedKey === "__global__" ? (
              <Badge variant={globalPrompt.trim() ? "amber" : "neutral"}>
                {globalPrompt.trim() ? "全局覆盖生效中" : "未设全局覆盖"}
              </Badge>
            ) : (
              <Badge variant={currentTemplate?.customized ? "amber" : "green"}>
                {currentTemplate?.customized ? "已自定义" : "内置默认"}
              </Badge>
            )}
          </div>
          <div style={{ display: "grid", gap: "12px" }}>
            <Field label="选择提示词对象">
              <select
                value={selectedKey}
                onChange={(e) => onSelectPromptKey(e.target.value)}
                style={{ width: "100%", padding: "8px 10px", borderRadius: "8px", border: "1px solid var(--border, #cbd5e1)" }}
              >
                <option value="__global__">全局统一覆盖提示词（留空则按分组模板）</option>
                {(data?.templates || []).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({t.id}){t.customized ? " · 已改" : ""}
                  </option>
                ))}
              </select>
            </Field>

            <Field
              label={selectedKey === "__global__" ? "全局提示词内容" : `模板提示词 (${selectedKey})`}
              hint={
                selectedKey === "__global__"
                  ? `当前 ${(globalPrompt || "").length} 字符。非空时将优先作为默认系统提示词注入。`
                  : `当前 ${(templateDraft || "").length} 字符。清空并保存或点击恢复默认可还原内置文本。`
              }
            >
              <textarea
                rows={13}
                value={selectedKey === "__global__" ? globalPrompt : templateDraft}
                onChange={(e) =>
                  selectedKey === "__global__"
                    ? setGlobalPrompt(e.target.value)
                    : setTemplateDraft(e.target.value)
                }
                placeholder={selectedKey === "__global__" ? "留空表示使用各分组绑定的模板提示词…" : ""}
                style={{
                  width: "100%",
                  padding: "10px 12px",
                  borderRadius: "8px",
                  border: "1px solid var(--border, #cbd5e1)",
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                  fontSize: "12.5px",
                  lineHeight: 1.55,
                  resize: "vertical",
                }}
              />
            </Field>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
              <Button type="button" disabled={saving} onClick={() => void resetPrompt()}>
                <RotateCcw size={15} />
                {selectedKey === "__global__" ? "清空全局覆盖" : "恢复默认"}
              </Button>
              <Button type="button" className="primary" disabled={saving} onClick={() => void savePrompt()}>
                <Save size={15} />
                保存提示词
              </Button>
            </div>
          </div>
        </section>

        <section className="panel" style={{ padding: "18px 20px", display: "grid", gap: "12px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "10px", flexWrap: "wrap" }}>
            <div>
              <h2 style={{ margin: 0, fontSize: "16px" }}>上游风控敏感词过滤</h2>
              <p style={{ margin: "4px 0 0", fontSize: "12.5px", opacity: 0.72 }}>
                发往上游前自动替换或删除敏感词（在系统层注入 / 双层注入 / 纯透传模式下均生效）。
              </p>
            </div>
            <Badge variant={filterEnabled ? "green" : "neutral"}>
              {filterEnabled ? `已启用 (${rules.filter((r) => r.enabled).length} 条)` : "已停用"}
            </Badge>
          </div>
          <div style={{ display: "grid", gap: "12px" }}>
            <Toggle
              checked={filterEnabled}
              onChange={setFilterEnabled}
              label="启用上游风控敏感词过滤（确定性文本替换，不破坏前缀缓存）"
            />

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto auto", gap: "8px", alignItems: "center" }}>
              <input
                type="text"
                value={newPattern}
                onChange={(e) => setNewPattern(e.target.value)}
                placeholder="敏感词"
                style={{ padding: "7px 10px", borderRadius: "8px", border: "1px solid var(--border, #cbd5e1)" }}
              />
              <input
                type="text"
                value={newReplace}
                onChange={(e) => setNewReplace(e.target.value)}
                placeholder="替换为（留空删除）"
                style={{ padding: "7px 10px", borderRadius: "8px", border: "1px solid var(--border, #cbd5e1)" }}
              />
              <label style={{ display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "12.5px", whiteSpace: "nowrap" }}>
                <input
                  type="checkbox"
                  checked={newCaseInsensitive}
                  onChange={(e) => setNewCaseInsensitive(e.target.checked)}
                />
                忽略大小写
              </label>
              <Button type="button" onClick={addRule}>
                <Plus size={15} />
                添加
              </Button>
            </div>

            <div style={{ border: "1px solid var(--border, #e2e8f0)", borderRadius: "8px", maxHeight: "260px", overflow: "auto" }}>
              {rules.length === 0 ? (
                <div style={{ padding: "18px", textAlign: "center", fontSize: "13px", opacity: 0.65 }}>
                  暂无敏感词规则
                </div>
              ) : (
                rules.map((r, idx) => (
                  <div
                    key={idx}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "auto 1fr 1fr auto auto",
                      gap: "8px",
                      alignItems: "center",
                      padding: "8px 10px",
                      borderBottom: idx === rules.length - 1 ? "none" : "1px solid var(--border, #e2e8f0)",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={r.enabled}
                      onChange={(e) =>
                        setRules((prev) =>
                          prev.map((item, i) => (i === idx ? { ...item, enabled: e.target.checked } : item)),
                        )
                      }
                    />
                    <input
                      type="text"
                      value={r.pattern}
                      onChange={(e) =>
                        setRules((prev) =>
                          prev.map((item, i) => (i === idx ? { ...item, pattern: e.target.value } : item)),
                        )
                      }
                      style={{ padding: "5px 8px", borderRadius: "6px", border: "1px solid var(--border, #cbd5e1)", fontSize: "12.5px" }}
                    />
                    <input
                      type="text"
                      value={r.replace}
                      placeholder="(删除)"
                      onChange={(e) =>
                        setRules((prev) =>
                          prev.map((item, i) => (i === idx ? { ...item, replace: e.target.value } : item)),
                        )
                      }
                      style={{ padding: "5px 8px", borderRadius: "6px", border: "1px solid var(--border, #cbd5e1)", fontSize: "12.5px" }}
                    />
                    <label style={{ display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "12px", whiteSpace: "nowrap" }}>
                      <input
                        type="checkbox"
                        checked={r.case_insensitive}
                        onChange={(e) =>
                          setRules((prev) =>
                            prev.map((item, i) => (i === idx ? { ...item, case_insensitive: e.target.checked } : item)),
                          )
                        }
                      />
                      Aa
                    </label>
                    <Button
                      type="button"
                      className="small-button"
                      onClick={() => setRules((prev) => prev.filter((_, i) => i !== idx))}
                    >
                      <Trash2 size={14} />
                    </Button>
                  </div>
                ))
              )}
            </div>

            <div style={{ display: "grid", gap: "6px", paddingTop: "8px", borderTop: "1px dashed var(--border, #e2e8f0)" }}>
              <div style={{ fontSize: "12.5px", fontWeight: 600 }}>本地预览测试</div>
              <div style={{ display: "flex", gap: "8px" }}>
                <input
                  type="text"
                  value={testText}
                  onChange={(e) => setTestText(e.target.value)}
                  placeholder="输入测试文本，点击预览过滤效果…"
                  style={{ flex: 1, padding: "7px 10px", borderRadius: "8px", border: "1px solid var(--border, #cbd5e1)" }}
                />
                <Button type="button" onClick={runLocalPreview}>
                  <ShieldCheck size={15} />
                  测试预览
                </Button>
              </div>
              {testResult !== null && (
                <div style={{ fontSize: "12.5px", padding: "6px 10px", borderRadius: "6px", background: "rgba(30,58,95,0.06)", wordBreak: "break-all" }}>
                  过滤结果：{testResult}
                </div>
              )}
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px", flexWrap: "wrap" }}>
              <Button type="button" className="primary" disabled={saving} onClick={() => void saveSensitiveRules()}>
                <Save size={15} />
                保存风控规则
              </Button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
