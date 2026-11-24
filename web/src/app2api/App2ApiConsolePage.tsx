import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Badge, Button, ErrorBox } from "../components";
import type { Notice } from "../components";
import { useMinSpin } from "../useMinSpin";
import { App2ApiAccountsView } from "./App2ApiAccountsView";
import { App2ApiKeysView } from "./App2ApiKeysView";
import { App2ApiLogsView } from "./App2ApiLogsView";
import { App2ApiModelsView } from "./App2ApiModelsView";
import { App2ApiSettingsView } from "./App2ApiSettingsView";
import type { App2ApiGatewayState } from "./useApp2ApiGateway";

type App2ApiTab = "accounts" | "keys" | "models" | "logs" | "settings";

const APP2API_TABS: readonly { id: App2ApiTab; label: string }[] = [
  { id: "accounts", label: "账号与配额" },
  { id: "keys", label: "API 密钥" },
  { id: "models", label: "三协议与模型" },
  { id: "logs", label: "请求与审计" },
  { id: "settings", label: "8049 运行配置" },
];

export interface App2ApiConsolePageProps {
  app2api: App2ApiGatewayState;
  notify: Notice;
  onLoadingChange?: (loading: boolean) => void;
}

export function App2ApiConsolePage({
  app2api,
  notify,
  onLoadingChange,
}: App2ApiConsolePageProps) {
  const [tab, setTab] = useState<App2ApiTab>("accounts");
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const refreshSpinning = useMinSpin(manualRefreshing);

  useEffect(() => {
    const initialLoading =
      app2api.loading &&
      !app2api.overview &&
      app2api.accounts.length === 0 &&
      !app2api.error;
    onLoadingChange?.(initialLoading);
  }, [
    app2api.loading,
    app2api.overview,
    app2api.accounts.length,
    app2api.error,
    onLoadingChange,
  ]);

  const app2apiNotify = useCallback(
    (msg: string, kind?: "success" | "error") => {
      notify(msg, kind === "error");
    },
    [notify]
  );

  const handleRefresh = useCallback(() => {
    setManualRefreshing(true);
    void app2api.refreshAll({
      onComplete: ({ ok, error }) => {
        setManualRefreshing(false);
        if (ok) {
          app2apiNotify("已刷新 8049 账号、密钥、日志与配置", "success");
        } else {
          app2apiNotify(error || "8049 控制台刷新失败", "error");
        }
      },
    });
  }, [app2api.refreshAll, app2apiNotify]);

  const readyAccounts = app2api.accounts.filter((acc) => {
    if (!acc.enabled) return false;
    const st = (acc.status || "ready").toLowerCase();
    return st === "ready" || st === "active" || st === "ok";
  }).length;

  return (
    <div className="acp-console-page">
      <div className="page-heading acp-console-heading">
        <div>
          <div className="eyebrow">GEMINI APP · 8049</div>
          <h1>Gemini App 控制台 (8049)</h1>
          <p>
            管理 8049 Gemini App 逆向账号池、API 密钥、三协议端点与运行配置
          </p>
        </div>

        <div className="acp-console-controls">
          <div
            className="segmented"
            role="tablist"
            aria-label="Gemini App 控制台子页"
          >
            {APP2API_TABS.map((item) => (
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

          <div className="acp-console-status">
            <Badge variant={app2api.online ? "green" : "red"} dot>
              {app2api.online
                ? `8049 在线 · ${readyAccounts}/${app2api.accounts.length} 就绪`
                : "8049 离线"}
            </Badge>
            <Button
              type="button"
              onClick={handleRefresh}
              disabled={app2api.loading}
            >
              <RefreshCw
                size={15}
                className={refreshSpinning ? "spin" : undefined}
              />
              刷新
            </Button>
          </div>
        </div>
      </div>

      <ErrorBox message={app2api.error ?? ""} />

      <div className="acp-console-body">
        {tab === "accounts" && (
          <App2ApiAccountsView
            overview={app2api.overview}
            accounts={app2api.accounts}
            keyCount={app2api.keys.length}
            online={app2api.online}
            onRefresh={app2api.refreshAll}
            notify={app2apiNotify}
          />
        )}
        {tab === "keys" && (
          <App2ApiKeysView
            keys={app2api.keys}
            onRefresh={app2api.refreshAll}
            notify={app2apiNotify}
          />
        )}
        {tab === "models" && (
          <App2ApiModelsView
            overview={app2api.overview}
            notify={app2apiNotify}
          />
        )}
        {tab === "logs" && (
          <App2ApiLogsView
            requests={app2api.requests}
            overview={app2api.overview}
            accounts={app2api.accounts}
            sseConnected={app2api.sseConnected}
            onRefresh={app2api.refreshAll}
            onCancelRequest={app2api.cancelRequest}
            onClearRequests={app2api.clearRequests}
            notify={app2apiNotify}
          />
        )}
        {tab === "settings" && (
          <App2ApiSettingsView
            settings={app2api.settings}
            onUpdated={() => {
              void app2api.refreshAll();
            }}
            notify={app2apiNotify}
          />
        )}
      </div>
    </div>
  );
}
