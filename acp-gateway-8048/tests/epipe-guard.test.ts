import { describe, expect, it } from 'bun:test';
import { AcpConnection } from '../src/acp/connection';
import { installProcessErrorGuards, isBenignPipeError } from '../src/server';

type MockProc = {
  exitCode: number | null;
  killed: boolean;
  stdin: {
    write: (chunk: string) => unknown;
    end: () => unknown;
  };
  kill: () => void;
};

function makeConnWithMockProc(proc: MockProc): AcpConnection {
  const conn = new AcpConnection({
    binaryPath: 'mock-bin',
    args: [],
    cwd: process.cwd(),
    env: {},
  });
  (conn as unknown as { proc: MockProc }).proc = proc;
  return conn;
}

function getPendingMap(conn: AcpConnection): Map<number, unknown> {
  return (conn as unknown as { pending: Map<number, unknown> }).pending;
}

describe('isBenignPipeError', () => {
  it('returns true for EPIPE code, errno -32, or broken pipe message', () => {
    const withCode = Object.assign(new Error('write failed'), { code: 'EPIPE' });
    const withErrno = Object.assign(new Error('write failed'), { errno: -32 });
    const withBrokenPipeMsg = new Error('stream write: Broken pipe');
    const withEpipeMsg = new Error('EOF / EPIPE while writing to stdin');

    expect(isBenignPipeError(withCode)).toBe(true);
    expect(isBenignPipeError(withErrno)).toBe(true);
    expect(isBenignPipeError(withBrokenPipeMsg)).toBe(true);
    expect(isBenignPipeError(withEpipeMsg)).toBe(true);
  });

  it('returns false for ordinary errors, TypeError, null, and undefined', () => {
    expect(isBenignPipeError(new Error('ordinary failure'))).toBe(false);
    expect(isBenignPipeError(new TypeError('cannot read property'))).toBe(false);
    expect(isBenignPipeError(null)).toBe(false);
    expect(isBenignPipeError(undefined)).toBe(false);
  });
});

describe('AcpConnection EPIPE and dead-process guards', () => {
  it('treats exited or killed subprocess as not alive and fails request fast without dangling pending', async () => {
    let writeCalls = 0;
    const exitedProc: MockProc = {
      exitCode: 1,
      killed: false,
      stdin: {
        write: () => {
          writeCalls += 1;
          return 0;
        },
        end: () => {},
      },
      kill: () => {},
    };

    const connExited = makeConnWithMockProc(exitedProc);
    expect(connExited.isAlive).toBe(false);
    await expect(connExited.request('session/prompt', {}, 30_000)).rejects.toThrow(
      'ACP process is not alive',
    );
    expect(getPendingMap(connExited).size).toBe(0);
    expect(() => connExited.notify('session/cancel')).not.toThrow();
    expect(() =>
      (connExited as unknown as { sendResponse: (id: number, res: unknown) => void }).sendResponse(
        1,
        { ok: true },
      ),
    ).not.toThrow();
    expect(() =>
      (
        connExited as unknown as {
          sendErrorResponse: (id: number, code: number, msg: string) => void;
        }
      ).sendErrorResponse(2, -32601, 'Method not found'),
    ).not.toThrow();
    expect(writeCalls).toBe(0);

    const killedProc: MockProc = {
      exitCode: null,
      killed: true,
      stdin: {
        write: () => {
          writeCalls += 1;
          return 0;
        },
        end: () => {},
      },
      kill: () => {},
    };

    const connKilled = makeConnWithMockProc(killedProc);
    expect(connKilled.isAlive).toBe(false);
    await expect(connKilled.request('session/prompt', {}, 30_000)).rejects.toThrow(
      'ACP process is not alive',
    );
    expect(getPendingMap(connKilled).size).toBe(0);
    expect(writeCalls).toBe(0);
  });

  it('handles synchronous EPIPE thrown by stdin.write across request/notify/response', async () => {
    const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE', errno: -32 });
    const proc: MockProc = {
      exitCode: null,
      killed: false,
      stdin: {
        write: () => {
          throw epipe;
        },
        end: () => {},
      },
      kill: () => {},
    };

    const conn = makeConnWithMockProc(proc);
    expect(conn.isAlive).toBe(true);

    await expect(conn.request('session/prompt', {}, 30_000)).rejects.toThrow('write EPIPE');
    expect(getPendingMap(conn).size).toBe(0);

    expect(() => conn.notify('session/cancel')).not.toThrow();
    expect(() =>
      (conn as unknown as { sendResponse: (id: number, res: unknown) => void }).sendResponse(
        1,
        { ok: true },
      ),
    ).not.toThrow();
    expect(() =>
      (
        conn as unknown as {
          sendErrorResponse: (id: number, code: number, msg: string) => void;
        }
      ).sendErrorResponse(2, -32601, 'Method not found'),
    ).not.toThrow();
  });

  it('catches asynchronous EPIPE rejection returned by stdin.write without escaping', async () => {
    const epipe = Object.assign(new Error('async write EPIPE'), { code: 'EPIPE', errno: -32 });
    const proc: MockProc = {
      exitCode: null,
      killed: false,
      stdin: {
        write: () => Promise.reject(epipe),
        end: () => Promise.reject(epipe),
      },
      kill: () => {},
    };

    const conn = makeConnWithMockProc(proc);

    await expect(conn.request('session/prompt', {}, 30_000)).rejects.toThrow('async write EPIPE');
    expect(getPendingMap(conn).size).toBe(0);

    expect(() => conn.notify('session/cancel')).not.toThrow();
    expect(() =>
      (conn as unknown as { sendResponse: (id: number, res: unknown) => void }).sendResponse(
        1,
        { ok: true },
      ),
    ).not.toThrow();
    expect(() =>
      (
        conn as unknown as {
          sendErrorResponse: (id: number, code: number, msg: string) => void;
        }
      ).sendErrorResponse(2, -32601, 'Method not found'),
    ).not.toThrow();

    await expect(conn.close()).resolves.toBeUndefined();
    await new Promise((r) => setTimeout(r, 10));
  });
});

describe('installProcessErrorGuards', () => {
  it('is idempotent when called multiple times', () => {
    const beforeUncaught = process.listenerCount('uncaughtException');
    const beforeUnhandled = process.listenerCount('unhandledRejection');

    installProcessErrorGuards();
    installProcessErrorGuards();

    expect(process.listenerCount('uncaughtException')).toBe(beforeUncaught + 1);
    expect(process.listenerCount('unhandledRejection')).toBe(beforeUnhandled + 1);
  });
});
