import { useEffect, useMemo, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  AlertTriangle,
  ArrowUpCircle,
  Boxes,
  Cpu,
  Eye,
  EyeOff,
  Globe,
  RefreshCw,
  RotateCcw,
  Save,
  Server,
  Shield,
  SlidersHorizontal,
} from "lucide-react";
import { Badge, Button, ErrorBox, Select, Toggle } from "../components";
import type { Notice } from "../components";
import { applyUpdate, fetchUpdateInfo, saveConfig } from "./api";
import type {
  AiStudioAccount,
  AiStudioConfig,
  AiStudioConfigPatch,
  AiStudioModel,
  AiStudioUpdateInfo,
} from "./types";

interface AiStudioSettingsViewProps {
  config: AiStudioConfig | null;
  accounts?: AiStudioAccount[];
  models?: AiStudioModel[];
  updateInfo: AiStudioUpdateInfo | null;
  updateError?: string;
  onSaveConfig?: (patch: AiStudioConfigPatch) => Promise<AiStudioConfig>;
  onRefresh: () => Promise<unknown>;
  notify: Notice;
}

type SectionId =
  | "service"
  | "capacity"
  | "runtime"
  | "models"
  | "network"
  | "security";

interface SectionMeta {
  id: SectionId;
  label: string;
  description: string;
  icon: ReactNode;
}

const SECTIONS: readonly SectionMeta[] = [
  {
    id: "service",
    label: "服务",
    description: "服务入口、API 密钥、账户状态目录与媒体输出方式",
    icon: <Server size={16} />,
  },
  {
    id: "capacity",
    label: "容量",
    description: "Worker 并发池、账户选择策略与故障切换上限",
    icon: <Cpu size={16} />,
  },
  {
    id: "runtime",
    label: "运行与通道",
    description: "WAA 验证后端、上游通道、超时控制与首字超时备用请求",
    icon: <SlidersHorizontal size={16} />,
  },
  {
    id: "models",
    label: "模型与协议",
    description: "模型映射、通道绑定、流式保活、搜索别名与自动续写",
    icon: <Boxes size={16} />,
  },
  {
    id: "network",
    label: "网络",
    description: "默认出口代理、多代理池与实时可用性检测",
    icon: <Globe size={16} />,
  },
  {
    id: "security",
    label: "安全与记录",
    description: "管理端登录鉴权、请求正文留存与本地日志文件上限",
    icon: <Shield size={16} />,
  },
];

const CHANNEL_OPTIONS = [
  { id: "playground", label: "Playground（默认通道）" },
  { id: "build", label: "Build（旧版通道）" },
] as const;

const READONLY_CONFIG_KEYS = [
  "active_listen_addr",
  "reserved_listen_addr",
  "active_preview_listen_addr",
  "active_proxy_api_key",
  "active_proxy",
  "proxy_pool",
  "environment",
  "invalid",
  "management_restart_required",
  "service_restart_required",
  "admin_password_set",
] as const;

function getEnvLockKey(
  config: AiStudioConfig | null,
  fieldKey: string,
): string | undefined {
  if (!config?.environment || config.environment.length === 0) return undefined;
  const envKey =
    fieldKey === "auth_states"
      ? "AISTUDIO_AUTH_STATES"
      : fieldKey.toUpperCase();
  return config.environment.includes(envKey) ? envKey : undefined;
}

function SettingRow({
  title,
  fieldKey,
  description,
  effect,
  envKey,
  isToggle = false,
  children,
}: {
  title: string;
  fieldKey: string;
  description: string;
  effect?: "immediate" | "service" | "management";
  envKey?: string;
  isToggle?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="aistudio-setting-row">
      <div className="aistudio-setting-meta">
        <div className="aistudio-setting-title">
          <span>{title}</span>
          <span className="mono" style={{ fontSize: 11.5, color: "var(--muted)", fontWeight: 500 }}>
            ({fieldKey})
          </span>
          {effect === "service" && <Badge variant="amber">重启生成服务生效</Badge>}
          {effect === "management" && <Badge variant="amber">重启程序生效</Badge>}
        </div>
        <p className="aistudio-setting-desc">{description}</p>
        {envKey && (
          <p className="aistudio-setting-env">
            由环境变量 <code className="mono">{envKey}</code> 决定，此处不可修改
          </p>
        )}
      </div>
      <div className={`aistudio-setting-control${isToggle ? " is-toggle" : ""}`}>
        <fieldset
          disabled={Boolean(envKey)}
          style={{
            border: 0,
            padding: 0,
            margin: 0,
            minWidth: 0,
            opacity: envKey ? 0.58 : 1,
          }}
        >
          {children}
        </fieldset>
      </div>
    </div>
  );
}

