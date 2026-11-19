import { Fragment, Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import {
  Activity,
  ArrowRight,
  ChevronRight,
  Database,
  Eye,
  EyeOff,
  FolderClosed,
  KeyRound,
  LayoutDashboard,
  LoaderCircle,
  LogOut,
  Menu,
  MessageSquareText,
  RefreshCw,
  Settings2,
  Server,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import { api, errorMessage } from "./api";
import type { State, Group, Account, RelayKey, Settings, Profile } from "./api";
import { Button, ErrorBox, Field, IconButton, Toast } from "./components";
import { Dashboard } from "./Dashboard";
import { ProvidersPage } from "./Providers";
import { GroupsPage, AccountsPage, KeysPage } from "./Management";
import { SettingsPage } from "./Settings";
import { PromptRulesPage } from "./PromptRules";
import { AcpConsolePage } from "./acp/AcpConsolePage";
import { useAcpGateway } from "./acp/useAcpGateway";
import { PromoBanner } from "./PromoBanner";
import { Mascot } from "./Mascot";
import { useUpdateCheck } from "./useUpdateCheck";
import { version } from "../package.json";

const Playground = lazy(() => import("./Playground").then((module) => ({ default: module.Playground })));

declare global {
  interface Window {
    turnstile?: {
      render: (element: HTMLElement, options: { sitekey: string; callback: (token: string) => void; "expired-callback": () => void; "error-callback": () => void }) => string;
      reset: (widgetId?: string) => void;
      remove?: (widgetId: string) => void;
    };
  }
}

const navigation = [
  { id: "playground", label: "聊天", icon: MessageSquareText, section: "对话" },
  { id: "dashboard", label: "仪表盘", icon: LayoutDashboard, section: "数据和调用" },
  { id: "keys", label: "密钥管理", icon: KeyRound },
  { id: "groups", label: "分组管理", icon: FolderClosed, section: "构建和管理" },
  { id: "accounts", label: "账号管理", icon: Database },
  { id: "providers", label: "服务提供商", icon: Server },
  { id: "prompts", label: "提示词与风控", icon: Sparkles },
  { id: "acp", label: "ACP 控制台", icon: Server },
  { id: "settings", label: "系统设置", icon: Settings2, section: "系统设置" },
] as const;
type Page = (typeof navigation)[number]["id"];
const independentlyLoadedPages: readonly Page[] = ["dashboard", "providers", "acp"];

function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark">
        <svg
          width={23}
          height={23}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M12 5c-2.8 0-5 1.1-6.5 2.5L3.5 3.5l1.8 6.2C4.5 11.2 4 12.8 4 14.5 4 18.6 7.6 21 12 21s8-2.4 8-6.5c0-1.7-.5-3.3-1.3-4.8L20.5 3.5l-2 4C17 6.1 14.8 5 12 5Z" />
          <circle cx="9" cy="13.5" r="1" fill="currentColor" />
          <circle cx="15" cy="13.5" r="1" fill="currentColor" />
          <path d="M10.2 16.5c.8.6 1.2.6 1.8.6s1-.1 1.8-.6" />
          <path d="M6 14H2" />
          <path d="M6 16.5H3" />
          <path d="M18 14h4" />
          <path d="M18 16.5h3" />
        </svg>
      </span>
      <span className="brand-word">
        多功能 ACP<span>聚合网关</span>
      </span>
    </div>
  );
}

