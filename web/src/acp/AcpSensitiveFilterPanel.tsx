import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Maximize2,
  Minimize2,
  Plus,
  Save,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { Badge, Button, ErrorBox, Toggle } from '../components';
import { updateConfig } from './api';
import type {
  AcpSensitiveWordRule,
  AcpSensitiveWordScope,
  GatewayConfig,
} from './types';

export const CLIENT_DESENSITIZE_RULES: AcpSensitiveWordRule[] = [
  {
    pattern: 'You are an AI agent running in OpenCode*',
    replace: '',
    case_insensitive: true,
    enabled: true,
    scope: 'all',
  },
  {
    pattern: '*An AI coding assistant running through an API relay*',
    replace: '',
    case_insensitive: true,
    enabled: true,
    scope: 'all',
  },
  {
    pattern: '*running through an API relay*',
    replace: '',
    case_insensitive: true,
    enabled: true,
    scope: 'all',
  },
  {
    pattern: '*WorkBuddy*',
    replace: '',
    case_insensitive: true,
    enabled: true,
    scope: 'all',
  },
  {
    pattern: '*the codex cli is an open*source project*',
    replace: '',
    case_insensitive: true,
    enabled: true,
    scope: 'all',
  },
  {
    pattern: '*You are a helpful assistant*',
    replace: '',
    case_insensitive: true,
    enabled: true,
    scope: 'all',
  },
];

const MONO_FONT_FAMILY =
  'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

const SCOPE_OPTIONS_ADD: Array<{ value: AcpSensitiveWordScope; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'system', label: '系统提示' },
  { value: 'messages', label: '对话消息' },
  { value: 'tools', label: '工具描述' },
];

const SCOPE_OPTIONS_SHORT: Array<{ value: AcpSensitiveWordScope; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'system', label: '系统' },
  { value: 'messages', label: '消息' },
  { value: 'tools', label: '工具' },
];

function normalizeScope(scope?: string): AcpSensitiveWordScope {
  if (
    scope === 'system' ||
    scope === 'messages' ||
    scope === 'tools' ||
    scope === 'all'
  ) {
    return scope;
  }
  return 'all';
}

