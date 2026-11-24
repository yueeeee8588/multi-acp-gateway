import { useCallback, useState } from "react";
import type { FormEvent } from "react";
import { Eye, EyeOff, KeyRound, Plus, Trash2 } from "lucide-react";
import {
  Badge,
  Button,
  Confirm,
  CopyButton,
  Empty,
  IconButton,
} from "../components";
import type { Notice } from "../components";
import { createKey, deleteKey, revealKey } from "./api";
import type { App2ApiKey } from "./types";

export interface App2ApiKeysViewProps {
  keys: App2ApiKey[];
  onRefresh: () => Promise<void>;
  notify: (msg: string, kind?: "success" | "error") => void;
}

function formatDateTime(val?: string | number | null): string {
  if (val === undefined || val === null || val === "") return "—";
  const d = new Date(val);
  if (Number.isNaN(d.getTime())) return String(val);
  return d.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function App2ApiKeysView({
  keys,
  onRefresh,
  notify,
}: App2ApiKeysViewProps) {
  const [label, setLabel] = useState("");
  const [creating, setCreating] = useState(false);
  const [freshKey, setFreshKey] = useState<{ label: string; secret: string } | null>(
    null
  );
  const [revealedSecrets, setRevealedSecrets] = useState<Record<string, string>>(
    {}
  );
  const [revealingId, setRevealingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<App2ApiKey | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  const copyNotify: Notice = useCallback(
    (text, isErr) => notify(text, isErr ? "error" : "success"),
    [notify]
  );

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = label.trim() || `8049-key-${keys.length + 1}`;
    setCreating(true);
    try {
      const created = await createKey(trimmed);
      const secret = created.key || created.token || "";
      if (secret) {
        setFreshKey({ label: created.label || trimmed, secret });
        setRevealedSecrets((prev) => ({ ...prev, [created.id]: secret }));
      }
      setLabel("");
      notify("已创建 8049 API 密钥", "success");
      await onRefresh();
    } catch (err) {
      notify(err instanceof Error ? err.message : "创建密钥失败", "error");
    } finally {
      setCreating(false);
    }
  };

  const handleToggleReveal = async (item: App2ApiKey) => {
    if (revealedSecrets[item.id]) {
      setRevealedSecrets((prev) => {
        const next = { ...prev };
        delete next[item.id];
        return next;
      });
      return;
    }

    setRevealingId(item.id);
    try {
      const res = await revealKey(item.id);
      const secret = res.key || res.token || res.secret || "";
      if (!secret) {
        notify("后端未返回明文密钥", "error");
        return;
      }
      setRevealedSecrets((prev) => ({ ...prev, [item.id]: secret }));
    } catch (err) {
      notify(err instanceof Error ? err.message : "显隐密钥失败", "error");
    } finally {
      setRevealingId(null);
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError("");
    try {
      await deleteKey(deleteTarget.id);
      setRevealedSecrets((prev) => {
        const next = { ...prev };
        delete next[deleteTarget.id];
        return next;
      });
      notify(`已吊销密钥「${deleteTarget.label}」`, "success");
      setDeleteTarget(null);
      await onRefresh();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "吊销密钥失败");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <section className="panel" style={{ padding: "18px 20px" }}>
        <form onSubmit={(e) => void handleCreate(e)} className="app2api-key-form">
          <div className="app2api-key-input">
            <KeyRound size={16} />
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="输入密钥备注名（例如：8046 上游池 / 本地开发）"
              maxLength={64}
              disabled={creating}
            />
          </div>
          <Button type="submit" className="primary" busy={creating}>
            <Plus size={15} />
            创建 API 密钥
          </Button>
        </form>

        {freshKey && (
          <div className="app2api-fresh-key">
            <div>
              <Badge variant="green">新建成功 · {freshKey.label}</Badge>
              <code className="app2api-code-chip">{freshKey.secret}</code>
            </div>
            <CopyButton
              value={freshKey.secret}
              notify={copyNotify}
              title="复制新密钥"
            />
          </div>
        )}
      </section>

      <section className="panel">
        {keys.length === 0 ? (
          <Empty
            title="暂无 8049 API 密钥"
            detail="创建一个密钥后，即可在 8046 服务提供商配置或第三方客户端中鉴权调用"
          />
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>备注名</th>
                  <th>密钥值</th>
                  <th>创建时间</th>
                  <th>最近使用</th>
                  <th style={{ textAlign: "right" }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {keys.map((item) => {
                  const revealed = revealedSecrets[item.id];
                  const displayVal =
                    revealed ||
                    item.maskedKey ||
                    (item.prefix ? `${item.prefix}••••••••` : `key_${item.id.slice(0, 8)}••••`);
                  const copyVal = revealed || item.key || item.token || "";

                  return (
                    <tr key={item.id}>
                      <td>
                        <strong>{item.label || "未命名密钥"}</strong>
                        <span className="cell-secondary">ID: {item.id}</span>
                      </td>
                      <td>
                        <div className="app2api-key-cell">
                          <code className="app2api-code-chip">{displayVal}</code>
                          <IconButton
                            title={revealed ? "隐藏密钥" : "显示明文密钥"}
                            disabled={revealingId === item.id}
                            onClick={() => void handleToggleReveal(item)}
                          >
                            {revealed ? <EyeOff size={15} /> : <Eye size={15} />}
                          </IconButton>
                          {copyVal && (
                            <CopyButton
                              value={copyVal}
                              notify={copyNotify}
                              title="复制密钥"
                            />
                          )}
                        </div>
                      </td>
                      <td>{formatDateTime(item.createdAt)}</td>
                      <td>
                        {formatDateTime(item.lastUsedAt)}
                        {typeof item.requestCount === "number" && (
                          <span className="cell-secondary">
                            累计 {item.requestCount} 次
                          </span>
                        )}
                      </td>
                      <td>
                        <div className="row-actions">
                          <IconButton
                            title="吊销密钥"
                            onClick={() => {
                              setDeleteError("");
                              setDeleteTarget(item);
                            }}
                          >
                            <Trash2 size={15} />
                          </IconButton>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {deleteTarget && (
        <Confirm
          title="吊销 API 密钥"
          message={`确定吊销密钥「${deleteTarget.label}」？吊销后使用该密钥的 8046 上游或客户端将立即失效。`}
          onClose={() => setDeleteTarget(null)}
          onConfirm={() => void handleConfirmDelete()}
          busy={deleting}
          error={deleteError}
        />
      )}
    </>
  );
}
