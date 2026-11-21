import { Fragment, useState } from "react";
import {
  AlertTriangle,
  Ban,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  ExternalLink,
  FileText,
  KeyRound,
  Pause,
  Play,
  RefreshCw,
  ShieldAlert,
  Terminal,
} from "lucide-react";
import { Badge, Button, Modal } from "../components";
import {
  resolveAttentionInfo,
  type AttentionCategory,
  type AttentionTone,
} from "./accountAttention";
import type { AccountRecord } from "./types";

export interface AcpAccountErrorModalProps {
  account: AccountRecord | null;
  busy?: boolean;
  onClose: () => void;
  onRelogin: (acc: AccountRecord) => Promise<void> | void;
  onToggleDisable: (acc: AccountRecord) => Promise<void> | void;
  onRefresh: (acc: AccountRecord) => Promise<void> | void;
  onOpenUrl: (
    acc: AccountRecord,
    url: string,
    actionLabel?: string
  ) => Promise<void> | void;
  notify: (msg: string, kind?: "success" | "error") => void;
}

function toneToBadgeVariant(tone: AttentionTone): "red" | "amber" | "neutral" {
  if (tone === "danger") return "red";
  if (tone === "warning") return "amber";
  return "neutral";
}

function formatDateTime(ts: number | null | undefined): string {
  if (!ts) return "未知";
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes()
  ).padStart(2, "0")}`;
}

function renderTextWithLinks(
  text: string,
  onLinkClick?: (url: string) => void
) {
  const urlRegex = /(https?:\/\/[^\s"'<>]+)/g;
  const parts = text.split(urlRegex);
  return parts.map((part, idx) => {
    if (/^https?:\/\//i.test(part)) {
      const cleaned = part.replace(/[.,;)\]]+$/, "");
      const trailing = part.slice(cleaned.length);
      return (
        <Fragment key={idx}>
          <a
            href={cleaned}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => {
              if (onLinkClick) {
                e.preventDefault();
                onLinkClick(cleaned);
              }
            }}
            style={{
              color: "var(--pink-500)",
              textDecoration: "underline",
              wordBreak: "break-all",
            }}
          >
            {cleaned}
          </a>
          {trailing}
        </Fragment>
      );
    }
    return <Fragment key={idx}>{part}</Fragment>;
  });
}

function getGuideTips(category: AttentionCategory): string[] {
  switch (category) {
    case "violation_blocked":
      return [
        "若认为属于误判，请点击上方「前往申诉」打开官方申诉表单，填写账号邮箱与使用场景说明。",
        "被封禁账号在申诉通过前请保持「停用隔离」，避免调度器反复重试导致同出口 IP 连带风控。",
        "若申诉长时间未回复或已确认永久停用，建议更换新号并检查近期触发高频或异常特征的请求。",
      ];
    case "validation_required":
      return [
        "请尽量使用与该账号相同的出口代理 / IP 环境在浏览器中打开验证链接，完成人机或手机号验证。",
        "验证通过后回到当前弹窗或列表，点击「验证后刷新」重新探活，状态恢复就绪即可继续调度。",
        "若页面反复要求验证，说明当前出口 IP 已被上游标记，建议为该账号切换更纯净的独立出口代理。",
      ];
    case "oauth_reauth_required":
      return [
        "当前 Refresh Token 可能已过期、被撤销，或账号仍停留在等待完成 OAuth 登录的状态。",
        "点击「重新 OAuth 登录」触发 CLI 登录，或使用列表顶部的「Chrome 扫描授权」/「批量导入 Token」重新导入凭证。",
      ];
    case "risk_controlled":
      return [
        "上游返回 429 / RESOURCE_EXHAUSTED 或触发临时风控策略，短时间高频重试会延长冷却时间。",
        "建议先降低该账号并发上限，等待冷却倒计时结束后再点击「冷却后刷新」。",
        "若同一出口 IP 下挂载了过多账号，建议分散出口代理后再恢复调度。",
      ];
    case "forbidden":
      return [
        "账号当前无权访问目标服务（可能受账号地区、项目开通状态或临时权限限制）。",
        "可尝试切换独立代理出口后点击「重新探活刷新」，确认是否恢复可用。",
      ];
    case "manual_disabled":
      return [
        "该账号当前处于手动停用状态，不会参与任何模型请求调度与自动配额刷新。",
        "确认凭证与出口正常后，点击「立即启用」即可重新加入可用账号池。",
      ];
  }
}

export function AcpAccountErrorModal({
  account,
  busy = false,
  onClose,
  onRelogin,
  onToggleDisable,
  onRefresh,
  onOpenUrl,
  notify,
}: AcpAccountErrorModalProps) {
  const [showRaw, setShowRaw] = useState(false);
  const [showGuide, setShowGuide] = useState(false);

  if (!account) return null;

  const info = resolveAttentionInfo(account);
  const rawReason = account.statusReason?.trim() || "";
  const hasRawDifference =
    Boolean(rawReason) && rawReason !== info.parsedMessage.trim();
  const tips = getGuideTips(info.category);

  const bannerColors =
    info.tone === "danger"
      ? {
          bg: "var(--rose-bg)",
          border: "rgba(180, 95, 80, 0.28)",
          text: "var(--rose)",
        }
      : info.tone === "warning"
        ? {
            bg: "var(--amber-bg)",
            border: "var(--honey-200)",
            text: "var(--amber)",
          }
        : {
            bg: "var(--pnl-soft)",
            border: "var(--line)",
            text: "var(--ink-soft)",
          };

  const handleCopyText = (text: string, successMsg: string) => {
    if (!text) return;
    navigator.clipboard
      ?.writeText(text)
      .then(() => notify(successMsg, "success"))
      .catch(() => notify("复制失败，请手动复制", "error"));
  };

  return (
    <Modal
      title="账号异常诊断与处理"
      subtitle={account.email || account.label}
      onClose={onClose}
      wide
      busy={busy}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        {/* 1. 账号标识与命中徽章 */}
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "10px",
            padding: "12px 14px",
            borderRadius: "var(--radius)",
            background: "var(--cream)",
            border: "1px solid var(--line)",
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div
              className="mono"
              style={{
                fontSize: "13.5px",
                fontWeight: 700,
                color: "var(--ink)",
                wordBreak: "break-all",
              }}
            >
              {account.email || account.label}
            </div>
            <div
              className="mono"
              style={{ fontSize: "11.5px", color: "var(--muted)", marginTop: "2px" }}
            >
              ID: {account.id}
              {account.exitIp ? ` · 出口: ${account.exitIp}` : ""}
            </div>
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
            {info.isDisabled && <Badge variant="neutral">已停用</Badge>}
            {(!info.isDisabled || info.category !== "manual_disabled") && (
              <Badge variant={toneToBadgeVariant(info.tone)} dot>
                {info.label}
              </Badge>
            )}
          </div>
        </div>

        {/* 2. 一句话诊断摘要 */}
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: "10px",
            padding: "12px 14px",
            borderRadius: "var(--radius)",
            background: bannerColors.bg,
            border: `1px solid ${bannerColors.border}`,
            color: bannerColors.text,
            fontSize: "13px",
            fontWeight: 600,
            lineHeight: 1.55,
          }}
        >
          {info.tone === "danger" ? (
            <Ban size={17} style={{ flexShrink: 0, marginTop: "2px" }} />
          ) : info.tone === "warning" ? (
            <AlertTriangle size={17} style={{ flexShrink: 0, marginTop: "2px" }} />
          ) : (
            <ShieldAlert size={17} style={{ flexShrink: 0, marginTop: "2px" }} />
          )}
          <span>{info.summary}</span>
        </div>

        {/* 3. 一键解决办法栏 */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "8px",
            padding: "12px 14px",
            borderRadius: "var(--radius)",
            background: "var(--surface)",
            border: "1px solid var(--line)",
          }}
        >
          <div
            style={{
              fontSize: "12px",
              fontWeight: 700,
              color: "var(--ink-soft)",
            }}
          >
            一键解决办法
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
            {info.category === "violation_blocked" && (
              <>
                {info.actionUrl && (
                  <Button
                    className="primary"
                    disabled={busy}
                    onClick={() =>
                      void onOpenUrl(account, info.actionUrl!, "申诉页面")
                    }
                  >
                    <ExternalLink size={14} />
                    前往申诉
                  </Button>
                )}
                {info.actionUrl && (
                  <Button
                    disabled={busy}
                    onClick={() =>
                      handleCopyText(info.actionUrl!, "申诉链接已复制到剪贴板")
                    }
                  >
                    <Copy size={14} />
                    复制申诉链接
                  </Button>
                )}
                <Button
                  disabled={busy}
                  onClick={() => void onToggleDisable(account)}
                >
                  {info.isDisabled ? <Play size={14} /> : <Pause size={14} />}
                  {info.isDisabled ? "启用" : "停用隔离"}
                </Button>
              </>
            )}

            {info.category === "validation_required" && (
              <>
                {info.actionUrl && (
                  <Button
                    className="primary"
                    disabled={busy}
                    onClick={() =>
                      void onOpenUrl(account, info.actionUrl!, "验证页面")
                    }
                  >
                    <ExternalLink size={14} />
                    点击去验证
                  </Button>
                )}
                {info.actionUrl && (
                  <Button
                    disabled={busy}
                    onClick={() =>
                      handleCopyText(info.actionUrl!, "验证链接已复制到剪贴板")
                    }
                  >
                    <Copy size={14} />
                    复制验证链接
                  </Button>
                )}
                <Button
                  disabled={busy}
                  onClick={() => void onRefresh(account)}
                >
                  <RefreshCw size={14} className={busy ? "spin" : undefined} />
                  验证后刷新
                </Button>
              </>
            )}

            {info.category === "oauth_reauth_required" && (
              <Button
                className="primary"
                disabled={busy}
                onClick={() => void onRelogin(account)}
              >
                <KeyRound size={14} />
                重新 OAuth 登录
              </Button>
            )}

            {info.category === "risk_controlled" && (
              <Button
                className="primary"
                disabled={busy}
                onClick={() => void onRefresh(account)}
              >
                <RefreshCw size={14} className={busy ? "spin" : undefined} />
                冷却后刷新
              </Button>
            )}

            {info.category === "forbidden" && (
              <Button
                className="primary"
                disabled={busy}
                onClick={() => void onRefresh(account)}
              >
                <RefreshCw size={14} className={busy ? "spin" : undefined} />
                重新探活刷新
              </Button>
            )}

            {info.category === "manual_disabled" && (
              <Button
                className="primary"
                disabled={busy}
                onClick={() => void onToggleDisable(account)}
              >
                <Play size={14} />
                立即启用
              </Button>
            )}
          </div>
        </div>

        {/* 4. 异常详情区（解析后 / 原始报文切换） */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "8px",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "8px",
            }}
          >
            <span
              style={{
                fontSize: "12.5px",
                fontWeight: 700,
                color: "var(--ink)",
              }}
            >
              异常原因详情
            </span>
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              {rawReason && (
                <button
                  type="button"
                  onClick={() =>
                    handleCopyText(
                      showRaw ? rawReason : info.parsedMessage || rawReason,
                      "异常信息已复制到剪贴板"
                    )
                  }
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "4px",
                    padding: "4px 8px",
                    borderRadius: "var(--radius-xs)",
                    border: "1px solid var(--line)",
                    background: "var(--surface)",
                    color: "var(--ink-soft)",
                    fontSize: "11.5px",
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  <Copy size={12} />
                  复制文本
                </button>
              )}
              {hasRawDifference && (
                <button
                  type="button"
                  onClick={() => setShowRaw((prev) => !prev)}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "4px",
                    padding: "4px 8px",
                    borderRadius: "var(--radius-xs)",
                    border: "1px solid var(--line)",
                    background: showRaw ? "var(--pink-50)" : "var(--surface)",
                    color: showRaw ? "var(--pink-600)" : "var(--ink-soft)",
                    fontSize: "11.5px",
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  {showRaw ? <FileText size={12} /> : <Terminal size={12} />}
                  {showRaw ? "显示解析后" : "显示原始报文"}
                </button>
              )}
            </div>
          </div>

          <div
            style={{
              padding: "12px 14px",
              borderRadius: "var(--radius)",
              border: "1px solid var(--line)",
              background: "var(--cream)",
              maxHeight: "200px",
              overflowY: "auto",
              fontSize: "12.5px",
              lineHeight: 1.6,
              color: "var(--ink)",
            }}
          >
            {!rawReason ? (
              <span style={{ color: "var(--muted)" }}>
                该账号未记录底层异常报文。
              </span>
            ) : showRaw ? (
              <pre
                className="mono"
                style={{
                  margin: 0,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  fontSize: "11.5px",
                  color: "var(--ink-soft)",
                }}
              >
                {rawReason}
              </pre>
            ) : (
              <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                {renderTextWithLinks(
                  info.parsedMessage || rawReason,
                  (url) => void onOpenUrl(account, url, "链接")
                )}
              </div>
            )}
          </div>
        </div>

        {/* 5. 可折叠的「排查与自救建议」 */}
        <div
          style={{
            borderRadius: "var(--radius)",
            border: "1px solid var(--line)",
            background: "var(--surface)",
            overflow: "hidden",
          }}
        >
          <button
            type="button"
            onClick={() => setShowGuide((prev) => !prev)}
            style={{
              width: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "10px 14px",
              border: 0,
              background: showGuide ? "var(--pnl-soft)" : "transparent",
              color: "var(--ink)",
              fontSize: "12.5px",
              fontWeight: 700,
              cursor: "pointer",
              textAlign: "left",
            }}
          >
            <span>排查与自救建议</span>
            {showGuide ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
          </button>
          {showGuide && (
            <div
              style={{
                padding: "10px 14px 12px",
                borderTop: "1px dashed var(--line)",
              }}
            >
              <ul
                style={{
                  margin: 0,
                  paddingLeft: "18px",
                  display: "flex",
                  flexDirection: "column",
                  gap: "6px",
                  fontSize: "12px",
                  lineHeight: 1.6,
                  color: "var(--ink-soft)",
                }}
              >
                {tips.map((tip, idx) => (
                  <li key={idx}>{tip}</li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {/* 6. 时间戳 */}
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "12px",
            fontSize: "11.5px",
            color: "var(--muted)",
          }}
        >
          <span style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}>
            <Clock size={12} />
            状态更新时间：{formatDateTime(account.updatedAt)}
          </span>
          {account.lastVerifiedAt && (
            <span>上次验证：{formatDateTime(account.lastVerifiedAt)}</span>
          )}
        </div>
      </div>
    </Modal>
  );
}
