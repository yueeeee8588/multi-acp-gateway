import { getConfig, getPublicConfig } from '../config/settings';
import { store } from '../db/store';
import type { AccountRecord, RequestAttempt, RequestLog, SseEventPayload, SseEventType } from '../types';

const encoder = new TextEncoder();

function getMaxLogsRetained(): number {
  const raw = getConfig().maxLogsRetained;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 1) {
    return Math.floor(raw);
  }
  return 500;
}

export class EventBus {
  private subscribers = new Set<ReadableStreamDefaultController<Uint8Array>>();
  private recentRequests = new Map<string, RequestLog>();
  private initialized = false;
  private activeCountProvider?: (accountId: string) => number;

  setActiveCountProvider(provider?: (accountId: string) => number): void {
    this.activeCountProvider = provider;
  }

  private enrichAccounts(accounts: AccountRecord[]): AccountRecord[] {
    const getActiveCount = this.activeCountProvider;
    if (!getActiveCount) return accounts;
    return accounts.map((account) => ({
      ...account,
      activeWorkers: getActiveCount(account.id),
    }));
  }

  private ensureInitialized(): void {
    if (this.initialized) return;
    this.initialized = true;
    const limit = getMaxLogsRetained();
    const rows = store.getRecentRequestLogs(limit);
    // Insert oldest-first so Map iteration order is chronological, or keep newest-first
    for (const row of rows.reverse()) {
      this.recentRequests.set(row.id, row);
    }
  }

  subscribe(controller: ReadableStreamDefaultController<Uint8Array>): void {
    this.ensureInitialized();
    this.subscribers.add(controller);
    this.sendSnapshot(controller);
  }

  unsubscribe(controller: ReadableStreamDefaultController<Uint8Array>): void {
    this.subscribers.delete(controller);
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  private formatSse(payload: SseEventPayload): Uint8Array {
    const line = `event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`;
    return encoder.encode(line);
  }

  private sendTo(
    controller: ReadableStreamDefaultController<Uint8Array>,
    type: SseEventType,
    data: unknown
  ): boolean {
    try {
      const bytes = this.formatSse({
        type,
        data,
        timestamp: Date.now(),
      });
      controller.enqueue(bytes);
      return true;
    } catch {
      this.subscribers.delete(controller);
      return false;
    }
  }

  emit(type: SseEventType, data: unknown): void {
    if (this.subscribers.size === 0) return;
    const payloadData =
      type === 'accounts' && Array.isArray(data)
        ? this.enrichAccounts(data as AccountRecord[])
        : data;
    const bytes = this.formatSse({
      type,
      data: payloadData,
      timestamp: Date.now(),
    });
    for (const controller of this.subscribers) {
      try {
        controller.enqueue(bytes);
      } catch {
        this.subscribers.delete(controller);
      }
    }
  }

  sendSnapshot(controller: ReadableStreamDefaultController<Uint8Array>): void {
    const now = Date.now();
    const accounts = this.enrichAccounts(store.listAccounts());
    const cooldowns = store.listCooldowns(now);
    const requests = this.getRecentRequests(100);
    const config = getPublicConfig();

    this.sendTo(controller, 'status', {
      ok: true,
      uptimeMs: Math.floor(process.uptime() * 1000),
      subscribers: this.subscribers.size,
      timestamp: now,
    });
    this.sendTo(controller, 'accounts', accounts);
    this.sendTo(controller, 'cooldowns', cooldowns);
    this.sendTo(controller, 'requests', requests);
    this.sendTo(controller, 'config', config);
  }

  startRequest(
    input: Omit<RequestLog, 'attempts' | 'switchCount' | 'state'> &
      Partial<Pick<RequestLog, 'attempts' | 'switchCount' | 'state'>>
  ): RequestLog {
    this.ensureInitialized();
    const log: RequestLog = {
      ...input,
      state: input.state ?? 'running',
      switchCount: input.switchCount ?? 0,
      attempts: input.attempts ?? [],
    };
    this.recentRequests.set(log.id, log);
    this.trimMemoryCache();
    store.upsertRequestLog(log);
    this.emit('request:start', log);
    return log;
  }

  recordAttempt(requestId: string, attempt: RequestAttempt): RequestLog | null {
    this.ensureInitialized();
    const log = this.recentRequests.get(requestId);
    if (!log) return null;

    const existingIdx = log.attempts.findIndex((a) => a.index === attempt.index);
    if (existingIdx >= 0) {
      log.attempts[existingIdx] = attempt;
    } else {
      log.attempts.push(attempt);
    }
    log.switchCount = Math.max(0, log.attempts.length - 1);

    store.upsertRequestLog(log);
    this.emit('request:attempt', { requestId, attempt, switchCount: log.switchCount });
    return log;
  }

  finishRequest(
    requestId: string,
    update: {
      state: RequestLog['state'];
      httpStatus?: number;
      durationMs?: number;
      inputTokens?: number;
      outputTokens?: number;
      cacheHit?: boolean;
      cachedTokens?: number;
    }
  ): RequestLog | null {
    this.ensureInitialized();
    const log = this.recentRequests.get(requestId);
    if (!log) return null;

    log.state = update.state;
    if (update.httpStatus !== undefined) log.httpStatus = update.httpStatus;
    log.durationMs = update.durationMs ?? Date.now() - log.startedAt;
    if (update.inputTokens !== undefined) log.inputTokens = update.inputTokens;
    if (update.outputTokens !== undefined) log.outputTokens = update.outputTokens;
    if (update.cacheHit !== undefined) log.cacheHit = update.cacheHit;
    if (update.cachedTokens !== undefined) log.cachedTokens = update.cachedTokens;

    store.upsertRequestLog(log);
    store.pruneOldRequestLogs(getMaxLogsRetained());
    this.emit('request:finish', log);
    return log;
  }

  getRecentRequests(limit = 100): RequestLog[] {
    this.ensureInitialized();
    const safeLimit =
      typeof limit === 'number' && Number.isFinite(limit) && limit >= 1
        ? Math.min(Math.floor(limit), 10_000)
        : 100;
    const all = Array.from(this.recentRequests.values());
    all.sort((a, b) => b.startedAt - a.startedAt);
    return all.slice(0, safeLimit);
  }

  private trimMemoryCache(): void {
    const max = getMaxLogsRetained();
    while (this.recentRequests.size > max) {
      const oldestKey = this.recentRequests.keys().next().value;
      if (!oldestKey) break;
      this.recentRequests.delete(oldestKey);
    }
  }
}

export const eventBus = new EventBus();
