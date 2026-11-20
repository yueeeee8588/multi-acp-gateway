import { useCallback, useEffect, useRef, useState } from 'react';
import {
  connectGatewayEvents,
  fetchAccountExits,
  fetchAccounts,
  fetchConfig,
  fetchCooldowns,
  fetchRequests,
} from './api';
import type {
  AccountRecord,
  CooldownRecord,
  ExitGroup,
  GatewayConfig,
  RequestAttempt,
  RequestLog,
} from './types';

const MAX_REQUESTS = 200;

function upsertRequestList(
  prev: RequestLog[],
  incoming: RequestLog
): RequestLog[] {
  const idx = prev.findIndex((r) => r.id === incoming.id);
  if (idx >= 0) {
    const next = prev.slice();
    next[idx] = incoming;
    return next;
  }
  const next = [incoming, ...prev];
  return next.length > MAX_REQUESTS ? next.slice(0, MAX_REQUESTS) : next;
}

function mergeRequestAttemptList(
  prev: RequestLog[],
  payload: { requestId: string; attempt: RequestAttempt } | RequestLog
): RequestLog[] {
  if ('attempts' in payload && 'id' in payload) {
    return upsertRequestList(prev, payload);
  }
  const idx = prev.findIndex((r) => r.id === payload.requestId);
  if (idx < 0) return prev;

  const target = prev[idx];
  const attemptIdx = target.attempts.findIndex(
    (a) => a.index === payload.attempt.index
  );
  const nextAttempts =
    attemptIdx >= 0
      ? target.attempts.map((a, i) =>
          i === attemptIdx ? payload.attempt : a
        )
      : [...target.attempts, payload.attempt];

  const next = prev.slice();
  next[idx] = {
    ...target,
    attempts: nextAttempts,
    switchCount: Math.max(0, nextAttempts.length - 1),
  };
  return next;
}

export interface AcpRefreshResult {
  ok: boolean;
  error?: string;
}

export interface AcpRefreshOptions {
  onComplete?: (result: AcpRefreshResult) => void;
}

export interface AcpGatewayState {
  accounts: AccountRecord[];
  exits: ExitGroup[];
  cooldowns: CooldownRecord[];
  requests: RequestLog[];
  config: GatewayConfig | null;
  sseConnected: boolean;
  loading: boolean;
  error: string | null;
  refreshAll: (options?: AcpRefreshOptions) => Promise<void>;
}

export function useAcpGateway(enabled: boolean): AcpGatewayState {
  const [accounts, setAccounts] = useState<AccountRecord[]>([]);
  const [exits, setExits] = useState<ExitGroup[]>([]);
  const [cooldowns, setCooldowns] = useState<CooldownRecord[]>([]);
  const [requests, setRequests] = useState<RequestLog[]>([]);
  const [config, setConfig] = useState<GatewayConfig | null>(null);
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

  const refreshAll = useCallback(async (options?: AcpRefreshOptions) => {
    setLoading(true);
    setError(null);
    const results = await Promise.allSettled([
      fetchAccounts(),
      fetchAccountExits(),
      fetchCooldowns(),
      fetchRequests(),
      fetchConfig(),
    ]);

    if (!mountedRef.current) return;

    const [accRes, exitRes, cdRes, reqRes, cfgRes] = results;

    if (accRes.status === 'fulfilled') setAccounts(accRes.value);
    if (exitRes.status === 'fulfilled') setExits(exitRes.value);
    if (cdRes.status === 'fulfilled') setCooldowns(cdRes.value);
    if (reqRes.status === 'fulfilled') {
      setRequests(reqRes.value.slice(0, MAX_REQUESTS));
    }
    if (cfgRes.status === 'fulfilled') setConfig(cfgRes.value);

    const firstRejected = results.find(
      (r): r is PromiseRejectedResult => r.status === 'rejected'
    );
    if (firstRejected) {
      const reason = firstRejected.reason;
      const errMsg =
        reason instanceof Error ? reason.message : 'ACP 网关数据加载失败';
      setError(errMsg);
      setLoading(false);
      options?.onComplete?.({ ok: false, error: errMsg });
      return;
    }

    setLoading(false);
    options?.onComplete?.({ ok: true });
  }, []);

  useEffect(() => {
    if (!enabled) {
      setSseConnected(false);
      return;
    }

    let active = true;
    void refreshAll();

    const disconnect = connectGatewayEvents({
      onOpen: () => {
        if (active) setSseConnected(true);
      },
      onError: () => {
        if (active) setSseConnected(false);
      },
      onStatus: () => {
        if (active) setSseConnected(true);
      },
      onPing: () => {
        if (active) setSseConnected(true);
      },
      onAccounts: (data) => {
        if (!active) return;
        setSseConnected(true);
        setAccounts(data);
        void fetchAccountExits()
          .then((res) => {
            if (active) setExits(res);
          })
          .catch(() => {
            // ignore transient exit refresh failure
          });
      },
      onCooldowns: (data) => {
        if (!active) return;
        setSseConnected(true);
        setCooldowns(data);
      },
      onRequests: (data) => {
        if (!active) return;
        setSseConnected(true);
        setRequests(data.slice(0, MAX_REQUESTS));
      },
      onRequestStart: (data) => {
        if (!active) return;
        setSseConnected(true);
        setRequests((prev) => upsertRequestList(prev, data));
      },
      onRequestAttempt: (data) => {
        if (!active) return;
        setSseConnected(true);
        setRequests((prev) => mergeRequestAttemptList(prev, data));
      },
      onRequestFinish: (data) => {
        if (!active) return;
        setSseConnected(true);
        setRequests((prev) => upsertRequestList(prev, data));
      },
      onConfig: (data) => {
        if (!active) return;
        setSseConnected(true);
        setConfig(data);
      },
    });

    return () => {
      active = false;
      disconnect();
      setSseConnected(false);
    };
  }, [enabled, refreshAll]);

  return {
    accounts,
    exits,
    cooldowns,
    requests,
    config,
    sseConnected,
    loading,
    error,
    refreshAll,
  };
}
