import { createHash } from "node:crypto";

export type JsonSchema = Record<string, unknown>;

export interface GeminiFunctionDeclaration {
  name: string;
  description?: string;
  parameters?: JsonSchema;
  parametersJsonSchema?: JsonSchema;
}

export interface SanitizedToolDefinition {
  originalName: string;
  mcpName: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface SanitizedToolsResult {
  tools: SanitizedToolDefinition[];
  mcpToOriginal: Map<string, string>;
  originalToMcp: Map<string, string>;
}

export const RESERVED_MCP_TOOL_NAMES = ["await_result"] as const;

const MAX_TOOL_NAME_LEN = 50;
const MAX_DEPTH = 32;
const UNSUPPORTED_RE2_RE = /\(\?[=!<]|\\[1-9]/;

function isObject(value: unknown): value is JsonSchema {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function appendHint(existing: unknown, hint: string): string {
  const base = typeof existing === "string" ? existing.trim() : "";
  if (!base) return hint;
  if (base.includes(hint)) return base;
  return `${base} ${hint}`;
}

function resolvePointer(root: JsonSchema, ref: unknown): JsonSchema | undefined {
  if (typeof ref !== "string" || !ref.startsWith("#/")) return undefined;
  const parts = ref.slice(2).split("/").map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  let cur: unknown = root;
  for (const part of parts) {
    if (!isObject(cur) || !Object.hasOwn(cur, part)) return undefined;
    cur = cur[part];
  }
  return isObject(cur) ? cur : undefined;
}

function sanitizePattern(schema: JsonSchema): void {
  if (typeof schema.pattern !== "string") return;
  if (UNSUPPORTED_RE2_RE.test(schema.pattern)) {
    const raw = schema.pattern;
    delete schema.pattern;
    schema.description = appendHint(schema.description, `Pattern constraint: ${raw}`);
  }
}

function mergeAllOf(branches: unknown[], root: JsonSchema, seenRefs: Set<string>, depth: number): JsonSchema {
  const merged: JsonSchema = { type: "object", properties: {}, required: [] as string[] };
  const props = merged.properties as Record<string, unknown>;
  const req = new Set<string>();

  for (const branch of branches) {
    const clean = sanitizeNode(branch, root, seenRefs, depth + 1);
    if (!isObject(clean)) continue;
    if (typeof clean.description === "string") {
      merged.description = appendHint(merged.description, clean.description);
    }
    if (isObject(clean.properties)) {
      for (const [k, v] of Object.entries(clean.properties)) {
        props[k] = v;
      }
    }
    if (Array.isArray(clean.required)) {
      for (const r of clean.required) {
        if (typeof r === "string") req.add(r);
      }
    }
    if (clean.type && clean.type !== "object" && Object.keys(props).length === 0) {
      merged.type = clean.type;
    }
  }

  if (Object.keys(props).length === 0) {
    delete merged.properties;
  }
  if (req.size > 0) {
    merged.required = Array.from(req);
  } else {
    delete merged.required;
  }
  return merged;
}

function isNullBranch(node: unknown): boolean {
  if (!isObject(node)) return false;
  if (node.type === "null") return true;
  if (Array.isArray(node.type) && node.type.length === 1 && node.type[0] === "null") return true;
  return node.const === null;
}

function sanitizeNode(
  node: unknown,
  root: JsonSchema,
  seenRefs: Set<string>,
  depth: number,
): JsonSchema {
  if (depth > MAX_DEPTH) {
    return { type: "string", description: "Schema depth limit reached." };
  }
  if (typeof node === "boolean") {
    return node ? { type: "object" } : { type: "object", description: "No value allowed." };
  }
  if (!isObject(node)) {
    return { type: "string" };
  }

  if (typeof node.$ref === "string") {
    if (seenRefs.has(node.$ref)) {
      return { type: "object", description: "Recursive schema reference." };
    }
    const target = resolvePointer(root, node.$ref);
    if (target) {
      const nextRefs = new Set(seenRefs);
      nextRefs.add(node.$ref);
      const resolved = sanitizeNode(target, root, nextRefs, depth + 1);
      if (typeof node.description === "string") {
        resolved.description = appendHint(resolved.description, node.description);
      }
      return resolved;
    }
  }

  if (Array.isArray(node.allOf) && node.allOf.length > 0) {
    const merged = mergeAllOf(node.allOf, root, seenRefs, depth);
    if (typeof node.description === "string") {
      merged.description = appendHint(merged.description, node.description);
    }
    return merged;
  }

  const union = Array.isArray(node.anyOf)
    ? node.anyOf
    : Array.isArray(node.oneOf)
      ? node.oneOf
      : null;

  if (union && union.length > 0) {
    const hasNull = union.some(isNullBranch);
    const nonNull = union.filter((b) => !isNullBranch(b));
    if (nonNull.length === 1) {
      const inner = sanitizeNode(nonNull[0], root, seenRefs, depth + 1);
      if (hasNull && typeof inner.type === "string") {
        inner.type = [inner.type, "null"];
      }
      if (typeof node.description === "string") {
        inner.description = appendHint(inner.description, node.description);
      }
      return inner;
    }
    if (nonNull.length > 1) {
      const first = sanitizeNode(nonNull[0], root, seenRefs, depth + 1);
      if (hasNull && typeof first.type === "string") {
        first.type = [first.type, "null"];
      }
      if (typeof node.description === "string") {
        first.description = appendHint(first.description, node.description);
      }
      return first;
    }
    return { type: "null" };
  }

  const out: JsonSchema = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === "$schema" || k === "$defs" || k === "definitions" || k === "$ref") continue;
    out[k] = v;
  }

  if (Object.hasOwn(out, "const")) {
    const constVal = out.const;
    delete out.const;
    if (constVal === null) {
      out.type = "null";
    } else {
      out.enum = [constVal];
      if (!out.type) {
        out.type = typeof constVal === "number" ? "number" : typeof constVal === "boolean" ? "boolean" : "string";
      }
    }
  }

  sanitizePattern(out);

  if (out.type === "array" || (Array.isArray(out.type) && out.type.includes("array"))) {
    if (out.items === undefined) {
      out.items = { type: "string" };
    } else if (Array.isArray(out.items)) {
      out.items = out.items.length > 0 ? sanitizeNode(out.items[0], root, seenRefs, depth + 1) : { type: "string" };
    } else {
      out.items = sanitizeNode(out.items, root, seenRefs, depth + 1);
    }
  }

  if (isObject(out.properties)) {
    const cleanProps: Record<string, unknown> = {};
    for (const [propName, propSchema] of Object.entries(out.properties)) {
      cleanProps[propName] = sanitizeNode(propSchema, root, seenRefs, depth + 1);
    }
    out.properties = cleanProps;
    if (!out.type) {
      out.type = "object";
    }
    if (Array.isArray(out.required)) {
      out.required = out.required.filter(
        (r): r is string => typeof r === "string" && Object.hasOwn(cleanProps, r),
      );
      if ((out.required as string[]).length === 0) {
        delete out.required;
      }
    }
  } else if (Array.isArray(out.required)) {
    delete out.required;
  }

  if (isObject(out.additionalProperties)) {
    out.additionalProperties = sanitizeNode(out.additionalProperties, root, seenRefs, depth + 1);
  }

  return out;
}

export function normalizeMcpToolName(originalName: string, usedNames: Set<string>): string {
  let base = originalName.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, MAX_TOOL_NAME_LEN);
  if (!base) base = "tool";

