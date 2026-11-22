import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { LogOut, Play, Power, RefreshCw, Square } from "lucide-react";
import {
  errorMessage,
  fetchAiStudioAutostart,
  setAiStudioAutostart,
} from "../api";
import type { AiStudioAutostartStatus } from "../api";
import { Badge, Button, ErrorBox, Field } from "../components";
import type { Notice } from "../components";
import { useMinSpin } from "../useMinSpin";
import { AiStudioAccountsView } from "./AiStudioAccountsView";
import { AiStudioLogsView } from "./AiStudioLogsView";
import { AiStudioModelsRequestsView } from "./AiStudioModelsRequestsView";
import { AiStudioSettingsView } from "./AiStudioSettingsView";
import type { AiStudioGatewayState } from "./useAiStudioGateway";
import "./aistudio.css";

type AiStudioTab = "accounts" | "models" | "logs" | "settings";

const TABS: readonly { id: AiStudioTab; label: string }[] = [
  { id: "accounts", label: "账号池与导入" },
  { id: "models", label: "模型与在途请求" },
  { id: "logs", label: "实时日志" },
  { id: "settings", label: "2048 运行配置" },
];

export interface AiStudioConsolePageProps {
  aistudio: AiStudioGatewayState;
  notify: Notice;
  onLoadingChange?: (loading: boolean) => void;
}

