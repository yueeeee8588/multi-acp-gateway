import { useCallback, useEffect, useRef, useState } from 'react';
import {
  App2ApiError,
  fetchAccounts,
  fetchKeys,
  fetchOverview,
  fetchSettings,
} from './api';
import type {
  App2ApiAccount,
  App2ApiKey,
  App2ApiOverview,
  App2ApiRequestAttempt,
  App2ApiRequestRecord,
  App2ApiSettings,
} from './types';

const APP2API_PREFIX = '/app2api-api';
const OVERVIEW_POLL_INTERVAL_MS = 5000;
const MAX_REQUESTS = 200;
const SSE_MIN_BACKOFF_MS = 2000;
const SSE_MAX_BACKOFF_MS = 5000;

export interface App2ApiRefreshResult {
  ok: boolean;
  error?: string;
}

export interface App2ApiRefreshOptions {
  onComplete?: (result: App2ApiRefreshResult) => void;
}

export interface App2ApiGatewayState {
  overview: App2ApiOverview | null;
  accounts: App2ApiAccount[];
  keys: App2ApiKey[];
  requests: App2ApiRequestRecord[];
  settings: App2ApiSettings | null;
  online: boolean;
  sseConnected: boolean;
  loading: boolean;
  error: string | null;
  refreshAll: (options?: App2ApiRefreshOptions) => Promise<void>;
  cancelRequest: (id: string) => Promise<{ ok: boolean }>;
  clearRequests: () => Promise<{ ok: boolean; cleared?: number }>;
}

interface RequestAttemptEventPayload {
  requestId: string;
  attempt: App2ApiRequestAttempt;
  switchCount: number;
  accountId?: string | null;
  accountLabel?: string | null;
}

interface App2ApiSseHandlers {
  onRequests?: (data: App2ApiRequestRecord[]) => void;
  onRequestStart?: (data: App2ApiRequestRecord) => void;
  onRequestAttempt?: (
    data: RequestAttemptEventPayload | App2ApiRequestRecord
  ) => void;
  onRequestFinish?: (data: App2ApiRequestRecord) => void;
  onPing?: (ts: number) => void;
  onOpen?: () => void;
  onError?: () => void;
}

function getConsoleHeaders(): Record<string, string> {
  return {
    'X-Console-Path': window.location.pathname,
  };
}

function checkSessionExpired(res: Response): void {
  if (
    res.status === 401 &&
    res.headers.get('x-zako-auth-error') === 'session_expired'
  ) {
    window.dispatchEvent(new Event('session-expired'));
  }
}

async function parseErrorResponse(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as {
    error?: { message?: string } | string;
    message?: string;
  } | null;
  const detail =
    typeof body?.error === 'string' ? body.error : body?.error?.message;
  const message = [detail, body?.message].find(
    (text) => typeof text === 'string' && text.trim()
  );
  return message || `HTTP ${res.status}`;
}

function getRecordId(record: App2ApiRequestRecord): string {
  return record.id || record.requestId || '';
}

function upsertRequestList(
  prev: App2ApiRequestRecord[],
  incoming: App2ApiRequestRecord
): App2ApiRequestRecord[] {
  const incomingId = getRecordId(incoming);
  if (!incomingId) return prev;
  const normalized = incoming.id ? incoming : { ...incoming, id: incomingId };
  const idx = prev.findIndex((r) => getRecordId(r) === incomingId);
  if (idx >= 0) {
    const next = prev.slice();
    next[idx] = normalized;
    return next;
  }
  const next = [normalized, ...prev];
  return next.length > MAX_REQUESTS ? next.slice(0, MAX_REQUESTS) : next;
}