export function AiStudioSettingsView({
  config,
  updateInfo,
  updateError,
  onSaveConfig,
  onRefresh,
  notify,
}: AiStudioSettingsViewProps) {
  const [activeSection, setActiveSection] = useState<SectionId>("service");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [latestUpdate, setLatestUpdate] = useState<AiStudioUpdateInfo | null>(
    updateInfo,
  );
  const [showApiKey, setShowApiKey] = useState(false);

  // ① 服务
  const [autoStart, setAutoStart] = useState(!!config?.auto_start);
  const [hideDockIcon, setHideDockIcon] = useState(!!config?.hide_dock_icon);
  const [listenAddr, setListenAddr] = useState(config?.listen_addr ?? "127.0.0.1:2048");
  const [previewListenAddr, setPreviewListenAddr] = useState(
    config?.preview_listen_addr ?? "127.0.0.1:2050",
  );
  const [proxyApiKey, setProxyApiKey] = useState(config?.proxy_api_key ?? "");
  const [apiKeyAccounts, setApiKeyAccounts] = useState(config?.api_key_accounts ?? "");
  const [authStates, setAuthStates] = useState(config?.auth_states ?? "");
  const [mediaOutput, setMediaOutput] = useState(config?.media_output ?? "inline");
  const [mediaBaseUrl, setMediaBaseUrl] = useState(config?.media_base_url ?? "");

  // ② 容量
  const [warmWorkerLimit, setWarmWorkerLimit] = useState(
    String(config?.warm_worker_limit ?? 6),
  );
  const [maxActiveWorkers, setMaxActiveWorkers] = useState(
    String(config?.max_active_workers ?? 10),
  );
  const [warmStartupConcurrency, setWarmStartupConcurrency] = useState(
    String(config?.warm_startup_concurrency ?? 2),
  );
  const [perAccountConcurrency, setPerAccountConcurrency] = useState(
    String(config?.per_account_concurrency ?? 1),
  );
  const [routingStrategy, setRoutingStrategy] = useState(
    config?.routing_strategy ?? "fill-first",
  );
  const [accountOrder, setAccountOrder] = useState(config?.account_order ?? "");
  const [maxAccountSwitches, setMaxAccountSwitches] = useState(
    String(config?.max_account_switches ?? 3),
  );

  // ③ 运行与通道
  const [waaBackend, setWaaBackend] = useState(config?.waa_backend ?? "spidermonkey");
  const [upstreamChannels, setUpstreamChannels] = useState<string[]>(
    config?.upstream_channels ?? ["playground"],
  );
  const [buildNativeNonstream, setBuildNativeNonstream] = useState(
    !!config?.build_native_nonstream,
  );
  const [initTimeout, setInitTimeout] = useState(config?.init_timeout ?? "2m0s");
  const [requestTimeout, setRequestTimeout] = useState(
    config?.request_timeout ?? "30m0s",
  );
  const [firstEventHedge, setFirstEventHedge] = useState(
    config?.first_event_hedge ?? "auto",
  );
  const [firstEventHedgeModels, setFirstEventHedgeModels] = useState(
    config?.first_event_hedge_models ?? "",
  );

  // ④ 模型与协议
  const [modelMapping, setModelMapping] = useState(config?.model_mapping ?? "");
  const [modelChannels, setModelChannels] = useState(config?.model_channels ?? "");
  const [modelAccounts, setModelAccounts] = useState(config?.model_accounts ?? "");
  const [searchModelAliases, setSearchModelAliases] = useState(
    !!config?.search_model_aliases,
  );
  const [discoverHiddenModels, setDiscoverHiddenModels] = useState(
    !!config?.discover_hidden_models,
  );
  const [googleSearch, setGoogleSearch] = useState(!!config?.google_search);
  const [fakeStream, setFakeStream] = useState(!!config?.fake_stream);
  const [nonstreamKeepalive, setNonstreamKeepalive] = useState(
    !!config?.nonstream_keepalive,
  );
  const [youtubeLinks, setYoutubeLinks] = useState(!!config?.youtube_links);
  const [stripThoughtSig, setStripThoughtSig] = useState(
    !!config?.strip_thought_signatures,
  );
  const [continuationRewrite, setContinuationRewrite] = useState(
    !!config?.continuation_rewrite,
  );
  const [continuationPrompt, setContinuationPrompt] = useState(
    config?.continuation_prompt ?? "",
  );

  // ⑤ 网络
  const [proxy, setProxy] = useState(config?.proxy ?? "");

  // ⑥ 安全与记录
  const [adminAuthEnabled, setAdminAuthEnabled] = useState(!!config?.admin_auth_enabled);
  const [adminUsername, setAdminUsername] = useState(config?.admin_username ?? "");
  const [adminPassword, setAdminPassword] = useState("");
  const [requestBodyLog, setRequestBodyLog] = useState(!!config?.request_body_log);
  const [logFile, setLogFile] = useState(!!config?.log_file);
  const [logMaxTotalMb, setLogMaxTotalMb] = useState(
    String(config?.log_max_total_mb ?? 100),
  );

  function syncFromConfig(src: AiStudioConfig) {
    setAutoStart(!!src.auto_start);
    setHideDockIcon(!!src.hide_dock_icon);
    setListenAddr(src.listen_addr ?? "127.0.0.1:2048");
    setPreviewListenAddr(src.preview_listen_addr ?? "127.0.0.1:2050");
    setProxyApiKey(src.proxy_api_key ?? "");
    setApiKeyAccounts(src.api_key_accounts ?? "");
    setAuthStates(src.auth_states ?? "");
    setMediaOutput(src.media_output ?? "inline");
    setMediaBaseUrl(src.media_base_url ?? "");

    setWarmWorkerLimit(String(src.warm_worker_limit ?? 6));
    setMaxActiveWorkers(String(src.max_active_workers ?? 10));
    setWarmStartupConcurrency(String(src.warm_startup_concurrency ?? 2));
    setPerAccountConcurrency(String(src.per_account_concurrency ?? 1));
    setRoutingStrategy(src.routing_strategy ?? "fill-first");
    setAccountOrder(src.account_order ?? "");
    setMaxAccountSwitches(String(src.max_account_switches ?? 3));

    setWaaBackend(src.waa_backend ?? "spidermonkey");
    setUpstreamChannels(src.upstream_channels ?? ["playground"]);
    setBuildNativeNonstream(!!src.build_native_nonstream);
    setInitTimeout(src.init_timeout ?? "2m0s");
    setRequestTimeout(src.request_timeout ?? "30m0s");
    setFirstEventHedge(src.first_event_hedge ?? "auto");
    setFirstEventHedgeModels(src.first_event_hedge_models ?? "");

    setModelMapping(src.model_mapping ?? "");
    setModelChannels(src.model_channels ?? "");
    setModelAccounts(src.model_accounts ?? "");
    setSearchModelAliases(!!src.search_model_aliases);
    setDiscoverHiddenModels(!!src.discover_hidden_models);
    setGoogleSearch(!!src.google_search);
    setFakeStream(!!src.fake_stream);
    setNonstreamKeepalive(!!src.nonstream_keepalive);
    setYoutubeLinks(!!src.youtube_links);
    setStripThoughtSig(!!src.strip_thought_signatures);
    setContinuationRewrite(!!src.continuation_rewrite);
    setContinuationPrompt(src.continuation_prompt ?? "");

    setProxy(src.proxy ?? "");

    setAdminAuthEnabled(!!src.admin_auth_enabled);
    setAdminUsername(src.admin_username ?? "");
    setAdminPassword("");
    setRequestBodyLog(!!src.request_body_log);
    setLogFile(!!src.log_file);
    setLogMaxTotalMb(String(src.log_max_total_mb ?? 100));
  }

  useEffect(() => {
    if (config) syncFromConfig(config);
  }, [config]);

  useEffect(() => {
    setLatestUpdate(updateInfo);
  }, [updateInfo]);

  const dirtySections = useMemo(() => {
    const dirty: Record<SectionId, boolean> = {
      service: false,
      capacity: false,
      runtime: false,
      models: false,
      network: false,
      security: false,
    };
    if (!config) return dirty;

    dirty.service =
      autoStart !== !!config.auto_start ||
      hideDockIcon !== !!config.hide_dock_icon ||
      listenAddr !== (config.listen_addr ?? "127.0.0.1:2048") ||
      previewListenAddr !== (config.preview_listen_addr ?? "127.0.0.1:2050") ||
      proxyApiKey !== (config.proxy_api_key ?? "") ||
      apiKeyAccounts !== (config.api_key_accounts ?? "") ||
      authStates !== (config.auth_states ?? "") ||
      mediaOutput !== (config.media_output ?? "inline") ||
      mediaBaseUrl !== (config.media_base_url ?? "");

    dirty.capacity =
      warmWorkerLimit !== String(config.warm_worker_limit ?? 6) ||
      maxActiveWorkers !== String(config.max_active_workers ?? 10) ||
      warmStartupConcurrency !== String(config.warm_startup_concurrency ?? 2) ||
      perAccountConcurrency !== String(config.per_account_concurrency ?? 1) ||
      routingStrategy !== (config.routing_strategy ?? "fill-first") ||
      accountOrder !== (config.account_order ?? "") ||
      maxAccountSwitches !== String(config.max_account_switches ?? 3);

    const origChannels = (config.upstream_channels ?? ["playground"]).join(",");
    dirty.runtime =
      waaBackend !== (config.waa_backend ?? "spidermonkey") ||
      upstreamChannels.join(",") !== origChannels ||
      buildNativeNonstream !== !!config.build_native_nonstream ||
      initTimeout !== (config.init_timeout ?? "2m0s") ||
      requestTimeout !== (config.request_timeout ?? "30m0s") ||
      firstEventHedge !== (config.first_event_hedge ?? "auto") ||
      firstEventHedgeModels !== (config.first_event_hedge_models ?? "");

    dirty.models =
      modelMapping !== (config.model_mapping ?? "") ||
      modelChannels !== (config.model_channels ?? "") ||
      modelAccounts !== (config.model_accounts ?? "") ||
      searchModelAliases !== !!config.search_model_aliases ||
      discoverHiddenModels !== !!config.discover_hidden_models ||
      googleSearch !== !!config.google_search ||
      fakeStream !== !!config.fake_stream ||
      nonstreamKeepalive !== !!config.nonstream_keepalive ||
      youtubeLinks !== !!config.youtube_links ||
      stripThoughtSig !== !!config.strip_thought_signatures ||
      continuationRewrite !== !!config.continuation_rewrite ||
      continuationPrompt !== (config.continuation_prompt ?? "");

    dirty.network = proxy !== (config.proxy ?? "");

    dirty.security =
      adminAuthEnabled !== !!config.admin_auth_enabled ||
      adminUsername !== (config.admin_username ?? "") ||
      adminPassword.length > 0 ||
      requestBodyLog !== !!config.request_body_log ||
      logFile !== !!config.log_file ||
      logMaxTotalMb !== String(config.log_max_total_mb ?? 100);

    return dirty;
  }, [
    config,
    autoStart,
    hideDockIcon,
    listenAddr,
    previewListenAddr,
    proxyApiKey,
    apiKeyAccounts,
    authStates,
    mediaOutput,
    mediaBaseUrl,
    warmWorkerLimit,
    maxActiveWorkers,
    warmStartupConcurrency,
    perAccountConcurrency,
    routingStrategy,
    accountOrder,
    maxAccountSwitches,
    waaBackend,
    upstreamChannels,
    buildNativeNonstream,
    initTimeout,
    requestTimeout,
    firstEventHedge,
    firstEventHedgeModels,
    modelMapping,
    modelChannels,
    modelAccounts,
    searchModelAliases,
    discoverHiddenModels,
    googleSearch,
    fakeStream,
    nonstreamKeepalive,
    youtubeLinks,
    stripThoughtSig,
    continuationRewrite,
    continuationPrompt,
    proxy,
    adminAuthEnabled,
    adminUsername,
    adminPassword,
    requestBodyLog,
    logFile,
    logMaxTotalMb,
  ]);

  const dirtyCount = useMemo(
    () => Object.values(dirtySections).filter(Boolean).length,
    [dirtySections],
  );
  const isDirty = dirtyCount > 0;

  function toggleUpstreamChannel(ch: string) {
    setUpstreamChannels((prev) => {
      if (prev.includes(ch)) {
        const next = prev.filter((item) => item !== ch);
        return next.length > 0 ? next : prev;
      }
      return [...prev, ch];
    });
  }

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    if (!config) return;
    setBusy("save");
    setError("");
    try {
      const base: Record<string, unknown> = { ...config };
      for (const roKey of READONLY_CONFIG_KEYS) {
        delete base[roKey];
      }

      const parsedMaxActive = Math.max(1, Number(maxActiveWorkers) || 10);
      const parsedWarm = Math.min(
        Math.max(0, Number(warmWorkerLimit) || 0),
        parsedMaxActive,
      );
      const parsedStartup = Math.min(
        Math.max(1, Number(warmStartupConcurrency) || 1),
        parsedMaxActive,
      );

      const draft: Partial<AiStudioConfig> = {
        auto_start: getEnvLockKey(config, "auto_start") ? config.auto_start : autoStart,
        hide_dock_icon: getEnvLockKey(config, "hide_dock_icon")
          ? config.hide_dock_icon
          : hideDockIcon,
        listen_addr: getEnvLockKey(config, "listen_addr")
          ? config.listen_addr
          : listenAddr.trim(),
        preview_listen_addr: getEnvLockKey(config, "preview_listen_addr")
          ? config.preview_listen_addr
          : previewListenAddr.trim(),
        proxy_api_key: getEnvLockKey(config, "proxy_api_key")
          ? config.proxy_api_key
          : proxyApiKey.trim(),
        api_key_accounts: getEnvLockKey(config, "api_key_accounts")
          ? config.api_key_accounts
          : apiKeyAccounts.trim(),
        auth_states: getEnvLockKey(config, "auth_states")
          ? config.auth_states
          : authStates.trim(),
        media_output: getEnvLockKey(config, "media_output")
          ? config.media_output
          : mediaOutput,
        media_base_url: getEnvLockKey(config, "media_base_url")
          ? config.media_base_url
          : mediaBaseUrl.trim(),

        warm_worker_limit: getEnvLockKey(config, "warm_worker_limit")
          ? config.warm_worker_limit
          : parsedWarm,
        max_active_workers: getEnvLockKey(config, "max_active_workers")
          ? config.max_active_workers
          : parsedMaxActive,
        warm_startup_concurrency: getEnvLockKey(config, "warm_startup_concurrency")
          ? config.warm_startup_concurrency
          : parsedStartup,
        per_account_concurrency: getEnvLockKey(config, "per_account_concurrency")
          ? config.per_account_concurrency
          : Math.max(1, Number(perAccountConcurrency) || 1),
        routing_strategy: getEnvLockKey(config, "routing_strategy")
          ? config.routing_strategy
          : routingStrategy,
        account_order: getEnvLockKey(config, "account_order")
          ? config.account_order
          : accountOrder.trim(),
        max_account_switches: getEnvLockKey(config, "max_account_switches")
          ? config.max_account_switches
          : Math.max(0, Number(maxAccountSwitches) || 0),

        waa_backend: getEnvLockKey(config, "waa_backend")
          ? config.waa_backend
          : waaBackend,
        upstream_channels: getEnvLockKey(config, "upstream_channels")
          ? config.upstream_channels
          : upstreamChannels,
        build_native_nonstream: getEnvLockKey(config, "build_native_nonstream")
          ? config.build_native_nonstream
          : buildNativeNonstream,
        init_timeout: getEnvLockKey(config, "init_timeout")
          ? config.init_timeout
          : initTimeout.trim(),
        request_timeout: getEnvLockKey(config, "request_timeout")
          ? config.request_timeout
          : requestTimeout.trim(),
        first_event_hedge: getEnvLockKey(config, "first_event_hedge")
          ? config.first_event_hedge
          : firstEventHedge.trim() || "off",
        first_event_hedge_models: getEnvLockKey(config, "first_event_hedge_models")
          ? config.first_event_hedge_models
          : firstEventHedgeModels.trim(),

        model_mapping: getEnvLockKey(config, "model_mapping")
          ? config.model_mapping
          : modelMapping.trim(),
        model_channels: getEnvLockKey(config, "model_channels")
          ? config.model_channels
          : modelChannels.trim(),
        model_accounts: getEnvLockKey(config, "model_accounts")
          ? config.model_accounts
          : modelAccounts.trim(),
        search_model_aliases: getEnvLockKey(config, "search_model_aliases")
          ? config.search_model_aliases
          : searchModelAliases,
        discover_hidden_models: getEnvLockKey(config, "discover_hidden_models")
          ? config.discover_hidden_models
          : discoverHiddenModels,
        google_search: getEnvLockKey(config, "google_search")
          ? config.google_search
          : googleSearch,
        fake_stream: getEnvLockKey(config, "fake_stream")
          ? config.fake_stream
          : fakeStream,
        nonstream_keepalive: getEnvLockKey(config, "nonstream_keepalive")
          ? config.nonstream_keepalive
          : nonstreamKeepalive,
        youtube_links: getEnvLockKey(config, "youtube_links")
          ? config.youtube_links
          : youtubeLinks,
        strip_thought_signatures: getEnvLockKey(config, "strip_thought_signatures")
          ? config.strip_thought_signatures
          : stripThoughtSig,
        continuation_rewrite: getEnvLockKey(config, "continuation_rewrite")
          ? config.continuation_rewrite
          : continuationRewrite,
        continuation_prompt: getEnvLockKey(config, "continuation_prompt")
          ? config.continuation_prompt
          : continuationPrompt,

        proxy: getEnvLockKey(config, "proxy") ? config.proxy : proxy.trim(),

        admin_auth_enabled: getEnvLockKey(config, "admin_auth_enabled")
          ? config.admin_auth_enabled
          : adminAuthEnabled,
        admin_username: getEnvLockKey(config, "admin_username")
          ? config.admin_username
          : adminUsername.trim(),
        request_body_log: getEnvLockKey(config, "request_body_log")
          ? config.request_body_log
          : requestBodyLog,
        log_file: getEnvLockKey(config, "log_file") ? config.log_file : logFile,
        log_max_total_mb: getEnvLockKey(config, "log_max_total_mb")
          ? config.log_max_total_mb
          : Math.max(1, Number(logMaxTotalMb) || 100),
      };

      if (adminPassword && !getEnvLockKey(config, "admin_password")) {
        draft.admin_password = adminPassword;
      }

      const savePayload = {
        ...(base as Partial<AiStudioConfig>),
        ...draft,
      };
      const saved = onSaveConfig
        ? await onSaveConfig(savePayload)
        : await saveConfig(savePayload, config);

      setAdminPassword("");
      if (saved.management_restart_required && saved.service_restart_required) {
        notify("配置已保存，请重启程序以使全部修改生效");
      } else if (saved.management_restart_required) {
        notify("配置已保存，监听地址/密钥或管理登录修改需重启程序生效");
      } else if (saved.service_restart_required) {
        notify("配置已保存，请停止并重新启动生成服务后生效");
      } else {
        notify("配置已保存");
      }
      await onRefresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      notify(msg, true);
    } finally {
      setBusy(null);
    }
  }

  async function handleCheckUpdate() {
    setBusy("check-update");
    setError("");
    try {
      const info = await fetchUpdateInfo(true);
      setLatestUpdate(info);
      notify(info.available ? `发现新版本 ${info.latest}` : "当前已是最新版本");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      notify(msg, true);
    } finally {
      setBusy(null);
    }
  }

  async function handleApplyUpdate() {
    setBusy("apply-update");
    setError("");
    try {
      await applyUpdate();
      notify("已触发 2048 后端更新任务");
      await onRefresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      notify(msg, true);
    } finally {
      setBusy(null);
    }
  }

  const activeMeta =
    SECTIONS.find((item) => item.id === activeSection) ?? SECTIONS[0];
  const hedgePreset =
    firstEventHedge === "off" || firstEventHedge === "auto"
      ? firstEventHedge
      : "custom";

  return (
    <div style={{ display: "grid", gap: 18 }}>
      <div className="page-heading" style={{ flexWrap: "wrap" }}>
        <div>
          <div className="eyebrow">AI STUDIO · 服务配置</div>
          <h1>
            服务配置
            {isDirty && (
              <span className="title-count">{dirtyCount} 个分组有修改</span>
            )}
          </h1>
          <p>服务入口、容量、上游通道、网络与安全</p>
        </div>

        <div className="settings-actions">
          {isDirty && (
            <span className="dirty-pill">有 {dirtyCount} 个分组未保存</span>
          )}
          <Button
            type="button"
            disabled={!isDirty || busy === "save"}
            onClick={() => config && syncFromConfig(config)}
          >
            <RotateCcw size={14} />
            放弃修改
          </Button>
          <Button
            type="submit"
            form="aistudio-settings-form"
            className="primary"
            disabled={!isDirty || !config}
            busy={busy === "save"}
          >
            <Save size={14} />
            保存配置
          </Button>
        </div>
      </div>

      <ErrorBox message={error || updateError || ""} />

      {config?.management_restart_required && (
        <div className="aistudio-notice-bar">
          <AlertTriangle size={16} />
          <span>监听地址、API 密钥或管理登录配置已修改，需重启 2048 程序后生效。</span>
        </div>
      )}

      {config?.service_restart_required && (
        <div className="aistudio-notice-bar">
          <AlertTriangle size={16} />
          <span>部分运行时参数已保存，将在下次启动生成服务时生效。</span>
        </div>
      )}

      <form id="aistudio-settings-form" onSubmit={(e) => void handleSave(e)}>
        <div className="aistudio-settings-shell">
          <nav
            className="aistudio-settings-nav"
            aria-label="服务配置分组"
          >
            {SECTIONS.map((section) => {
              const active = activeSection === section.id;
              const dirty = dirtySections[section.id];
              return (
                <button
                  key={section.id}
                  type="button"
                  className={`aistudio-settings-nav-btn${active ? " active" : ""}`}
                  onClick={() => setActiveSection(section.id)}
                >
                  {section.icon}
                  <span>{section.label}</span>
                  {dirty && (
                    <span
                      className="aistudio-settings-nav-dot"
                      title="此分组有未保存的修改"
                    />
                  )}
                </button>
              );
            })}
          </nav>

          <section className="settings-section">
            <div className="settings-section-heading">
              <span className="settings-icon">{activeMeta.icon}</span>
              <div>
                <h2>{activeMeta.label}</h2>
                <p>{activeMeta.description}</p>
              </div>
            </div>

            <div className="settings-section-body">
              <div className="aistudio-setting-list">
                {activeSection === "service" && (
                  <>
                    <SettingRow
                      title="自动启动生成服务"
                      fieldKey="auto_start"
                      description="管理程序启动后直接启动生成服务。"
                      envKey={getEnvLockKey(config, "auto_start")}
                      isToggle
                    >
                      <Toggle
                        checked={autoStart}
                        onChange={(v) =>
                          !getEnvLockKey(config, "auto_start") && setAutoStart(v)
                        }
                        label={autoStart ? "已开启" : "已关闭"}
                      />
                    </SettingRow>

                    <SettingRow
                      title="隐藏 Dock 图标"
                      fieldKey="hide_dock_icon"
                      description="仅 macOS 桌面应用生效，隐藏程序坞图标。"
                      envKey={getEnvLockKey(config, "hide_dock_icon")}
                      isToggle
                    >
                      <Toggle
                        checked={hideDockIcon}
                        onChange={(v) =>
                          !getEnvLockKey(config, "hide_dock_icon") &&
                          setHideDockIcon(v)
                        }
                        label={hideDockIcon ? "已隐藏" : "显示"}
                      />
                    </SettingRow>

                    <SettingRow
                      title="服务监听地址"
                      fieldKey="listen_addr"
                      description="HTTP API 与控制台监听的 host:port 地址。"
                      effect="management"
                      envKey={getEnvLockKey(config, "listen_addr")}
                    >
                      <input
                        className="mono"
                        value={listenAddr}
                        onChange={(e) => setListenAddr(e.target.value)}
                        placeholder="127.0.0.1:2048"
                      />
                      {config?.active_listen_addr &&
                        config.active_listen_addr !== config.listen_addr && (
                          <span style={{ fontSize: 12, color: "var(--muted)" }}>
                            当前生效：{config.active_listen_addr}
                          </span>
                        )}
                    </SettingRow>

                    <SettingRow
                      title="预览监听地址"
                      fieldKey="preview_listen_addr"
                      description="API 试用页 HTML 预览的独立来源，以当前主机名加此端口打开，端口与监听地址不同。"
                      effect="management"
                      envKey={getEnvLockKey(config, "preview_listen_addr")}
                    >
                      <input
                        className="mono"
                        value={previewListenAddr}
                        onChange={(e) => setPreviewListenAddr(e.target.value)}
                        placeholder="127.0.0.1:2050"
                      />
                      {config?.active_preview_listen_addr &&
                        config.active_preview_listen_addr !==
                          config.preview_listen_addr && (
                          <span style={{ fontSize: 12, color: "var(--muted)" }}>
                            当前生效：{config.active_preview_listen_addr}
                          </span>
                        )}
                    </SettingRow>

                    <SettingRow
                      title="本地 API 密钥"
                      fieldKey="proxy_api_key"
                      description="支持逗号分隔多个密钥；留空时只有本机页面能调用。"
                      effect="management"
                      envKey={getEnvLockKey(config, "proxy_api_key")}
                    >
                      <div style={{ display: "flex", gap: 6 }}>
                        <input
                          className="mono"
                          type={showApiKey ? "text" : "password"}
                          value={proxyApiKey}
                          onChange={(e) => setProxyApiKey(e.target.value)}
                          placeholder="sk-..."
                        />
                        <Button
                          type="button"
                          onClick={() => setShowApiKey((v) => !v)}
                          title={showApiKey ? "隐藏密钥" : "显示密钥"}
                        >
                          {showApiKey ? <EyeOff size={14} /> : <Eye size={14} />}
                        </Button>
                      </div>
                    </SettingRow>

                    <SettingRow
                      title="各密钥可用的账户"
                      fieldKey="api_key_accounts"
                      description="选择每个密钥的请求由哪些账户处理；不选时可用全部账户（格式 key=acc1|acc2,...）。"
                      envKey={getEnvLockKey(config, "api_key_accounts")}
                    >
                      <input
                        className="mono"
                        value={apiKeyAccounts}
                        onChange={(e) => setApiKeyAccounts(e.target.value)}
                        placeholder="key1=acc1|acc2,key2=acc3"
                      />
                    </SettingRow>

                    <SettingRow
                      title="账户状态目录"
                      fieldKey="auth_states"
                      description="账户文件、目录或多个逗号分隔的路径。"
                      effect="service"
                      envKey={getEnvLockKey(config, "auth_states")}
                    >
                      <input
                        className="mono"
                        value={authStates}
                        onChange={(e) => setAuthStates(e.target.value)}
                        placeholder="./auth"
                      />
                    </SettingRow>

                    <SettingRow
                      title="媒体输出方式"
                      fieldKey="media_output"
                      description="控制生成图片/音频等媒体内容的返回形式。"
                      envKey={getEnvLockKey(config, "media_output")}
                    >
                      <Select
                        value={mediaOutput}
                        onChange={(e) => setMediaOutput(e.target.value)}
                      >
                        <option value="inline">内联 data URI (inline)</option>
                        <option value="url">本服务链接 (url)</option>
                      </Select>
                    </SettingRow>

                    {mediaOutput === "url" && (
                      <SettingRow
                        title="媒体链接前缀"
                        fieldKey="media_base_url"
                        description="媒体输出选择“本服务链接”时拼接的外部访问基础 URL。"
                        envKey={getEnvLockKey(config, "media_base_url")}
                      >
                        <input
                          className="mono"
                          value={mediaBaseUrl}
                          onChange={(e) => setMediaBaseUrl(e.target.value)}
                          placeholder="http://127.0.0.1:2048"
                        />
                      </SettingRow>
                    )}
                  </>
                )}

                {activeSection === "capacity" && (
                  <>
                    <SettingRow
                      title="常驻 Worker 数"
                      fieldKey="warm_worker_limit"
                      description="服务启动后预先保持预热的账户 Worker 数量，不超过峰值 Worker 上限。"
                      effect="service"
                      envKey={getEnvLockKey(config, "warm_worker_limit")}
                    >
                      <input
                        type="number"
                        min={0}
                        className="mono"
                        value={warmWorkerLimit}
                        onChange={(e) => setWarmWorkerLimit(e.target.value)}
                      />
                    </SettingRow>

                    <SettingRow
                      title="峰值 Worker 上限"
                      fieldKey="max_active_workers"
                      description="高峰期最多同时运行的账户 Worker 数量。"
                      effect="service"
                      envKey={getEnvLockKey(config, "max_active_workers")}
                    >
                      <input
                        type="number"
                        min={1}
                        className="mono"
                        value={maxActiveWorkers}
                        onChange={(e) => setMaxActiveWorkers(e.target.value)}
                      />
                    </SettingRow>

                    <SettingRow
                      title="Camoufox 启动并发"
                      fieldKey="warm_startup_concurrency"
                      description="同时冷启动的 Worker 数量。"
                      effect="service"
                      envKey={getEnvLockKey(config, "warm_startup_concurrency")}
                    >
                      <input
                        type="number"
                        min={1}
                        className="mono"
                        value={warmStartupConcurrency}
                        onChange={(e) =>
                          setWarmStartupConcurrency(e.target.value)
                        }
                      />
                    </SettingRow>

                    <SettingRow
                      title="单账户请求并发"
                      fieldKey="per_account_concurrency"
                      description="单个账户同时执行的请求数。"
                      effect="service"
                      envKey={getEnvLockKey(config, "per_account_concurrency")}
                    >
                      <input
                        type="number"
                        min={1}
                        className="mono"
                        value={perAccountConcurrency}
                        onChange={(e) =>
                          setPerAccountConcurrency(e.target.value)
                        }
                      />
                    </SettingRow>

                    <SettingRow
                      title="账户选择策略"
                      fieldKey="routing_strategy"
                      description="轮询依次使用各账户；粘性优先持续用同一账户，满载或不可用时切换。"
                      envKey={getEnvLockKey(config, "routing_strategy")}
                    >
                      <Select
                        value={routingStrategy}
                        onChange={(e) => setRoutingStrategy(e.target.value)}
                      >
                        <option value="fill-first">
                          账户粘性优先 (fill-first)
                        </option>
                        <option value="round-robin">轮询 (round-robin)</option>
                      </Select>
                    </SettingRow>

                    <SettingRow
                      title="账户顺序"
                      fieldKey="account_order"
                      description="账户粘性优先时依次使用这些账户，满载、冷却或不可用时换下一个；留空按账户 ID 依次使用。"
                      envKey={getEnvLockKey(config, "account_order")}
                    >
                      <input
                        className="mono"
                        value={accountOrder}
                        onChange={(e) => setAccountOrder(e.target.value)}
                        placeholder="acc1,acc2,..."
                      />
                    </SettingRow>

                    <SettingRow
                      title="最大故障切换次数"
                      fieldKey="max_account_switches"
                      description="单次请求在遇到限流、冷却或错误时最多切换账户的重试次数。"
                      envKey={getEnvLockKey(config, "max_account_switches")}
                    >
                      <input
                        type="number"
                        min={0}
                        className="mono"
                        value={maxAccountSwitches}
                        onChange={(e) => setMaxAccountSwitches(e.target.value)}
                      />
                    </SettingRow>
                  </>
                )}

                {activeSection === "runtime" && (
                  <>
                    <SettingRow
                      title="WAA 后端"
                      fieldKey="waa_backend"
                      description="WAA 是 AI Studio 官网每次生成前运行的验证程序；SpiderMonkey 在服务进程内运行（每账户约 150 MB 内存），Camoufox 在后台打开官网页面运行（每账户约 0.5 GB 内存）。"
                      effect="service"
                      envKey={getEnvLockKey(config, "waa_backend")}
                    >
                      <Select
                        value={waaBackend}
                        onChange={(e) => setWaaBackend(e.target.value)}
                      >
                        <option value="spidermonkey">SpiderMonkey</option>
                        <option value="camoufox">Camoufox</option>
                      </Select>
                    </SettingRow>

                    <SettingRow
                      title="上游通道"
                      fieldKey="upstream_channels"
                      description="Playground 为默认通道；Build 为旧版通道，上游已停用其生成，开启后被拒请求改经默认通道完成。"
                      envKey={getEnvLockKey(config, "upstream_channels")}
                    >
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        {CHANNEL_OPTIONS.map((ch) => {
                          const checked = upstreamChannels.includes(ch.id);
                          return (
                            <button
                              key={ch.id}
                              type="button"
                              className={`button ${checked ? "primary" : ""}`}
                              aria-pressed={checked}
                              onClick={() => toggleUpstreamChannel(ch.id)}
                            >
                              {ch.label}
                            </button>
                          );
                        })}
                      </div>
                    </SettingRow>

                    <SettingRow
                      title="非流式请求优先使用 Build"
                      fieldKey="build_native_nonstream"
                      description="非流式请求优先用 Build，不可用时用 Playground。"
                      envKey={getEnvLockKey(config, "build_native_nonstream")}
                      isToggle
                    >
                      <Toggle
                        checked={buildNativeNonstream}
                        onChange={(v) =>
                          !getEnvLockKey(config, "build_native_nonstream") &&
                          setBuildNativeNonstream(v)
                        }
                        label={buildNativeNonstream ? "已开启" : "已关闭"}
                      />
                    </SettingRow>

                    <SettingRow
                      title="初始化超时"
                      fieldKey="init_timeout"
                      description="Worker 启动与环境初始化的最大等待时间（如 2m0s）。"
                      effect="service"
                      envKey={getEnvLockKey(config, "init_timeout")}
                    >
                      <input
                        className="mono"
                        value={initTimeout}
                        onChange={(e) => setInitTimeout(e.target.value)}
                        placeholder="2m0s"
                      />
                    </SettingRow>

                    <SettingRow
                      title="请求超时"
                      fieldKey="request_timeout"
                      description="单次请求的最长执行时间（如 30m0s）。"
                      envKey={getEnvLockKey(config, "request_timeout")}
                    >
                      <input
                        className="mono"
                        value={requestTimeout}
                        onChange={(e) => setRequestTimeout(e.target.value)}
                        placeholder="30m0s"
                      />
                    </SettingRow>

                    <SettingRow
                      title="首字超时备用请求"
                      fieldKey="first_event_hedge"
                      description="等待首字响应超时后向备用账户发起对冲请求；自动模式取近 24 小时首字等待 p95（请求少于 20 次时不发起）。"
                      envKey={getEnvLockKey(config, "first_event_hedge")}
                    >
                      <div style={{ display: "grid", gap: 8 }}>
                        <Select
                          value={hedgePreset}
                          onChange={(e) => {
                            const val = e.target.value;
                            if (val === "custom") {
                              setFirstEventHedge(
                                firstEventHedge === "off" ||
                                  firstEventHedge === "auto"
                                  ? "5s"
                                  : firstEventHedge,
                              );
                            } else {
                              setFirstEventHedge(val);
                            }
                          }}
                        >
                          <option value="off">关闭 (off)</option>
                          <option value="auto">自动（近期 p95）</option>
                          <option value="custom">自定义时长</option>
                        </Select>
                        {hedgePreset === "custom" && (
                          <input
                            className="mono"
                            value={firstEventHedge}
                            onChange={(e) => setFirstEventHedge(e.target.value)}
                            placeholder="例如 5s 或 8000ms"
                          />
                        )}
                      </div>
                    </SettingRow>

                    <SettingRow
                      title="对冲适用模型"
                      fieldKey="first_event_hedge_models"
                      description="仅对指定模型启用首字超时备用请求（逗号分隔）；留空表示不限制模型。"
                      envKey={getEnvLockKey(config, "first_event_hedge_models")}
                    >
                      <input
                        className="mono"
                        value={firstEventHedgeModels}
                        onChange={(e) =>
                          setFirstEventHedgeModels(e.target.value)
                        }
                        placeholder="gemini-4-argon,gemini-4-neon"
                      />
                    </SettingRow>
                  </>
                )}

                {activeSection === "models" && (
                  <>
                    <SettingRow
                      title="模型映射"
                      fieldKey="model_mapping"
                      description="将外部请求的模型别名映射为实际目标模型（格式 alias=target,...）。"
                      envKey={getEnvLockKey(config, "model_mapping")}
                    >
                      <input
                        className="mono"
                        value={modelMapping}
                        onChange={(e) => setModelMapping(e.target.value)}
                        placeholder="gpt-4o=gemini-4-neon,..."
                      />
                    </SettingRow>

                    <SettingRow
                      title="模型通道绑定"
                      fieldKey="model_channels"
                      description="为指定模型固定上游通道（格式 model=playground|build,...）。"
                      envKey={getEnvLockKey(config, "model_channels")}
                    >
                      <input
                        className="mono"
                        value={modelChannels}
                        onChange={(e) => setModelChannels(e.target.value)}
                        placeholder="gemini-4-argon=playground"
                      />
                    </SettingRow>

                    <SettingRow
                      title="模型绑定账号"
                      fieldKey="model_accounts"
                      description="限制指定模型仅从这些账号中自动选号（格式 model=acc1|acc2,...）。"
                      envKey={getEnvLockKey(config, "model_accounts")}
                    >
                      <input
                        className="mono"
                        value={modelAccounts}
                        onChange={(e) => setModelAccounts(e.target.value)}
                        placeholder="gemini-4-neon=acc1|acc2"
                      />
                    </SettingRow>

                    <SettingRow
                      title="搜索后缀模型"
                      fieldKey="search_model_aliases"
                      description="为支持搜索的模型提供 -search 型号，使用该型号时启用 Google 搜索。"
                      envKey={getEnvLockKey(config, "search_model_aliases")}
                      isToggle
                    >
                      <Toggle
                        checked={searchModelAliases}
                        onChange={(v) =>
                          !getEnvLockKey(config, "search_model_aliases") &&
                          setSearchModelAliases(v)
                        }
                        label={searchModelAliases ? "已开启" : "已关闭"}
                      />
                    </SettingRow>

                    <SettingRow
                      title="探测官网隐藏模型"
                      fieldKey="discover_hidden_models"
                      description="同步账户模型目录时，从 AI Studio 官网前端找出账户模型列表尚未列出的模型，经上游确认可用后加入目录，可直接用于请求。"
                      envKey={getEnvLockKey(config, "discover_hidden_models")}
                      isToggle
                    >
                      <Toggle
                        checked={discoverHiddenModels}
                        onChange={(v) =>
                          !getEnvLockKey(config, "discover_hidden_models") &&
                          setDiscoverHiddenModels(v)
                        }
                        label={discoverHiddenModels ? "已开启" : "已关闭"}
                      />
                    </SettingRow>

                    <SettingRow
                      title="默认启用 Google 搜索"
                      fieldKey="google_search"
                      description="为支持搜索的模型默认挂载 Google Search 工具。"
                      envKey={getEnvLockKey(config, "google_search")}
                      isToggle
                    >
                      <Toggle
                        checked={googleSearch}
                        onChange={(v) =>
                          !getEnvLockKey(config, "google_search") &&
                          setGoogleSearch(v)
                        }
                        label={googleSearch ? "已开启" : "已关闭"}
                      />
                    </SettingRow>

                    <SettingRow
                      title="假流式"
                      fieldKey="fake_stream"
                      description="流式请求先取得完整结果再按流式输出，等待期间发送心跳，生成失败时换账户重试。"
                      envKey={getEnvLockKey(config, "fake_stream")}
                      isToggle
                    >
                      <Toggle
                        checked={fakeStream}
                        onChange={(v) =>
                          !getEnvLockKey(config, "fake_stream") &&
                          setFakeStream(v)
                        }
                        label={fakeStream ? "已开启" : "已关闭"}
                      />
                    </SettingRow>

                    <SettingRow
                      title="非流式请求保活"
                      fieldKey="nonstream_keepalive"
                      description="等待结果时每 10 秒写出一个换行，避免反向代理因长时间无数据断开连接。"
                      envKey={getEnvLockKey(config, "nonstream_keepalive")}
                      isToggle
                    >
                      <Toggle
                        checked={nonstreamKeepalive}
                        onChange={(v) =>
                          !getEnvLockKey(config, "nonstream_keepalive") &&
                          setNonstreamKeepalive(v)
                        }
                        label={nonstreamKeepalive ? "已开启" : "已关闭"}
                      />
                    </SettingRow>

                    <SettingRow
                      title="YouTube 链接识别"
                      fieldKey="youtube_links"
                      description="把用户消息文本中的 YouTube 链接作为视频发送给模型。"
                      envKey={getEnvLockKey(config, "youtube_links")}
                      isToggle
                    >
                      <Toggle
                        checked={youtubeLinks}
                        onChange={(v) =>
                          !getEnvLockKey(config, "youtube_links") &&
                          setYoutubeLinks(v)
                        }
                        label={youtubeLinks ? "已开启" : "已关闭"}
                      />
                    </SettingRow>

                    <SettingRow
                      title="剥离历史思考签名"
                      fieldKey="strip_thought_signatures"
                      description="发往上游前去掉对话历史中的思考签名，函数调用带 skip_thought_signature_validator；长对话的输入 token 较少。"
                      envKey={getEnvLockKey(config, "strip_thought_signatures")}
                      isToggle
                    >
                      <Toggle
                        checked={stripThoughtSig}
                        onChange={(v) =>
                          !getEnvLockKey(config, "strip_thought_signatures") &&
                          setStripThoughtSig(v)
                        }
                        label={stripThoughtSig ? "已开启" : "已关闭"}
                      />
                    </SettingRow>

                    <SettingRow
                      title="改写续写请求"
                      fieldKey="continuation_rewrite"
                      description="以 assistant 消息结尾的请求，在不支持原生续写的模型上改为续写请求；关闭时原样发送，上游拒绝时返回其错误。"
                      envKey={getEnvLockKey(config, "continuation_rewrite")}
                      isToggle
                    >
                      <Toggle
                        checked={continuationRewrite}
                        onChange={(v) =>
                          !getEnvLockKey(config, "continuation_rewrite") &&
                          setContinuationRewrite(v)
                        }
                        label={continuationRewrite ? "已开启" : "已关闭"}
                      />
                    </SettingRow>

                    <SettingRow
                      title="续写提示词"
                      fieldKey="continuation_prompt"
                      description="改写时与末尾的 assistant 消息一起写入系统指令；留空时末尾的 assistant 消息改作 user 消息发送。"
                      envKey={getEnvLockKey(config, "continuation_prompt")}
                    >
                      <textarea
                        rows={3}
                        value={continuationPrompt}
                        onChange={(e) => setContinuationPrompt(e.target.value)}
                        placeholder="留空则将末尾 assistant 消息改作 user 消息发送"
                      />
                    </SettingRow>
                  </>
                )}

                {activeSection === "network" && (
                  <>
                    <SettingRow
                      title="默认代理"
                      fieldKey="proxy"
                      description="HTTP、HTTPS 或 SOCKS5 代理，多个用逗号分隔组成代理池；留空用系统代理。"
                      effect="service"
                      envKey={getEnvLockKey(config, "proxy")}
                    >
                      <input
                        className="mono"
                        value={proxy}
                        onChange={(e) => setProxy(e.target.value)}
                        placeholder="http://127.0.0.1:7890"
                      />
                      {config?.active_proxy && (
                        <span style={{ fontSize: 12, color: "var(--muted)" }}>
                          当前出口：{config.active_proxy}
                        </span>
                      )}
                    </SettingRow>

                    <SettingRow
                      title="代理池"
                      fieldKey="proxy_pool"
                      description="当前配置下各代理出口的实时可用状态与绑定账户数（只读）。"
                    >
                      {config?.proxy_pool && config.proxy_pool.length > 0 ? (
                        <div style={{ display: "grid", gap: 6 }}>
                          {config.proxy_pool.map((item) => (
                            <div
                              key={item.proxy || "direct"}
                              style={{
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "space-between",
                                gap: 8,
                                padding: "6px 10px",
                                borderRadius: "var(--radius-sm)",
                                border: "1px solid var(--line)",
                                background: "var(--cream)",
                                fontSize: 12,
                              }}
                            >
                              <span className="mono">
                                {item.proxy || "直连 (Direct)"}
                              </span>
                              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                                <Badge variant={item.available ? "green" : "red"} dot>
                                  {item.available ? "可用" : "不可用"}
                                </Badge>
                                <span style={{ color: "var(--muted)" }}>
                                  {item.accounts} 个账户
                                </span>
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <span style={{ fontSize: 12.5, color: "var(--muted)" }}>
                          当前未配置代理池，使用直连或系统代理。
                        </span>
                      )}
                    </SettingRow>
                  </>
                )}

                {activeSection === "security" && (
                  <>
                    <SettingRow
                      title="开启管理登录"
                      fieldKey="admin_auth_enabled"
                      description="访问管理控制台需要管理员账号与密码。"
                      effect="management"
                      envKey={getEnvLockKey(config, "admin_auth_enabled")}
                      isToggle
                    >
                      <Toggle
                        checked={adminAuthEnabled}
                        onChange={(v) =>
                          !getEnvLockKey(config, "admin_auth_enabled") &&
                          setAdminAuthEnabled(v)
                        }
                        label={adminAuthEnabled ? "已开启" : "免密访问"}
                      />
                    </SettingRow>

                    <SettingRow
                      title="管理员用户名"
                      fieldKey="admin_username"
                      description="登录 2048 管理控制台使用的用户名。"
                      effect="management"
                      envKey={getEnvLockKey(config, "admin_username")}
                    >
                      <input
                        className="mono"
                        value={adminUsername}
                        onChange={(e) => setAdminUsername(e.target.value)}
                        placeholder="magpie"
                      />
                    </SettingRow>

                    <SettingRow
                      title="管理密码"
                      fieldKey="admin_password"
                      description="留空表示保持当前已设置的密码不变。"
                      effect="management"
                      envKey={getEnvLockKey(config, "admin_password")}
                    >
                      <input
                        type="password"
                        value={adminPassword}
                        onChange={(e) => setAdminPassword(e.target.value)}
                        placeholder={
                          config?.admin_password_set
                            ? "已设置（留空保持不变）"
                            : "输入新密码"
                        }
                      />
                    </SettingRow>

                    <SettingRow
                      title="保存请求正文"
                      fieldKey="request_body_log"
                      description="保留最近 1000 条请求与响应正文，在日志详情查看。"
                      envKey={getEnvLockKey(config, "request_body_log")}
                      isToggle
                    >
                      <Toggle
                        checked={requestBodyLog}
                        onChange={(v) =>
                          !getEnvLockKey(config, "request_body_log") &&
                          setRequestBodyLog(v)
                        }
                        label={requestBodyLog ? "已开启" : "已关闭"}
                      />
                    </SettingRow>

                    <SettingRow
                      title="写入日志文件"
                      fieldKey="log_file"
                      description="将运行日志持久化写入本地日志文件。"
                      effect="management"
                      envKey={getEnvLockKey(config, "log_file")}
                      isToggle
                    >
                      <Toggle
                        checked={logFile}
                        onChange={(v) =>
                          !getEnvLockKey(config, "log_file") && setLogFile(v)
                        }
                        label={logFile ? "已开启" : "已关闭"}
                      />
                    </SettingRow>

                    <SettingRow
                      title="日志总量上限（MB）"
                      fieldKey="log_max_total_mb"
                      description="本地保留日志文件的最大磁盘占用上限。"
                      effect="management"
                      envKey={getEnvLockKey(config, "log_max_total_mb")}
                    >
                      <input
                        type="number"
                        min={1}
                        className="mono"
                        value={logMaxTotalMb}
                        onChange={(e) => setLogMaxTotalMb(e.target.value)}
                      />
                    </SettingRow>
                  </>
                )}
              </div>
            </div>
          </section>
        </div>
      </form>

      {/* 版本检查与更新 */}
      <section className="settings-section">
        <div className="settings-section-heading">
          <span className="settings-icon">
            <ArrowUpCircle size={20} />
          </span>
          <div style={{ flex: 1 }}>
            <h2>版本检查与更新</h2>
            <p>
              当前版本：{latestUpdate?.current || "—"} · 最新版本：
              {latestUpdate?.latest || "—"} · 模式：{latestUpdate?.mode || "—"}
            </p>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Button
              type="button"
              busy={busy === "check-update"}
              onClick={() => void handleCheckUpdate()}
            >
              <RefreshCw size={14} />
              检查更新
            </Button>
            {latestUpdate?.available && (
              <Button
                type="button"
                className="primary"
                busy={busy === "apply-update"}
                onClick={() => void handleApplyUpdate()}
              >
                <ArrowUpCircle size={14} />
                立即更新到 {latestUpdate.latest}
              </Button>
            )}
          </div>
        </div>
        {latestUpdate?.notes && (
          <div className="settings-section-body">
            <pre className="aistudio-pre">{latestUpdate.notes}</pre>
          </div>
        )}
      </section>
    </div>
  );
}
