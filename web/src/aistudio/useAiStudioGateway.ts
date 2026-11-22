import { useCallback, useEffect, useRef, useState } from "react";
import {
  AISTUDIO_PREFIX,
  AiStudioApiError,
  assertValidAccounts,
  checkZakoSessionExpired,
  clearLogs as clearLogsApi,
  fetchAccountExits,
  fetchAccounts,
  fetchAccountTasks,
  fetchAuthSession,
  fetchConfig,
  fetchCooldowns,
  fetchModels,
  fetchRequests,
  fetchStatus,
  fetchUpdateInfo,
  getConsoleHeaders,
  loginAiStudio,
  logoutAiStudio,
  parseAuthMode,
  saveConfig as saveConfigApi,
  startService,
  stopService,
} from "./api";
import type {
  AiStudioAccount,
  AiStudioAccountExit,
  AiStudioAccountTask,
  AiStudioActiveRequest,
  AiStudioAuthSession,
  AiStudioConfig,
  AiStudioConfigPatch,
  AiStudioCooldown,
  AiStudioLogEntry,
  AiStudioModel,
  AiStudioStatus,
  AiStudioUpdateInfo,
} from "./types";

export interface AiStudioRefreshResult {
  ok: boolean;
  error?: string;
}

export interface AiStudioOptionalErrors {
  exits?: string;
  update?: string;
}

export interface AiStudioGatewayState {
  authSession: AiStudioAuthSession | null;
  authRequired: boolean;
  status: AiStudioStatus | null;
  accounts: AiStudioAccount[];
  exits: AiStudioAccountExit[];
  tasks: AiStudioAccountTask[];
  models: AiStudioModel[];
  requests: AiStudioActiveRequest[];
  cooldowns: AiStudioCooldown[];
  logs: AiStudioLogEntry[];
  config: AiStudioConfig | null;
  updateInfo: AiStudioUpdateInfo | null;
  optionalErrors: AiStudioOptionalErrors;
  online: boolean;
  sseConnected: boolean;
  loading: boolean;
  error: string | null;
  refreshAll: (
    onComplete?: (res: AiStudioRefreshResult) => void,
  ) => Promise<AiStudioRefreshResult>;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  toggleService: (action: "start" | "stop") => Promise<void>;
  clearLogs: () => Promise<void>;
  saveConfig: (patch: AiStudioConfigPatch) => Promise<AiStudioConfig>;
}

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