function mergeRequestAttemptList(
  prev: App2ApiRequestRecord[],
  payload: RequestAttemptEventPayload | App2ApiRequestRecord
): App2ApiRequestRecord[] {
  if (!('attempt' in payload)) {
    return upsertRequestList(prev, payload);
  }
  const idx = prev.findIndex((r) => getRecordId(r) === payload.requestId);
  if (idx < 0) return prev;

  const target = prev[idx];
  const existingAttempts = Array.isArray(target.attempts) ? target.attempts : [];
  const attemptIdx = existingAttempts.findIndex(
    (a) => a.index === payload.attempt.index
  );
  const nextAttempts =
    attemptIdx >= 0
      ? existingAttempts.map((a, i) =>
          i === attemptIdx ? payload.attempt : a
        )
      : [...existingAttempts, payload.attempt];

  const next = prev.slice();
  next[idx] = {
    ...target,
    attempts: nextAttempts,
    providerAttempts: nextAttempts.length,
    switchCount:
      typeof payload.switchCount === 'number'
        ? payload.switchCount
        : Math.max(0, nextAttempts.length - 1),
    accountId:
      payload.accountId !== undefined ? payload.accountId : target.accountId,
    accountLabel:
      payload.accountLabel !== undefined
        ? payload.accountLabel
        : target.accountLabel,
  };
  return next;
}

async function fetchApp2ApiRequests(): Promise<App2ApiRequestRecord[] | null> {
  const res = await fetch(`${APP2API_PREFIX}/admin/api/requests`, {
    method: 'GET',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...getConsoleHeaders(),
    },
  });

  if (res.status === 404) {
    return null;
  }

  if (!res.ok) {
    checkSessionExpired(res);
    throw new App2ApiError(await parseErrorResponse(res), res.status);
  }

  const body = (await res.json()) as
    | App2ApiRequestRecord[]
    | { requests?: App2ApiRequestRecord[]; items?: App2ApiRequestRecord[]; data?: App2ApiRequestRecord[] };

  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.requests)) return body.requests;
  if (Array.isArray(body?.items)) return body.items;
  if (Array.isArray(body?.data)) return body.data;
  return [];
}

async function cancelApp2ApiRequest(id: string): Promise<{ ok: boolean }> {
  const res = await fetch(
    `${APP2API_PREFIX}/admin/api/requests/${encodeURIComponent(id)}/cancel`,
    {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        ...getConsoleHeaders(),
      },
    }
  );

  if (!res.ok) {
    checkSessionExpired(res);
    throw new App2ApiError(await parseErrorResponse(res), res.status);
  }

  if (res.status === 204) return { ok: true };
  return (await res.json()) as { ok: boolean };
}

async function clearApp2ApiRequests(): Promise<{ ok: boolean; cleared?: number }> {
  const res = await fetch(`${APP2API_PREFIX}/admin/api/requests`, {
    method: 'DELETE',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...getConsoleHeaders(),
    },
  });

  if (!res.ok) {
    checkSessionExpired(res);
    throw new App2ApiError(await parseErrorResponse(res), res.status);
  }

  if (res.status === 204) return { ok: true };
  return (await res.json()) as { ok: boolean; cleared?: number };
}

function unwrapSseData(rawParsed: unknown): unknown {
  if (
    rawParsed &&
    typeof rawParsed === 'object' &&
    !Array.isArray(rawParsed) &&
    'data' in rawParsed &&
    ('type' in rawParsed || 'timestamp' in rawParsed || 'ts' in rawParsed)
  ) {
    return (rawParsed as { data: unknown }).data;
  }
  return rawParsed;
}

function dispatchSseEvent(
  eventName: string,
  rawData: string,
  handlers: App2ApiSseHandlers
): void {
  if (eventName === 'ping') {
    try {
      const parsed = JSON.parse(rawData) as { ts?: number; timestamp?: number };
      handlers.onPing?.(parsed.ts ?? parsed.timestamp ?? Date.now());
    } catch {
      handlers.onPing?.(Date.now());
    }
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawData);
  } catch {
    return;
  }

  const data = unwrapSseData(parsed);

  switch (eventName) {
    case 'requests':
      if (Array.isArray(data)) {
        handlers.onRequests?.(data as App2ApiRequestRecord[]);
      }
      break;
    case 'request:start':
      if (data && typeof data === 'object') {
        handlers.onRequestStart?.(data as App2ApiRequestRecord);
      }
      break;
    case 'request:attempt':
      if (data && typeof data === 'object') {
        handlers.onRequestAttempt?.(
          data as RequestAttemptEventPayload | App2ApiRequestRecord
        );
      }
      break;
    case 'request:finish':
      if (data && typeof data === 'object') {
        handlers.onRequestFinish?.(data as App2ApiRequestRecord);
      }
      break;
    default:
      break;
  }
}