  if (!usedNames.has(base) && !RESERVED_MCP_TOOL_NAMES.includes(base as (typeof RESERVED_MCP_TOOL_NAMES)[number])) {
    usedNames.add(base);
    return base;
  }

  const hash = createHash("sha256").update(originalName).digest("hex").slice(0, 6);
  const candidate = `${base.slice(0, MAX_TOOL_NAME_LEN - 7)}_${hash}`;
  usedNames.add(candidate);
  return candidate;
}

export function sanitizeToolDeclarations(
  declarations: GeminiFunctionDeclaration[],
): SanitizedToolsResult {
  const usedNames = new Set<string>(RESERVED_MCP_TOOL_NAMES);
  const mcpToOriginal = new Map<string, string>();
  const originalToMcp = new Map<string, string>();
  const tools: SanitizedToolDefinition[] = [];

  for (const decl of declarations) {
    if (!decl || typeof decl.name !== "string" || !decl.name.trim()) continue;
    const originalName = decl.name.trim();
    const mcpName = normalizeMcpToolName(originalName, usedNames);

    mcpToOriginal.set(mcpName, originalName);
    originalToMcp.set(originalName, mcpName);

    const rawSchema = decl.parametersJsonSchema ?? decl.parameters ?? { type: "object", properties: {} };
    const sanitized = sanitizeNode(rawSchema, rawSchema, new Set<string>(), 0);

    sanitized.type = "object";
    if (!isObject(sanitized.properties)) {
      sanitized.properties = {};
    }
    if (Array.isArray(sanitized.required)) {
      const props = sanitized.properties as Record<string, unknown>;
      sanitized.required = sanitized.required.filter(
        (r): r is string => typeof r === "string" && Object.hasOwn(props, r),
      );
      if ((sanitized.required as string[]).length === 0) {
        delete sanitized.required;
      }
    }

    tools.push({
      originalName,
      mcpName,
      description: typeof decl.description === "string" ? decl.description : "",
      inputSchema: sanitized,
    });
  }

  return { tools, mcpToOriginal, originalToMcp };
}