function Authentication({
  initialized,
  turnstileSiteKey,
  onSuccess,
  manualLogout = false,
}: {
  initialized: boolean;
  turnstileSiteKey: string;
  onSuccess: () => Promise<void>;
  manualLogout?: boolean;
}) {
  const [username, setUsername] = useState(() => localStorage.getItem("zako-saved-username") || "");
  const [password, setPassword] = useState(() => localStorage.getItem("zako-saved-password") || "");
  const [confirm, setConfirm] = useState("");
  const [rememberPassword, setRememberPassword] = useState(() => !!localStorage.getItem("zako-saved-password"));
  const [autoLogin, setAutoLogin] = useState(() => localStorage.getItem("zako-auto-login") === "1");
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [turnstileToken, setTurnstileToken] = useState("");
  const turnstileRef = useRef<HTMLDivElement>(null);
  const turnstileWidget = useRef<string | null>(null);
  const autoLoginAttempted = useRef(false);

  useEffect(() => {
    if (!initialized || !turnstileSiteKey || !turnstileRef.current) return;
    const render = () => {
      if (!window.turnstile || !turnstileRef.current || turnstileWidget.current) return;
      turnstileWidget.current = window.turnstile.render(turnstileRef.current, {
        sitekey: turnstileSiteKey,
        callback: setTurnstileToken,
        "expired-callback": () => setTurnstileToken(""),
        "error-callback": () => setTurnstileToken(""),
      });
    };
    if (window.turnstile) render();
    else {
      const script = document.createElement("script");
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.async = true;
      script.defer = true;
      script.addEventListener("load", render);
      document.head.appendChild(script);
      return () => script.removeEventListener("load", render);
    }
  }, [initialized, turnstileSiteKey]);

  const submitLogin = useCallback(
    async (targetUser: string, targetPass: string, token: string) => {
      setError("");
      if (!initialized && targetPass !== confirm) {
        setError("两次输入的密码不一致");
        return;
      }
      if (initialized && turnstileSiteKey && !token) {
        setError("请完成 Cloudflare Turnstile 安全校验");
        return;
      }
      setBusy(true);
      try {
        await api(initialized ? "/login" : "/setup", "POST", {
          username: targetUser,
          password: targetPass,
          ...(initialized && turnstileSiteKey
            ? { turnstile_token: token }
            : {}),
        });
        if (rememberPassword) {
          localStorage.setItem("zako-saved-password", targetPass);
          localStorage.setItem("zako-saved-username", targetUser);
        }
        if (autoLogin) {
          localStorage.setItem("zako-auto-login", "1");
        }
        await onSuccess();
      } catch (failure) {
        if (initialized && token && window.turnstile) {
          window.turnstile.reset(turnstileWidget.current || undefined);
          setTurnstileToken("");
        }
        setError(errorMessage(failure));
      } finally {
        setBusy(false);
      }
    },
    [autoLogin, confirm, initialized, onSuccess, rememberPassword, turnstileSiteKey],
  );

  useEffect(() => {
    if (!initialized) return;
    if (manualLogout) return;
    if (autoLoginAttempted.current) return;

    const savedPassword = localStorage.getItem("zako-saved-password");
    const isAuto = localStorage.getItem("zako-auto-login") === "1";

    if (isAuto && savedPassword) {
      if (turnstileSiteKey && !turnstileToken) {
        return;
      }
      autoLoginAttempted.current = true;
      const savedUser = localStorage.getItem("zako-saved-username") || username || "";
      void submitLogin(savedUser, savedPassword, turnstileToken);
    }
  }, [initialized, manualLogout, submitLogin, turnstileSiteKey, turnstileToken, username]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    await submitLogin(username, password, turnstileToken);
  }
  return (
    <div className="auth-shell">
      <PromoBanner />
      <header>
        <Brand />
        <span className="auth-label">
          <ShieldCheck size={15} />
          管理控制台
        </span>
      </header>
      <main className="auth-main">
        <div className="auth-symbol">
          <Mascot size={64} />
        </div>
        <div className="auth-heading">
          <span className="eyebrow">ACP · 控制台</span>
          <h1>{initialized ? "欢迎回来" : "创建管理员账号"}</h1>
          <p>
            {initialized
              ? "登录你的 API 工作空间"
              : "设置此站点的首个管理员账号"}
          </p>
        </div>
        <form onSubmit={submit} className="auth-form">
          <Field label="管理员账号">
            <input
              autoFocus
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              value={username}
              onChange={(event) => {
                const val = event.target.value;
                setUsername(val);
                if (rememberPassword) {
                  localStorage.setItem("zako-saved-username", val);
                }
              }}
              required
              maxLength={64}
              placeholder="输入账号"
            />
          </Field>
          <Field label="密码">
            <span className="password-input">
              <input
                type={visible ? "text" : "password"}
                autoComplete={initialized ? "current-password" : "new-password"}
                value={password}
                onChange={(event) => {
                  const val = event.target.value;
                  setPassword(val);
                  if (rememberPassword) {
                    localStorage.setItem("zako-saved-password", val);
                  }
                }}
                required
                minLength={1}
                placeholder="输入密码"
              />
              <IconButton
                title={visible ? "隐藏密码" : "显示密码"}
                onClick={() => setVisible(!visible)}
              >
                {visible ? <EyeOff size={17} /> : <Eye size={17} />}
              </IconButton>
            </span>
          </Field>
          {!initialized && (
            <Field label="确认密码">
              <input
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                required
                minLength={1}
                placeholder="再次输入密码"
              />
            </Field>
          )}
          {initialized && turnstileSiteKey && (
            <div ref={turnstileRef} className="turnstile-widget" />
          )}
          {initialized && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                margin: "-4px 0 2px",
                fontSize: "13px",
                color: "var(--ink-soft)",
              }}
            >
              <label
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                  cursor: "pointer",
                  userSelect: "none",
                }}
              >
                <input
                  type="checkbox"
                  checked={rememberPassword}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setRememberPassword(checked);
                    if (checked) {
                      if (password) localStorage.setItem("zako-saved-password", password);
                      if (username) localStorage.setItem("zako-saved-username", username);
                    } else {
                      setAutoLogin(false);
                      localStorage.removeItem("zako-saved-password");
                      localStorage.removeItem("zako-saved-username");
                      localStorage.removeItem("zako-auto-login");
                    }
                  }}
                  style={{
                    width: "16px",
                    height: "16px",
                    accentColor: "var(--pink-500)",
                    cursor: "pointer",
                  }}
                />
                <span>保存密码</span>
              </label>
              <label
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                  cursor: "pointer",
                  userSelect: "none",
                }}
              >
                <input
                  type="checkbox"
                  checked={autoLogin}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setAutoLogin(checked);
                    if (checked) {
                      setRememberPassword(true);
                      localStorage.setItem("zako-auto-login", "1");
                      if (password) localStorage.setItem("zako-saved-password", password);
                      if (username) localStorage.setItem("zako-saved-username", username);
                    } else {
                      localStorage.removeItem("zako-auto-login");
                    }
                  }}
                  style={{
                    width: "16px",
                    height: "16px",
                    accentColor: "var(--pink-500)",
                    cursor: "pointer",
                  }}
                />
                <span>自动登录</span>
              </label>
            </div>
          )}
          <ErrorBox message={error} />
          <Button className="primary auth-submit" busy={busy} type="submit">
            {initialized ? "登录工作空间" : "创建并进入工作空间"}
            <ArrowRight size={17} />
          </Button>
        </form>
        <div className="auth-note">
          <span className="status-dot" />
          独立部署 · 数据由本站存储
        </div>
      </main>
      <footer>
        <span>© {new Date().getFullYear()} 多功能 ACP 聚合网关</span>
        <span>API Relay Console</span>
      </footer>
    </div>
  );
}

