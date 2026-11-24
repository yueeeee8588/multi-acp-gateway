import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { RotateCcw, Save, Server, SlidersHorizontal } from "lucide-react";
import { Button, Empty, ErrorBox, Field, Toggle } from "../components";
import { updateSettings } from "./api";
import type { App2ApiSettings } from "./types";

export interface App2ApiSettingsViewProps {
  settings: App2ApiSettings | null;
  onUpdated: (next: App2ApiSettings) => void;
  notify: (msg: string, kind?: "success" | "error") => void;
}

const DEFAULT_SETTINGS: App2ApiSettings = {
  host: "127.0.0.1",
  port: 8049,
  timeoutMs: 180_000,
  maxConcurrent: 8,
  maxBodyBytes: 128 * 1024 * 1024,
  maxPromptBytes: 0,
  continuation: false,
  allowRemoteImages: false,
  sessionTtlMs: 3_600_000,
  maxSessions: 256,
};

function clampInt(value: number, min: number, max: number): number {
  const rounded = Math.round(value);
  if (!Number.isFinite(rounded)) return min;
  return Math.max(min, Math.min(max, rounded));
}

function toFiniteNumber(raw: string, fallback: number): number {
  if (raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function App2ApiSettingsView({
  settings,
  onUpdated,
  notify,
}: App2ApiSettingsViewProps) {
  const [draft, setDraft] = useState<App2ApiSettings | null>(() =>
    settings ? { ...DEFAULT_SETTINGS, ...settings } : null
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!settings) {
      setDraft(null);
      return;
    }
    setDraft((prev) => prev ?? { ...DEFAULT_SETTINGS, ...settings });
  }, [settings]);

  const handleReset = () => {
    if (!settings) return;
    setDraft({ ...DEFAULT_SETTINGS, ...settings });
    setError("");
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!draft || !settings) return;
    setSaving(true);
    setError("");
    try {
      const normalized: Partial<App2ApiSettings> = {
        timeoutMs: clampInt(draft.timeoutMs, 1000, 600_000),
        maxConcurrent: clampInt(draft.maxConcurrent, 1, 64),
        maxPromptBytes: clampInt(draft.maxPromptBytes, 0, 16 * 1024 * 1024),
        continuation: Boolean(draft.continuation),
        allowRemoteImages: Boolean(draft.allowRemoteImages),
        sessionTtlMs: clampInt(draft.sessionTtlMs, 1000, 86_400_000),
        maxSessions: clampInt(draft.maxSessions, 1, 4096),
      };

      const patchPayload: Partial<App2ApiSettings> = {};
      if (normalized.timeoutMs !== settings.timeoutMs) {
        patchPayload.timeoutMs = normalized.timeoutMs;
      }
      if (normalized.maxConcurrent !== settings.maxConcurrent) {
        patchPayload.maxConcurrent = normalized.maxConcurrent;
      }
      if (normalized.maxPromptBytes !== settings.maxPromptBytes) {
        patchPayload.maxPromptBytes = normalized.maxPromptBytes;
      }
      if (normalized.continuation !== settings.continuation) {
        patchPayload.continuation = normalized.continuation;
      }
      if (normalized.allowRemoteImages !== settings.allowRemoteImages) {
        patchPayload.allowRemoteImages = normalized.allowRemoteImages;
      }
      if (normalized.sessionTtlMs !== settings.sessionTtlMs) {
        patchPayload.sessionTtlMs = normalized.sessionTtlMs;
      }
      if (normalized.maxSessions !== settings.maxSessions) {
        patchPayload.maxSessions = normalized.maxSessions;
      }

      if (Object.keys(patchPayload).length === 0) {
        notify("配置未发生变化", "success");
        return;
      }

      const updated = await updateSettings(patchPayload);
      setDraft({ ...DEFAULT_SETTINGS, ...updated });
      onUpdated(updated);
      notify("8049 运行配置已保存", "success");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "保存 8049 配置失败";
      setError(msg);
      notify(msg, "error");
    } finally {
      setSaving(false);
    }
  };

  if (!draft) {
    return (
      <section className="panel">
        <Empty
          title="尚未获取到 8049 运行配置"
          detail="请确认 8049 网关进程已启动后点击右上角刷新"
        />
      </section>
    );
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="app2api-settings-form">
      <section className="panel" style={{ padding: "20px 22px" }}>
        <div className="app2api-panel-head" style={{ marginBottom: 16 }}>
          <div>
            <h3 style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Server size={16} />
              网络与并发限制
            </h3>
            <p className="cell-secondary">
              控制 8049 监听地址、请求超时、并发上限与请求体大小阈值
            </p>
          </div>
        </div>

        <div className="app2api-settings-grid">
          <Field
            label="监听主机 (host)"
            hint="由网关启动参数托管（只读）"
          >
            <input value={draft.host || "127.0.0.1"} readOnly disabled />
          </Field>

          <Field
            label="监听端口 (port)"
            hint="默认 8049，由网关启动参数托管（只读）"
          >
            <input value={draft.port ?? 8049} readOnly disabled />
          </Field>

          <Field label="请求超时 (timeoutMs)" hint="单位：毫秒，范围 1000 ~ 600000">
            <input
              type="number"
              min={1000}
              max={600_000}
              step={1000}
              value={draft.timeoutMs}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  timeoutMs: toFiniteNumber(e.target.value, draft.timeoutMs),
                })
              }
            />
          </Field>

          <Field label="最大并发数 (maxConcurrent)" hint="范围 1 ~ 64">
            <input
              type="number"
              min={1}
              max={64}
              value={draft.maxConcurrent}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  maxConcurrent: toFiniteNumber(
                    e.target.value,
                    draft.maxConcurrent
                  ),
                })
              }
            />
          </Field>

          <Field
            label="最大请求体字节 (maxBodyBytes)"
            hint="由网关静态配置托管（只读）"
          >
            <input value={draft.maxBodyBytes} readOnly disabled />
          </Field>

          <Field
            label="最大提示词字节 (maxPromptBytes)"
            hint="0 表示禁用限制，最大 16777216 字节 (16 MiB)"
          >
            <input
              type="number"
              min={0}
              max={16 * 1024 * 1024}
              step={1024}
              value={draft.maxPromptBytes}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  maxPromptBytes: toFiniteNumber(
                    e.target.value,
                    draft.maxPromptBytes
                  ),
                })
              }
            />
          </Field>
        </div>
      </section>

      <section className="panel" style={{ padding: "20px 22px" }}>
        <div className="app2api-panel-head" style={{ marginBottom: 16 }}>
          <div>
            <h3 style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <SlidersHorizontal size={16} />
              会话与多模态特性
            </h3>
            <p className="cell-secondary">
              管理续写模式、远程图片拉取及内存会话池生命周期
            </p>
          </div>
        </div>

        <div className="app2api-settings-grid">
          <Field label="会话存活时间 (sessionTtlMs)" hint="单位：毫秒，范围 1000 ~ 86400000">
            <input
              type="number"
              min={1000}
              max={86_400_000}
              step={1000}
              value={draft.sessionTtlMs}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  sessionTtlMs: toFiniteNumber(
                    e.target.value,
                    draft.sessionTtlMs
                  ),
                })
              }
            />
          </Field>

          <Field label="最大会话缓存数 (maxSessions)" hint="范围 1 ~ 4096">
            <input
              type="number"
              min={1}
              max={4096}
              value={draft.maxSessions}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  maxSessions: toFiniteNumber(
                    e.target.value,
                    draft.maxSessions
                  ),
                })
              }
            />
          </Field>

          <div className="app2api-toggle-box">
            <Toggle
              checked={draft.continuation}
              onChange={(checked) => {
                if (checked) {
                  notify("当前 8049 网关版本暂不支持开启自动续写", "error");
                  return;
                }
                setDraft({ ...draft, continuation: false });
              }}
              label="启用长响应自动续写 (continuation)"
            />
            <span className="cell-secondary">
              当前 8049 网关版本暂不支持开启自动续写（仅允许关闭）
            </span>
          </div>

          <div className="app2api-toggle-box">
            <Toggle
              checked={draft.allowRemoteImages}
              onChange={(checked) =>
                setDraft({ ...draft, allowRemoteImages: checked })
              }
              label="允许拉取远程图片 URL (allowRemoteImages)"
            />
            <span className="cell-secondary">
              关闭后仅接受 Base64 内联图片，提升内网隔离安全性
            </span>
          </div>
        </div>

        <ErrorBox message={error} />

        <div className="app2api-settings-actions">
          <Button type="button" onClick={handleReset} disabled={saving}>
            <RotateCcw size={15} />
            重置修改
          </Button>
          <Button type="submit" className="primary" busy={saving}>
            <Save size={15} />
            保存配置
          </Button>
        </div>
      </section>
    </form>
  );
}
