import { createHash } from "node:crypto";
import { describe, expect, it } from "bun:test";
import {
  findReusablePrefixLength,
  normalizeMessageForHistory,
  summarizeMessageForHistory,
} from "../src/acp/history-matcher";
import {
  AGENT_MODEL_LINE_RE,
  normalizeSystemInstructionForHash,
  stripVolatileSystem,
} from "../src/acp/volatile-system";

function hashJson(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value ?? null))
    .digest("hex");
}

describe("acp/history-matcher", () => {
  it("returns exact: true when JSON hashes match identically", () => {
    const committed = [
      { role: "user", parts: [{ text: "hello" }] },
      { role: "model", parts: [{ text: "hi there" }] },
    ];
    const hashes = committed.map(hashJson);
    const norms = committed.map(normalizeMessageForHistory);

    const incoming = [
      ...committed,
      { role: "user", parts: [{ text: "next question" }] },
    ];

    expect(findReusablePrefixLength(hashes, norms, incoming)).toEqual({
      matchedCount: 2,
      exact: true,
    });
  });

  it("tolerates key reordering, whitespace tweaks, thought blocks, trailing nudge, and redaction boundaries", () => {
    const committed = [
      {
        role: "user",
        parts: [{ text: "Check key=[REDACTED]please" }],
      },
      {
        role: "model",
        parts: [
          { text: "Let me think silently...", thought: true },
          { text: "Result is ready.", thoughtSignature: "sig-abc" },
        ],
      },
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              name: "read_file",
              response: { ok: true, path: "a.ts" },
            },
          },
          { text: "Continue now" },
        ],
      },
    ];

    const hashes = committed.map(hashJson);
    const norms = committed.map(normalizeMessageForHistory);

    const incoming = [
      // 1. Key order + whitespace + redaction placeholder adjacency boundary
      {
        parts: [{ text: "Check   key= [REDACTED]  please\r\n" }],
        role: "user",
      },
      // 2. Thought block removed & thoughtSignature stripped
      {
        role: "model",
        parts: [{ text: "Result   is ready." }],
      },
      // 3. Nested object keys reordered + trailing nudge injected once
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              response: { path: "a.ts", ok: true },
              name: "read_file",
            },
          },
          { text: "Continue now\n\n<system-reminder>Keep output brief</system-reminder>" },
        ],
      },
      {
        role: "model",
        parts: [{ text: "new turn" }],
      },
    ];

    expect(findReusablePrefixLength(hashes, norms, incoming)).toEqual({
      matchedCount: 3,
      exact: false,
    });
  });

  it("fails fast at the exact mismatch index when substantive content is tampered", () => {
    const committed = [
      { role: "user", parts: [{ text: "step 1" }] },
      { role: "model", parts: [{ text: "step 2 original" }] },
      { role: "user", parts: [{ text: "step 3" }] },
    ];
    const hashes = committed.map(hashJson);
    const norms = committed.map(normalizeMessageForHistory);

    const incoming = [
      { role: "user", parts: [{ text: "step 1" }] },
      { role: "model", parts: [{ text: "step 2 TAMPERED" }] },
      { role: "user", parts: [{ text: "step 3" }] },
    ];

    expect(findReusablePrefixLength(hashes, norms, incoming)).toEqual({
      matchedCount: 1,
      exact: false,
    });
  });

  it("fails fast when tool arguments or role are altered", () => {
    const committed = [
      {
        role: "model",
        parts: [{ functionCall: { name: "run", args: { cmd: "ls" } } }],
      },
    ];
    const hashes = committed.map(hashJson);
    const norms = committed.map(normalizeMessageForHistory);

    const alteredArgs = [
      {
        role: "model",
        parts: [{ functionCall: { name: "run", args: { cmd: "rm -rf /" } } }],
      },
    ];
    expect(findReusablePrefixLength(hashes, norms, alteredArgs)).toEqual({
      matchedCount: 0,
      exact: false,
    });

    const alteredRole = [
      {
        role: "user",
        parts: [{ functionCall: { name: "run", args: { cmd: "ls" } } }],
      },
    ];
    expect(findReusablePrefixLength(hashes, norms, alteredRole)).toEqual({
      matchedCount: 0,
      exact: false,
    });
  });

  it("matches reuse when inlineData image is replaced by Magpie English placeholders", () => {
    const committed = [
      {
        role: "user",
        parts: [
          { text: "Look at this screenshot:" },
          { inlineData: { mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUg==" } },
          { text: "What went wrong?" },
        ],
      },
      {
        role: "model",
        parts: [{ text: "It shows a 404 error." }],
      },
      {
        role: "user",
        parts: [
          { inlineData: { mimeType: "image/jpeg", data: "/9j/4AAQSkZJRg==" } },
        ],
      },
    ];
    const hashes = committed.map(hashJson);
    const norms = committed.map(normalizeMessageForHistory);

    const incoming = [
      {
        role: "user",
        parts: [
          { text: "Look at this screenshot:" },
          {
            text: "  [An earlier image was left out here to keep this request under its size limit.]  ",
          },
          { text: "What went wrong?" },
        ],
      },
      {
        role: "model",
        parts: [{ text: "It shows a 404 error." }],
      },
      {
        role: "user",
        parts: [
          {
            text: "[128.5 KB image left out here: image/jpeg\noriginal size exceeded limit]",
          },
        ],
      },
      {
        role: "model",
        parts: [{ text: "Got it." }],
      },
    ];

    expect(findReusablePrefixLength(hashes, norms, incoming)).toEqual({
      matchedCount: 3,
      exact: false,
    });
  });

  it("matches reuse when real image is replaced by Hana Chinese placeholders (including inline lines)", () => {
    const committed = [
      {
        role: "user",
        parts: [
          { text: "请分析这两张图：" },
          { inlineData: { mimeType: "image/png", data: "img1" } },
          { fileData: { mimeType: "image/png", fileUri: "gs://bucket/img2.png" } },
          { text: "谢谢" },
        ],
      },
    ];
    const hashes = committed.map(hashJson);
    const norms = committed.map(normalizeMessageForHistory);

    const incoming = [
      {
        role: "user",
        parts: [
          {
            text: "请分析这两张图：\n[图片已替换为文字占位]\n[图片已省略：原图已降载]\n谢谢",
          },
        ],
      },
    ];

    expect(findReusablePrefixLength(hashes, norms, incoming)).toEqual({
      matchedCount: 1,
      exact: false,
    });
    expect(JSON.parse(norms[0])).toEqual({
      role: "user",
      parts: [{ type: "text", text: "请分析这两张图： 谢谢" }],
      mediaCount: 2,
    });
  });

  it("matches OpenAI image_url / Claude image and tool_result / functionResponse media placeholders", () => {
    const committed = [
      {
        role: "user",
        content: [
          { type: "text", text: "Inspect UI" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [
              { type: "text", text: "Captured" },
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: "BBB" },
              },
            ],
          },
        ],
      },
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              name: "screenshot",
              response: { ok: true },
              parts: [{ inlineData: { mimeType: "image/png", data: "CCC" } }],
            },
          },
        ],
      },
    ];
    const hashes = committed.map(hashJson);
    const norms = committed.map(normalizeMessageForHistory);

    const incoming = [
      {
        role: "user",
        content: "Inspect UI\n[Image omitted]",
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [
              { type: "text", text: "Captured" },
              { type: "text", text: "[Image placeholder...]" },
            ],
          },
        ],
      },
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              name: "screenshot",
              response: { ok: true },
              parts: [{ text: "[已省略图片]" }],
            },
          },
        ],
      },
    ];

    expect(findReusablePrefixLength(hashes, norms, incoming)).toEqual({
      matchedCount: 3,
      exact: false,
    });
  });

  it("fails fast when image is completely deleted (1 -> 0) or image count changes (1 -> 2)", () => {
    const committed = [
      {
        role: "user",
        parts: [
          { text: "Check this" },
          { inlineData: { mimeType: "image/png", data: "img1" } },
        ],
      },
    ];
    const hashes = committed.map(hashJson);
    const norms = committed.map(normalizeMessageForHistory);

    const deletedImage = [
      {
        role: "user",
        parts: [{ text: "Check this" }],
      },
    ];
    expect(findReusablePrefixLength(hashes, norms, deletedImage)).toEqual({
      matchedCount: 0,
      exact: false,
    });

    const extraPlaceholder = [
      {
        role: "user",
        parts: [
          { text: "Check this" },
          { text: "[图片已省略]" },
          { text: "[图片已省略]" },
        ],
      },
    ];
    expect(findReusablePrefixLength(hashes, norms, extraPlaceholder)).toEqual({
      matchedCount: 0,
      exact: false,
    });
  });

  it("fails fast when text outside image placeholder is tampered, and does not strip normal prose mentioning 图片", () => {
    const committed = [
      {
        role: "user",
        parts: [
          { text: "这张图片里有什么动物？" },
          { inlineData: { mimeType: "image/png", data: "img1" } },
        ],
      },
    ];
    const hashes = committed.map(hashJson);
    const norms = committed.map(normalizeMessageForHistory);

    const tamperedText = [
      {
        role: "user",
        parts: [
          { text: "这张图片里有什么植物？" },
          { text: "[图片已省略]" },
        ],
      },
    ];
    expect(findReusablePrefixLength(hashes, norms, tamperedText)).toEqual({
      matchedCount: 0,
      exact: false,
    });

    const proseNorm = JSON.parse(
      normalizeMessageForHistory({
        role: "user",
        parts: [{ text: "请不要删除 [包含图片说明的普通括号内容] 这句话" }],
      }),
    );
    expect(proseNorm.mediaCount).toBeUndefined();
    expect(proseNorm.parts).toEqual([
      { type: "text", text: "请不要删除 [包含图片说明的普通括号内容] 这句话" },
    ]);
  });

  it("recognizes all 4 upstream image placeholder categories including image-slim and strips base64 from summary", () => {
    const rawSecretB64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const committed = [
      {
        role: "user",
        parts: [
          { text: "Compare 4 images:" },
          { inlineData: { mimeType: "image/png", data: rawSecretB64 } },
          { inlineData: { mimeType: "image/png", data: rawSecretB64 } },
          { inlineData: { mimeType: "image/png", data: rawSecretB64 } },
          { inlineData: { mimeType: "image/png", data: rawSecretB64 } },
        ],
      },
    ];
    const summaries = committed.map(summarizeMessageForHistory);
    expect(summaries[0].mediaCount).toBe(4);
    expect(summaries[0].hasRawMedia).toBe(true);
    expect(summaries[0].norm).not.toContain(rawSecretB64);
    expect(JSON.stringify(summaries[0])).not.toContain(rawSecretB64);

    const incoming = [
      {
        role: "user",
        parts: [
          { text: "Compare 4 images:" },
          { text: "[An earlier image was left out here to keep this request under its size limit.]" },
          { text: "[An earlier image was omitted here to keep this request within the model's image limit.]" },
          { text: "[This image is omitted here; the same image appears again later in this conversation.]" },
          { text: "[image-slim: 800x600]\n" },
        ],
      },
    ];
    expect(findReusablePrefixLength(summaries, incoming)).toEqual({
      matchedCount: 1,
      exact: false,
    });

    const incomingXmlSlim = [
      {
        role: "user",
        parts: [
          { text: "Compare 4 images:" },
          { text: "[12.3 KB image left out here: image/png]" },
          { text: "[An earlier image was omitted here to keep this request within the model's image limit.]" },
          { text: "<image-slim id=\"a\" />" },
          { text: "before <image-slim/> after" },
        ],
      },
    ];
    // "before <image-slim/> after" leaves "before after" which alters text -> must fail fast!
    expect(findReusablePrefixLength(summaries, incomingXmlSlim)).toEqual({
      matchedCount: 0,
      exact: false,
    });

    const incomingXmlSlimPureLines = [
      {
        role: "user",
        parts: [
          { text: "Compare 4 images:" },
          { text: "[12.3 KB image left out here: image/png]" },
          { text: "[An earlier image was omitted here to keep this request within the model's image limit.]" },
          { text: "[This image is omitted here; the same image appears again later in this conversation.]" },
          { text: "<image-slim id=\"a\" />" },
        ],
      },
    ];
    expect(findReusablePrefixLength(summaries, incomingXmlSlimPureLines)).toEqual({
      matchedCount: 1,
      exact: false,
    });
  });

  it("enforces one-way image downgrade: raw -> placeholder allowed, placeholder -> raw fails fast", () => {
    const rawMsg = {
      role: "user",
      parts: [
        { text: "Inspect:" },
        { inlineData: { mimeType: "image/png", data: "BASE64_DATA_1" } },
      ],
    };
    const placeholderMsg = {
      role: "user",
      parts: [
        { text: "Inspect:" },
        { text: "[image-slim]" },
      ],
    };

    const rawCommitted = [summarizeMessageForHistory(rawMsg)];
    expect(rawCommitted[0].hasRawMedia).toBe(true);
    expect(findReusablePrefixLength(rawCommitted, [placeholderMsg])).toEqual({
      matchedCount: 1,
      exact: false,
    });

    const placeholderCommitted = [summarizeMessageForHistory(placeholderMsg)];
    expect(placeholderCommitted[0].hasRawMedia).toBe(false);
    expect(placeholderCommitted[0].mediaCount).toBe(1);
    expect(findReusablePrefixLength(placeholderCommitted, [rawMsg])).toEqual({
      matchedCount: 0,
      exact: false,
    });
  });

  it("handles 3 valid diff shapes while failing fast on illegal mutations", () => {
    // Shape 1: whole pure-image/placeholder part or blank line dropped while mediaCount stays equal
    const shape1Committed = [
      summarizeMessageForHistory({
        role: "user",
        parts: [
          { text: "Analyze:" },
          { text: "   \n  " },
          { inlineData: { mimeType: "image/png", data: "IMG_A" } },
        ],
      }),
    ];
    expect(
      findReusablePrefixLength(shape1Committed, [
        {
          role: "user",
          parts: [{ text: "Analyze:\n[Image omitted]" }],
        },
      ]),
    ).toEqual({ matchedCount: 1, exact: false });

    // Shape 2: caption folded into adjacent tool_result / functionResponse
    const shape2Committed = [
      summarizeMessageForHistory({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [
              { type: "text", text: "Screenshot captured" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "IMG_B" } },
            ],
          },
          { type: "text", text: "Image caption: Login button in blue" },
        ],
      }),
    ];
    expect(
      findReusablePrefixLength(shape2Committed, [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: [
                { type: "text", text: "Screenshot captured\n[Image caption: Login button in blue]" },
                { type: "text", text: "[image-slim]" },
              ],
            },
          ],
        },
      ]),
    ).toEqual({ matchedCount: 1, exact: false });

    // Shape 2 for Gemini functionResponse
    const shape2GeminiCommitted = [
      summarizeMessageForHistory({
        role: "user",
        parts: [
          {
            functionResponse: {
              name: "snap",
              response: { ok: true },
              parts: [{ inlineData: { mimeType: "image/png", data: "IMG_C" } }],
            },
          },
          { text: "[Image caption: Terminal window]" },
        ],
      }),
    ];
    expect(
      findReusablePrefixLength(shape2GeminiCommitted, [
        {
          role: "user",
          parts: [
            {
              functionResponse: {
                name: "snap",
                response: { ok: true },
                parts: [
                  { text: "[Image omitted]" },
                  { text: "Image caption: Terminal window" },
                ],
              },
            },
          ],
        },
      ]),
    ).toEqual({ matchedCount: 1, exact: false });

    // Shape 3: image replaced with equal placeholder count AND adjacent caption dropped
    const shape3Committed = [
      summarizeMessageForHistory({
        role: "user",
        parts: [
          { text: "Look here:" },
          { inlineData: { mimeType: "image/png", data: "IMG_D" } },
          { text: "Image caption: Red warning banner" },
        ],
      }),
    ];
    expect(
      findReusablePrefixLength(shape3Committed, [
        {
          role: "user",
          parts: [
            { text: "Look here:" },
            { text: "[Image omitted]" },
          ],
        },
      ]),
    ).toEqual({ matchedCount: 1, exact: false });

    // Fail-Fast Redline: raw image KEPT (hasRawMedia: true) but caption DROPPED -> MUST reject!
    expect(
      findReusablePrefixLength(shape3Committed, [
        {
          role: "user",
          parts: [
            { text: "Look here:" },
            { inlineData: { mimeType: "image/png", data: "IMG_D" } },
          ],
        },
      ]),
    ).toEqual({ matchedCount: 0, exact: false });

    // Fail-Fast Redline: non-image pure text altered -> MUST reject!
    const pureTextCommitted = [
      summarizeMessageForHistory({
        role: "user",
        parts: [{ text: "Image caption: Not an image message" }],
      }),
    ];
    expect(
      findReusablePrefixLength(pureTextCommitted, [
        {
          role: "user",
          parts: [{ text: "" }],
        },
      ]),
    ).toEqual({ matchedCount: 0, exact: false });

    // Fail-Fast Redline: other text modified alongside valid image downgrade -> MUST reject!
    expect(
      findReusablePrefixLength(shape3Committed, [
        {
          role: "user",
          parts: [
            { text: "Look elsewhere:" },
            { text: "[Image omitted]" },
          ],
        },
      ]),
    ).toEqual({ matchedCount: 0, exact: false });
  });
});