function connectApp2ApiEvents(handlers: App2ApiSseHandlers): () => void {
  let closed = false;
  let activeController: AbortController | null = null;
  let reconnectTimer: number | null = null;
  let retryAttempt = 0;

  const clearReconnectTimer = () => {
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const scheduleReconnect = () => {
    if (closed) return;
    clearReconnectTimer();
    const delay = Math.min(
      SSE_MAX_BACKOFF_MS,
      Math.round(SSE_MIN_BACKOFF_MS * Math.pow(1.5, retryAttempt))
    );
    retryAttempt += 1;
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, delay);
  };

  const connect = async () => {
    if (closed) return;
    activeController?.abort();
    const controller = new AbortController();
    activeController = controller;

    try {
      const res = await fetch(`${APP2API_PREFIX}/admin/api/events`, {
        method: 'GET',
        headers: {
          ...getConsoleHeaders(),
          Accept: 'text/event-stream',
        },
        credentials: 'same-origin',
        signal: controller.signal,
      });

      checkSessionExpired(res);

      if (!res.ok || !res.body) {
        throw new Error(`SSE HTTP ${res.status}`);
      }

      retryAttempt = 0;
      handlers.onOpen?.();

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let eventName = 'message';
      let dataLines: string[] = [];

      const flushEvent = () => {
        if (dataLines.length > 0) {
          dispatchSseEvent(eventName, dataLines.join('\n'), handlers);
        }
        eventName = 'message';
        dataLines = [];
      };

      while (!closed) {
        const { done, value } = await reader.read();
        if (done) {
          flushEvent();
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line === '') {
            flushEvent();
            continue;
          }
          if (line.startsWith(':')) {
            continue;
          }
          if (line.startsWith('event:')) {
            eventName = line.slice(6).trim() || 'message';
          } else if (line.startsWith('data:')) {
            const val = line.slice(5);
            dataLines.push(val.startsWith(' ') ? val.slice(1) : val);
          }
        }
      }

      if (!closed) {
        handlers.onError?.();
        scheduleReconnect();
      }
    } catch {
      if (closed || controller.signal.aborted) {
        return;
      }
      handlers.onError?.();
      scheduleReconnect();
    }
  };

  void connect();

  return () => {
    closed = true;
    clearReconnectTimer();
    activeController?.abort();
    activeController = null;
  };
}

function formatGatewayError(reason: unknown): string {
  if (reason instanceof Error && reason.message.trim()) {
    return reason.message;
  }
  return '无法连接到 8049 Gemini App 网关';
}