export function useAiStudioGateway(enabled: boolean): AiStudioGatewayState {
  const [authSession, setAuthSession] = useState<AiStudioAuthSession | null>(
    null,
  );
  const [status, setStatus] = useState<AiStudioStatus | null>(null);
  const [accounts, setAccounts] = useState<AiStudioAccount[]>([]);
  const [exits, setExits] = useState<AiStudioAccountExit[]>([]);
  const [tasks, setTasks] = useState<AiStudioAccountTask[]>([]);
  const [models, setModels] = useState<AiStudioModel[]>([]);
  const [requests, setRequests] = useState<AiStudioActiveRequest[]>([]);
  const [cooldowns, setCooldowns] = useState<AiStudioCooldown[]>([]);
  const [logs, setLogs] = useState<AiStudioLogEntry[]>([]);
  const [config, setConfig] = useState<AiStudioConfig | null>(null);
  const [updateInfo, setUpdateInfo] = useState<AiStudioUpdateInfo | null>(null);
  const [optionalErrors, setOptionalErrors] = useState<AiStudioOptionalErrors>(
    {},
  );
  const [online, setOnline] = useState(false);
  const [sseConnected, setSseConnected] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reqSeq = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const configRef = useRef<AiStudioConfig | null>(null);
  configRef.current = config;

  const authRequired =
    !!authSession &&
    authSession.mode !== "managed" &&
    authSession.enabled &&
    !authSession.authenticated;

  const clearProtectedState = useCallback(() => {
    setStatus(null);
    setAccounts([]);
    setExits([]);
    setTasks([]);
    setModels([]);
    setRequests([]);
    setCooldowns([]);
    setLogs([]);
    setConfig(null);
    setUpdateInfo(null);
    setOptionalErrors({});
    setSseConnected(false);
  }, []);

  const abortInFlight = useCallback(() => {
    reqSeq.current += 1;
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  }, []);

  const isStale = useCallback((seq: number, signal?: AbortSignal) => {
    return seq !== reqSeq.current || !!signal?.aborted || !enabledRef.current;
  }, []);

  const loadProtectedData = useCallback(
    async (seq: number, signal: AbortSignal) => {
      const nextOptionalErrors: AiStudioOptionalErrors = {};

      const [
        nextStatus,
        nextAccounts,
        nextExitsResult,
        nextTasks,
        nextModels,
        nextRequests,
        nextCooldowns,
        nextConfig,
        nextUpdateResult,
      ] = await Promise.all([
        fetchStatus(signal),
        fetchAccounts(signal),
        fetchAccountExits(signal).then(
          (data) => ({ ok: true as const, data }),
          (err) => {
            if (isAbortError(err)) throw err;
            nextOptionalErrors.exits = toMessage(err);
            return { ok: false as const, data: [] as AiStudioAccountExit[] };
          },
        ),
        fetchAccountTasks(signal),
        fetchModels(signal),
        fetchRequests(signal),
        fetchCooldowns(signal),
        fetchConfig(signal),
        fetchUpdateInfo(false, signal).then(
          (data) => ({ ok: true as const, data }),
          (err) => {
            if (isAbortError(err)) throw err;
            nextOptionalErrors.update = toMessage(err);
            return { ok: false as const, data: null };
          },
        ),
      ]);

      if (isStale(seq, signal)) return;

      setStatus(nextStatus);
      setAccounts(nextAccounts);
      if (nextExitsResult.ok) setExits(nextExitsResult.data);
      setTasks(nextTasks);
      setModels(nextModels);
      setRequests(nextRequests);
      setCooldowns(nextCooldowns);
      setConfig(nextConfig);
      if (nextUpdateResult.ok) setUpdateInfo(nextUpdateResult.data);
      setOptionalErrors(nextOptionalErrors);
      setOnline(true);
    },
    [isStale],
  );

  const refreshAll = useCallback(
    async (
      onComplete?: (res: AiStudioRefreshResult) => void,
    ): Promise<AiStudioRefreshResult> => {
      abortInFlight();
      const seq = reqSeq.current;
      const controller = new AbortController();
      abortRef.current = controller;

      setLoading(true);
      setError(null);
      try {
        const session = await fetchAuthSession(controller.signal);
        if (isStale(seq, controller.signal)) {
          return { ok: false, error: "请求已取消" };
        }
        setAuthSession(session);
        setOnline(true);

        if (session.mode === "managed" && !session.authenticated) {
          clearProtectedState();
          const managedErr =
            "由 8046 会话统一托管鉴权失败，请检查服务端 ADMIN_USERNAME / ADMIN_PASSWORD 配置";
          setError(managedErr);
          setLoading(false);
          const result: AiStudioRefreshResult = { ok: false, error: managedErr };
          onComplete?.(result);
          return result;
        }

        if (session.enabled && !session.authenticated) {
          clearProtectedState();
          setLoading(false);
          const result: AiStudioRefreshResult = {
            ok: false,
            error: "需要登录 AI Studio 管理端",
          };
          onComplete?.(result);
          return result;
        }

        await loadProtectedData(seq, controller.signal);
        if (isStale(seq, controller.signal)) {
          return { ok: false, error: "请求已取消" };
        }
        const result: AiStudioRefreshResult = { ok: true };
        onComplete?.(result);
        return result;
      } catch (err) {
        if (isAbortError(err) || isStale(seq, controller.signal)) {
          return { ok: false, error: "请求已取消" };
        }
        if (
          err instanceof AiStudioApiError &&
          err.code === "admin_login_required"
        ) {
          setAuthSession((prev) => ({
            authenticated: false,
            enabled: true,
            username: "",
            ...(prev?.mode ? { mode: prev.mode } : {}),
          }));
          clearProtectedState();
          setOnline(true);
          setError(null);
          const result: AiStudioRefreshResult = {
            ok: false,
            error: "需要登录 AI Studio 管理端",
          };
          onComplete?.(result);
          return result;
        }
        const msg = toMessage(err);
        setError(msg);
        setOnline(false);
        const result: AiStudioRefreshResult = { ok: false, error: msg };
        onComplete?.(result);
        return result;
      } finally {
        if (seq === reqSeq.current) {
          setLoading(false);
        }
      }
    },
    [abortInFlight, clearProtectedState, isStale, loadProtectedData],
  );

  // Global session-expired listener & enabled lifecycle cleanup
  useEffect(() => {
    const onSessionExpired = () => {
      abortInFlight();
      setAuthSession(null);
      clearProtectedState();
      setOnline(false);
      setLoading(false);
    };
    window.addEventListener("session-expired", onSessionExpired);
    return () => {
      window.removeEventListener("session-expired", onSessionExpired);
    };
  }, [abortInFlight, clearProtectedState]);

  useEffect(() => {
    if (!enabled) {
      abortInFlight();
      clearProtectedState();
      setLoading(false);
      return;
    }
    void refreshAll();
    return () => {
      abortInFlight();
    };
  }, [enabled, abortInFlight, clearProtectedState, refreshAll]);

  // Fetch + ReadableStream SSE /api/events subscription when authenticated
  useEffect(() => {
    if (!enabled || authRequired || !authSession) {
      setSseConnected(false);
      return;
    }

    let retryTimer: number | null = null;
    let currentController: AbortController | null = null;
    let backoff = 2000;
    let disposed = false;
    let needSnapshotOnConnect = false;

    const handleSsePayload = (eventName: string, rawData: string) => {
      const seqSnapshot = reqSeq.current;
      const trimmed = rawData.trim();
      if (!trimmed) return;
      let payload: { type?: string; data?: unknown };
      try {
        payload = JSON.parse(trimmed) as { type?: string; data?: unknown };
      } catch (err) {
        console.warn("[AIStudio SSE] 忽略无法解析的 JSON 事件:", err);
        return;
      }
      if (disposed || seqSnapshot !== reqSeq.current || !enabledRef.current) {
        return;
      }

      const evtType = payload.type || eventName;
      if (evtType === "status" && payload.data) {
        setStatus(payload.data as AiStudioStatus);
        setOnline(true);
      } else if (
        evtType === "log" &&
        payload.data &&
        typeof payload.data === "object"
      ) {
        const entry = payload.data as AiStudioLogEntry;
        setLogs((prev) => {
          const next = [...prev, entry];
          return next.length > 512 ? next.slice(next.length - 512) : next;
        });
      } else if (
        evtType === "account_tasks" &&
        payload.data &&
        typeof payload.data === "object"
      ) {
        const list = (payload.data as { tasks?: AiStudioAccountTask[] }).tasks;
        if (Array.isArray(list)) setTasks(list);
      } else if (
        evtType === "models" &&
        payload.data &&
        typeof payload.data === "object"
      ) {
        const list = (payload.data as { models?: AiStudioModel[] }).models;
        if (Array.isArray(list)) setModels(list);
      } else if (evtType === "accounts") {
        const directList = Array.isArray(payload.data)
          ? payload.data
          : (payload.data as { accounts?: unknown } | undefined)?.accounts;
        if (Array.isArray(directList)) {
          try {
            setAccounts(assertValidAccounts(directList, "/api/events#accounts"));
          } catch (err) {
            console.warn("[AIStudio SSE] 忽略格式异常的 accounts 事件:", err);
          }
        } else {
          const sig = currentController?.signal;
          void fetchAccounts(sig)
            .then((list) => {
              if (!disposed && seqSnapshot === reqSeq.current && !sig?.aborted) {
                setAccounts(list);
              }
            })
            .catch(() => {});
        }
      } else if (evtType === "cooldowns") {
        const directList = Array.isArray(payload.data)
          ? (payload.data as AiStudioCooldown[])
          : (payload.data as { cooldowns?: AiStudioCooldown[] } | undefined)
              ?.cooldowns;
        if (Array.isArray(directList)) {
          setCooldowns(directList);
        } else {
          const sig = currentController?.signal;
          void fetchCooldowns(sig)
            .then((list) => {
              if (!disposed && seqSnapshot === reqSeq.current && !sig?.aborted) {
                setCooldowns(list);
              }
            })
            .catch(() => {});
        }
      }
    };

    const connect = async () => {
      if (disposed) return;
      const controller = new AbortController();
      currentController = controller;

      try {
        const res = await fetch(`${AISTUDIO_PREFIX}/api/events`, {
          method: "GET",
          credentials: "same-origin",
          headers: {
            ...getConsoleHeaders(),
            Accept: "text/event-stream",
          },
          signal: controller.signal,
        });

        if (disposed || controller.signal.aborted) return;

        if (!res.ok) {
          if (checkZakoSessionExpired(res)) {
            disposed = true;
            setSseConnected(false);
            clearProtectedState();
            return;
          }
          if (res.status === 401) {
            disposed = true;
            setSseConnected(false);
            const headerMode = parseAuthMode(
              res.headers.get("x-aistudio-auth-mode"),
            );
            setAuthSession((prev) => {
              const nextMode = headerMode ?? prev?.mode;
              if (nextMode === "managed") {
                setError(
                  "由 8046 会话统一托管鉴权失败，请检查服务端 ADMIN_USERNAME / ADMIN_PASSWORD 配置",
                );
              }
              return {
                authenticated: false,
                enabled: true,
                username: "",
                ...(nextMode ? { mode: nextMode } : {}),
              };
            });
            clearProtectedState();
            return;
          }
          throw new Error(`SSE HTTP ${res.status}`);
        }

        if (!res.body) {
          throw new Error("SSE response missing body");
        }

        backoff = 2000;
        setSseConnected(true);
        if (needSnapshotOnConnect) {
          needSnapshotOnConnect = false;
          void refreshAll();
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = "";
        let currentEvent = "";
        let dataLines: string[] = [];

        while (!disposed && !controller.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let nlIdx = buffer.indexOf("\n");
          while (nlIdx !== -1) {
            const rawLine = buffer.slice(0, nlIdx).replace(/\r$/, "");
            buffer = buffer.slice(nlIdx + 1);

            if (rawLine === "") {
              if (dataLines.length > 0) {
                handleSsePayload(currentEvent, dataLines.join("\n"));
                dataLines = [];
              }
              currentEvent = "";
            } else if (rawLine.startsWith(":")) {
              // heartbeat comment line, ignore
            } else if (rawLine.startsWith("event:")) {
              currentEvent = rawLine.slice(6).trim();
            } else if (rawLine.startsWith("id:")) {
              // standard SSE id field
            } else if (rawLine.startsWith("data:")) {
              dataLines.push(rawLine.slice(5).trimStart());
            }

            nlIdx = buffer.indexOf("\n");
          }
        }
      } catch (err) {
        if (disposed || isAbortError(err)) return;
      }

      if (disposed) return;
      setSseConnected(false);
      needSnapshotOnConnect = true;
      retryTimer = window.setTimeout(() => {
        void connect();
      }, backoff);
      backoff = Math.min(5000, backoff + 1000);
    };

    void connect();

    return () => {
      disposed = true;
      setSseConnected(false);
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      currentController?.abort();
    };
  }, [enabled, authRequired, authSession, clearProtectedState, refreshAll]);

  const login = useCallback(
    async (username: string, password: string) => {
      abortInFlight();
      const seq = reqSeq.current;
      const controller = new AbortController();
      abortRef.current = controller;

      const next = await loginAiStudio(username, password, controller.signal);
      if (isStale(seq, controller.signal)) return;
      setAuthSession(next);
      if (next.mode === "managed" && !next.authenticated) {
        const managedErr =
          "由 8046 会话统一托管鉴权失败，请检查服务端 ADMIN_USERNAME / ADMIN_PASSWORD 配置";
        setError(managedErr);
        clearProtectedState();
        throw new Error(managedErr);
      }
      setError(null);
      await loadProtectedData(seq, controller.signal);
    },
    [abortInFlight, clearProtectedState, isStale, loadProtectedData],
  );

  const logout = useCallback(async () => {
    abortInFlight();
    await logoutAiStudio();
    setAuthSession({ authenticated: false, enabled: true, username: "" });
    clearProtectedState();
  }, [abortInFlight, clearProtectedState]);

  const toggleService = useCallback(
    async (action: "start" | "stop") => {
      if (action === "start") {
        await startService();
      } else {
        await stopService();
      }
      await refreshAll();
    },
    [refreshAll],
  );

  const clearLogs = useCallback(async () => {
    await clearLogsApi();
    setLogs([]);
  }, []);

  const saveConfig = useCallback(async (patch: AiStudioConfigPatch) => {
    const saved = await saveConfigApi(patch, configRef.current);
    configRef.current = saved;
    setConfig(saved);
    return saved;
  }, []);

  return {
    authSession,
    authRequired,
    status,
    accounts,
    exits,
    tasks,
    models,
    requests,
    cooldowns,
    logs,
    config,
    updateInfo,
    optionalErrors,
    online,
    sseConnected,
    loading,
    error,
    refreshAll,
    login,
    logout,
    toggleService,
    clearLogs,
    saveConfig,
  };
}