function cloneRules(rules?: AcpSensitiveWordRule[]): AcpSensitiveWordRule[] {
  if (!Array.isArray(rules)) return [];
  return rules.map((r) => ({
    pattern: r.pattern ?? '',
    replace: r.replace ?? '',
    case_insensitive: Boolean(r.case_insensitive),
    enabled: Boolean(r.enabled),
    scope: normalizeScope(r.scope),
  }));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildSensitiveWordRegex(
  pattern: string,
  caseInsensitive: boolean
): RegExp | null {
  const normalized = pattern.replace(/\*+/g, '*');
  if (!normalized || normalized === '*') return null;

  const flags = caseInsensitive ? 'gi' : 'g';
  if (!normalized.includes('*')) {
    return new RegExp(escapeRegExp(normalized), flags);
  }

  const parts = normalized.split('*');
  let regexSource = '';
  for (let i = 0; i < parts.length; i += 1) {
    regexSource += escapeRegExp(parts[i]);
    if (i < parts.length - 1) {
      const isLeadingOrTrailing =
        (i === 0 && parts[0] === '') ||
        (i === parts.length - 2 && parts[parts.length - 1] === '');
      regexSource += isLeadingOrTrailing ? '[^\\r\\n]*' : '[^\\r\\n]*?';
    }
  }
  return new RegExp(regexSource, flags);
}

export interface AcpSensitiveFilterPanelProps {
  config: GatewayConfig | null;
  onSaved: (updated: GatewayConfig) => void;
  notify: (msg: string, kind?: 'success' | 'error') => void;
}

export function AcpSensitiveFilterPanel({
  config,
  onSaved,
  notify,
}: AcpSensitiveFilterPanelProps) {
  const [filterEnabled, setFilterEnabled] = useState<boolean>(
    () => Boolean(config?.sensitiveFilterEnabled)
  );
  const [rules, setRules] = useState<AcpSensitiveWordRule[]>(
    () => cloneRules(config?.sensitiveWords)
  );
  const [newScope, setNewScope] = useState<AcpSensitiveWordScope>('all');
  const [newPattern, setNewPattern] = useState('');
  const [newReplace, setNewReplace] = useState('');
  const [newCaseInsensitive, setNewCaseInsensitive] = useState(false);
  const [expandedRows, setExpandedRows] = useState<Record<number, boolean>>({});
  const [testScope, setTestScope] = useState<AcpSensitiveWordScope>('all');
  const [testText, setTestText] = useState('');
  const [testResult, setTestResult] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [error, setError] = useState('');

  const syncedRef = useRef<{ enabled: boolean; rulesJson: string }>({
    enabled: Boolean(config?.sensitiveFilterEnabled),
    rulesJson: JSON.stringify(cloneRules(config?.sensitiveWords)),
  });

  const isRulesDirty = useMemo(() => {
    return JSON.stringify(rules) !== syncedRef.current.rulesJson;
  }, [rules]);

  useEffect(() => {
    if (!config) return;
    const nextEnabled = Boolean(config.sensitiveFilterEnabled);
    const nextRules = cloneRules(config.sensitiveWords);
    const nextRulesJson = JSON.stringify(nextRules);

    if (!toggling && nextEnabled !== syncedRef.current.enabled) {
      syncedRef.current.enabled = nextEnabled;
      setFilterEnabled(nextEnabled);
    }

    if (!isRulesDirty && nextRulesJson !== syncedRef.current.rulesJson) {
      syncedRef.current.rulesJson = nextRulesJson;
      setRules(nextRules);
    }
  }, [config, isRulesDirty, toggling]);

  const activeRuleCount = useMemo(
    () => rules.filter((r) => r.enabled && r.pattern.trim().length > 0).length,
    [rules]
  );

  function addRule() {
    const pat = newPattern.trim();
    if (!pat) {
      notify('请先输入需要过滤的敏感词', 'error');
      return;
    }
    setRules((prev) => [
      ...prev,
      {
        pattern: pat,
        replace: newReplace,
        case_insensitive: newCaseInsensitive,
        enabled: true,
        scope: newScope,
      },
    ]);
    setNewPattern('');
    setNewReplace('');
    setNewCaseInsensitive(false);
    setNewScope('all');
  }

  function removeRule(idx: number) {
    setRules((prev) => prev.filter((_, i) => i !== idx));
    setExpandedRows((prev) => {
      const next: Record<number, boolean> = {};
      for (const [keyStr, val] of Object.entries(prev)) {
        const key = Number(keyStr);
        if (key < idx && val) next[key] = true;
        if (key > idx && val) next[key - 1] = true;
      }
      return next;
    });
  }

  function toggleExpand(idx: number) {
    setExpandedRows((prev) => ({ ...prev, [idx]: !prev[idx] }));
  }

  function importClientDesensitizeRules() {
    const existing = new Set(rules.map((r) => r.pattern.toLowerCase()));
    const toAdd = CLIENT_DESENSITIZE_RULES.filter(
      (r) => !existing.has(r.pattern.toLowerCase())
    );
    if (toAdd.length === 0) {
      notify('所有客户端脱敏规则已存在', 'success');
      return;
    }
    setRules((prev) => [...prev, ...toAdd.map((r) => ({ ...r }))]);
    notify(
      `已导入 ${toAdd.length} 条客户端脱敏规则，请点击保存风控规则生效`,
      'success'
    );
  }

  function runLocalPreview() {
    let out = testText;
    for (const r of rules) {
      if (!r.enabled || r.pattern.trim().length === 0) continue;
      const ruleScope = normalizeScope(r.scope);
      if (
        testScope !== 'all' &&
        ruleScope !== 'all' &&
        ruleScope !== testScope
      ) {
        continue;
      }
      const regex = buildSensitiveWordRegex(r.pattern, r.case_insensitive);
      if (!regex) continue;
      out = out.replace(regex, () => r.replace ?? '');
    }
    setTestResult(out);
  }

  async function handleToggleEnabled(next: boolean) {
    if (toggling || saving) return;
    setError('');
    setFilterEnabled(next);
    setToggling(true);
    try {
      const updated = await updateConfig({
        sensitiveFilterEnabled: next,
      });
      const nextEnabled = Boolean(updated.sensitiveFilterEnabled);
      syncedRef.current = {
        ...syncedRef.current,
        enabled: nextEnabled,
      };
      setFilterEnabled(nextEnabled);
      onSaved(updated);
      notify(
        next ? '已启用上游风控敏感词过滤' : '已停用上游风控敏感词过滤',
        'success'
      );
    } catch (err) {
      setFilterEnabled(!next);
      const message = err instanceof Error ? err.message : '切换风控开关失败';
      setError(message);
      notify(message, 'error');
    } finally {
      setToggling(false);
    }
  }

  async function saveSensitiveRules() {
    if (saving) return;
    setError('');
    setSaving(true);
    try {
      const updated = await updateConfig({
        sensitiveFilterEnabled: filterEnabled,
        sensitiveWords: rules,
      });
      const nextEnabled = Boolean(updated.sensitiveFilterEnabled);
      const nextRules = cloneRules(updated.sensitiveWords);
      syncedRef.current = {
        enabled: nextEnabled,
        rulesJson: JSON.stringify(nextRules),
      };
      setFilterEnabled(nextEnabled);
      setRules(nextRules);
      onSaved(updated);
      notify('风控敏感词过滤规则已保存并热更新', 'success');
    } catch (err) {
      const message = err instanceof Error ? err.message : '保存风控规则失败';
      setError(message);
      notify(message, 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section id="acp-sensitive-filter" className="settings-section">
      <div className="settings-section-heading">
        <span className="settings-icon">
          <ShieldAlert size={20} />
        </span>
        <div>
          <h2>上游风控敏感词过滤</h2>
          <p>
            发往上游前确定性替换或删除敏感词（支持 * 通配符与作用域过滤，严格保留工具名与参数结构），降低上游风控拦截风险
          </p>
        </div>
        <div
          style={{
            marginLeft: 'auto',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            flexWrap: 'wrap',
            flexShrink: 0,
          }}
        >
          {isRulesDirty && (
            <>
              <Badge variant="amber" dot>
                规则未保存
              </Badge>
              <Button
                type="button"
                className="small-button primary"
                busy={saving}
                onClick={() => void saveSensitiveRules()}
              >
                <Save size={14} />
                保存规则
              </Button>
            </>
          )}
          <Badge variant={filterEnabled ? 'green' : 'neutral'} dot>
            {filterEnabled ? `已启用 (${activeRuleCount} 条)` : '已停用'}
          </Badge>
        </div>
      </div>

      <div className="settings-section-body">
        <Toggle
          checked={filterEnabled}
          onChange={(next) => void handleToggleEnabled(next)}
          label="启用上游风控敏感词过滤（支持 * 通配符与作用域过滤，作用于系统提示、对话消息与工具描述）"
        />

        {/* 新增规则栏 */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'auto minmax(0, 1fr) auto minmax(0, 1fr) auto auto',
            gap: '8px',
            alignItems: 'center',
          }}
        >
          <select
            aria-label="新增规则作用域"
            value={newScope}
            onChange={(e) => setNewScope(normalizeScope(e.target.value))}
            style={{
              padding: '7px 8px',
              borderRadius: '8px',
              border: '1px solid var(--border, #cbd5e1)',
              background: 'var(--bg-input, #ffffff)',
              fontSize: '12.5px',
            }}
          >
            {SCOPE_OPTIONS_ADD.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <input
            type="text"
            value={newPattern}
            onChange={(e) => setNewPattern(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addRule();
              }
            }}
            placeholder="敏感词（支持 * 通配符）"
            style={{
              width: '100%',
              minWidth: 0,
              padding: '7px 10px',
              borderRadius: '8px',
              border: '1px solid var(--border, #cbd5e1)',
              fontFamily: MONO_FONT_FAMILY,
              fontSize: '12.5px',
            }}
          />
          <span
            style={{
              fontFamily: MONO_FONT_FAMILY,
              fontSize: '11.5px',
              fontWeight: 600,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              color: 'var(--text-muted, #64748b)',
              textAlign: 'center',
              userSelect: 'none',
              padding: '0 2px',
            }}
          >
            TO
          </span>
          <input
            type="text"
            value={newReplace}
            onChange={(e) => setNewReplace(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addRule();
              }
            }}
            placeholder="留空 = 删除匹配内容"
            style={{
              width: '100%',
              minWidth: 0,
              padding: '7px 10px',
              borderRadius: '8px',
              border: '1px solid var(--border, #cbd5e1)',
              fontFamily: MONO_FONT_FAMILY,
              fontSize: '12.5px',
            }}
          />
          <label
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
              fontSize: '12.5px',
              whiteSpace: 'nowrap',
              cursor: 'pointer',
            }}
          >
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

        {/* 规则列表：独立圆角卡片风 */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
            maxHeight: '460px',
            overflowY: 'auto',
            paddingRight: '2px',
          }}
        >
          {rules.length === 0 ? (
            <div
              style={{
                padding: '22px',
                textAlign: 'center',
                fontSize: '13px',
                opacity: 0.65,
                border: '1px dashed var(--border, #e2e8f0)',
                borderRadius: '12px',
              }}
            >
              暂无敏感词规则
            </div>
          ) : (
            rules.map((r, idx) => {
              const isExpanded = Boolean(expandedRows[idx]);
              const ruleScope = normalizeScope(r.scope);
              const hasWildcard = r.pattern.includes('*');

              return (
                <div
                  key={idx}
                  style={{
                    border: '1px solid var(--border, #e2e8f0)',
                    borderRadius: '12px',
                    padding: '12px 14px',
                    background: 'var(--bg-card, rgba(248, 250, 252, 0.72))',
                    opacity: r.enabled ? 1 : 0.6,
                    transition: 'opacity 0.15s ease',
                    display: 'grid',
                    gridTemplateColumns:
                      '26px auto auto minmax(0, 1fr) auto minmax(0, 1fr) auto',
                    columnGap: '8px',
                    rowGap: '6px',
                    alignItems: isExpanded ? 'start' : 'center',
                  }}
                >
                  {/* 第 1 行：主编辑行 */}
                  <span
                    style={{
                      fontFamily: MONO_FONT_FAMILY,
                      fontSize: '12px',
                      color: 'var(--text-muted, #64748b)',
                      opacity: 0.75,
                      textAlign: 'right',
                      paddingTop: isExpanded ? '6px' : undefined,
                      userSelect: 'none',
                    }}
                  >
                    {idx + 1}.
                  </span>

                  <input
                    type="checkbox"
                    checked={r.enabled}
                    aria-label={`启用规则 ${idx + 1}`}
                    onChange={(e) =>
                      setRules((prev) =>
                        prev.map((item, i) =>
                          i === idx
                            ? { ...item, enabled: e.target.checked }
                            : item
                        )
                      )
                    }
                    style={{
                      marginTop: isExpanded ? '7px' : undefined,
                      cursor: 'pointer',
                    }}
                  />

                  <select
                    aria-label={`规则 ${idx + 1} 作用域`}
                    value={ruleScope}
                    onChange={(e) => {
                      const nextScope = normalizeScope(e.target.value);
                      setRules((prev) =>
                        prev.map((item, i) =>
                          i === idx ? { ...item, scope: nextScope } : item
                        )
                      );
                    }}
                    style={{
                      padding: '5px 6px',
                      borderRadius: '6px',
                      border: '1px solid var(--border, #cbd5e1)',
                      background: 'var(--bg-input, #ffffff)',
                      fontSize: '12px',
                      marginTop: isExpanded ? '1px' : undefined,
                    }}
                  >
                    {SCOPE_OPTIONS_SHORT.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>

                  {isExpanded ? (
                    <textarea
                      rows={3}
                      value={r.pattern}
                      title={r.pattern}
                      placeholder="敏感词（支持 * 通配符，留空将被忽略）"
                      onChange={(e) =>
                        setRules((prev) =>
                          prev.map((item, i) =>
                            i === idx
                              ? { ...item, pattern: e.target.value }
                              : item
                          )
                        )
                      }
                      style={{
                        width: '100%',
                        minWidth: 0,
                        padding: '6px 8px',
                        borderRadius: '6px',
                        border: '1px solid var(--border, #cbd5e1)',
                        fontFamily: MONO_FONT_FAMILY,
                        fontSize: '12.5px',
                        lineHeight: 1.45,
                        resize: 'vertical',
                      }}
                    />
                  ) : (
                    <input
                      type="text"
                      value={r.pattern}
                      title={r.pattern}
                      placeholder="敏感词（支持 * 通配符，留空将被忽略）"
                      onChange={(e) =>
                        setRules((prev) =>
                          prev.map((item, i) =>
                            i === idx
                              ? { ...item, pattern: e.target.value }
                              : item
                          )
                        )
                      }
                      style={{
                        width: '100%',
                        minWidth: 0,
                        padding: '5px 8px',
                        borderRadius: '6px',
                        border: '1px solid var(--border, #cbd5e1)',
                        fontFamily: MONO_FONT_FAMILY,
                        fontSize: '12.5px',
                      }}
                    />
                  )}

                  <span
                    style={{
                      fontFamily: MONO_FONT_FAMILY,
                      fontSize: '11.5px',
                      fontWeight: 600,
                      letterSpacing: '0.06em',
                      textTransform: 'uppercase',
                      color: 'var(--text-muted, #64748b)',
                      textAlign: 'center',
                      userSelect: 'none',
                      padding: isExpanded ? '6px 2px 0' : '0 2px',
                    }}
                  >
                    TO
                  </span>

                  {isExpanded ? (
                    <textarea
                      rows={3}
                      value={r.replace}
                      title={r.replace || '留空 = 删除匹配内容'}
                      placeholder="留空 = 删除匹配内容"
                      onChange={(e) =>
                        setRules((prev) =>
                          prev.map((item, i) =>
                            i === idx
                              ? { ...item, replace: e.target.value }
                              : item
                          )
                        )
                      }
                      style={{
                        width: '100%',
                        minWidth: 0,
                        padding: '6px 8px',
                        borderRadius: '6px',
                        border: '1px solid var(--border, #cbd5e1)',
                        fontFamily: MONO_FONT_FAMILY,
                        fontSize: '12.5px',
                        lineHeight: 1.45,
                        resize: 'vertical',
                      }}
                    />
                  ) : (
                    <input
                      type="text"
                      value={r.replace}
                      title={r.replace || '留空 = 删除匹配内容'}
                      placeholder="留空 = 删除匹配内容"
                      onChange={(e) =>
                        setRules((prev) =>
                          prev.map((item, i) =>
                            i === idx
                              ? { ...item, replace: e.target.value }
                              : item
                          )
                        )
                      }
                      style={{
                        width: '100%',
                        minWidth: 0,
                        padding: '5px 8px',
                        borderRadius: '6px',
                        border: '1px solid var(--border, #cbd5e1)',
                        fontFamily: MONO_FONT_FAMILY,
                        fontSize: '12.5px',
                      }}
                    />
                  )}

                  <div
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '6px',
                      paddingTop: isExpanded ? '2px' : undefined,
                    }}
                  >
                    <Button
                      type="button"
                      className="small-button"
                      onClick={() => toggleExpand(idx)}
                      title={isExpanded ? '收起输入框' : '展开多行编辑'}
                      aria-label={isExpanded ? '收起输入框' : '展开多行编辑'}
                    >
                      {isExpanded ? (
                        <Minimize2 size={14} />
                      ) : (
                        <Maximize2 size={14} />
                      )}
                    </Button>

                    <label
                      title="忽略大小写"
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '4px',
                        fontSize: '12px',
                        whiteSpace: 'nowrap',
                        cursor: 'pointer',
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={r.case_insensitive}
                        onChange={(e) =>
                          setRules((prev) =>
                            prev.map((item, i) =>
                              i === idx
                                ? {
                                    ...item,
                                    case_insensitive: e.target.checked,
                                  }
                                : item
                            )
                          )
                        }
                      />
                      Aa
                    </label>

                    <Button
                      type="button"
                      className="small-button"
                      onClick={() => removeRule(idx)}
                      title="删除规则"
                      aria-label={`删除规则 ${idx + 1}`}
                    >
                      <Trash2 size={14} />
                    </Button>
                  </div>

                  {/* 第 2 行：底部状态摘要行，紧贴匹配词列对齐 */}
                  <div
                    style={{
                      gridColumn: '4 / -1',
                      fontSize: '11.5px',
                      opacity: 0.65,
                      lineHeight: 1.3,
                      userSelect: 'none',
                    }}
                  >
                    {r.replace === ''
                      ? '替换为留空 = 删除匹配内容'
                      : `替换为目标文本（${r.replace.length} 字符）`}
                    {hasWildcard ? ' · 已启用 * 通配符' : ''}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* 本地预览测试 */}
        <div
          style={{
            display: 'grid',
            gap: '6px',
            paddingTop: '8px',
            borderTop: '1px dashed var(--border, #e2e8f0)',
          }}
        >
          <div style={{ fontSize: '12.5px', fontWeight: 600 }}>
            本地预览测试
          </div>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <select
              aria-label="模拟作用域"
              value={testScope}
              onChange={(e) => setTestScope(normalizeScope(e.target.value))}
              style={{
                padding: '7px 8px',
                borderRadius: '8px',
                border: '1px solid var(--border, #cbd5e1)',
                background: 'var(--bg-input, #ffffff)',
                fontSize: '12.5px',
              }}
            >
              {SCOPE_OPTIONS_SHORT.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <input
              type="text"
              value={testText}
              onChange={(e) => setTestText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  runLocalPreview();
                }
              }}
              placeholder="输入测试文本，点击预览过滤效果…"
              style={{
                flex: 1,
                padding: '7px 10px',
                borderRadius: '8px',
                border: '1px solid var(--border, #cbd5e1)',
              }}
            />
            <Button type="button" onClick={runLocalPreview}>
              <ShieldCheck size={15} />
              测试预览
            </Button>
          </div>
          {testResult !== null && (
            <div
              style={{
                fontSize: '12.5px',
                padding: '8px 10px',
                borderRadius: '6px',
                background: 'rgba(30,58,95,0.06)',
                wordBreak: 'break-all',
                display: 'grid',
                gap: '4px',
              }}
            >
              {!filterEnabled && (
                <div
                  style={{
                    fontSize: '12px',
                    color: 'var(--amber-700, #b45309)',
                    fontWeight: 600,
                  }}
                >
                  当前总开关已停用，以下为启用后的模拟效果：
                </div>
              )}
              <div>过滤结果：{testResult}</div>
            </div>
          )}
        </div>

        <ErrorBox message={error} />

        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: '8px',
            flexWrap: 'wrap',
          }}
        >
          <Button type="button" onClick={importClientDesensitizeRules}>
            <Sparkles size={15} />
            导入客户端脱敏规则
          </Button>
          <Button
            type="button"
            className="primary"
            busy={saving}
            onClick={() => void saveSensitiveRules()}
          >
            <Save size={15} />
            保存风控规则
          </Button>
        </div>
      </div>
    </section>
  );
}
