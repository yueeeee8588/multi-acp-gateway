import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Globe, KeyRound, RefreshCw } from "lucide-react";
import {
  Badge,
  Button,
  ErrorBox,
  Field,
  Modal,
  ModalForm,
} from "../components";
import type { Notice } from "../components";
import {
  createAccountTask,
  discoverCookies,
  fetchChromeProfiles,
  importChromeAccounts,
  importCookies,
} from "./api";
import type {
  AiStudioChromeProfile,
  AiStudioDiscoveredCookieAccount,
} from "./types";

// ============================================================================
// 1. Cookie 无头导入弹窗
// ============================================================================

export interface CookieImportModalProps {
  onClose: () => void;
  onImported: () => Promise<unknown>;
  notify: Notice;
}

export function CookieImportModal({
  onClose,
  onImported,
  notify,
}: CookieImportModalProps) {
  const [cookieText, setCookieText] = useState("");
  const [cookieEmail, setCookieEmail] = useState("");
  const [cookieAuthuser, setCookieAuthuser] = useState("0");
  const [cookieProxy, setCookieProxy] = useState("");
  const [discovered, setDiscovered] = useState<AiStudioDiscoveredCookieAccount[]>([]);
  const [discoverBusy, setDiscoverBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function handleDiscover() {
    if (!cookieText.trim()) {
      setError("请先粘贴 Cookie 内容");
      return;
    }
    setDiscoverBusy(true);
    setError("");
    try {
      const accountsFound = await discoverCookies({
        cookies: cookieText.trim(),
        ...(cookieProxy.trim() ? { proxy: cookieProxy.trim() } : {}),
      });
      setDiscovered(accountsFound);
      if (accountsFound.length === 1 && !accountsFound[0].restricted) {
        setCookieEmail(accountsFound[0].email || "");
        setCookieAuthuser(String(accountsFound[0].auth_user ?? 0));
      }
      notify(`已完成 Cookie 探测，发现 ${accountsFound.length} 个会话`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      notify(msg, true);
    } finally {
      setDiscoverBusy(false);
    }
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!cookieText.trim()) {
      setError("请先粘贴 Cookie 内容");
      return;
    }
    const authUserNum = Number(cookieAuthuser.trim() || "0");
    if (!Number.isInteger(authUserNum) || authUserNum < 0) {
      setError("auth_user 必须是非负整数索引（如 0、1、2）");
      return;
    }

    setBusy(true);
    setError("");
    try {
      const res = await importCookies({
        items: [
          {
            email: cookieEmail.trim(),
            cookies: cookieText.trim(),
            cdp: "",
            auth_user: authUserNum,
          },
        ],
        proxy: cookieProxy.trim(),
        locale: "",
        timezone: "",
      });
      if (!res?.task || typeof res.task.id !== "string" || !res.task.id.trim()) {
        throw new Error("Cookie 导入未返回有效任务 ID，请检查后端响应");
      }
      notify(`导入任务已受理 (ID: ${res.task.id})，可在下方任务队列查看进度`);
      await onImported();
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      notify(msg, true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Cookie 无头导入"
      subtitle="粘贴 aistudio.google.com 的 Cookie 字符串或 Netscape/JSON，支持先探测多账号会话再回填导入"
      onClose={onClose}
      wide
      busy={busy || discoverBusy}
    >
      <ModalForm
        onSubmit={(e) => void handleSubmit(e)}
        onClose={onClose}
        busy={busy}
        submit={busy ? "提交中..." : "提交导入任务"}
        error={error}
      >
        <Field label="Cookie 内容">
          <textarea
            className="mono"
            rows={5}
            value={cookieText}
            onChange={(e) => setCookieText(e.target.value)}
            placeholder="粘贴完整 Cookie 请求头或 JSON 数组..."
            required
          />
        </Field>

        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <Button
            type="button"
            busy={discoverBusy}
            disabled={busy || !cookieText.trim()}
            onClick={() => void handleDiscover()}
          >
            <KeyRound size={14} />
            探测账号会话
          </Button>
          {discovered.length > 0 && (
            <span style={{ fontSize: 12, color: "var(--muted)" }}>
              点击下方探测到的账号可自动回填邮箱与 auth_user：
            </span>
          )}
        </div>

        {discovered.length > 0 && (
          <div className="aistudio-discovered-pills">
            {discovered.map((item) => {
              const selected =
                cookieEmail === (item.email || "") &&
                cookieAuthuser === String(item.auth_user ?? 0);
              return (
                <button
                  key={`${item.auth_user}:${item.email}`}
                  type="button"
                  className={`aistudio-discovered-pill ${selected ? "selected" : ""}`}
                  onClick={() => {
                    setCookieEmail(item.email || "");
                    setCookieAuthuser(String(item.auth_user ?? 0));
                  }}
                >
                  <span style={{ fontWeight: 700 }}>
                    {item.email || `auth_user=${item.auth_user}`}
                  </span>
                  <span className="mono" style={{ fontSize: 11.5, color: "var(--muted)" }}>
                    #{item.auth_user}
                  </span>
                  {item.restricted && <Badge variant="amber">受限</Badge>}
                </button>
              );
            })}
          </div>
        )}

        <div className="form-grid">
          <Field label="账号邮箱 (email)" optional hint="可先点击上方探测自动回填">
            <input
              type="text"
              value={cookieEmail}
              onChange={(e) => setCookieEmail(e.target.value)}
              placeholder="例如 user@gmail.com"
            />
          </Field>
          <Field label="auth_user 索引" hint="非负整数，默认 0">
            <input
              type="number"
              className="mono"
              min={0}
              step={1}
              value={cookieAuthuser}
              onChange={(e) => setCookieAuthuser(e.target.value)}
              placeholder="0"
            />
          </Field>
        </div>

        <Field label="专用代理" optional hint="留空则使用默认出口或直连">
          <input
            type="text"
            className="mono"
            value={cookieProxy}
            onChange={(e) => setCookieProxy(e.target.value)}
            placeholder="http://127.0.0.1:7890"
          />
        </Field>
      </ModalForm>
    </Modal>
  );
}

// ============================================================================
// 2. Chrome 扫描导入弹窗
// ============================================================================

export interface ChromeImportModalProps {
  onClose: () => void;
  onImported: () => Promise<unknown>;
  notify: Notice;
}

export function ChromeImportModal({
  onClose,
  onImported,
  notify,
}: ChromeImportModalProps) {
  const [profiles, setProfiles] = useState<AiStudioChromeProfile[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [proxy, setProxy] = useState("");
  const [scanning, setScanning] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function scan() {
    setScanning(true);
    setError("");
    try {
      const list = await fetchChromeProfiles();
      setProfiles(list);
      setSelectedIds(list.filter((p) => !p.restricted).map((p) => p.id));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      notify(msg, true);
    } finally {
      setScanning(false);
    }
  }

  useEffect(() => {
    void scan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const chosen = profiles
      .filter((p) => selectedIds.includes(p.id))
      .map((p) => ({ id: p.id, email: p.email }));
    if (chosen.length === 0) {
      setError("请至少勾选一个本地 Chrome Profile");
      return;
    }

    setBusy(true);
    setError("");
    try {
      const res = await importChromeAccounts({
        accounts: chosen,
        ...(proxy.trim() ? { proxy: proxy.trim() } : {}),
      });
      if (!res?.task || typeof res.task.id !== "string" || !res.task.id.trim()) {
        throw new Error("Chrome 导入未返回有效任务 ID，请检查后端响应");
      }
      notify(`导入任务已受理 (ID: ${res.task.id})，可在下方任务队列查看进度`);
      await onImported();
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      notify(msg, true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Chrome 扫描导入"
      subtitle="扫描本机 Chrome Profile 中已登录的 Google AI Studio 会话，勾选后提交异步导入"
      onClose={onClose}
      wide
      busy={busy}
    >
      <ModalForm
        onSubmit={(e) => void handleSubmit(e)}
        onClose={onClose}
        busy={busy}
        submit={busy ? "导入中..." : `导入选中 (${selectedIds.length})`}
        submitDisabled={scanning || selectedIds.length === 0}
        error={error}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <span style={{ fontSize: 12.5, color: "var(--muted)" }}>
            {scanning
              ? "正在扫描本机 Chrome Profile..."
              : `共发现 ${profiles.length} 个 Profile（已自动跳过受限账号默认勾选）`}
          </span>
          <Button
            type="button"
            className="small-button"
            busy={scanning}
            disabled={busy}
            onClick={() => void scan()}
          >
            <RefreshCw size={13} />
            重新扫描
          </Button>
        </div>

        {!scanning && profiles.length === 0 ? (
          <ErrorBox message="未检测到可用的本地 Chrome Profile，请先在 Chrome 登录 aistudio.google.com 或改用 Cookie 无头导入。" />
        ) : (
          <div
            style={{
              display: "grid",
              gap: 8,
              maxHeight: 280,
              overflowY: "auto",
              padding: "2px 0",
            }}
          >
            {profiles.map((p) => {
              const checked = selectedIds.includes(p.id);
              return (
                <label
                  key={p.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 12,
                    padding: "10px 12px",
                    borderRadius: "var(--radius-sm)",
                    border: `1px solid ${checked ? "var(--pink-500)" : "var(--line)"}`,
                    background: checked ? "var(--pink-50)" : "var(--pnl-soft)",
                    cursor: "pointer",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(ev) => {
                        setSelectedIds((prev) =>
                          ev.target.checked
                            ? [...prev, p.id]
                            : prev.filter((id) => id !== p.id),
                        );
                      }}
                    />
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: 13 }}>
                        {p.email || p.display_name || p.profile}
                      </div>
                      <div style={{ fontSize: 11.5, color: "var(--muted)" }}>
                        <Globe size={11} style={{ verticalAlign: "-1px", marginRight: 4 }} />
                        {p.profile}
                        {p.display_name ? ` · ${p.display_name}` : ""}
                      </div>
                      {p.restricted && (
                        <div style={{ fontSize: 11.5, color: "var(--amber)", marginTop: 2 }}>
                          {p.restricted}
                        </div>
                      )}
                    </div>
                  </div>
                  <Badge variant={p.restricted ? "amber" : "green"}>
                    {p.restricted ? "需验证" : "可用"}
                  </Badge>
                </label>
              );
            })}
          </div>
        )}

        <Field label="专用代理" optional>
          <input
            type="text"
            className="mono"
            value={proxy}
            onChange={(e) => setProxy(e.target.value)}
            placeholder="http://127.0.0.1:7890"
          />
        </Field>
      </ModalForm>
    </Modal>
  );
}

// ============================================================================
// 3. 新增浏览器登录任务弹窗
// ============================================================================

export interface AccountTaskModalProps {
  onClose: () => void;
  onCreated: () => Promise<unknown>;
  notify: Notice;
}

export function AccountTaskModal({
  onClose,
  onCreated,
  notify,
}: AccountTaskModalProps) {
  const [label, setLabel] = useState("");
  const [proxy, setProxy] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await createAccountTask({
        ...(label.trim() ? { label: label.trim() } : {}),
        ...(proxy.trim() ? { proxy: proxy.trim() } : {}),
      });
      if (!res?.task || typeof res.task.id !== "string" || !res.task.id.trim()) {
        throw new Error("创建登录任务未返回有效任务 ID，请检查后端响应");
      }
      notify(`登录任务已受理 (ID: ${res.task.id})，请在任务队列查看进度`);
      await onCreated();
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      notify(msg, true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="新增浏览器登录任务"
      subtitle="调用后端拉起隔离浏览器会话登录新的 Google AI Studio 账号"
      onClose={onClose}
      busy={busy}
    >
      <ModalForm
        onSubmit={(e) => void handleSubmit(e)}
        onClose={onClose}
        busy={busy}
        submit={busy ? "创建中..." : "发起登录任务"}
        error={error}
      >
        <Field label="账号标签" optional>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="例如 main-pro-01"
          />
        </Field>
        <Field label="指定代理" optional>
          <input
            type="text"
            className="mono"
            value={proxy}
            onChange={(e) => setProxy(e.target.value)}
            placeholder="http://127.0.0.1:7890"
          />
        </Field>
      </ModalForm>
    </Modal>
  );
}