export default function App() {
  const [initialized, setInitialized] = useState<boolean | null>(null);
  const [manualLogout, setManualLogout] = useState(false);
  const [turnstileSiteKey, setTurnstileSiteKey] = useState("");
  const [state, setState] = useState<State | null>(null);
  const [page, setPage] = useState<Page>(() => {
    const stored = localStorage.getItem("zako-page");
    return navigation.some((item) => item.id === stored)
      ? (stored as Page)
      : "dashboard";
  });
  const [pageLoading, setPageLoading] = useState(() => independentlyLoadedPages.includes(page));
  const [pageError, setPageError] = useState("");
  const [navigationId, setNavigationId] = useState(0);
  const navigationSequence = useRef(0);
  const currentPage = useRef(page);
  const stateRequestSequence = useRef(0);
  const [mobileNav, setMobileNav] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [revision, setRevision] = useState(0);
  const [updateFocusRequest, setUpdateFocusRequest] = useState(0);
  const updateCheck = useUpdateCheck(!!state);
  const acp = useAcpGateway(!!state && page === "acp");
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(
    null,
  );
  const notify = useCallback(
    (text: string, isError = false) => setNotice({ text, error: isError }),
    [],
  );
  const loadState = useCallback(async () => {
    const request = ++stateRequestSequence.current;
    const [groups, accounts, keys, settings, profiles, bootstrap] =
      await Promise.all([
        api<Group[]>("/groups"),
        api<Account[]>("/accounts"),
        api<RelayKey[]>("/keys"),
        api<Settings>("/settings"),
        api<Profile[]>("/profiles"),
        api<{ username: string; turnstile_site_key: string }>("/bootstrap"),
      ]);
    if (request !== stateRequestSequence.current) return;
    setState({
      groups,
      accounts,
      keys,
      settings,
      profiles,
      username: bootstrap.username,
    });
    setTurnstileSiteKey(bootstrap.turnstile_site_key || "");
    setInitialized(true);
  }, []);
  const reportPageLoading = useCallback((pending: boolean) => {
    if (navigationId === navigationSequence.current && page === currentPage.current) {
      setPageLoading(pending);
    }
  }, [navigationId, page]);
  async function navigate(target: Page, retry = false) {
    setMobileNav(false);
    if (target === currentPage.current && !retry) return;
    const request = ++navigationSequence.current;
    currentPage.current = target;
    setNavigationId(request);
    setPage(target);
    setPageError("");
    setPageLoading(true);
    if (independentlyLoadedPages.includes(target)) return;
    try {
      await loadState();
    } catch (failure) {
      if (request === navigationSequence.current) setPageError(errorMessage(failure));
    } finally {
      if (request === navigationSequence.current) setPageLoading(false);
    }
  }
  const boot = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const bootstrap = await api<{
        initialized: boolean;
        authenticated: boolean;
        turnstile_site_key: string;
      }>("/bootstrap");
      setInitialized(bootstrap.initialized);
      setTurnstileSiteKey(bootstrap.turnstile_site_key || "");
      if (bootstrap.authenticated) await loadState();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setLoading(false);
    }
  }, [loadState]);
  useEffect(() => {
    void boot();
    const expired = () => {
      stateRequestSequence.current += 1;
      setNavigationId(++navigationSequence.current);
      setPageLoading(independentlyLoadedPages.includes(currentPage.current));
      setPageError("");
      setState(null);
    };
    window.addEventListener("session-expired", expired);
    return () => window.removeEventListener("session-expired", expired);
  }, [boot]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 4200);
    return () => window.clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    localStorage.setItem("zako-page", page);
    setMobileNav(false);
    if (page !== "settings") setUpdateFocusRequest(0);
  }, [page]);
  useEffect(() => {
    if (!mobileNav) return;
    const listener = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileNav(false);
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [mobileNav]);
  useEffect(() => {
    document.documentElement.classList.toggle("nav-open-lock", mobileNav);
    document.body.classList.toggle("nav-open-lock", mobileNav);
    return () => {
      document.documentElement.classList.remove("nav-open-lock");
      document.body.classList.remove("nav-open-lock");
    };
  }, [mobileNav]);
  async function refresh() {
    setRefreshing(true);
    try {
      await loadState();
      setRevision((value) => value + 1);
      if (page === "acp") {
        await acp.refreshAll();
      }
    } catch (failure) {
      notify(errorMessage(failure), true);
    } finally {
      setRefreshing(false);
    }
  }
  async function logout() {
    try {
      await api("/logout", "POST");
      setManualLogout(true);
      stateRequestSequence.current += 1;
      setNavigationId(++navigationSequence.current);
      setPageLoading(independentlyLoadedPages.includes(currentPage.current));
      setPageError("");
      setState(null);
    } catch (failure) {
      notify(errorMessage(failure), true);
    }
  }
  if (loading)
    return (
      <div className="startup-shell">
        <PromoBanner />
        <div className="full-loading">
          <Brand />
          <LoaderCircle className="spin" size={23} />
          <span>正在连接工作空间</span>
        </div>
      </div>
    );
  if (error)
    return (
      <div className="startup-shell">
        <PromoBanner />
        <div className="full-loading">
          <Brand />
          <ErrorBox message={error} />
          <Button onClick={() => void boot()}>
            <RefreshCw size={16} />
            重新连接
          </Button>
        </div>
      </div>
    );
  if (!state)
    return (
      <>
        <Authentication
          initialized={!!initialized}
          turnstileSiteKey={turnstileSiteKey}
          onSuccess={async () => {
            setManualLogout(false);
            await loadState();
          }}
          manualLogout={manualLogout}
        />
        {notice && <Toast {...notice} onClose={() => setNotice(null)} />}
      </>
    );
  const activePage = navigation.find((item) => item.id === page)!;
  const props = { state, reload: loadState, notify };
  return (
    <div className={`app-shell ${mobileNav ? "mobile-nav-open" : ""}`}>
      <button
        className={`nav-backdrop ${mobileNav ? "is-open" : ""}`}
        aria-label="关闭导航"
        onClick={() => setMobileNav(false)}
      />
      <aside className={`sidebar ${mobileNav ? "nav-open" : ""}`}>
        <div className="sidebar-brand">
          <Brand />
          <IconButton
            title="关闭导航"
            className="mobile-nav-close"
            onClick={() => setMobileNav(false)}
          >
            <X size={20} />
          </IconButton>
        </div>
        <div className="workspace-label">
          <span className="workspace-avatar">Z</span>
          <span>
            默认工作空间<small>PERSONAL WORKSPACE</small>
          </span>
          <ChevronRight size={15} />
        </div>
        <nav aria-label="主导航">
          {navigation.map((item) => (
            <Fragment key={item.id}>
              {"section" in item && <div className="nav-label">{item.section}</div>}
              <button
                className={`nav-item ${page === item.id ? "active" : ""}`}
                onClick={() => void navigate(item.id)}
                aria-current={page === item.id ? "page" : undefined}
              >
                <item.icon size={19} strokeWidth={1.7} />
                <span>{item.label}</span>
                {page === item.id && <span className="nav-indicator" />}
              </button>
            </Fragment>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="relay-status">
            <Activity size={16} />
            <span>Relay 运行中</span>
            <span className="status-dot" />
          </div>
          <div className="sidebar-version">
            <span>ACP 网关 / v{version}</span>
          </div>
        </div>
      </aside>
      <div className={`workspace${page === "playground" ? " playground-workspace" : ""}`}>
        <PromoBanner />
        <header className="topbar">
          <div className="breadcrumb">
            <IconButton
              title="打开导航"
              className="menu-button"
              onClick={() => setMobileNav(true)}
            >
              <Menu size={21} />
            </IconButton>
            <span className="breadcrumb-workspace">工作空间</span>
            <ChevronRight size={14} className="breadcrumb-chevron" />
            <span>{activePage.label}</span>
            {updateCheck.status?.update_available && (
              <button
                type="button"
                className="update-available-badge"
                title={`发现新版本 ${updateCheck.status.latest?.tag || ""}，前往系统更新`}
                aria-label="有新版本，前往系统设置更新"
                onClick={() => {
                  void navigate("settings");
                  setUpdateFocusRequest((value) => value + 1);
                }}
              >
                <span className="update-available-dot" aria-hidden="true" />
                有新版本
              </button>
            )}
          </div>
          <div className="topbar-actions">
            <span className="live-state">
              <span className="status-dot" />
              系统在线
            </span>
            <span className="topbar-divider" />
            <IconButton
              title="刷新数据"
              disabled={refreshing || pageLoading}
              onClick={() => void refresh()}
            >
              <RefreshCw size={17} className={refreshing ? "spin" : ""} />
            </IconButton>
            <span className="user-avatar" title={state.username}>
              {state.username?.slice(0, 1).toUpperCase() || "A"}
            </span>
            <IconButton title="退出登录" onClick={() => void logout()}>
              <LogOut size={17} />
            </IconButton>
          </div>
        </header>
        <main className={`main-content${page === "playground" ? " playground-main" : ""}`}>
          {pageError && <div className="page-load-error" role="alert">
            <ErrorBox message={`未能更新${activePage.label}：${pageError}`} />
            <Button className="small-button" onClick={() => void navigate(page, true)}>
              <RefreshCw size={15} />重新加载
            </Button>
          </div>}
          {/* Keep page effects mounted so requests can finish while the content is hidden. */}
          <div className="page-content" hidden={pageLoading} inert={pageLoading}>
          {page === "dashboard" && (
            <Dashboard revision={revision} notify={notify} state={state} onLoadingChange={reportPageLoading} />
          )}
          {page === "playground" && !pageLoading && <Suspense fallback={<div className="full-loading"><LoaderCircle className="spin" size={23} />正在加载游乐场</div>}><Playground state={state} notify={notify} /></Suspense>}
          {page === "groups" && !pageLoading && <GroupsPage {...props} />}
          {page === "accounts" && !pageLoading && <AccountsPage {...props} />}
          {page === "keys" && !pageLoading && <KeysPage {...props} />}
          {page === "providers" && (
            <ProvidersPage revision={revision} notify={notify} onLoadingChange={reportPageLoading} />
          )}
          {page === "prompts" && !pageLoading && (
            <PromptRulesPage revision={revision} notify={notify} />
          )}
          {page === "acp" && (
            <AcpConsolePage
              acp={acp}
              notify={notify}
              onLoadingChange={reportPageLoading}
              onOpenPlayground={(modelId) => {
                void navigate("playground");
                notify(`已切换到聊天页，可选择模型 ${modelId}`);
              }}
            />
          )}
          {page === "settings" && !pageLoading && (
            <SettingsPage
              {...props}
              updateCheck={updateCheck}
              updateFocusRequest={updateFocusRequest}
            />
          )}
          </div>
          {pageLoading && <section className="page-loading-state" aria-label={`${activePage.label}加载中`}>
            <div className="page-loading-card" role="status" aria-live="polite" aria-atomic="true">
              <span className="page-loading-symbol" aria-hidden="true"><LoaderCircle className="spin page-loading-spinner" size={42} strokeWidth={1.6} /></span>
              <strong>正在加载{activePage.label}</strong>
              <span>正在获取最新数据，请稍候…</span>
            </div>
          </section>}
        </main>
        <footer className="workspace-footer">
          <span>多功能 ACP 聚合网关</span>
          <span>
            <ShieldCheck size={12} />
            自托管工作空间
          </span>
        </footer>
      </div>
      {notice && <Toast {...notice} onClose={() => setNotice(null)} />}
    </div>
  );
}
