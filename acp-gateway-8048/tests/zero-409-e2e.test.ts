import { describe, expect, it } from 'bun:test';
import { createApp } from '../src/server';
import type { SchedulerLike, WorkerHandle, WorkerPoolLike } from '../src/gemini/handler';
import type { AccountRecord, GeminiGenerateRequest, GeminiGenerateResponse } from '../src/types';

function makeAccount(id: string): AccountRecord {
  const now = Date.now();
  return {
    id,
    label: `Mock-${id}`,
    email: `${id}@example.com`,
    source: 'test',
    homeDir: '',
    proxyUrl: '',
    status: 'ready',
    statusReason: '',
    exitIp: '127.0.0.1',
    exitCountry: 'JP',
    concurrencyLimit: 4,
    activeWorkers: 0,
    lastVerifiedAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

describe('zero-409 end-to-end multi-turn tool calling & branch rewind', () => {
  it('handles 4 consecutive tool-calling turns + branched history without 409 and rebuilds stale workers', async () => {
    const account = makeAccount('acc-e2e');
    const scheduler: SchedulerLike = {
      selectAccount: () => ({ account }),
    };

    // Track worker lifecycle per sessionHash + prefix length to verify rebuild on branch/rewind
    let workerSeq = 0;
    let disposedCount = 0;
    const activeWorkers = new Map<string, { id: string; lastHistoryLen: number }>();

    const workerPool: WorkerPoolLike = {
      async acquire({ sessionHash, request }) {
        const existing = activeWorkers.get(sessionHash);
        const historyLen = request.contents.length;

        // If history was truncated/rewound (branched), dispose old worker and spawn a fresh one
        if (existing && historyLen <= existing.lastHistoryLen) {
          disposedCount += 1;
          activeWorkers.delete(sessionHash);
        }

        let entry = activeWorkers.get(sessionHash);
        if (!entry) {
          entry = { id: `worker-${++workerSeq}`, lastHistoryLen: 0 };
          activeWorkers.set(sessionHash, entry);
        }
        entry.lastHistoryLen = historyLen;

        const handle: WorkerHandle = {
          id: entry.id,
          accountId: account.id,
          async generate({ request: req, stream, onChunk }) {
            const turn = req.contents.length;
            const resp: GeminiGenerateResponse = {
              candidates: [
                {
                  index: 0,
                  content: {
                    role: 'model',
                    parts: [
                      { thought: true, thoughtSignature: `sig_turn_${turn}`, text: `Reasoning turn ${turn}` },
                      turn < 7
                        ? { functionCall: { name: 'lookup_data', args: { step: turn } } }
                        : { text: `Final answer at turn ${turn}` },
                    ],
                  },
                  finishReason: 'STOP',
                },
              ],
              usageMetadata: {
                promptTokenCount: 100 * turn,
                candidatesTokenCount: 25,
                totalTokenCount: 100 * turn + 25,
              },
            };

            if (stream && onChunk) {
              onChunk(resp);
            }
            return resp;
          },
        };
        return handle;
      },
      release() {},
    };

    const app = createApp({ geminiDeps: { scheduler, workerPool } });
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: app.fetch });
    const baseUrl = `http://127.0.0.1:${server.port}`;

    try {
      const contents: GeminiGenerateRequest['contents'] = [
        { role: 'user', parts: [{ text: 'Start 4-turn tool workflow' }] },
      ];

      // 4 consecutive turns with functionCall / functionResponse
      for (let turn = 1; turn <= 4; turn++) {
        const isStream = turn % 2 === 0;
        const endpoint = isStream
          ? `${baseUrl}/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse`
          : `${baseUrl}/v1beta/models/gemini-2.5-flash:generateContent`;

        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: 'Zero 409 test' }] },
            contents,
          }),
        });

        expect(res.status).toBe(200);

        let data: GeminiGenerateResponse;
        if (isStream) {
          const text = await res.text();
          const dataLine = text.split('\n').find((l) => l.startsWith('data: '));
          expect(dataLine).toBeDefined();
          data = JSON.parse(dataLine!.slice(6));
        } else {
          data = (await res.json()) as GeminiGenerateResponse;
        }

        const parts = data.candidates?.[0]?.content?.parts ?? [];
        expect(parts[0]?.thought).toBe(true);
        expect(parts[0]?.thoughtSignature).toBeDefined();

        // Append model functionCall + user functionResponse for next turn
        const fc = parts.find((p) => p.functionCall)?.functionCall;
        if (fc) {
          contents.push({ role: 'model', parts });
          contents.push({
            role: 'user',
            parts: [{ functionResponse: { name: fc.name, response: { ok: true, turn } } }],
          });
        }
      }

      // Now send a branched/rewound request (shorter history, modified prefix)
      const branchRes = await fetch(`${baseUrl}/v1beta/models/gemini-2.5-flash:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: 'Zero 409 test' }] },
          contents: [{ role: 'user', parts: [{ text: 'Start 4-turn tool workflow' }] }],
        }),
      });

      expect(branchRes.status).toBe(200);
      expect(disposedCount).toBe(1);
      expect(workerSeq).toBe(2);
    } finally {
      server.stop(true);
    }
  });
});
