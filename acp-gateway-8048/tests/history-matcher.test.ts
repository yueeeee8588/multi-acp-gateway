import { createHash } from "node:crypto";
import { describe, expect, it } from "bun:test";
import {
  findReusablePrefixLength,
  normalizeMessageForHistory,
} from "../src/acp/history-matcher";

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
});
