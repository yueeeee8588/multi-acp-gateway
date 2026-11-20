import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { Globe, RefreshCw } from "lucide-react";
import {
  Badge,
  Button,
  ErrorBox,
  Field,
  Modal,
  ModalForm,
  Select,
} from "../components";
import { useMinSpin } from "../useMinSpin";
import {
  createAccount,
  fetchChromeProfiles,
  importRefreshTokens,
  refreshAccount,
  startChromeOAuth,
  updateAccount,
} from "./api";
import type {
  AccountRecord,
  AccountTier,
  ChromeOAuthResult,
  ChromeProfilesResult,
  ImportRefreshTokensResult,
} from "./types";

type NotifyFn = (msg: string, kind?: "success" | "error") => void;

// ============================================================================
// 1. 新建 / 编辑账号弹窗
// ============================================================================

export interface AccountEditModalProps {
  account: AccountRecord | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
  notify: NotifyFn;
}

export function AccountEditModal({
  account,
  onClose,
  onSaved,
  notify,
}: AccountEditModalProps) {
  const [label, setLabel] = useState(account?.label ?? "");
  const [email, setEmail] = useState(account?.email ?? "");
  const [proxyUrl, setProxyUrl] = useState(account?.proxyUrl ?? "");
  const [tier, setTier] = useState<AccountTier>(
    account?.tier === "pro" ? "pro" : "standard"
  );
  const [concurrencyLimit, setConcurrencyLimit] = useState(
    String(account?.concurrencyLimit ?? 2)
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const isEdit = account !== null;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedLabel = label.trim();
    if (!trimmedLabel) {
      setError("请输入账户标签");
      return;
    }

    const parsedConcurrency = Number(concurrencyLimit);
    const safeConcurrency =
      Number.isFinite(parsedConcurrency) && parsedConcurrency >= 1
        ? Math.min(16, Math.floor(parsedConcurrency))
        : 2;

    setBusy(true);
    setError("");
    try {
      if (isEdit && account) {
        await updateAccount(account.id, {
          label: trimmedLabel,
          email: email.trim(),
          proxyUrl: proxyUrl.trim(),
          concurrencyLimit: safeConcurrency,
          tier,
        });
        notify("账户已更新", "success");
      } else {
        await createAccount({
          label: trimmedLabel,
          email: email.trim(),
          proxyUrl: proxyUrl.trim(),
          concurrencyLimit: safeConcurrency,
          tier,
        });
        notify("账户已创建", "success");
      }
      await onSaved();
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "保存失败";
      setError(msg);
      notify(msg, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={isEdit ? "编辑账户" : "手动添加账户"}
      subtitle={
        isEdit
          ? "修改账号标签、代理出口、等级与并发限制"
          : "手动创建 ACP 账号记录，创建后可触发 CLI 登录"
      }
      onClose={onClose}
      busy={busy}
    >
      <ModalForm
        onSubmit={(e) => void handleSubmit(e)}
        onClose={onClose}
        busy={busy}
        submit={busy ? "保存中..." : "保存"}
        error={error}
      >
        <Field label="账户标签">
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="例如: agy-main-01"
            required
          />
        </Field>

        <Field label="邮箱" optional>
          <input
            type="email"
            className="mono"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="user@example.com"
          />
        </Field>

        <Field label="独立代理" optional hint="留空则使用网关默认代理或直连">
          <input
            type="text"
            className="mono"
            value={proxyUrl}
            onChange={(e) => setProxyUrl(e.target.value)}
            placeholder="http://127.0.0.1:7890"
          />
        </Field>

        <Field label="账号类型">
          <Select
            value={tier}
            onChange={(e) =>
              setTier(e.target.value === "pro" ? "pro" : "standard")
            }
          >
            <option value="standard">普通账号</option>
            <option value="pro">Pro 账号</option>
          </Select>
        </Field>

        <Field label="并发上限" hint="单账号允许同时处理的请求数 (1-16)">
          <input
            type="number"
            className="mono"
            min={1}
            max={16}
            value={concurrencyLimit}
            onChange={(e) => setConcurrencyLimit(e.target.value)}
          />
        </Field>
      </ModalForm>
    </Modal>
  );
}

// ============================================================================
// 2. 批量导入 Refresh Token 弹窗
// ============================================================================

export interface BatchTokenImportModalProps {
  onClose: () => void;
  onImported: () => Promise<void>;
  notify: NotifyFn;
}

export function BatchTokenImportModal({
  onClose,
  onImported,
  notify,
}: BatchTokenImportModalProps) {
  const [tokenText, setTokenText] = useState("");
  const [proxyUrl, setProxyUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<ImportRefreshTokensResult | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!tokenText.trim()) {
      setError("请粘贴至少一条 Refresh Token");
      return;
    }

    setBusy(true);
    setError("");
    setResult(null);
    try {
      const res = await importRefreshTokens(
        tokenText,
        proxyUrl.trim() || undefined
      );
      setResult(res);
      const summary = `导入 ${res.imported} · 更新 ${res.updated} · 失败 ${res.failed}`;
      notify(summary, res.failed > 0 ? "error" : "success");
      await onImported();
      if (res.failed === 0) {
        setTokenText("");
        onClose();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "批量导入失败";
      setError(msg);
      notify(msg, "error");
    } finally {
      setBusy(false);
    }
  }

  const failedItems = useMemo(
    () => result?.results.filter((item) => !item.ok) ?? [],
    [result]
  );

  return (
    <Modal
      title="批量粘贴 Refresh Token"
      subtitle="支持每行一条纯文本 Token 或 JSON 格式凭据"
      onClose={onClose}
      busy={busy}
      wide
    >
      <ModalForm
        onSubmit={(e) => void handleSubmit(e)}
        onClose={onClose}
        busy={busy}
        submit={busy ? "导入中..." : "开始导入"}
        error={error}
      >
        <Field label="每行一个 Refresh Token（支持 JSON 或纯文本）">
          <textarea
            rows={6}
            className="mono"
            style={{ padding: "10px 14px", fontSize: "12px", lineHeight: 1.6 }}
            value={tokenText}
            onChange={(e) => setTokenText(e.target.value)}
            placeholder="1//0g..."
          />
        </Field>

        <Field label="统一代理" optional hint="为本次批量导入的账号统一设置代理">
          <input
            type="text"
            className="mono"
            value={proxyUrl}
            onChange={(e) => setProxyUrl(e.target.value)}
            placeholder="http://127.0.0.1:7890"
          />
        </Field>

        {result && (
          <div
            style={{
              padding: "12px 14px",
              borderRadius: "var(--radius-sm)",
              border: "1.5px solid var(--line)",
              background: "var(--pink-50)",
              fontSize: "12.5px",
              color: "var(--ink-soft)",
            }}
          >
            <div style={{ fontWeight: 700, color: "var(--ink)" }}>
              导入 {result.imported} · 更新 {result.updated} · 失败{" "}
              {result.failed}
            </div>
            {failedItems.length > 0 && (
              <ul
                style={{
                  margin: "8px 0 0",
                  paddingLeft: "18px",
                  color: "var(--rose)",
                }}
              >
                {failedItems.map((item) => (
                  <li key={`${item.index}-${item.id}`}>
                    第 {item.index + 1} 行 ({item.email || item.id || "未知"}
                    )：{item.error || "导入失败"}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </ModalForm>
    </Modal>
  );
}

// ============================================================================
// 3. Chrome Profile 扫描与 OAuth 授权弹窗
// ============================================================================

export interface ChromeScanModalProps {
  onClose: () => void;
  onAuthorized: () => Promise<void>;
  notify: NotifyFn;
}

export function ChromeScanModal({
  onClose,
  onAuthorized,
  notify,
}: ChromeScanModalProps) {
  const [scanning, setScanning] = useState(false);
  const scanSpinning = useMinSpin(scanning);
  const [authorizing, setAuthorizing] = useState(false);
  const [scanResult, setScanResult] = useState<ChromeProfilesResult | null>(
    null
  );
  const [error, setError] = useState("");
  const [oauthResult, setOauthResult] = useState<ChromeOAuthResult | null>(
    null
  );
  const [selectedDirs, setSelectedDirs] = useState<string[]>([]);

  const busy = scanning || authorizing;

  const scanProfiles = useCallback(async (options?: { manual?: boolean }) => {
    setScanning(true);
    setError("");
    setOauthResult(null);
    setScanResult(null);
    setSelectedDirs([]);
    try {
      const res = await fetchChromeProfiles();
      setScanResult(res);
      if (res.chromeAvailable) {
        setSelectedDirs(
          res.profiles.filter((p) => !p.alreadyAdded).map((p) => p.profileDir)
        );
      }
      if (options?.manual) {
        notify(`扫描完成，共发现 ${res.profiles.length} 个账号配置`, "success");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "扫描 Chrome 账号失败";
      setError(msg);
      if (options?.manual) {
        notify(msg, "error");
      }
    } finally {
      setScanning(false);
    }
  }, [notify]);

  useEffect(() => {
    void scanProfiles();
  }, [scanProfiles]);

  const selectedItems = useMemo(() => {
    if (!scanResult) return [];
    const dirSet = new Set(selectedDirs);
    return scanResult.profiles.filter(
      (p) => !p.alreadyAdded && dirSet.has(p.profileDir)
    );
  }, [scanResult, selectedDirs]);

  function selectAllPending() {
    if (!scanResult) return;
    setSelectedDirs(
      scanResult.profiles
        .filter((p) => !p.alreadyAdded)
        .map((p) => p.profileDir)
    );
  }

  function toggleProfile(profileDir: string) {
    setSelectedDirs((prev) =>
      prev.includes(profileDir)
        ? prev.filter((item) => item !== profileDir)
        : [...prev, profileDir]
    );
  }

  async function handleAuthorize() {
    if (busy || !scanResult?.chromeAvailable || selectedItems.length === 0) {
      return;
    }

    const profiles = selectedItems.map(({ profileDir, email }) => ({
      profileDir,
      email,
    }));

    setAuthorizing(true);
    setError("");
    setOauthResult(null);

    try {
      const res = await startChromeOAuth(profiles);
      setOauthResult(res);

      const failedDirs = new Set(res.errors.map((item) => item.profileDir));
      const submittedDirs = new Set(profiles.map((item) => item.profileDir));

      if (res.ok || res.imported > 0 || res.skipped > 0) {
        setScanResult((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            profiles: prev.profiles.map((profile) =>
              submittedDirs.has(profile.profileDir) &&
              !failedDirs.has(profile.profileDir)
                ? { ...profile, alreadyAdded: true }
                : profile
            ),
          };
        });
      }

      // 授权失败项保留勾选，成功/跳过项取消勾选
      setSelectedDirs(
        profiles
          .filter((item) => failedDirs.has(item.profileDir))
          .map((item) => item.profileDir)
      );

      await onAuthorized();
      notify(
        `Chrome 授权完成：导入 ${res.imported} / 跳过 ${res.skipped} / 失败 ${res.errors.length}`,
        res.ok && res.errors.length === 0 ? "success" : "error"
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Chrome 授权失败";
      setError(msg);
      await onAuthorized();
      notify(msg, "error");
    } finally {
      setAuthorizing(false);
    }
  }

  return (
    <Modal
      title="从本机 Chrome 扫描加入"
      subtitle="扫描网关所在电脑的 Chrome Google 账号。选中后将依次打开浏览器授权窗口，需要点击允许。"
      onClose={onClose}
      busy={busy}
      wide
    >
      <div className="modal-body">
        {scanning && (
          <div
            role="status"
            style={{
              padding: "24px 0",
              textAlign: "center",
              fontSize: "13px",
              color: "var(--ink-soft)",
              fontWeight: 600,
            }}
          >
            正在扫描本机 Chrome 账号...
          </div>
        )}

        <ErrorBox message={error} />

        {scanResult && !scanResult.chromeAvailable && (
          <div
            style={{
              padding: "12px 14px",
              borderRadius: "var(--radius-sm)",
              border: "1.5px solid var(--honey-200)",
              background: "var(--amber-bg)",
              color: "var(--amber)",
              fontSize: "13px",
              fontWeight: 600,
            }}
          >
            未检测到可用的 Chrome。请先在网关所在电脑安装 Chrome，并登录 Google
            账号后重新扫描。
          </div>
        )}

        {scanResult &&
          scanResult.chromeAvailable &&
          scanResult.profiles.length === 0 && (
            <div
              style={{
                padding: "16px 0",
                fontSize: "13px",
                color: "var(--muted)",
                fontWeight: 600,
              }}
            >
              未发现已登录 Google 的 Chrome Profile。请先在 Chrome 中登录 Google
              账号，再重新扫描。
            </div>
          )}

        {scanResult &&
          scanResult.chromeAvailable &&
          scanResult.profiles.length > 0 && (
            <>
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  alignItems: "center",
                  gap: "8px",
                }}
              >
                <Button
                  type="button"
                  className="small-button"
                  disabled={busy}
                  onClick={selectAllPending}
                >
                  全选未加入
                </Button>
                <Button
                  type="button"
                  className="small-button"
                  disabled={busy}
                  onClick={() => setSelectedDirs([])}
                >
                  清空选择
                </Button>
                <span
                  style={{
                    marginLeft: "auto",
                    fontSize: "12px",
                    fontWeight: 700,
                    color: "var(--muted)",
                  }}
                >
                  已选 {selectedItems.length} / {scanResult.profiles.length}
                </span>
              </div>

              <div
                style={{
                  maxHeight: "290px",
                  overflowY: "auto",
                  borderRadius: "var(--radius)",
                  border: "1.5px solid var(--line)",
                  background: "var(--cream)",
                }}
              >
                {scanResult.profiles.map((profile, idx) => {
                  const checked = selectedDirs.includes(profile.profileDir);
                  const disabled =
                    profile.alreadyAdded || busy || !scanResult.chromeAvailable;

                  return (
                    <label
                      key={profile.profileDir}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "12px",
                        padding: "11px 14px",
                        borderBottom:
                          idx === scanResult.profiles.length - 1
                            ? "none"
                            : "1px solid var(--line)",
                        background: checked ? "var(--pink-50)" : "var(--surface)",
                        cursor: disabled ? "not-allowed" : "pointer",
                        opacity: profile.alreadyAdded ? 0.72 : 1,
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={disabled}
                        aria-label={`选择 ${profile.email || profile.profileDir}`}
                        onChange={() => toggleProfile(profile.profileDir)}
                        style={{
                          width: "16px",
                          height: "16px",
                          flexShrink: 0,
                          accentColor: "var(--pink-500)",
                        }}
                      />
                      <span style={{ minWidth: 0, flex: 1 }}>
                        <span
                          className="mono"
                          style={{
                            display: "block",
                            fontSize: "13px",
                            fontWeight: 700,
                            color: "var(--ink)",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                          title={profile.email}
                        >
                          {profile.email || profile.profileDir}
                        </span>
                        <span
                          style={{
                            display: "block",
                            marginTop: "2px",
                            fontSize: "12px",
                            color: "var(--muted)",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {profile.name} ({profile.profileDir})
                        </span>
                      </span>
                      <Badge
                        variant={profile.alreadyAdded ? "neutral" : "green"}
                      >
                        {profile.alreadyAdded ? "已加入" : "可导入"}
                      </Badge>
                    </label>
                  );
                })}
              </div>
            </>
          )}

        {authorizing && (
          <div
            role="status"
            aria-live="polite"
            style={{
              padding: "11px 14px",
              borderRadius: "var(--radius-sm)",
              border: "1.5px solid var(--pink-300)",
              background: "var(--pink-50)",
              color: "var(--pink-700)",
              fontSize: "13px",
              fontWeight: 600,
              display: "flex",
              alignItems: "center",
              gap: "8px",
            }}
          >
            <Globe size={15} />
            正在依次拉起 Chrome 授权窗口，请在浏览器中点击允许...
          </div>
        )}

        {oauthResult && (
          <div
            role="status"
            style={{
              padding: "12px 14px",
              borderRadius: "var(--radius-sm)",
              border: "1.5px solid var(--line)",
              background: "var(--pink-50)",
              fontSize: "12.5px",
              color: "var(--ink-soft)",
            }}
          >
            <div style={{ fontWeight: 700, color: "var(--ink)" }}>
              导入 {oauthResult.imported} / 跳过 {oauthResult.skipped} / 失败{" "}
              {oauthResult.errors.length}
            </div>
            {oauthResult.errors.length > 0 && (
              <ul
                style={{
                  margin: "8px 0 0",
                  paddingLeft: "18px",
                  color: "var(--rose)",
                }}
              >
                {oauthResult.errors.map((failure, index) => (
                  <li key={`${failure.profileDir}-${index}`}>
                    {failure.email || failure.profileDir}：{failure.error}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      <div className="modal-footer">
        <Button
          type="button"
          disabled={busy}
          onClick={() => void scanProfiles({ manual: true })}
        >
          <RefreshCw size={15} className={scanSpinning ? "spin" : undefined} />
          重新扫描
        </Button>
        <Button type="button" disabled={busy} onClick={onClose}>
          关闭
        </Button>
        <Button
          type="button"
          className="primary"
          busy={authorizing}
          disabled={
            busy || !scanResult?.chromeAvailable || selectedItems.length === 0
          }
          onClick={() => void handleAuthorize()}
        >
          {authorizing
            ? "授权进行中..."
            : `授权加入选中账号 (${selectedItems.length})`}
        </Button>
      </div>
    </Modal>
  );
}

// ============================================================================
// 4. 批量设置出口代理弹窗
// ============================================================================

export interface BatchProxyModalProps {
  open: boolean;
  totalCount: number;
  selectedIds: Set<string>;
  accounts: AccountRecord[];
  onClose: () => void;
  onDone: () => Promise<void>;
  notify: NotifyFn;
}

export function BatchProxyModal({
  open,
  totalCount,
  selectedIds,
  accounts,
  onClose,
  onDone,
  notify,
}: BatchProxyModalProps) {
  const [proxyInput, setProxyInput] = useState("");
  const [scope, setScope] = useState<"selected" | "all">(
    selectedIds.size > 0 ? "selected" : "all"
  );
  const [probeAfterSave, setProbeAfterSave] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setScope(selectedIds.size > 0 ? "selected" : "all");
    setError("");
  }, [open, selectedIds.size]);

  if (!open) {
    return null;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const targets =
      scope === "selected" && selectedIds.size > 0
        ? accounts.filter((acc) => selectedIds.has(acc.id))
        : accounts;

    if (targets.length === 0) {
      setError("当前没有可操作的账号");
      return;
    }

    const trimmedProxy = proxyInput.trim();
    setBusy(true);
    setError("");

    let succeeded = 0;
    let failed = 0;
    let lastError = "";

    try {
      for (const acc of targets) {
        try {
          await updateAccount(acc.id, { proxyUrl: trimmedProxy });
          if (probeAfterSave) {
            await refreshAccount(acc.id);
          }
          succeeded += 1;
        } catch (err) {
          failed += 1;
          lastError = err instanceof Error ? err.message : "请求失败";
        }
      }

      if (failed === 0) {
        notify(
          `已更新 ${succeeded} 个账号的出口代理${probeAfterSave ? "并完成探测" : ""}`,
          "success"
        );
        await onDone();
        onClose();
      } else if (succeeded > 0) {
        notify(
          `已更新 ${succeeded} 个账号，${failed} 个失败：${lastError}`,
          "error"
        );
        await onDone();
        onClose();
      } else {
        const msg = lastError || "设置出口代理失败";
        setError(msg);
        notify(msg, "error");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="设置出口代理"
      subtitle="为选中或全部账号统一配置独立出口代理，留空将清空独立代理"
      onClose={onClose}
      busy={busy}
    >
      <ModalForm
        onSubmit={(e) => void handleSubmit(e)}
        onClose={onClose}
        busy={busy}
        submit={busy ? "应用中..." : "保存并应用"}
        error={error}
      >
        <Field
          label="代理 / 出口地址"
          optional
          hint="支持 http:// 或 socks5:// 协议；留空表示清空独立代理、走默认出口"
        >
          <input
            type="text"
            className="mono"
            value={proxyInput}
            onChange={(e) => setProxyInput(e.target.value)}
            placeholder="例如 http://127.0.0.1:7890 或 socks5://127.0.0.1:7890，留空则清空独立代理"
            disabled={busy}
          />
        </Field>

        <Field label="应用范围">
          <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
            <label
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                padding: "7px 12px",
                borderRadius: "var(--radius-sm)",
                border:
                  scope === "selected"
                    ? "1.5px solid var(--pink-500)"
                    : "1.5px solid var(--line)",
                background:
                  scope === "selected" ? "var(--pink-50)" : "var(--surface)",
                color:
                  selectedIds.size === 0 ? "var(--muted)" : "var(--ink)",
                fontSize: "13px",
                fontWeight: 600,
                cursor:
                  selectedIds.size === 0 || busy ? "not-allowed" : "pointer",
                opacity: selectedIds.size === 0 ? 0.6 : 1,
              }}
            >
              <input
                type="radio"
                name="batch-proxy-scope"
                checked={scope === "selected"}
                disabled={selectedIds.size === 0 || busy}
                onChange={() => setScope("selected")}
              />
              仅已选中的 {selectedIds.size} 个账号
            </label>

            <label
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                padding: "7px 12px",
                borderRadius: "var(--radius-sm)",
                border:
                  scope === "all"
                    ? "1.5px solid var(--pink-500)"
                    : "1.5px solid var(--line)",
                background:
                  scope === "all" ? "var(--pink-50)" : "var(--surface)",
                color: "var(--ink)",
                fontSize: "13px",
                fontWeight: 600,
                cursor: busy ? "not-allowed" : "pointer",
              }}
            >
              <input
                type="radio"
                name="batch-proxy-scope"
                checked={scope === "all"}
                disabled={busy}
                onChange={() => setScope("all")}
              />
              全部 {totalCount} 个账号
            </label>
          </div>
        </Field>

        <label
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "8px",
            fontSize: "13px",
            fontWeight: 600,
            color: "var(--ink-soft)",
            cursor: busy ? "not-allowed" : "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={probeAfterSave}
            disabled={busy}
            onChange={(e) => setProbeAfterSave(e.target.checked)}
          />
          保存后立即刷新探测出口 IP
        </label>
      </ModalForm>
    </Modal>
  );
}