export function useApp2ApiGateway(enabled: boolean): App2ApiGatewayState {
  const [overview, setOverview] = useState<App2ApiOverview | null>(null);
  const [accounts, setAccounts] = useState<App2ApiAccount[]>([]);
  const [keys, setKeys] = useState<App2ApiKey[]>([]);
  const [requests, setRequests] = useState<App2ApiRequestRecord[]>([]);
  const [settings, setSettings] = useState<App2ApiSettings | null>(null);
  const [online, setOnline] = useState(false);
  const [sseConnected, setSseConnected] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refreshAll = useCallback(async (options?: App2ApiRefreshOptions) => {
    setLoading(true);
    const results = await Promise.allSettled([
      fetchOverview(),
      fetchAccounts(),
      fetchKeys(),
      fetchSettings(),
      fetchApp2ApiRequests(),
    ]);

    if (!mountedRef.current) return;

    const [ovRes, accRes, keyRes, setRes, reqRes] = results;

    if (ovRes.status === 'fulfilled') {
      const ov = ovRes.value;
      setOverview(ov);
      setOnline(true);
      if (accRes.status !== 'fulfilled' && Array.isArray(ov.accounts)) {
        setAccounts(ov.accounts);
      }
      if (setRes.status !== 'fulfilled' && ov.settings) {
        setSettings(ov.settings);
      }
    } else {
      setOnline(false);
    }

    if (accRes.status === 'fulfilled') setAccounts(accRes.value);
    if (keyRes.status === 'fulfilled') setKeys(keyRes.value);
    if (setRes.status === 'fulfilled') setSettings(setRes.value);

    if (reqRes.status === 'fulfilled' && reqRes.value !== null) {
      setRequests(reqRes.value.slice(0, MAX_REQUESTS));
    } else if (
      ovRes.status === 'fulfilled' &&
      Array.isArray(ovRes.value.requests)
    ) {
      setRequests(ovRes.value.requests.slice(0, MAX_REQUESTS));
    }

    if (ovRes.status === 'rejected') {
      const errMsg = `8049 网关离线或不可达：${formatGatewayError(ovRes.reason)}`;
      setError(errMsg);
      setLoading(false);
      options?.onComplete?.({ ok: false, error: errMsg });
      return;
    }

    const coreResults = [ovRes, accRes, keyRes, setRes];
    const firstRejected = coreResults.find(
      (r): r is PromiseRejectedResult => r.status === 'rejected'
    );

    if (firstRejected) {
      const errMsg = formatGatewayError(firstRejected.reason);
      setError(errMsg);
      setLoading(false);
      options?.onComplete?.({ ok: false, error: errMsg });
      return;
    }

    setError(null);
    setLoading(false);
    options?.onComplete?.({ ok: true });
  }, []);

  const cancelRequest = useCallback(async (id: string) => {
    return cancelApp2ApiRequest(id);
  }, []);

  const clearRequests = useCallback(async () => {
    const res = await clearApp2ApiRequests();
    if (mountedRef.current) {
      setRequests([]);
      setOverview((prev) => (prev ? { ...prev, requests: [] } : prev));
    }
    return res;
  }, []);

  useEffect(() => {
    if (!enabled) {
      setSseConnected(false);
      return;
    }

    let active = true;
    void refreshAll();

    const disconnect = connectApp2ApiEvents({
      onOpen: () => {
        if (active && mountedRef.current) setSseConnected(true);
      },
      onError: () => {
        if (active && mountedRef.current) setSseConnected(false);
      },
      onPing: () => {
        if (active && mountedRef.current) setSseConnected(true);
      },
      onRequests: (data) => {
        if (!active || !mountedRef.current) return;
        setSseConnected(true);
        setRequests(data.slice(0, MAX_REQUESTS));
      },
      onRequestStart: (data) => {
        if (!active || !mountedRef.current) return;
        setSseConnected(true);
        setRequests((prev) => upsertRequestList(prev, data));
      },
      onRequestAttempt: (data) => {
        if (!active || !mountedRef.current) return;
        setSseConnected(true);
        setRequests((prev) => mergeRequestAttemptList(prev, data));
      },
      onRequestFinish: (data) => {
        if (!active || !mountedRef.current) return;
        setSseConnected(true);
        setRequests((prev) => upsertRequestList(prev, data));
      },
    });

    const timer = window.setInterval(() => {
      void fetchOverview()
        .then((ov) => {
          if (!active || !mountedRef.current) return;
          setOverview(ov);
          setOnline(true);
          setError(null);
          if (Array.isArray(ov.accounts)) {
            setAccounts(ov.accounts);
          }
          if (ov.settings) {
            setSettings((prev) => prev ?? ov.settings ?? null);
          }
        })
        .catch((err) => {
          if (!active || !mountedRef.current) return;
          setOnline(false);
          setError(`8049 网关离线或不可达：${formatGatewayError(err)}`);
        });
    }, OVERVIEW_POLL_INTERVAL_MS);

    return () => {
      active = false;
      disconnect();
      setSseConnected(false);
      window.clearInterval(timer);
    };
  }, [enabled, refreshAll]);

  return {
    overview,
    accounts,
    keys,
    requests,
    settings,
    online,
    sseConnected,
    loading,
    error,
    refreshAll,
    cancelRequest,
    clearRequests,
  };
}
