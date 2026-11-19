import { describe, expect, test } from "bun:test";
import type { GeminiContent } from "../src/types";
import {
  DEFAULT_HISTORY_BUDGET_BYTES,
  DEFAULT_TOOL_RESULT_CLIP_BYTES,
  DEFAULT_TOOL_RESULT_KEEP_BYTES,
  serializeContentsWithBudget,
} from "../src/acp/history-budget";

function totalTextBytes(blocks: Array<Record<string, unknown>>): number {
  return blocks.reduce((sum, b) => {
    if (b.type === "text" && typeof b.text === "string") {
      return sum + Buffer.byteLength(b.text, "utf8");
    }
    if (b.type === "image") {
      return (
        sum +
        Buffer.byteLength(String(b.data ?? ""), "utf8") +
        Buffer.byteLength(String(b.mimeType ?? ""), "utf8")
      );
    }
    return sum + Buffer.byteLength(JSON.stringify(b), "utf8");
  }, 0);
}

describe("history-budget", () => {
  test("exports expected default constants", () => {
    expect(DEFAULT_HISTORY_BUDGET_BYTES).toBe(8 * 1024 * 1024);
    expect(DEFAULT_TOOL_RESULT_CLIP_BYTES).toBe(12 * 1024);
    expect(DEFAULT_TOOL_RESULT_KEEP_BYTES).toBe(4 * 1024);
  });

  test("passes through short history with text, thought, inlineData, functionCall, functionResponse", () => {
    const contents: GeminiContent[] = [
      {
        role: "user",
        parts: [
          { text: "Look at this image" },
          { inlineData: { mimeType: "image/png", data: "AQIDBA==" } },
        ],
      },
      {
        role: "model",
        parts: [
          { thought: true, text: "thinking step" },
          { functionCall: { name: "read_file", args: { path: "a.ts" } } },
        ],
      },
      {
        role: "user",
        parts: [
          { functionResponse: { name: "read_file", response: { ok: true, lines: 10 } } },
        ],
      },
    ];

    const blocks = serializeContentsWithBudget(contents);
    expect(blocks).toEqual([
      { type: "image", mimeType: "image/png", data: "AQIDBA==" },
      { type: "text", text: "[user]\nLook at this image" },
      {
        type: "text",
        text: '[model]\n[thought]\nthinking step\n[functionCall read_file]: {"path":"a.ts"}',
      },
      {
        type: "text",
        text: '[user]\n[functionResponse read_file]: {"ok":true,"lines":10}',
      },
    ]);
  });

  test("clips oversized functionResponse (> 12 KiB) keeping 4 KiB head and tail", () => {
    const payload = "A".repeat(8000) + "M".repeat(8000) + "Z".repeat(8000);
    const contents: GeminiContent[] = [
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              name: "big_tool",
              response: { output: payload },
            },
          },
        ],
      },
    ];

    const blocks = serializeContentsWithBudget(contents);
    expect(blocks.length).toBe(1);
    const text = blocks[0].text as string;
    expect(text).toContain("[functionResponse big_tool]:");
    expect(text).toContain("bytes of this history block omitted");
    expect(text.includes("AAAA")).toBe(true);
    expect(text.includes("ZZZZ")).toBe(true);
    expect(text.includes("MMMM")).toBe(false);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(DEFAULT_TOOL_RESULT_CLIP_BYTES);
  });

  test("clips multi-byte Chinese and emoji UTF-8 text without splitting characters", () => {
    // 3-byte Chinese chars + 4-byte emoji surrogate pairs
    const headMarker = "开头中文";
    const tailMarker = "结尾中文";
    const chunk = "测试汉字🚀".repeat(2500); // > 20 KiB
    const contents: GeminiContent[] = [
      {
        role: "user",
        parts: [{ text: `${headMarker}${chunk}${tailMarker}` }],
      },
    ];

    const blocks = serializeContentsWithBudget(contents);
    expect(blocks.length).toBe(1);
    const text = blocks[0].text as string;
    expect(text).toContain("bytes of this history block omitted");
    expect(text).toContain(headMarker);
    expect(text).toContain(tailMarker);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(DEFAULT_TOOL_RESULT_CLIP_BYTES);

    // Ensure valid UTF-8 and no replacement character U+FFFD or lone surrogates
    const roundTripped = new TextDecoder("utf-8", { fatal: true }).decode(
      new TextEncoder().encode(text),
    );
    expect(roundTripped).toBe(text);
    expect(text.includes("\uFFFD")).toBe(false);
  });

  test("evicts earlier middle turns when total exceeds 8 MiB while preserving anchor and latest turn", () => {
    const imageChunk = "A".repeat(1024 * 1024); // 1 MiB inlineData per turn (not clipped by tool-result limit)
    const makeTurn = (label: string): GeminiContent => ({
      role: "user",
      parts: [
        { text: label },
        { inlineData: { mimeType: "image/png", data: imageChunk } },
      ],
    });

    // 10 turns of ~1 MiB each (~10 MiB total > 8 MiB)
    const contents: GeminiContent[] = [
      makeTurn("ANCHOR_0"),
      ...Array.from({ length: 8 }, (_, i) => makeTurn(`MID_${i + 1}`)),
      makeTurn("LATEST_TURN"),
    ];

    const blocks = serializeContentsWithBudget(contents);
    const joined = blocks.map((b) => String(b.text ?? "")).join("\n");

    expect(totalTextBytes(blocks)).toBeLessThanOrEqual(DEFAULT_HISTORY_BUDGET_BYTES);
    expect(joined).toContain("ANCHOR_0");
    expect(joined).toContain("LATEST_TURN");
    expect(joined).toContain(
      "[... earlier conversation history omitted to fit ACP 8 MiB prompt budget ...]",
    );
    // Earliest middle turn must have been evicted
    expect(joined).not.toContain("MID_1");
  });

  test("preserves single and multiple inlineData images (> 112 KiB) within default 8 MiB budget", () => {
    const img150K = "A".repeat(150 * 1024);
    const singleTurn: GeminiContent[] = [
      {
        role: "user",
        parts: [
          { inlineData: { mimeType: "image/png", data: img150K } },
          { text: "Describe this single image" },
        ],
      },
    ];
    const singleBlocks = serializeContentsWithBudget(singleTurn);
    expect(singleBlocks.filter((b) => b.type === "image")).toHaveLength(1);

    const multiTurn: GeminiContent[] = [
      {
        role: "user",
        parts: [
          { inlineData: { mimeType: "image/png", data: img150K } },
          { inlineData: { mimeType: "image/png", data: img150K } },
          { inlineData: { mimeType: "image/png", data: img150K } },
          { text: "Compare these three images" },
        ],
      },
    ];
    const multiBlocks = serializeContentsWithBudget(multiTurn);
    expect(multiBlocks.filter((b) => b.type === "image")).toHaveLength(3);
  });

  test("drops opening anchor if anchor squeezes latest turn out of budget", () => {
    const contents: GeminiContent[] = [
      { role: "user", parts: [{ text: `BIG_ANCHOR:${"A".repeat(900)}` }] },
      { role: "model", parts: [{ text: `MID:${"B".repeat(200)}` }] },
      { role: "user", parts: [{ text: `LATEST_MUST_STAY:${"C".repeat(400)}` }] },
    ];

    const blocks = serializeContentsWithBudget(contents, {
      maxTotalBytes: 600,
      maxToolResultBytes: 2000,
      keepBytes: 200,
    });

    const joined = blocks.map((b) => String(b.text ?? "")).join("\n");
    expect(totalTextBytes(blocks)).toBeLessThanOrEqual(600);
    expect(joined).toContain("LATEST_MUST_STAY");
    expect(joined).not.toContain("BIG_ANCHOR");
  });

  test("never mutates input contents object or nested parts", () => {
    const longPayload = "Z".repeat(20 * 1024);
    const contents: GeminiContent[] = [
      { role: "user", parts: [{ text: "hello" }] },
      {
        role: "user",
        parts: [{ functionResponse: { name: "tool", response: { data: longPayload } } }],
      },
    ];
    const snapshot = structuredClone(contents);

    serializeContentsWithBudget(contents, {
      maxTotalBytes: 1024,
      maxToolResultBytes: 512,
      keepBytes: 128,
    });

    expect(contents).toEqual(snapshot);
  });

  test("preserves latest turn text/function blocks before inlineData when budget is tight", () => {
    const bigBase64 = "A".repeat(4000);
    const contents: GeminiContent[] = [
      { role: "user", parts: [{ text: "earlier turn" }] },
      {
        role: "user",
        parts: [
          { inlineData: { mimeType: "image/png", data: bigBase64 } },
          { text: "LATEST_CRITICAL_QUESTION" },
        ],
      },
    ];

    const blocks = serializeContentsWithBudget(contents, {
      maxTotalBytes: 500,
      maxToolResultBytes: 2000,
      keepBytes: 200,
    });

    const joined = blocks.map((b) => String(b.text ?? "")).join("\n");
    expect(joined).toContain("LATEST_CRITICAL_QUESTION");
    expect(blocks.some((b) => b.type === "image")).toBe(false);
  });
});
