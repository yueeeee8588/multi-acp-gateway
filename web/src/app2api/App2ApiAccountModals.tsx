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
  Toggle,
} from "../components";
import { useMinSpin } from "../useMinSpin";
import {
  authorizeChromeProfiles,
  importAccountTokens,
  scanChromeProfiles,
} from "./api";
import type {
  App2ApiChromeOAuthResponse,
  App2ApiChromeProfilesResponse,
  App2ApiImportTokensResponse,
} from "./types";

type NotifyFn = (msg: string, kind?: "success" | "error") => void;

function isResultSuccess(status: string): boolean {
  const st = status.toLowerCase();
  return st === "added" || st === "updated" || st === "ok" || st === "success";
}

function formatResultStatusLabel(status: string): string {
  const st = status.toLowerCase();
  if (st === "added") return "新增";
  if (st === "updated") return "更新";
  if (st === "skipped") return "跳过";
  if (st === "failed" || st === "error") return "失败";
  return status;
}

// ============================================================================
// 1. 同源 Refresh Token 批量导入弹窗
// ============================================================================

export interface App2ApiBatchTokenImportModalProps {
  onClose: () => void;
  onImported: () => Promise<void>;
  notify: NotifyFn;
}

export function App2ApiBatchTokenImportModal({
  onClose,
  onImported,
  notify,
}: App2ApiBatchTokenImportModalProps) {
  const [tokenText, setTokenText] = useState("");
  const [acceptTerms, setAcceptTerms] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<App2ApiImportTokensResponse | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!tokenText.trim()) {
      setError("请粘贴至少一条 Refresh Token 或导出备份 JSON");
      return;
    }

    setBusy(true);
    setError("");
    setResult(null);
    try {
      const res = await importAccountTokens(tokenText, acceptTerms);
      setResult(res);
      const summary = `新增 ${res.added} · 更新 ${res.updated} · 失败 ${res.failed}`;
      notify(summary, res.failed > 0 ? "error" : "success");
      await onImported();
      if (res.failed === 0) {
        setTokenText("");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "批量导入失败";
      setError(msg);
      notify(msg, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="批量导入 Refresh Token"
      subtitle="支持 8049 导出的 JSON 或同源 Refresh Token（Google OAuth 客户端隔离，不支持直接导入 8048 Antigravity Token）"
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
        <Field label="每行一个 1//...、token|备注 或导出备份 JSON">
          <textarea
            rows={6}
            className="mono"
            style={{ padding: "10px 14px", fontSize: "12px", lineHeight: 1.6 }}
            value={tokenText}
            onChange={(e) => setTokenText(e.target.value)}
            placeholder={"1//0g...\n1//0g...|备用号-01"}
            disabled={busy}
          />
        </Field>

        <Toggle
          checked={acceptTerms}
          onChange={setAcceptTerms}
          label="导入后自动同意服务条款"
        />

        {result && (
          <div className="app2api-modal-summary" role="status">
            <div className="app2api-modal-summary-head">
              共 {result.total} 条：新增 {result.added} · 更新 {result.updated} · 失败{" "}
              {result.failed}
            </div>
            {result.results.length > 0 && (
              <ul className="app2api-modal-result-list">
                {result.results.map((item, idx) => {
                  const ok = isResultSuccess(item.status);
                  const who = item.email || item.label || item.accountId || "未知账号";
                  return (
                    <li
                      key={`${item.index}-${idx}`}
                      className={ok ? "is-ok" : "is-fail"}
                    >
                      <span>
                        第 {item.index + 1} 条 ({who}) ·{" "}
                        {formatResultStatusLabel(item.status)}
                      </span>
                      {item.error && (
                        <span className="app2api-modal-result-err">：{item.error}</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </ModalForm>
    </Modal>
  );
}

// ============================================================================
// 2. Chrome Profile 扫描与一键批量授权弹窗
// ============================================================================

export interface App2ApiChromeScanModalProps {
  onClose: () => void;
  onAuthorized: () => Promise<void>;
  notify: NotifyFn;
}

export function App2ApiChromeScanModal({
  onClose,
  onAuthorized,
  notify,
}: App2ApiChromeScanModalProps) {
  const [scanning, setScanning] = useState(false);
  const scanSpinning = useMinSpin(scanning);
  const [authorizing, setAuthorizing] = useState(false);
  const [acceptTerms, setAcceptTerms] = useState(true);
  const [scanResult, setScanResult] = useState<App2ApiChromeProfilesResponse | null>(
    null
  );
  const [error, setError] = useState("");
  const [oauthResult, setOauthResult] = useState<App2ApiChromeOAuthResponse | null>(
    null
  );
  const [selectedDirs, setSelectedDirs] = useState<string[]>([]);

  const busy = scanning || authorizing;

  const scanProfiles = useCallback(
    async (options?: { manual?: boolean }) => {
      setScanning(true);
      setError("");
      setOauthResult(null);
      setScanResult(null);
      setSelectedDirs([]);
      try {
        const res = await scanChromeProfiles();
        setScanResult(res);
        if (res.chromeFound) {
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
    },
    [notify]
  );

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
    if (busy || !scanResult?.chromeFound || selectedItems.length === 0) {
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
      const res = await authorizeChromeProfiles(profiles, acceptTerms);
      setOauthResult(res);

      const failedDirs = new Set(
        res.results
          .filter((item) => item.status === "failed" || Boolean(item.error))
          .map((item) => item.profileDir)
      );
      const submittedDirs = new Set(profiles.map((item) => item.profileDir));

      if (res.added > 0 || res.updated > 0 || res.skipped > 0) {
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

      setSelectedDirs(
        profiles
          .filter((item) => failedDirs.has(item.profileDir))
          .map((item) => item.profileDir)
      );

      await onAuthorized();
      notify(
        `Chrome 授权完成：新增 ${res.added} / 更新 ${res.updated} / 跳过 ${res.skipped} / 失败 ${res.failed}`,
        res.failed === 0 ? "success" : "error"
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
      title="Chrome 扫描批量授权"
      subtitle="扫描网关所在电脑的 Chrome Google 账号。选中后将依次拉起对应 Chrome 窗口等待确认。"
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

        {scanResult && !scanResult.chromeFound && (
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
          scanResult.chromeFound &&
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
          scanResult.chromeFound &&
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
                  全选未添加
                </Button>
                <Button
                  type="button"
                  className="small-button"
                  disabled={busy}
                  onClick={() => setSelectedDirs([])}
                >
                  清空
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

              <div className="app2api-chrome-list">
                {scanResult.profiles.map((profile) => {
                  const checked = selectedDirs.includes(profile.profileDir);
                  const disabled =
                    profile.alreadyAdded || busy || !scanResult.chromeFound;

                  return (
                    <label
                      key={profile.profileDir}
                      className={`app2api-chrome-row${disabled ? " is-disabled" : ""}`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={disabled}
                        onChange={() => toggleProfile(profile.profileDir)}
                      />
                      <span className="app2api-chrome-meta">
                        <span className="mono app2api-chrome-email" title={profile.email}>
                          {profile.email || profile.profileDir}
                        </span>
                        <span className="app2api-chrome-name">
                          {profile.name} ({profile.profileDir})
                        </span>
                      </span>
                      <Badge variant={profile.alreadyAdded ? "neutral" : "green"}>
                        {profile.alreadyAdded ? "已添加" : "可导入"}
                      </Badge>
                    </label>
                  );
                })}
              </div>

              <Toggle
                checked={acceptTerms}
                onChange={setAcceptTerms}
                label="授权后自动同意服务条款"
              />
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
            将逐个拉起对应 Chrome 窗口等待确认，请在浏览器中点击允许...
          </div>
        )}

        {oauthResult && (
          <div className="app2api-modal-summary" role="status">
            <div className="app2api-modal-summary-head">
              新增 {oauthResult.added} / 更新 {oauthResult.updated} / 跳过{" "}
              {oauthResult.skipped} / 失败 {oauthResult.failed}
            </div>
            {oauthResult.results.length > 0 && (
              <ul className="app2api-modal-result-list">
                {oauthResult.results.map((item, idx) => {
                  const ok = item.status !== "failed" && !item.error;
                  return (
                    <li
                      key={`${item.profileDir}-${idx}`}
                      className={ok ? "is-ok" : "is-fail"}
                    >
                      <span>
                        {item.email || item.profileDir} ·{" "}
                        {formatResultStatusLabel(item.status)}
                      </span>
                      {item.error && (
                        <span className="app2api-modal-result-err">：{item.error}</span>
                      )}
                    </li>
                  );
                })}
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
          disabled={busy || !scanResult?.chromeFound || selectedItems.length === 0}
          onClick={() => void handleAuthorize()}
        >
          {authorizing
            ? "授权进行中..."
            : `开始批量授权 (${selectedItems.length})`}
        </Button>
      </div>
    </Modal>
  );
}
