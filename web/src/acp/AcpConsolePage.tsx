import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Badge, Button, ErrorBox } from "../components";
import type { Notice } from "../components";
import { AcpAccountsView } from "./AcpAccountsView";
import { AcpLiveLogsSection } from "./AcpLiveLogsSection";
import { AcpModelsView } from "./AcpModelsView";
import { AcpSettingsView } from "./AcpSettingsView";
import type { AcpGatewayState } from "./useAcpGateway";
import { useMinSpin } from "../useMinSpin";

type AcpTab = "accounts" | "models" | "logs" | "settings";

const ACP_TABS: readonly { id: AcpTab; label: string }[] = [
  { id: "accounts", label: "账号与风控" },
  { id: "models", label: "模型目录" },
  { id: "logs", label: "实时日志" },
  { id: "settings", label: "8048 运行配置" },
];

export interface AcpConsolePageProps {
  acp: AcpGatewayState;
  notify: Notice;
  onOpenPlayground: (modelId: string) => void;
  onLoadingChange?: (loading: boolean) => void;
}

export function AcpConsolePage({
  acp,
  notify,
  onOpenPlayground,
  onLoadingChange,
}: AcpConsolePageProps) {
  const [tab, setTab] = useState<AcpTab>("accounts");
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const refreshSpinning = useMinSpin(manualRefreshing);

  useEffect(() => {
    const initialLoading =
      acp.loading && !acp.config && acp.accounts.length === 0 && !acp.error;
    onLoadingChange?.(initialLoading);
  }, [acp.loading, acp.config, acp.accounts.length, acp.error, onLoadingChange]);

  const acpNotify = useCallback(
    (msg: string, kind?: "success" | "error") => {
      notify(msg, kind === "error");
    },
    [notify],
  );

  const handleRefresh = useCallback(() => {
    setManualRefreshing(true);
    void acp.refreshAll({
      onComplete: ({ ok, error }) => {
        setManualRefreshing(false);
        if (ok) {
          acpNotify("已刷新账号、风控、日志与配置", "success");
        } else {
          acpNotify(error || "ACP 控制台刷新失败", "error");
        }
      },
    });
  }, [acp.refreshAll, acpNotify]);

  return (
    <div className="acp-console-page">
      <div className="page-heading acp-console-heading">
        <div>
          <div className="eyebrow">ACP GATEWAY · 8048</div>
          <h1>ACP 控制台</h1>
          <p>管理 8048 AGY-Gemini ACP 账号池、风控冷却、模型目录与运行配置</p>
        </div>

        <div className="acp-console-controls">
          <div className="segmented" role="tablist" aria-label="ACP 控制台子页">
            {ACP_TABS.map((item) => (
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
            <Badge variant={acp.sseConnected ? "green" : "amber"} dot>
              {acp.sseConnected ? "已连接" : "重连中"}
            </Badge>
            <Button
              type="button"
              onClick={handleRefresh}
              disabled={acp.loading}
            >
              <RefreshCw size={15} className={refreshSpinning ? "spin" : undefined} />
              刷新
            </Button>
          </div>
        </div>
      </div>

      <ErrorBox message={acp.error ?? ""} />

      <div className="acp-console-body">
        {tab === "accounts" && (
          <AcpAccountsView
            accounts={acp.accounts}
            exits={acp.exits}
            cooldowns={acp.cooldowns}
            onRefresh={acp.refreshAll}
            notify={acpNotify}
          />
        )}
        {tab === "models" && (
          <AcpModelsView
            onTryModel={onOpenPlayground}
            notify={acpNotify}
          />
        )}
        {tab === "logs" && (
          <AcpLiveLogsSection
            requests={acp.requests}
            cooldowns={acp.cooldowns}
            sseConnected={acp.sseConnected}
            onRefresh={acp.refreshAll}
            notify={acpNotify}
            defaultOpen
          />
        )}
        {tab === "settings" && (
          <AcpSettingsView
            config={acp.config}
            onUpdated={() => {
              void acp.refreshAll();
            }}
            notify={acpNotify}
          />
        )}
      </div>
    </div>
  );
}
