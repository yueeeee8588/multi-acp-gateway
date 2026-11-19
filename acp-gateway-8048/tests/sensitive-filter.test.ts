import { describe, expect, it } from 'bun:test';
import { LoopbackMcpServer } from '../src/acp/loopback-mcp';
import {
  applySensitiveFilterToContents,
  applySensitiveFilterToText,
  applySensitiveFilterToTools,
  computeSensitiveFilterFingerprint,
  filterTextWithSensitiveRules,
} from '../src/acp/sensitive-filter';
import { AgySessionWorker, type AcpTransport } from '../src/acp/worker';
import { getConfig, invalidateConfigCache, updateConfig } from '../src/config/settings';
import { store } from '../src/db/store';
import { createApp } from '../src/server';
import type {
  AccountRecord,
  GatewayConfig,
  GeminiContent,
  GeminiFunctionDeclaration,
  SensitiveWordRule,
} from '../src/types';

function makeAccount(id = 'sensitive-filter-acc'): AccountRecord {
  const now = Date.now();
  return {
    id,
    label: id,
    email: `${id}@example.com`,
    source: 'test',
    homeDir: 'unused',
    proxyUrl: '',
    status: 'ready',
    statusReason: '',
    tier: 'standard',
    exitIp: '127.0.0.1',
    exitCountry: 'JP',
    concurrencyLimit: 2,
    activeWorkers: 0,
    lastVerifiedAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

describe('sensitive-filter engine', () => {
  it('passes text, contents, and tools through unchanged when disabled or rules empty', () => {
    const rules: SensitiveWordRule[] = [
      { pattern: 'SecretWord', replace: '[MASKED]', case_insensitive: false, enabled: true },
    ];
    const contents: GeminiContent[] = [
      { role: 'user', parts: [{ text: 'SecretWord in message' }] },
    ];
    const tools: GeminiFunctionDeclaration[] = [
      {
        name: 'my_tool',
        description: 'Uses SecretWord internally',
        parameters: { type: 'object', properties: { q: { type: 'string' } } },
      },
    ];

    expect(applySensitiveFilterToText('SecretWord', { sensitiveFilterEnabled: false, sensitiveWords: rules })).toBe('SecretWord');
    expect(applySensitiveFilterToText('SecretWord', { sensitiveFilterEnabled: true, sensitiveWords: [] })).toBe('SecretWord');
    expect(applySensitiveFilterToContents(contents, { sensitiveFilterEnabled: false, sensitiveWords: rules })).toBe(contents);
    expect(applySensitiveFilterToTools(tools, { sensitiveFilterEnabled: false, sensitiveWords: rules })).toBe(tools);
  });

  it('skips disabled rules and respects case sensitivity', () => {
    const rules: SensitiveWordRule[] = [
      { pattern: 'Alpha', replace: 'A', case_insensitive: false, enabled: false },
      { pattern: 'Beta', replace: 'B', case_insensitive: false, enabled: true },
      { pattern: 'Gamma', replace: 'G', case_insensitive: true, enabled: true },
    ];

    const input = 'Alpha alpha Beta beta Gamma gAmMa GAMMA';
    expect(filterTextWithSensitiveRules(input, rules)).toBe(
      'Alpha alpha B beta G G G',
    );
  });

  it('supports deletion when replace is empty string and chained multi-rule replacement', () => {
    const rules: SensitiveWordRule[] = [
      { pattern: 'token_secret', replace: 'REDACTED', case_insensitive: false, enabled: true },
      { pattern: 'REDACTED', replace: 'SAFE', case_insensitive: false, enabled: true },
      { pattern: '[DROP]', replace: '', case_insensitive: false, enabled: true },
    ];

    expect(filterTextWithSensitiveRules('key=token_secret [DROP]!', rules)).toBe(
      'key=SAFE !',
    );
  });

  it('escapes regex metacharacters and treats $& / $1 in replacement literally', () => {
    const rules: SensitiveWordRule[] = [
      {
        pattern: 'a.*+?()[]$',
        replace: '$&-$1-$$',
        case_insensitive: true,
        enabled: true,
      },
      {
        pattern: 'Literal.Key',
        replace: '$&',
        case_insensitive: false,
        enabled: true,
      },
    ];

    expect(
      filterTextWithSensitiveRules('prefix A.*+?()[]$ suffix Literal.Key end', rules),
    ).toBe('prefix $&-$1-$$ suffix $& end');
  });

  it('filters multi-role contents text parts without mutating input or non-text parts', () => {
    const inlineData = { mimeType: 'image/png', data: 'base64-data-SecretWord' };
    const functionCall = { id: 'call_1', name: 'SecretWordTool', args: { key: 'SecretWord' } };
    const functionResponse = {
      id: 'call_1',
      name: 'SecretWordTool',
      response: { raw: 'SecretWord' },
    };

    const contents: GeminiContent[] = [
      {
        role: 'user',
        parts: [{ text: 'Hello SecretWord' }, { inlineData }],
      },
      {
        role: 'model',
        parts: [{ functionCall }, { text: 'Calling with SecretWord' }],
      },
      {
        role: 'function',
        parts: [{ functionResponse }],
      },
    ];

    const filtered = applySensitiveFilterToContents(contents, {
      sensitiveFilterEnabled: true,
      sensitiveWords: [
        { pattern: 'SecretWord', replace: 'CleanWord', case_insensitive: false, enabled: true },
      ],
    });

    expect(filtered).not.toBe(contents);
    expect(filtered[0].parts[0].text).toBe('Hello CleanWord');
    expect(filtered[0].parts[1].inlineData).toEqual(inlineData);
    expect(filtered[1].parts[0].functionCall).toEqual(functionCall);
    expect(filtered[1].parts[1].text).toBe('Calling with CleanWord');
    expect(filtered[2].parts[0].functionResponse).toEqual(functionResponse);
    // Original object remains untouched
    expect(contents[0].parts[0].text).toBe('Hello SecretWord');
    expect(contents[1].parts[1].text).toBe('Calling with SecretWord');
  });

  it('filters tools[].description while strictly preserving name and parameters/parametersJsonSchema', () => {
    const params = {
      type: 'object',
      properties: {
        SecretWord: { type: 'string', description: 'keep schema untouched' },
      },
      required: ['SecretWord'],
    };
    const tools = [
      {
        name: 'SecretWord_exec',
        description: 'Execute SecretWord action safely',
        parameters: params,
        parametersJsonSchema: params,
      },
    ];

    const filtered = applySensitiveFilterToTools(tools, {
      sensitiveFilterEnabled: true,
      sensitiveWords: [
        { pattern: 'SecretWord', replace: 'SafeWord', case_insensitive: false, enabled: true },
      ],
    });

    expect(filtered[0].name).toBe('SecretWord_exec');
    expect(filtered[0].description).toBe('Execute SafeWord action safely');
    expect(filtered[0].parameters).toBe(params);
    expect(filtered[0].parametersJsonSchema).toBe(params);
    expect(tools[0].description).toBe('Execute SecretWord action safely');
  });

  it('supports * wildcard matching at start/middle/end without crossing line boundaries', () => {
    const rules: SensitiveWordRule[] = [
      {
        pattern: 'You are an AI agent running in OpenCode*',
        replace: 'You are a helpful assistant',
        case_insensitive: false,
        enabled: true,
      },
      {
        pattern: '*WorkBuddy*',
        replace: '[REMOVED_WB]',
        case_insensitive: true,
        enabled: true,
      },
      {
        pattern: '**the codex cli is an open***source project*',
        replace: '$&-$1-codex-masked',
        case_insensitive: true,
        enabled: true,
      },
    ];

    const input = [
      'You are an AI agent running in OpenCode v1.2.3 on Windows.',
      'Keep this second line intact.',
      'Prefix text workbuddy suffix text',
      'Another intact line.',
      'Intro: The Codex CLI is an open-source project maintained by community.',
      'Final intact line.',
    ].join('\n');

    expect(filterTextWithSensitiveRules(input, rules)).toBe(
      [
        'You are a helpful assistant',
        'Keep this second line intact.',
        '[REMOVED_WB]',
        'Another intact line.',
        '$&-$1-codex-masked',
        'Final intact line.',
      ].join('\n'),
    );
  });

  it('skips pure * wildcard rules safely without wiping lines', () => {
    const rules: SensitiveWordRule[] = [
      { pattern: '*', replace: '', case_insensitive: false, enabled: true },
      { pattern: '***', replace: '[WIPED]', case_insensitive: true, enabled: true },
      { pattern: ' * * ', replace: '[WIPED]', case_insensitive: false, enabled: true },
    ];

    const input = 'Line 1\nLine 2';
    expect(filterTextWithSensitiveRules(input, rules)).toBe(input);
  });

  it('isolates rules by scope (all, system, messages, tools) and reflects scope in fingerprint', () => {
    const rules: SensitiveWordRule[] = [
      {
        pattern: 'GlobalTerm',
        replace: 'SAFE_ALL',
        case_insensitive: false,
        enabled: true,
        scope: 'all',
      },
      {
        pattern: 'SystemOnly',
        replace: 'SAFE_SYS',
        case_insensitive: false,
        enabled: true,
        scope: 'system',
      },
      {
        pattern: 'MsgOnly',
        replace: 'SAFE_MSG',
        case_insensitive: false,
        enabled: true,
        scope: 'messages',
      },
      {
        pattern: 'ToolOnly',
        replace: 'SAFE_TOOL',
        case_insensitive: false,
        enabled: true,
        scope: 'tools',
      },
    ];
    const config = { sensitiveFilterEnabled: true, sensitiveWords: rules };

    const sample = 'GlobalTerm SystemOnly MsgOnly ToolOnly';
    expect(applySensitiveFilterToText(sample, config)).toBe(
      'SAFE_ALL SAFE_SYS MsgOnly ToolOnly',
    );
    expect(applySensitiveFilterToText(sample, config, 'system')).toBe(
      'SAFE_ALL SAFE_SYS MsgOnly ToolOnly',
    );

    const contents: GeminiContent[] = [{ role: 'user', parts: [{ text: sample }] }];
    expect(applySensitiveFilterToContents(contents, config)[0].parts[0].text).toBe(
      'SAFE_ALL SystemOnly SAFE_MSG ToolOnly',
    );

    const tools: GeminiFunctionDeclaration[] = [{ name: 't', description: sample }];
    expect(applySensitiveFilterToTools(tools, config)[0].description).toBe(
      'SAFE_ALL SystemOnly MsgOnly SAFE_TOOL',
    );

    const fpTools = computeSensitiveFilterFingerprint({
      sensitiveFilterEnabled: true,
      sensitiveWords: [
        { pattern: 'Foo', replace: 'Bar', case_insensitive: false, enabled: true, scope: 'tools' },
      ],
    });
    const fpSystem = computeSensitiveFilterFingerprint({
      sensitiveFilterEnabled: true,
      sensitiveWords: [
        { pattern: 'Foo', replace: 'Bar', case_insensitive: false, enabled: true, scope: 'system' },
      ],
    });
    const fpAll = computeSensitiveFilterFingerprint({
      sensitiveFilterEnabled: true,
      sensitiveWords: [
        { pattern: 'Foo', replace: 'Bar', case_insensitive: false, enabled: true },
      ],
    });
    const fpExplicitAll = computeSensitiveFilterFingerprint({
      sensitiveFilterEnabled: true,
      sensitiveWords: [
        { pattern: 'Foo', replace: 'Bar', case_insensitive: false, enabled: true, scope: 'all' },
      ],
    });
    expect(fpTools).not.toBe(fpSystem);
    expect(fpAll).toBe(fpExplicitAll);
  });
});

describe('sensitive-filter config persistence & worker pipeline integration', () => {
  it('persists sensitiveFilterEnabled and normalizes sensitiveWords (dropping empty patterns)', () => {
    const previous = store.getConfigValue<Partial<GatewayConfig>>('gateway_config');
    try {
      const updated = updateConfig({
        sensitiveFilterEnabled: true,
        sensitiveWords: [
          { pattern: '   ', replace: 'x', case_insensitive: false, enabled: true },
          { pattern: '', replace: 'y', case_insensitive: true, enabled: true },
          { pattern: 'BannedTerm', replace: 'AllowedTerm', case_insensitive: true, enabled: true },
          { pattern: 'DisabledTerm', replace: '', case_insensitive: false, enabled: false },
        ],
      });

      expect(updated.sensitiveFilterEnabled).toBe(true);
      expect(updated.sensitiveWords).toEqual([
        { pattern: 'BannedTerm', replace: 'AllowedTerm', case_insensitive: true, enabled: true, scope: 'all' },
        { pattern: 'DisabledTerm', replace: '', case_insensitive: false, enabled: false, scope: 'all' },
      ]);

      invalidateConfigCache();
      const reloaded = getConfig();
      expect(reloaded.sensitiveFilterEnabled).toBe(true);
      expect(reloaded.sensitiveWords).toEqual(updated.sensitiveWords);
    } finally {
      store.setConfigValue('gateway_config', previous);
      invalidateConfigCache();
    }
  });

  it('applies hot-updated sensitive rules in AgySessionWorker across systemPrompt, tools, and contents', async () => {
    const previous = store.getConfigValue<Partial<GatewayConfig>>('gateway_config');
    const mcpServer = new LoopbackMcpServer();
    await mcpServer.start();

    const capturedSessions: Array<Record<string, unknown>> = [];
    const capturedPrompts: Array<Array<Record<string, unknown>>> = [];
    let sessionSeq = 0;

    const worker = new AgySessionWorker({
      account: makeAccount('worker-sensitive-test'),
      model: 'gemini-4-hydrogen-medium',
      workspaceDir: 'unused',
      mcpServer,
      transportFactory: ({ onUpdate }): AcpTransport => ({
        initialize: async () => ({ ok: true }),
        newSession: async (params) => {
          sessionSeq += 1;
          capturedSessions.push(params);
          return { sessionId: `sess-sensitive-${sessionSeq}` };
        },
        setModel: async () => ({}),
        prompt: async (params) => {
          capturedPrompts.push(params.prompt as Array<Record<string, unknown>>);
          onUpdate({
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'ok' },
            },
          });
          return { stopReason: 'end_turn' };
        },
        close: async () => {},
        isAlive: () => true,
      }),
    });

    const req = {
      systemInstruction: { parts: [{ text: 'System uses SecretCode here.' }] },
      tools: [
        {
          functionDeclarations: [
            {
              name: 'run_task',
              description: 'Tool handles SecretCode payload',
              parameters: {
                type: 'object',
                properties: { SecretCode: { type: 'string' } },
              },
            },
          ],
        },
      ],
      contents: [{ role: 'user', parts: [{ text: 'User sent SecretCode!' }] }],
    };

    try {
      updateConfig({
        sensitiveFilterEnabled: true,
        sensitiveWords: [
          { pattern: 'SecretCode', replace: 'PublicToken', case_insensitive: false, enabled: true },
        ],
      });

      await worker.executePrompt(req);

      expect(capturedSessions.length).toBe(1);
      const meta = capturedSessions[0]._meta as {
        antigravity?: { systemPrompt?: { append?: string } };
      };
      expect(meta?.antigravity?.systemPrompt?.append).toContain('PublicToken');
      expect(meta?.antigravity?.systemPrompt?.append).not.toContain('SecretCode');

      const promptText = capturedPrompts[0]
        .map((b) => (typeof b.text === 'string' ? b.text : ''))
        .join('\n');
      expect(promptText).toContain('PublicToken');
      expect(promptText).not.toContain('SecretCode');

      // Hot-update rules and verify session reuse hash invalidates cleanly
      updateConfig({
        sensitiveFilterEnabled: true,
        sensitiveWords: [
          { pattern: 'SecretCode', replace: 'NewToken', case_insensitive: false, enabled: true },
        ],
      });

      expect(
        worker.canReuse({
          ...req,
          contents: [
            ...req.contents,
            { role: 'model', parts: [{ text: 'ok' }] },
            { role: 'user', parts: [{ text: 'Second turn SecretCode' }] },
          ],
        }),
      ).toBe(false);
    } finally {
      await worker.resetAndClose();
      await mcpServer.stop();
      store.setConfigValue('gateway_config', previous);
      invalidateConfigCache();
    }
  });

  it('rejects invalid sensitiveFilterEnabled and sensitiveWords payloads in PUT /api/config without mutating stored config', async () => {
    const previous = store.getConfigValue<Partial<GatewayConfig>>('gateway_config');
    const app = createApp();
    try {
      const baselineRules: SensitiveWordRule[] = [
        { pattern: 'KeepMe', replace: 'Safe', case_insensitive: false, enabled: true, scope: 'all' },
      ];
      updateConfig({
        sensitiveFilterEnabled: false,
        sensitiveWords: baselineRules,
      });

      const invalidPayloads: unknown[] = [
        { sensitiveFilterEnabled: 'true' },
        { sensitiveWords: 'not-an-array' },
        {
          sensitiveWords: [
            { pattern: 'x', replace: 'y', case_insensitive: 'false', enabled: true },
          ],
        },
        {
          sensitiveWords: [
            { pattern: 'x', replace: 123, case_insensitive: false, enabled: true },
          ],
        },
        {
          sensitiveWords: [
            { pattern: 'x', replace: 'y', case_insensitive: false, enabled: true, scope: 'invalid_scope' },
          ],
        },
        {
          sensitiveWords: [
            { pattern: 'x', replace: 'y', case_insensitive: false, enabled: true, scope: 123 },
          ],
        },
      ];

      for (const payload of invalidPayloads) {
        const res = await app.fetch(
          new Request('http://127.0.0.1:8048/api/config', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          }),
        );
        expect(res.status).toBe(400);
        const current = getConfig();
        expect(current.sensitiveFilterEnabled).toBe(false);
        expect(current.sensitiveWords).toEqual(baselineRules);
      }
    } finally {
      store.setConfigValue('gateway_config', previous);
      invalidateConfigCache();
    }
  });

  it('invalidates session reuse when hot-updated rule only affects contents (not systemInstruction or tools)', async () => {
    const previous = store.getConfigValue<Partial<GatewayConfig>>('gateway_config');
    const mcpServer = new LoopbackMcpServer();
    await mcpServer.start();
    let sessionSeq = 0;

    const worker = new AgySessionWorker({
      account: makeAccount('worker-contents-only-fp'),
      model: 'gemini-4-hydrogen-medium',
      workspaceDir: 'unused',
      mcpServer,
      transportFactory: ({ onUpdate }): AcpTransport => ({
        initialize: async () => ({ ok: true }),
        newSession: async () => {
          sessionSeq += 1;
          return { sessionId: `sess-fp-${sessionSeq}` };
        },
        setModel: async () => ({}),
        prompt: async (params) => {
          onUpdate({
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'ok' },
            },
          });
          return { stopReason: 'end_turn' };
        },
        close: async () => {},
        isAlive: () => true,
      }),
    });

    const req = {
      systemInstruction: { parts: [{ text: 'Plain system prompt without keywords.' }] },
      contents: [{ role: 'user', parts: [{ text: 'Hello OnlyInContents' }] }],
    };

    try {
      updateConfig({
        sensitiveFilterEnabled: true,
        sensitiveWords: [
          { pattern: 'OnlyInContents', replace: 'MaskedV1', case_insensitive: false, enabled: true },
        ],
      });

      await worker.executePrompt(req);
      expect(sessionSeq).toBe(1);

      updateConfig({
        sensitiveFilterEnabled: true,
        sensitiveWords: [
          { pattern: 'OnlyInContents', replace: 'MaskedV2', case_insensitive: false, enabled: true },
        ],
      });

      const nextReq = {
        ...req,
        contents: [
          ...req.contents,
          { role: 'model', parts: [{ text: 'ok' }] },
          { role: 'user', parts: [{ text: 'Turn 2 OnlyInContents' }] },
        ],
      };
      expect(worker.canReuse(nextReq)).toBe(false);

      await worker.executePrompt(nextReq);
      expect(sessionSeq).toBe(2);
    } finally {
      await worker.resetAndClose();
      await mcpServer.stop();
      store.setConfigValue('gateway_config', previous);
      invalidateConfigCache();
    }
  });

  it('treats sensitiveFilterEnabled=true with all disabled rules as empty fingerprint without breaking session reuse', async () => {
    const previous = store.getConfigValue<Partial<GatewayConfig>>('gateway_config');
    const mcpServer = new LoopbackMcpServer();
    await mcpServer.start();
    let sessionSeq = 0;

    expect(
      computeSensitiveFilterFingerprint({
        sensitiveFilterEnabled: true,
        sensitiveWords: [
          { pattern: 'Foo', replace: 'Bar', case_insensitive: false, enabled: false },
        ],
      }),
    ).toBe('');

    const worker = new AgySessionWorker({
      account: makeAccount('worker-disabled-rules-fp'),
      model: 'gemini-4-hydrogen-medium',
      workspaceDir: 'unused',
      mcpServer,
      transportFactory: ({ onUpdate }): AcpTransport => ({
        initialize: async () => ({ ok: true }),
        newSession: async () => {
          sessionSeq += 1;
          return { sessionId: `sess-disabled-${sessionSeq}` };
        },
        setModel: async () => ({}),
        prompt: async (params) => {
          onUpdate({
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'ok' },
            },
          });
          return { stopReason: 'end_turn' };
        },
        close: async () => {},
        isAlive: () => true,
      }),
    });

    const req = {
      systemInstruction: { parts: [{ text: 'System prompt' }] },
      contents: [{ role: 'user', parts: [{ text: 'Turn 1' }] }],
    };

    try {
      updateConfig({
        sensitiveFilterEnabled: false,
        sensitiveWords: [],
      });
      await worker.executePrompt(req);
      expect(sessionSeq).toBe(1);

      updateConfig({
        sensitiveFilterEnabled: true,
        sensitiveWords: [
          { pattern: 'Foo', replace: 'Bar', case_insensitive: false, enabled: false },
        ],
      });

      const nextReq = {
        ...req,
        contents: [
          ...req.contents,
          { role: 'model', parts: [{ text: 'ok' }] },
          { role: 'user', parts: [{ text: 'Turn 2' }] },
        ],
      };
      expect(worker.canReuse(nextReq)).toBe(true);
      await worker.executePrompt(nextReq);
      expect(sessionSeq).toBe(1);
    } finally {
      await worker.resetAndClose();
      await mcpServer.stop();
      store.setConfigValue('gateway_config', previous);
      invalidateConfigCache();
    }
  });
});