describe("acp/volatile-system", () => {
  it("strips 4 volatile line categories and respects legacy option for AGENT_MODEL_LINE_RE", () => {
    const raw = [
      "x-anthropic-billing-header: cc=123; budget=456",
      "You are an expert software engineer.",
      "Current local time: 2026-11-26T06:29:00Z",
      "Today's date is 2026-11-26.",
      "Session started at: Thursday, November 26, 2026",
      "You are powered by Gemini 4 Hydrogen.",
      "Your knowledge cutoff is March 2026.",
      "Model: claude-opus-4-5",
      "[REDACTED: api_key]",
      "Note: Sensitive content has been redacted from this prompt.",
      "Values written like {{NAME_1}} were redacted.",
      "<system-reminder>[REDACTED] sensitive token stripped</system-reminder>",
      "",
      "",
      "",
      "Always write clean TypeScript.",
    ].join("\n");

    expect(AGENT_MODEL_LINE_RE.test("You are powered by Gemini 4 Hydrogen.")).toBe(true);
    expect(AGENT_MODEL_LINE_RE.test("Your knowledge cutoff is March 2026.")).toBe(true);
    expect(AGENT_MODEL_LINE_RE.test("Model: gemini-4-argon")).toBe(true);

    const stripped = stripVolatileSystem(raw);
    expect(stripped).toBe(
      "You are an expert software engineer.\n\nAlways write clean TypeScript.",
    );

    const legacyStripped = stripVolatileSystem(raw, { legacy: true });
    expect(legacyStripped).toContain("You are powered by Gemini 4 Hydrogen.");
    expect(legacyStripped).toContain("Your knowledge cutoff is March 2026.");
    expect(legacyStripped).toContain("Model: claude-opus-4-5");
    expect(legacyStripped).not.toContain("x-anthropic-billing-header");
    expect(legacyStripped).not.toContain("Current local time");
    expect(legacyStripped).not.toContain("Values written like");
  });

  it("normalizeSystemInstructionForHash is pure and never mutates the original input object", () => {
    const original = {
      role: "system",
      parts: [
        { text: "x-anthropic-billing-header: abc\nCore rule 1." },
        { text: "Current date: 2026-11-26\nYou are powered by TestModel." },
        { text: "Core rule 2." },
      ],
    };
    const snapshot = structuredClone(original);

    const normalized = normalizeSystemInstructionForHash(original) as {
      parts: Array<{ text: string }>;
      role: string;
    };

    expect(original).toEqual(snapshot);
    expect(normalized).toEqual({
      parts: [
        { text: "Core rule 1." },
        { text: "Core rule 2." },
      ],
      role: "system",
    });
    expect(normalizeSystemInstructionForHash(null)).toBeNull();
    expect(normalizeSystemInstructionForHash(undefined)).toBeNull();
    expect(normalizeSystemInstructionForHash("Model: x\nKeep this")).toBe("Keep this");
  });
});