export function AiStudioConsolePage({
  aistudio,
  notify,
  onLoadingChange,
}: AiStudioConsolePageProps) {
  const [tab, setTab] = useState<AiStudioTab>("accounts");
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const [controlBusy, setControlBusy] = useState(false);
  const [autostartStatus, setAutostartStatus] =
    useState<AiStudioAutostartStatus | null>(null);
  const [autostartLoading, setAutostartLoading] = useState(true);
  const [autostartBusy, setAutostartBusy] = useState(false);
  const [username, setUsername] = useState("magpie");
  const [password, setPassword] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState("");
  const refreshSpin = useMinSpin(manualRefreshing);

  useEffect(() => {
    const initialLoading =
      aistudio.loading &&
      !aistudio.authSession &&
      !aistudio.status &&
      !aistudio.error;
    onLoadingChange?.(initialLoading);
  }, [
    aistudio.loading,
    aistudio.authSession,
    aistudio.status,
    aistudio.error,
    onLoadingChange,
  ]);

  useEffect(() => {
    let cancelled = false;
    setAutostartLoading(true);
    void fetchAiStudioAutostart()
      .then((res) => {
        if (!cancelled) setAutostartStatus(res);
      })
      .catch(() => {
        if (!cancelled) setAutostartStatus(null);
      })
      .finally(() => {
        if (!cancelled) setAutostartLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleRefresh = useCallback(() => {
    setManualRefreshing(true);
    void aistudio.refreshAll(({ ok, error }) => {
      setManualRefreshing(false);
      if (ok) {
        notify("已刷新 AI Studio 2048 状态与配置");
      } else {
        notify(error || "AI Studio 2048 刷新失败", true);
      }
    });
  }, [aistudio.refreshAll, notify]);

  async function handleToggleService() {
    if (!aistudio.status) return;
    const action = aistudio.status.running ? "stop" : "start";
    setControlBusy(true);
    try {
      await aistudio.toggleService(action);
      notify(action === "start" ? "已启动 AI Studio 生成服务" : "已停止 AI Studio 生成服务");
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), true);
    } finally {
      setControlBusy(false);
    }
  }

  async function handleToggleAutostart() {
    if (autostartBusy || !autostartStatus) return;
    if (!autostartStatus.supported) {
      notify("仅 Windows 环境支持 2048 开机自启", true);
      return;
    }
    const nextEnabled = !autostartStatus.enabled;
    if (nextEnabled && !autostartStatus.available) {
      notify("未检测到 magpie-aistudio-2048 启动脚本，无法开启开机自启", true);
      return;
    }
    setAutostartBusy(true);
    try {
      const updated = await setAiStudioAutostart(nextEnabled);
      setAutostartStatus(updated);
      notify(
        updated.enabled
          ? "已开启 AI Studio 2048 开机自启"
          : "已关闭 AI Studio 2048 开机自启",
      );
    } catch (err) {
      notify(errorMessage(err), true);
    } finally {
      setAutostartBusy(false);
    }
  }

  async function handleLogin(e: FormEvent) {
    e.preventDefault();
    setLoginBusy(true);
    setLoginError("");
    try {
      await aistudio.login(username.trim(), password);
      setPassword("");
      notify("已登录 AI Studio 2048 管理端");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setLoginError(msg);
      notify(msg, true);
    } finally {
      setLoginBusy(false);
    }
  }

  const st = aistudio.status;
  const readyCount = st?.accounts?.ready ?? aistudio.accounts.filter((a) => a.enabled && a.state === "ready").length;
  const totalCount = st?.accounts?.total ?? aistudio.accounts.length;

  const isManaged = aistudio.authSession?.mode === "managed";
  const isManual = aistudio.authSession?.mode === "manual";
  const managedAuthFailed =
    isManaged && aistudio.authSession?.authenticated === false;
  const hideContentForAuth = aistudio.authRequired || managedAuthFailed;

  return (
    <div className="acp-console-page">
      <div className="page-heading acp-console-heading">
        <div>
          <div className="eyebrow">AI STUDIO · 2048</div>
          <h1>AI Studio 控制台 (2048)</h1>
          <p>
            托管 AIStudio2API 原生后端：账号池、模型路由、实时在途请求、用量账单与运行配置
          </p>
        </div>

        <div className="acp-console-controls">
          {!hideContentForAuth && (
            <div
              className="segmented"
              role="tablist"
              aria-label="AI Studio 控制台子页"
            >
              {TABS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === item.id}
                  className={tab === item.id ? "selected" : ""}
                  onClick={() => setTab(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          )}

          <div className="acp-console-status">
            <Badge variant={aistudio.online && st?.running ? "green" : aistudio.online ? "amber" : "red"} dot>
              {!aistudio.online
                ? "2048 离线"
                : st
                  ? `${st.state} · ${st.version} · ${readyCount}/${totalCount} 就绪 · ${st.active_requests} 在途`
                  : "已连接"}
            </Badge>
            {!hideContentForAuth && (
              <Badge variant={aistudio.sseConnected ? "green" : "neutral"} dot>
                {aistudio.sseConnected ? "SSE 实时" : "SSE 未连接"}
              </Badge>
            )}
            {st && !hideContentForAuth && (
              <Button
                type="button"
                busy={controlBusy}
                onClick={() => void handleToggleService()}
              >
                {st.running ? <Square size={14} /> : <Play size={14} />}
                {st.running ? "停止服务" : "启动服务"}
              </Button>
            )}
            <Button
              type="button"
              className={autostartStatus?.enabled ? "primary" : ""}
              busy={autostartBusy}
              disabled={
                autostartLoading ||
                !autostartStatus ||
                !autostartStatus.supported ||
                (!autostartStatus.enabled && !autostartStatus.available)
              }
              title={
                !autostartStatus
                  ? "正在加载开机自启状态"
                  : !autostartStatus.supported
                    ? "仅 Windows 环境支持开机自启"
                    : !autostartStatus.available && !autostartStatus.enabled
                      ? "未检测到 magpie-aistudio-2048 启动脚本"
                      : autostartStatus.enabled
                        ? "点击关闭 AI Studio 2048 开机自启"
                        : "点击开启 AI Studio 2048 开机自启"
              }
              onClick={() => void handleToggleAutostart()}
            >
              {!autostartBusy && <Power size={14} />}
              {autostartLoading
                ? "开机自启..."
                : autostartStatus?.enabled
                  ? "开机自启：已开启"
                  : "开机自启：已关闭"}
            </Button>
            <Button
              type="button"
              onClick={handleRefresh}
              disabled={aistudio.loading}
            >
              <RefreshCw
                size={15}
                className={refreshSpin ? "spin" : undefined}
              />
              刷新
            </Button>
            {isManaged ? (
              <Badge variant={managedAuthFailed ? "red" : "neutral"}>
                {managedAuthFailed ? "8046 托管鉴权失败" : "由 8046 会话统一托管"}
              </Badge>
            ) : (
              isManual &&
              aistudio.authSession?.enabled &&
              aistudio.authSession.authenticated && (
                <Button
                  type="button"
                  onClick={() => {
                    void aistudio
                      .logout()
                      .then(() => notify("已退出 AI Studio 管理端"))
                      .catch((err) =>
                        notify(err instanceof Error ? err.message : String(err), true),
                      );
                  }}
                >
                  <LogOut size={14} />
                  退出
                </Button>
              )
            )}
          </div>
        </div>
      </div>

      <ErrorBox message={aistudio.error ?? ""} />

      {managedAuthFailed ? null : aistudio.authRequired ? (
        <form className="aistudio-auth-card" onSubmit={(e) => void handleLogin(e)}>
          <div>
            <h2>登录 AI Studio 2048 管理端</h2>
            <p>后端启用了管理端鉴权（ADMIN_AUTH_ENABLED=true），请输入管理凭证以继续</p>
          </div>
          <ErrorBox message={loginError} />
          <Field label="管理员用户名">
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              required
            />
          </Field>
          <Field label="管理员密码">
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </Field>
          <Button type="submit" className="primary" busy={loginBusy}>
            登录控制台
          </Button>
        </form>
      ) : (
        <div className="acp-console-body">
          {tab === "accounts" && (
            <AiStudioAccountsView
              accounts={aistudio.accounts}
              exits={aistudio.exits}
              exitsError={aistudio.optionalErrors.exits}
              tasks={aistudio.tasks}
              onRefresh={aistudio.refreshAll}
              notify={notify}
            />
          )}
          {tab === "models" && (
            <AiStudioModelsRequestsView
              models={aistudio.models}
              requests={aistudio.requests}
              cooldowns={aistudio.cooldowns}
              config={aistudio.config}
              onSaveConfig={aistudio.saveConfig}
              onRefresh={aistudio.refreshAll}
              notify={notify}
            />
          )}
          {tab === "logs" && (
            <AiStudioLogsView
              requests={aistudio.requests}
              cooldowns={aistudio.cooldowns}
              logs={aistudio.logs}
              sseConnected={aistudio.sseConnected}
              onRefresh={aistudio.refreshAll}
              onClearLogs={aistudio.clearLogs}
              notify={notify}
            />
          )}
          {tab === "settings" && (
            <AiStudioSettingsView
              config={aistudio.config}
              accounts={aistudio.accounts}
              models={aistudio.models}
              updateInfo={aistudio.updateInfo}
              updateError={aistudio.optionalErrors.update}
              onSaveConfig={aistudio.saveConfig}
              onRefresh={aistudio.refreshAll}
              notify={notify}
            />
          )}
        </div>
      )}
    </div>
  );
}
