import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import {
  Clock3,
  Eye,
  EyeOff,
  Globe,
  KeyRound,
  RotateCcw,
  Save,
  Server,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import { Badge, Button, ErrorBox, Field, IconButton, Select, Toggle } from '../components';
import { AcpSensitiveFilterPanel } from './AcpSensitiveFilterPanel';
import { updateConfig } from './api';
import type { GatewayConfig, QuotaCooldownScope, RoutingStrategy } from './types';

export interface AcpSettingsViewProps {
  config: GatewayConfig | null;
  onUpdated: (cfg: GatewayConfig) => void;
  notify: (msg: string, kind?: 'success' | 'error') => void;
}

const RISK_CONTROL_DEFAULTS = {
  strictProxyBinding: true,
  blockOnExitIpDrift: false,
  maxConcurrencyPerExitIp: 4,
  minExitIpRequestIntervalMs: 250,
  minAccountRequestIntervalMs: 500,
  requestJitterMs: 300,
  maxWorkerSpawnsPerMinute: 12,
  quotaCooldownScope: 'family' as QuotaCooldownScope,
  excludeDefaultComponents: false,
  accountFailover: false,
  maxQuotaAccountSwitches: 1,
  policyBlockCooldownMs: 21_600_000,
  maxInternal429RetriesBeforeCancel: 2,
};

function withRiskControlDefaults(cfg: GatewayConfig) {
  return {
    strictProxyBinding: cfg.strictProxyBinding ?? RISK_CONTROL_DEFAULTS.strictProxyBinding,
    blockOnExitIpDrift: cfg.blockOnExitIpDrift ?? RISK_CONTROL_DEFAULTS.blockOnExitIpDrift,
    maxConcurrencyPerExitIp:
      cfg.maxConcurrencyPerExitIp ?? RISK_CONTROL_DEFAULTS.maxConcurrencyPerExitIp,
    minExitIpRequestIntervalMs:
      cfg.minExitIpRequestIntervalMs ?? RISK_CONTROL_DEFAULTS.minExitIpRequestIntervalMs,
    minAccountRequestIntervalMs:
      cfg.minAccountRequestIntervalMs ?? RISK_CONTROL_DEFAULTS.minAccountRequestIntervalMs,
    requestJitterMs: cfg.requestJitterMs ?? RISK_CONTROL_DEFAULTS.requestJitterMs,
    maxWorkerSpawnsPerMinute:
      cfg.maxWorkerSpawnsPerMinute ?? RISK_CONTROL_DEFAULTS.maxWorkerSpawnsPerMinute,
    quotaCooldownScope: cfg.quotaCooldownScope ?? RISK_CONTROL_DEFAULTS.quotaCooldownScope,
    excludeDefaultComponents:
      cfg.excludeDefaultComponents ?? RISK_CONTROL_DEFAULTS.excludeDefaultComponents,
    accountFailover:
      cfg.accountFailover ?? RISK_CONTROL_DEFAULTS.accountFailover,
    maxQuotaAccountSwitches:
      cfg.maxQuotaAccountSwitches ?? RISK_CONTROL_DEFAULTS.maxQuotaAccountSwitches,
    policyBlockCooldownMs:
      cfg.policyBlockCooldownMs ?? RISK_CONTROL_DEFAULTS.policyBlockCooldownMs,
    maxInternal429RetriesBeforeCancel:
      cfg.maxInternal429RetriesBeforeCancel ??
      RISK_CONTROL_DEFAULTS.maxInternal429RetriesBeforeCancel,
  };
}

function cloneConfig(cfg: GatewayConfig): GatewayConfig {
  return {
    ...cfg,
    cacheSettlingDelayMs: cfg.cacheSettlingDelayMs ?? 1000,
    ...withRiskControlDefaults(cfg),
    apiKey: '',
    defaultProxy: '',
    cooldownStepsMinutes: [...cfg.cooldownStepsMinutes],
  };
}

function parseCooldownSteps(input: string): number[] {
  return input
    .split(/[,，\s]+/)
    .map((part) => Number(part.trim()))
    .filter((num) => Number.isFinite(num) && num > 0);
}

function toFiniteNumber(raw: string, fallback: number): number {
  if (raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function AcpSettingsView({
  config,
  onUpdated,
  notify,
}: AcpSettingsViewProps) {
  const [draft, setDraft] = useState<GatewayConfig | null>(() =>
    config ? cloneConfig(config) : null
  );
  const [cooldownStepsInput, setCooldownStepsInput] = useState<string>(() =>
    config ? config.cooldownStepsMinutes.join(', ') : ''
  );
  const [showApiKey, setShowApiKey] = useState(false);
  const [clearApiKey, setClearApiKey] = useState(false);
  const [clearDefaultProxy, setClearDefaultProxy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const prevConfigRef = useRef<GatewayConfig | null>(config);

  useEffect(() => {
    if (!config) {
      prevConfigRef.current = null;
      setDraft(null);
      setCooldownStepsInput('');
      setClearApiKey(false);
      setClearDefaultProxy(false);
      setShowApiKey(false);
      setError('');
      return;
    }

    const prev = prevConfigRef.current;
    if (!prev) {
      prevConfigRef.current = config;
      setDraft(cloneConfig(config));
      setCooldownStepsInput(config.cooldownStepsMinutes.join(', '));
      setClearApiKey(false);
      setClearDefaultProxy(false);
      setShowApiKey(false);
      setError('');
      return;
    }

    setDraft((currentDraft) => {
      if (!currentDraft) return cloneConfig(config);
      const next: GatewayConfig = {
        ...currentDraft,
        sensitiveFilterEnabled: config.sensitiveFilterEnabled,
        sensitiveWords: config.sensitiveWords,
      };
      if (currentDraft.host === prev.host) next.host = config.host;
      if (currentDraft.agyPath === prev.agyPath) next.agyPath = config.agyPath;
      if (currentDraft.routingStrategy === prev.routingStrategy) {
        next.routingStrategy = config.routingStrategy;
      }
      if (currentDraft.perAccountConcurrency === prev.perAccountConcurrency) {
        next.perAccountConcurrency = config.perAccountConcurrency;
      }
      if (currentDraft.maxAccountSwitches === prev.maxAccountSwitches) {
        next.maxAccountSwitches = config.maxAccountSwitches;
      }
      if (currentDraft.queueWaitTimeoutMs === prev.queueWaitTimeoutMs) {
        next.queueWaitTimeoutMs = config.queueWaitTimeoutMs;
      }
      if (
        (currentDraft.cacheSettlingDelayMs ?? 1000) ===
        (prev.cacheSettlingDelayMs ?? 1000)
      ) {
        next.cacheSettlingDelayMs = config.cacheSettlingDelayMs ?? 1000;
      }
      if (currentDraft.softErrorCutoffMs === prev.softErrorCutoffMs) {
        next.softErrorCutoffMs = config.softErrorCutoffMs;
      }
      if (currentDraft.maxImagesPerRequest === prev.maxImagesPerRequest) {
        next.maxImagesPerRequest = config.maxImagesPerRequest;
      }
      if (currentDraft.maxLogsRetained === prev.maxLogsRetained) {
        next.maxLogsRetained = config.maxLogsRetained;
      }
      const prevRisk = withRiskControlDefaults(prev);
      const nextRisk = withRiskControlDefaults(config);
      if ((currentDraft.strictProxyBinding ?? prevRisk.strictProxyBinding) === prevRisk.strictProxyBinding) {
        next.strictProxyBinding = nextRisk.strictProxyBinding;
      }
      if ((currentDraft.blockOnExitIpDrift ?? prevRisk.blockOnExitIpDrift) === prevRisk.blockOnExitIpDrift) {
        next.blockOnExitIpDrift = nextRisk.blockOnExitIpDrift;
      }
      if ((currentDraft.maxConcurrencyPerExitIp ?? prevRisk.maxConcurrencyPerExitIp) === prevRisk.maxConcurrencyPerExitIp) {
        next.maxConcurrencyPerExitIp = nextRisk.maxConcurrencyPerExitIp;
      }
      if ((currentDraft.minExitIpRequestIntervalMs ?? prevRisk.minExitIpRequestIntervalMs) === prevRisk.minExitIpRequestIntervalMs) {
        next.minExitIpRequestIntervalMs = nextRisk.minExitIpRequestIntervalMs;
      }
      if ((currentDraft.minAccountRequestIntervalMs ?? prevRisk.minAccountRequestIntervalMs) === prevRisk.minAccountRequestIntervalMs) {
        next.minAccountRequestIntervalMs = nextRisk.minAccountRequestIntervalMs;
      }
      if ((currentDraft.requestJitterMs ?? prevRisk.requestJitterMs) === prevRisk.requestJitterMs) {
        next.requestJitterMs = nextRisk.requestJitterMs;
      }
      if ((currentDraft.maxWorkerSpawnsPerMinute ?? prevRisk.maxWorkerSpawnsPerMinute) === prevRisk.maxWorkerSpawnsPerMinute) {
        next.maxWorkerSpawnsPerMinute = nextRisk.maxWorkerSpawnsPerMinute;
      }
      if ((currentDraft.quotaCooldownScope ?? prevRisk.quotaCooldownScope) === prevRisk.quotaCooldownScope) {
        next.quotaCooldownScope = nextRisk.quotaCooldownScope;
      }
      if ((currentDraft.excludeDefaultComponents ?? prevRisk.excludeDefaultComponents) === prevRisk.excludeDefaultComponents) {
        next.excludeDefaultComponents = nextRisk.excludeDefaultComponents;
      }
      if ((currentDraft.accountFailover ?? prevRisk.accountFailover) === prevRisk.accountFailover) {
        next.accountFailover = nextRisk.accountFailover;
      }
      if ((currentDraft.maxQuotaAccountSwitches ?? prevRisk.maxQuotaAccountSwitches) === prevRisk.maxQuotaAccountSwitches) {
        next.maxQuotaAccountSwitches = nextRisk.maxQuotaAccountSwitches;
      }
      if ((currentDraft.policyBlockCooldownMs ?? prevRisk.policyBlockCooldownMs) === prevRisk.policyBlockCooldownMs) {
        next.policyBlockCooldownMs = nextRisk.policyBlockCooldownMs;
      }
      if ((currentDraft.maxInternal429RetriesBeforeCancel ?? prevRisk.maxInternal429RetriesBeforeCancel) === prevRisk.maxInternal429RetriesBeforeCancel) {
        next.maxInternal429RetriesBeforeCancel = nextRisk.maxInternal429RetriesBeforeCancel;
      }
      return next;
    });

    setCooldownStepsInput((currentInput) => {
      const currentParsed = parseCooldownSteps(currentInput);
      const isCooldownDirty =
        JSON.stringify(currentParsed) !==
        JSON.stringify(prev.cooldownStepsMinutes);
      return isCooldownDirty
        ? currentInput
        : config.cooldownStepsMinutes.join(', ');
    });

    prevConfigRef.current = config;
  }, [config]);

  const parsedCooldownSteps = useMemo(
    () => parseCooldownSteps(cooldownStepsInput),
    [cooldownStepsInput]
  );

  const patch = useMemo<Partial<GatewayConfig>>(() => {
    if (!config || !draft) return {};
    const {
      apiKey,
      defaultProxy,
      port: _port,
      sensitiveFilterEnabled: _sensitiveFilterEnabled,
      sensitiveWords: _sensitiveWords,
      ...ordinarySettings
    } = draft;
    const draftRisk = withRiskControlDefaults(draft);
    const settings = {
      ...ordinarySettings,
      ...draftRisk,
      host: draft.host.trim(),
      agyPath: draft.agyPath.trim(),
      cooldownStepsMinutes: parsedCooldownSteps,
    };
    const currentSettings = {
      ...config,
      cacheSettlingDelayMs: config.cacheSettlingDelayMs ?? 1000,
      ...withRiskControlDefaults(config),
    };
    const changes = Object.fromEntries(
      (Object.keys(settings) as Array<keyof typeof settings>)
        .filter((key) => JSON.stringify(settings[key]) !== JSON.stringify(currentSettings[key]))
        .map((key) => [key, settings[key]])
    ) as Partial<GatewayConfig>;
    if (clearApiKey || apiKey.trim()) changes.apiKey = clearApiKey ? '' : apiKey.trim();
    if (clearDefaultProxy || defaultProxy.trim()) {
      changes.defaultProxy = clearDefaultProxy ? '' : defaultProxy.trim();
    }
    if (Object.keys(changes).length === 0) return {};
    return {
      ...changes,
      ...draftRisk,
    };
  }, [config, draft, parsedCooldownSteps, clearApiKey, clearDefaultProxy]);
  const isDirty = Object.keys(patch).length > 0;

  function updateField<K extends keyof GatewayConfig>(
    key: K,
    value: GatewayConfig[K]
  ) {
    setDraft((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  function handleReset() {
    if (!config) return;
    setDraft(cloneConfig(config));
    setCooldownStepsInput(config.cooldownStepsMinutes.join(', '));
    setClearApiKey(false);
    setClearDefaultProxy(false);
    setShowApiKey(false);
    setError('');
  }

  async function handleSave(event?: FormEvent) {
    event?.preventDefault();
    if (!draft || !isDirty || saving) return;

    setError('');

    const trimmedHost = draft.host.trim();
    if (!trimmedHost) {
      setError('监听地址 (Host) 不能为空');
      return;
    }

    if (parsedCooldownSteps.length === 0) {
      setError('冷却阶梯至少需要一个大于 0 的分钟数');
      return;
    }

    const risk = withRiskControlDefaults(draft);
    const rangeChecks: Array<[string, number, number, number]> = [
      ['同出口 IP 并发上限', risk.maxConcurrencyPerExitIp, 0, 64],
      ['同出口最小错峰间隔', risk.minExitIpRequestIntervalMs, 0, 10000],
      ['单号最小请求间隔', risk.minAccountRequestIntervalMs, 0, 30000],
      ['随机抖动上限', risk.requestJitterMs, 0, 10000],
      ['单号每分钟最大 Worker 拉起次数', risk.maxWorkerSpawnsPerMinute, 0, 120],
      ['配额/429 单次请求最大切号次数', risk.maxQuotaAccountSwitches, 0, 10],
      ['403 策略封禁硬锁时长 (ms)', risk.policyBlockCooldownMs, 60_000, 604_800_000],
      ['内部 429 重试熔断次数', risk.maxInternal429RetriesBeforeCancel, 1, 8],
    ];
    for (const [label, val, min, max] of rangeChecks) {
      if (!Number.isInteger(val) || val < min || val > max) {
        setError(`${label}必须为 ${min}–${max} 之间的整数`);
        return;
      }
    }

    setSaving(true);
    try {
      const updated = await updateConfig(patch);
      prevConfigRef.current = updated;
      setDraft(cloneConfig(updated));
      setCooldownStepsInput(updated.cooldownStepsMinutes.join(', '));
      setClearApiKey(false);
      setClearDefaultProxy(false);
      setShowApiKey(false);
      onUpdated(updated);
      notify('运行配置已保存', 'success');
    } catch (err) {
      const message = err instanceof Error ? err.message : '保存配置失败';
      setError(message);
      notify(message, 'error');
    } finally {
      setSaving(false);
    }
  }

  function handleSensitiveSaved(updated: GatewayConfig) {
    if (prevConfigRef.current) {
      prevConfigRef.current = {
        ...prevConfigRef.current,
        sensitiveFilterEnabled: updated.sensitiveFilterEnabled,
        sensitiveWords: updated.sensitiveWords,
      };
    }
    setDraft((prev) =>
      prev
        ? {
            ...prev,
            sensitiveFilterEnabled: updated.sensitiveFilterEnabled,
            sensitiveWords: updated.sensitiveWords,
          }
        : prev
    );
    onUpdated(updated);
  }

  if (!draft) {
    return (
      <>
        <div className="page-heading">
          <div>
            <div className="eyebrow">ACP GATEWAY CONFIG</div>
            <h1>运行配置</h1>
            <p>网关路由策略、并发控制、冷却阶梯与安全鉴权设置</p>
          </div>
        </div>
        <div className="page-loading-state">
          <div className="page-loading-card">
            <div className="page-loading-symbol">
              <Server size={32} />
            </div>
            <strong>正在加载网关配置…</strong>
            <span>正在从 8048 ACP 网关读取当前运行参数</span>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">ACP GATEWAY CONFIG</div>
          <h1>运行配置</h1>
          <p>网关路由策略、并发控制、冷却阶梯与安全鉴权设置</p>
        </div>
        {isDirty && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <Button
              type="button"
              onClick={handleReset}
              disabled={saving}
            >
              <RotateCcw size={16} />
              重置
            </Button>
            <Button
              type="submit"
              form="acp-settings-form"
              className="primary"
              busy={saving}
            >
              <Save size={16} />
              保存配置
            </Button>
          </div>
        )}
      </div>

      <div className="settings-layout">
        <div style={{ minWidth: 0 }}>
          <form id="acp-settings-form" onSubmit={(e) => void handleSave(e)}>
          {/* 1. 服务与路由 */}
          <section className="settings-section">
            <div className="settings-section-heading">
              <span className="settings-icon">
                <Server size={20} />
              </span>
              <div>
                <h2>服务与路由</h2>
                <p>监听地址、可执行文件路径与多账号调度策略</p>
              </div>
            </div>
            <div className="settings-section-body">
              <div className="form-grid">
                <Field
                  label="监听地址 (Host)"
                  hint="默认 127.0.0.1，修改后需重启生效"
                >
                  <input
                    type="text"
                    value={draft.host}
                    onChange={(e) => updateField('host', e.target.value)}
                    placeholder="127.0.0.1"
                    required
                  />
                </Field>
                <Field
                  label="监听端口 (Port)"
                  hint="固定为 8048，与控制台和守护脚本共用"
                >
                  <input type="number" value={8048} readOnly />
                </Field>
              </div>

              <Field
                label="Agy 路径 (agyPath)"
                hint="Antigravity CLI / 二进制路径，留空将尝试自动探测"
                optional
              >
                <input
                  type="text"
                  value={draft.agyPath}
                  onChange={(e) => updateField('agyPath', e.target.value)}
                  placeholder="例如 C:\path\to\agy.exe"
                />
              </Field>

              <Field
                label="路由策略 (Routing Strategy)"
                hint="sticky-round-robin 兼顾缓存命中与负载均衡；cache-first 限流先短暂等待；performance-first 纯轮询打散；fill-first 集中消耗前排"
              >
                <Select
                  aria-label="路由策略"
                  value={draft.routingStrategy}
                  onChange={(e) =>
                    updateField(
                      'routingStrategy',
                      e.target.value as RoutingStrategy
                    )
                  }
                >
                  <option value="sticky-round-robin">
                    sticky-round-robin（粘性轮询 · 默认推荐）
                  </option>
                  <option value="cache-first">
                    cache-first（缓存优先 · 限流先短暂等待）
                  </option>
                  <option value="performance-first">
                    performance-first（性能优先 · 纯轮询打散）
                  </option>
                  <option value="fill-first">
                    fill-first（填满优先 · 集中消耗前排）
                  </option>
                </Select>
              </Field>
            </div>
          </section>

          {/* 2. 并发与截断 */}
          <section className="settings-section">
            <div className="settings-section-heading">
              <span className="settings-icon">
                <SlidersHorizontal size={20} />
              </span>
              <div>
                <h2>并发与截断</h2>
                <p>单号并发上限、换号重试、排队超时与日志保留</p>
              </div>
            </div>
            <div className="settings-section-body">
              <div className="form-grid">
                <Field
                  label="单账号默认并发上限"
                  hint="每个账号同时处理的最大请求数"
                >
                  <span className="suffixed-input">
                    <input
                      type="number"
                      min={1}
                      value={draft.perAccountConcurrency}
                      onChange={(e) =>
                        updateField(
                          'perAccountConcurrency',
                          toFiniteNumber(
                            e.target.value,
                            draft.perAccountConcurrency
                          )
                        )
                      }
                      required
                    />
                    <span>并发</span>
                  </span>
                </Field>
                <Field
                  label="最大换号重试次数"
                  hint="单次请求失败后允许切换其他账号的上限"
                >
                  <span className="suffixed-input">
                    <input
                      type="number"
                      min={0}
                      value={draft.maxAccountSwitches}
                      onChange={(e) =>
                        updateField(
                          'maxAccountSwitches',
                          toFiniteNumber(
                            e.target.value,
                            draft.maxAccountSwitches
                          )
                        )
                      }
                      required
                    />
                    <span>次</span>
                  </span>
                </Field>
                <Field
                  label="排队等待超时"
                  hint="无可用并发槽位时的最大排队时间"
                >
                  <span className="suffixed-input">
                    <input
                      type="number"
                      min={0}
                      value={draft.queueWaitTimeoutMs}
                      onChange={(e) =>
                        updateField(
                          'queueWaitTimeoutMs',
                          toFiniteNumber(
                            e.target.value,
                            draft.queueWaitTimeoutMs
                          )
                        )
                      }
                      required
                    />
                    <span>ms</span>
                  </span>
                </Field>
                <Field
                  label="日志保留条数"
                  hint="内存中保留的最大结构化请求日志数"
                >
                  <span className="suffixed-input">
                    <input
                      type="number"
                      min={10}
                      value={draft.maxLogsRetained}
                      onChange={(e) =>
                        updateField(
                          'maxLogsRetained',
                          toFiniteNumber(e.target.value, draft.maxLogsRetained)
                        )
                      }
                      required
                    />
                    <span>条</span>
                  </span>
                </Field>
                <Field
                  label="KV 缓存防竞争延迟 (ms)"
                  hint="范围 0–5000 ms，设为 0 关闭，默认 1000 ms。"
                >
                  <span className="suffixed-input">
                    <input
                      type="number"
                      min={0}
                      max={5000}
                      step={50}
                      value={draft.cacheSettlingDelayMs}
                      onChange={(e) =>
                        updateField(
                          'cacheSettlingDelayMs',
                          toFiniteNumber(e.target.value, draft.cacheSettlingDelayMs)
                        )
                      }
                      required
                    />
                    <span>ms</span>
                  </span>
                </Field>
              </div>
            </div>
          </section>

          {/* 3. 冷却阶梯 */}
          <section className="settings-section">
            <div className="settings-section-heading">
              <span className="settings-icon">
                <Clock3 size={20} />
              </span>
              <div>
                <h2>冷却阶梯</h2>
                <p>连续失败递增冷却时长与软错误快速换号阈值</p>
              </div>
            </div>
            <div className="settings-section-body">
              <div className="form-grid">
                <Field
                  label="冷却阶梯 (分钟)"
                  hint={
                    parsedCooldownSteps.length > 0
                      ? `逗号分隔正数，当前解析：[${parsedCooldownSteps.join(', ')}]`
                      : '请输入逗号分隔的正数，例如：1, 5, 15, 60'
                  }
                >
                  <input
                    type="text"
                    value={cooldownStepsInput}
                    onChange={(e) => setCooldownStepsInput(e.target.value)}
                    placeholder="1, 5, 15, 60"
                    required
                  />
                </Field>
                <Field
                  label="软错误截断阈值"
                  hint="超过该耗时前的软错误允许快速换号"
                >
                  <span className="suffixed-input">
                    <input
                      type="number"
                      min={0}
                      value={draft.softErrorCutoffMs}
                      onChange={(e) =>
                        updateField(
                          'softErrorCutoffMs',
                          toFiniteNumber(
                            e.target.value,
                            draft.softErrorCutoffMs
                          )
                        )
                      }
                      required
                    />
                    <span>ms</span>
                  </span>
                </Field>
              </div>
            </div>
          </section>

          {/* 4. 网络与代理 */}
          <section className="settings-section">
            <div className="settings-section-heading">
              <span className="settings-icon">
                <Globe size={20} />
              </span>
              <div>
                <h2>网络与代理</h2>
                <p>默认上游代理及单次请求媒体上限</p>
              </div>
            </div>
            <div className="settings-section-body">
              <div className="form-grid">
                <Field
                  label="默认上游代理 (Default Proxy)"
                  hint="未配置独立代理的账号将使用此代理"
                  optional
                >
                  <div className="password-input">
                    <input
                      type="text"
                      value={draft.defaultProxy}
                      onChange={(e) => {
                        setClearDefaultProxy(false);
                        updateField('defaultProxy', e.target.value);
                      }}
                      placeholder={clearDefaultProxy ? '保存后将清除' : config?.defaultProxy || 'http://127.0.0.1:7890'}
                    />
                    {config?.defaultProxy && (
                      <IconButton
                        title={clearDefaultProxy ? '撤销清除默认代理' : '清除默认代理'}
                        onClick={() => {
                          updateField('defaultProxy', '');
                          setClearDefaultProxy((pending) => !pending);
                        }}
                      >
                        <X size={16} />
                      </IconButton>
                    )}
                  </div>
                </Field>
                <Field
                  label="单次请求最大图片数"
                  hint="限制 inlineData 图片数量防止超限"
                >
                  <span className="suffixed-input">
                    <input
                      type="number"
                      min={1}
                      value={draft.maxImagesPerRequest}
                      onChange={(e) =>
                        updateField(
                          'maxImagesPerRequest',
                          toFiniteNumber(
                            e.target.value,
                            draft.maxImagesPerRequest
                          )
                        )
                      }
                      required
                    />
                    <span>张</span>
                  </span>
                </Field>
              </div>
            </div>
          </section>

          {/* 5. 风控与防漂移保护 */}
          <section className="settings-section">
            <div className="settings-section-heading">
              <span className="settings-icon">
                <ShieldAlert size={20} />
              </span>
              <div>
                <h2>风控与防漂移保护</h2>
                <p>代理强绑定、出口 IP 漂移熔断、同出口错峰限流与冷启动风暴防护</p>
              </div>
            </div>
            <div className="settings-section-body">
              <div className="form-grid" style={{ marginBottom: '12px' }}>
                <Toggle
                  checked={draft.strictProxyBinding ?? RISK_CONTROL_DEFAULTS.strictProxyBinding}
                  onChange={(checked) => updateField('strictProxyBinding', checked)}
                  label="强代理绑定（代理不可达时直接阻断，严禁回退直连）"
                />
                <Toggle
                  checked={draft.blockOnExitIpDrift ?? RISK_CONTROL_DEFAULTS.blockOnExitIpDrift}
                  onChange={(checked) => updateField('blockOnExitIpDrift', checked)}
                  label="出口 IP 漂移自动熔断（检测到出口 IP 变化时自动标为受限并移出调度）"
                />
                <Toggle
                  checked={draft.accountFailover ?? RISK_CONTROL_DEFAULTS.accountFailover}
                  onChange={(checked) => updateField('accountFailover', checked)}
                  label="防连坐自动切号（关闭时 401/402/403/429 停在当前号防连坐；开启时受下方 429 切号上限保护）"
                />
                <Toggle
                  checked={draft.excludeDefaultComponents ?? RISK_CONTROL_DEFAULTS.excludeDefaultComponents}
                  onChange={(checked) => updateField('excludeDefaultComponents', checked)}
                  label="极简模式（开启时剥离 agy 官方默认系统提示词以省 Token；关闭为保真模式）"
                />
              </div>

              <div className="form-grid">
                <Field
                  label="同出口 IP 并发上限"
                  hint="范围 0–64，0 表示不限制（默认 4）"
                >
                  <span className="suffixed-input">
                    <input
                      type="number"
                      min={0}
                      max={64}
                      step={1}
                      value={draft.maxConcurrencyPerExitIp ?? RISK_CONTROL_DEFAULTS.maxConcurrencyPerExitIp}
                      onChange={(e) =>
                        updateField(
                          'maxConcurrencyPerExitIp',
                          toFiniteNumber(
                            e.target.value,
                            draft.maxConcurrencyPerExitIp ?? RISK_CONTROL_DEFAULTS.maxConcurrencyPerExitIp
                          )
                        )
                      }
                      required
                    />
                    <span>并发</span>
                  </span>
                </Field>
                <Field
                  label="同出口最小错峰间隔 (ms)"
                  hint="范围 0–10000 ms，0 表示关闭（默认 250）"
                >
                  <span className="suffixed-input">
                    <input
                      type="number"
                      min={0}
                      max={10000}
                      step={50}
                      value={draft.minExitIpRequestIntervalMs ?? RISK_CONTROL_DEFAULTS.minExitIpRequestIntervalMs}
                      onChange={(e) =>
                        updateField(
                          'minExitIpRequestIntervalMs',
                          toFiniteNumber(
                            e.target.value,
                            draft.minExitIpRequestIntervalMs ?? RISK_CONTROL_DEFAULTS.minExitIpRequestIntervalMs
                          )
                        )
                      }
                      required
                    />
                    <span>ms</span>
                  </span>
                </Field>
                <Field
                  label="单号最小请求间隔 (ms)"
                  hint="范围 0–30000 ms，0 表示关闭（默认 500）"
                >
                  <span className="suffixed-input">
                    <input
                      type="number"
                      min={0}
                      max={30000}
                      step={50}
                      value={draft.minAccountRequestIntervalMs ?? RISK_CONTROL_DEFAULTS.minAccountRequestIntervalMs}
                      onChange={(e) =>
                        updateField(
                          'minAccountRequestIntervalMs',
                          toFiniteNumber(
                            e.target.value,
                            draft.minAccountRequestIntervalMs ?? RISK_CONTROL_DEFAULTS.minAccountRequestIntervalMs
                          )
                        )
                      }
                      required
                    />
                    <span>ms</span>
                  </span>
                </Field>
                <Field
                  label="随机抖动上限 (ms)"
                  hint="范围 0–10000 ms，0 表示关闭（默认 300）"
                >
                  <span className="suffixed-input">
                    <input
                      type="number"
                      min={0}
                      max={10000}
                      step={50}
                      value={draft.requestJitterMs ?? RISK_CONTROL_DEFAULTS.requestJitterMs}
                      onChange={(e) =>
                        updateField(
                          'requestJitterMs',
                          toFiniteNumber(
                            e.target.value,
                            draft.requestJitterMs ?? RISK_CONTROL_DEFAULTS.requestJitterMs
                          )
                        )
                      }
                      required
                    />
                    <span>ms</span>
                  </span>
                </Field>
                <Field
                  label="单号每分钟最大 Worker 拉起次数"
                  hint="范围 0–120 次，0 表示关闭（默认 12）"
                >
                  <span className="suffixed-input">
                    <input
                      type="number"
                      min={0}
                      max={120}
                      step={1}
                      value={draft.maxWorkerSpawnsPerMinute ?? RISK_CONTROL_DEFAULTS.maxWorkerSpawnsPerMinute}
                      onChange={(e) =>
                        updateField(
                          'maxWorkerSpawnsPerMinute',
                          toFiniteNumber(
                            e.target.value,
                            draft.maxWorkerSpawnsPerMinute ?? RISK_CONTROL_DEFAULTS.maxWorkerSpawnsPerMinute
                          )
                        )
                      }
                      required
                    />
                    <span>次</span>
                  </span>
                </Field>
                <Field
                  label="429 配额冷却范围"
                  hint="控制单号触发 429 时的避让粒度"
                >
                  <Select
                    aria-label="429 配额冷却范围"
                    value={draft.quotaCooldownScope ?? RISK_CONTROL_DEFAULTS.quotaCooldownScope}
                    onChange={(e) =>
                      updateField(
                        'quotaCooldownScope',
                        e.target.value as QuotaCooldownScope
                      )
                    }
                  >
                    <option value="family">
                      family（仅冷却当前模型家族 · 默认）
                    </option>
                    <option value="account">
                      account（附带账号级短避让，防跨模型连打）
                    </option>
                  </Select>
                </Field>
                <Field
                  label="配额/429 单次请求最大切号次数"
                  hint="范围 0–10 次，仅开启「防连坐自动切号」时生效（默认 1）"
                >
                  <span className="suffixed-input">
                    <input
                      type="number"
                      min={0}
                      max={10}
                      step={1}
                      value={draft.maxQuotaAccountSwitches ?? RISK_CONTROL_DEFAULTS.maxQuotaAccountSwitches}
                      onChange={(e) =>
                        updateField(
                          'maxQuotaAccountSwitches',
                          toFiniteNumber(
                            e.target.value,
                            draft.maxQuotaAccountSwitches ?? RISK_CONTROL_DEFAULTS.maxQuotaAccountSwitches
                          )
                        )
                      }
                      required
                    />
                    <span>次</span>
                  </span>
                </Field>
                <Field
                  label="内部 429 重试熔断次数"
                  hint="范围 1–8 次，agy 内部 429 重试风暴触发 session/cancel 熔断（默认 2）"
                >
                  <span className="suffixed-input">
                    <input
                      type="number"
                      min={1}
                      max={8}
                      step={1}
                      value={
                        draft.maxInternal429RetriesBeforeCancel ??
                        RISK_CONTROL_DEFAULTS.maxInternal429RetriesBeforeCancel
                      }
                      onChange={(e) =>
                        updateField(
                          'maxInternal429RetriesBeforeCancel',
                          toFiniteNumber(
                            e.target.value,
                            draft.maxInternal429RetriesBeforeCancel ??
                              RISK_CONTROL_DEFAULTS.maxInternal429RetriesBeforeCancel
                          )
                        )
                      }
                      required
                    />
                    <span>次</span>
                  </span>
                </Field>
                <Field
                  label="403 策略封禁硬锁时长 (分钟)"
                  hint={(() => {
                    const ms =
                      draft.policyBlockCooldownMs ??
                      RISK_CONTROL_DEFAULTS.policyBlockCooldownMs;
                    const hours = (ms / 3_600_000).toFixed(2).replace(/\.?0+$/, '');
                    return `范围 1–10080 分钟（60000–604800000 ms，默认 360 分钟 / 6 小时），当前换算：${ms} ms（约 ${hours} 小时）`;
                  })()}
                >
                  <span className="suffixed-input">
                    <input
                      type="number"
                      min={1}
                      max={10080}
                      step={1}
                      value={Math.round(
                        (draft.policyBlockCooldownMs ??
                          RISK_CONTROL_DEFAULTS.policyBlockCooldownMs) / 60_000
                      )}
                      onChange={(e) => {
                        const currentMinutes = Math.round(
                          (draft.policyBlockCooldownMs ??
                            RISK_CONTROL_DEFAULTS.policyBlockCooldownMs) / 60_000
                        );
                        const nextMinutes = toFiniteNumber(e.target.value, currentMinutes);
                        updateField('policyBlockCooldownMs', Math.round(nextMinutes * 60_000));
                      }}
                      required
                    />
                    <span>分钟</span>
                  </span>
                </Field>
              </div>
            </div>
          </section>

          {/* 6. 安全鉴权 */}
          <section className="settings-section">
            <div className="settings-section-heading">
              <span className="settings-icon">
                <KeyRound size={20} />
              </span>
              <div>
                <h2>安全鉴权</h2>
                <p>网关 API Key 访问控制</p>
              </div>
              <Badge variant={config?.apiKey ? 'green' : 'neutral'} dot>
                {config?.apiKey ? '已启用' : '未启用'}
              </Badge>
            </div>
            <div className="settings-section-body">
              <Field
                label="网关访问密钥 (API Key)"
                hint="留空保留原设置。清除密钥后保存会关闭 API Key 校验。"
                optional
              >
                <div className="password-input">
                  <input
                    type={showApiKey ? 'text' : 'password'}
                    value={draft.apiKey}
                    onChange={(e) => {
                      setClearApiKey(false);
                      updateField('apiKey', e.target.value);
                    }}
                    placeholder={clearApiKey ? '保存后将清除' : config?.apiKey ? '已设置，输入新密钥可更换' : '输入密钥可启用校验'}
                    autoComplete="new-password"
                  />
                  <IconButton
                    title={showApiKey ? '隐藏密钥' : '显示密钥'}
                    onClick={() => setShowApiKey((prev) => !prev)}
                  >
                    {showApiKey ? <EyeOff size={16} /> : <Eye size={16} />}
                  </IconButton>
                  {config?.apiKey && (
                    <IconButton
                      title={clearApiKey ? '撤销清除密钥' : '清除密钥'}
                      onClick={() => {
                        updateField('apiKey', '');
                        setClearApiKey((pending) => !pending);
                      }}
                    >
                      <X size={16} />
                    </IconButton>
                  )}
                </div>
              </Field>
            </div>
          </section>

          <ErrorBox message={error} />

          {isDirty && (
            <div
              className="password-actions"
              style={{ gap: '10px', marginTop: '4px', marginBottom: '20px' }}
            >
              <Button
                type="button"
                onClick={handleReset}
                disabled={saving}
              >
                <RotateCcw size={16} />
                重置
              </Button>
              <Button type="submit" className="primary" busy={saving}>
                <Save size={16} />
                保存配置
              </Button>
            </div>
          )}
        </form>

          {/* 6. 上游风控敏感词过滤 */}
          <AcpSensitiveFilterPanel
            config={config}
            onSaved={handleSensitiveSaved}
            notify={notify}
          />
        </div>

        <aside className="settings-aside">
          <span className="settings-aside-icon">
            <ShieldCheck size={27} strokeWidth={1.5} />
          </span>
          <span className="eyebrow">ACP GATEWAY</span>
          <strong>
            {draft.host}:8048
          </strong>
          <div>
            <span className="status-dot" />
            {isDirty ? '有未保存更改' : '配置已同步'}
          </div>
          <hr />
          <span>路由策略</span>
          <strong className="deployment-label">{draft.routingStrategy}</strong>
          <span>单号并发</span>
          <code>{draft.perAccountConcurrency} 并发</code>
          <span>接口鉴权</span>
          <code>{config?.apiKey ? '已启用' : '未启用'}</code>
          <span>风控敏感词</span>
          <code>
            {config?.sensitiveFilterEnabled
              ? `已启用 (${(config.sensitiveWords ?? []).filter((r) => r.enabled && r.pattern.trim().length > 0).length} 条)`
              : '已停用'}
          </code>
        </aside>
      </div>
    </>
  );
}
