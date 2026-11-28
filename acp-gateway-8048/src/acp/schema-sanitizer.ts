import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

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
  expectsToolSummary?: boolean;
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

function hasSchemaEntries(value: unknown): boolean {
  return isObject(value) && Object.keys(value).length > 0;
}

function openEmptyObject(out: JsonSchema, raw: JsonSchema): void {
  if (
    out.type === "object" &&
    !Object.hasOwn(raw, "additionalProperties") &&
    !Object.hasOwn(out, "additionalProperties") &&
    raw.unevaluatedProperties !== false && !isObject(raw.unevaluatedProperties) &&
    out.unevaluatedProperties !== false && !isObject(out.unevaluatedProperties) &&
    (raw.properties === undefined || (isObject(raw.properties) && !hasSchemaEntries(raw.properties))) &&
    !hasSchemaEntries(out.properties) &&
    !hasSchemaEntries(out.patternProperties)
  ) {
    out.additionalProperties = true;
  }
}

function mergeObjectConstraints(out: JsonSchema, branch: JsonSchema): void {
  for (const key of ["additionalProperties", "unevaluatedProperties"]) {
    if (!Object.hasOwn(branch, key)) continue;
    const current = out[key];
    const incoming = branch[key];
    if (!Object.hasOwn(out, key) || current === true || incoming === false) {
      out[key] = incoming;
    } else if (isObject(current) && isObject(incoming)) {
      out[key] = { allOf: [current, incoming] };
    }
  }
  if (isObject(branch.patternProperties)) {
    const patterns = isObject(out.patternProperties) ? out.patternProperties : {};
    out.patternProperties = {
      ...patterns,
      ...Object.fromEntries(Object.entries(branch.patternProperties).map(([pattern, schema]) => [
        pattern,
        Object.hasOwn(patterns, pattern) ? { allOf: [patterns[pattern], schema] } : schema,
      ])),
    };
  }
}

function collectRawRequired(
  node: unknown,
  root: JsonSchema,
  req: Set<string>,
  seen: Set<string>,
  depth: number,
): void {
  if (depth > MAX_DEPTH || !isObject(node)) return;
  if (Array.isArray(node.required)) {
    for (const r of node.required) {
      if (typeof r === "string") req.add(r);
    }
  }
  if (typeof node.$ref === "string" && !seen.has(node.$ref)) {
    const target = resolvePointer(root, node.$ref);
    if (target) {
      const nextSeen = new Set(seen);
      nextSeen.add(node.$ref);
      collectRawRequired(target, root, req, nextSeen, depth + 1);
    }
  }
  if (Array.isArray(node.allOf)) {
    for (const b of node.allOf) {
      collectRawRequired(b, root, req, seen, depth + 1);
    }
  }
}

function mergeAllOf(branches: unknown[], root: JsonSchema, seenRefs: Set<string>, depth: number): JsonSchema {
  const merged: JsonSchema = {};
  const props: Record<string, unknown> = Object.create(null);
  const req = new Set<string>();
  const explicitTypes: unknown[] = [];

  for (const branch of branches) {
    collectRawRequired(branch, root, req, seenRefs, depth + 1);
    const clean = sanitizeNode(branch, root, seenRefs, depth + 1, false);
    mergeObjectConstraints(merged, clean);
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
    if (clean.type !== undefined) {
      explicitTypes.push(clean.type);
    }
    if (Array.isArray(clean.enum)) {
      if (Array.isArray(merged.enum)) {
        const nextSet = new Set(clean.enum);
        const intersected = (merged.enum as unknown[]).filter((v) => nextSet.has(v));
        merged.enum = intersected.length > 0 ? intersected : merged.enum;
      } else {
        merged.enum = [...clean.enum];
      }
    }
    if (clean.items !== undefined) {
      if (merged.items === undefined) {
        merged.items = clean.items;
      } else if (isObject(merged.items) && isObject(clean.items)) {
        merged.items = mergePropertySchemas([merged.items, clean.items]);
      }
    }
    if (typeof clean.pattern === "string") {
      if (typeof merged.pattern !== "string") {
        merged.pattern = clean.pattern;
      } else if (merged.pattern !== clean.pattern) {
        merged.description = appendHint(merged.description, `Pattern constraint: ${clean.pattern}`);
      }
    }
    for (const minKey of ["minimum", "exclusiveMinimum", "minLength", "minItems"] as const) {
      if (typeof clean[minKey] === "number") {
        merged[minKey] =
          typeof merged[minKey] === "number"
            ? Math.max(merged[minKey] as number, clean[minKey] as number)
            : clean[minKey];
      }
    }
    for (const maxKey of ["maximum", "exclusiveMaximum", "maxLength", "maxItems"] as const) {
      if (typeof clean[maxKey] === "number") {
        merged[maxKey] =
          typeof merged[maxKey] === "number"
            ? Math.min(merged[maxKey] as number, clean[maxKey] as number)
            : clean[maxKey];
      }
    }
    for (const key of ["format", "default", "title"] as const) {
      if (clean[key] !== undefined && merged[key] === undefined) {
        merged[key] = clean[key];
      }
    }
  }

  if (Object.keys(props).length > 0) {
    merged.type = "object";
    merged.properties = props;
    const filteredReq = Array.from(req).filter((r) => Object.hasOwn(props, r));
    if (filteredReq.length > 0) {
      merged.required = filteredReq;
    }
  } else if (explicitTypes.length > 0) {
    const nonObject = explicitTypes.find((t) => t !== "object");
    merged.type = nonObject ?? explicitTypes[0];
  } else if (merged.items !== undefined) {
    merged.type = "array";
  } else if (
    merged.enum === undefined &&
    merged.pattern === undefined &&
    merged.minimum === undefined &&
    merged.maximum === undefined &&
    merged.exclusiveMinimum === undefined &&
    merged.exclusiveMaximum === undefined &&
    merged.minLength === undefined &&
    merged.maxLength === undefined &&
    merged.minItems === undefined &&
    merged.maxItems === undefined
  ) {
    merged.type = "object";
  }

  return merged;
}

function isNullBranch(node: unknown): boolean {
  if (!isObject(node)) return false;
  if (node.type === "null") return true;
  if (Array.isArray(node.type) && node.type.length === 1 && node.type[0] === "null") return true;
  return node.const === null;
}

function hasNullType(schema: JsonSchema): boolean {
  if (schema.type === "null") return true;
  return Array.isArray(schema.type) && schema.type.includes("null");
}

function collectTypes(schemas: JsonSchema[], hasNull: boolean): string | string[] | undefined {
  const types = new Set<string>();
  for (const s of schemas) {
    if (typeof s.type === "string") {
      types.add(s.type);
    } else if (Array.isArray(s.type)) {
      for (const t of s.type) {
        if (typeof t === "string") types.add(t);
      }
    }
  }
  if (hasNull) types.add("null");
  if (types.size === 0) return undefined;
  const arr = Array.from(types);
  return arr.length === 1 ? arr[0] : arr;
}

function mergeDescriptions(schemas: JsonSchema[]): string | undefined {
  let desc = "";
  for (const s of schemas) {
    if (typeof s.description === "string" && s.description.trim()) {
      desc = appendHint(desc, s.description);
    }
  }
  return desc || undefined;
}

function dedupeEnums(schemas: JsonSchema[]): unknown[] {
  const seen = new Set<unknown>();
  for (const s of schemas) {
    if (!Array.isArray(s.enum)) continue;
    for (const val of s.enum) {
      seen.add(val);
    }
  }
  return Array.from(seen);
}

function isObjectBranch(schema: JsonSchema): boolean {
  if (typeof schema.type === "string") {
    return schema.type === "object";
  }
  if (Array.isArray(schema.type)) {
    const nonNull = schema.type.filter((t) => t !== "null");
    return nonNull.length > 0 && nonNull.every((t) => t === "object");
  }
  return isObject(schema.properties);
}

function mergePropertySchemas(schemas: JsonSchema[]): JsonSchema {
  if (schemas.length === 1) return schemas[0]!;

  const allHaveEnum = schemas.every((s) => Array.isArray(s.enum) && s.enum.length > 0);
  if (allHaveEnum) {
    const merged: JsonSchema = {};
    const t = collectTypes(schemas, false);
    if (t !== undefined) merged.type = t;
    merged.enum = dedupeEnums(schemas);
    const desc = mergeDescriptions(schemas);
    if (desc) merged.description = desc;
    return merged;
  }

  const allObjectWithProps = schemas.every((s) => isObjectBranch(s) && isObject(s.properties));
  if (allObjectWithProps) {
    return mergeObjectBranches(schemas, false, false);
  }

  const merged: JsonSchema = {};
  const t = collectTypes(schemas, false);
  if (t !== undefined) merged.type = t;

  const props = mergePropertiesMap(schemas);
  if (Object.keys(props).length > 0) {
    merged.properties = props;
  }

  const itemSchemas = schemas.map((s) => s.items).filter(isObject);
  if (itemSchemas.length === 1) {
    merged.items = itemSchemas[0];
  } else if (itemSchemas.length > 1) {
    merged.items = mergeUnionBranches(itemSchemas, false);
  }

  const desc = mergeDescriptions(schemas);
  if (desc) merged.description = desc;
  return merged;
}

function mergePropertiesMap(branches: JsonSchema[]): Record<string, JsonSchema> {
  const grouped = new Map<string, JsonSchema[]>();
  for (const b of branches) {
    if (!isObject(b.properties)) continue;
    for (const [key, val] of Object.entries(b.properties)) {
      if (!isObject(val)) continue;
      let list = grouped.get(key);
      if (!list) {
        list = [];
        grouped.set(key, list);
      }
      list.push(val);
    }
  }
  const result: Record<string, JsonSchema> = Object.create(null);
  for (const [key, list] of grouped.entries()) {
    result[key] = mergePropertySchemas(list);
  }
  return result;
}

function intersectRequired(branches: JsonSchema[], validProps: Record<string, JsonSchema>): string[] {
  if (branches.length === 0) return [];
  const sets = branches.map((b) =>
    Array.isArray(b.required)
      ? new Set(b.required.filter((r): r is string => typeof r === "string"))
      : new Set<string>(),
  );
  const first = sets[0]!;
  const result: string[] = [];
  for (const field of first) {
    if (Object.hasOwn(validProps, field) && sets.every((s) => s.has(field))) {
      result.push(field);
    }
  }
  return result;
}

function buildUnionVariantHint(branches: JsonSchema[]): string | undefined {
  const summaries: string[] = [];
  for (const b of branches) {
    let discriminator: string | undefined;
    if (isObject(b.properties)) {
      for (const [k, v] of Object.entries(b.properties)) {
        if (isObject(v) && Array.isArray(v.enum) && v.enum.length === 1) {
          discriminator = `${k}=${JSON.stringify(v.enum[0])}`;
          break;
        }
      }
    }
    const req = Array.isArray(b.required)
      ? b.required.filter((r): r is string => typeof r === "string")
      : [];
    if (discriminator && req.length > 0) {
      summaries.push(`${discriminator} (requires: ${req.join(", ")})`);
    } else if (discriminator) {
      summaries.push(discriminator);
    } else if (req.length > 0) {
      summaries.push(`(${req.join(", ")})`);
    }
  }
  if (summaries.length < 2 || new Set(summaries).size <= 1) {
    return undefined;
  }
  const full = `Variants: ${summaries.join("; ")}`;
  return full.length > 240 ? `${full.slice(0, 237)}...` : full;
}

function mergeObjectBranches(
  branches: JsonSchema[],
  hasNull: boolean,
  includeVariantHint: boolean,
): JsonSchema {
  const effectiveNull = hasNull || branches.some(hasNullType);
  const out: JsonSchema = {
    type: effectiveNull ? ["object", "null"] : "object",
  };
  for (const key of ["additionalProperties", "unevaluatedProperties", "patternProperties"]) {
    const value = branches[0]?.[key];
    if (value !== undefined && branches.every((branch) => isDeepStrictEqual(branch[key], value))) {
      out[key] = value;
    }
  }
  const mergedProps = mergePropertiesMap(branches);
  if (Object.keys(mergedProps).length > 0) {
    out.properties = mergedProps;
    const req = intersectRequired(branches, mergedProps);
    if (req.length > 0) {
      out.required = req;
    }
  }
  let desc = mergeDescriptions(branches);
  if (includeVariantHint) {
    const hint = buildUnionVariantHint(branches);
    if (hint) desc = appendHint(desc, hint);
  }
  if (desc) out.description = desc;
  return out;
}

export function mergeUnionBranches(branches: JsonSchema[], hasNull: boolean): JsonSchema {
  if (branches.length === 0) {
    return { type: "null" };
  }
  if (branches.length === 1) {
    const single = { ...branches[0]! };
    if (hasNull && typeof single.type === "string" && single.type !== "null") {
      single.type = [single.type, "null"];
    }
    return single;
  }

  // a) Pure enum / constant union with a single shared base type
  const allHaveEnum = branches.every(
    (b) => Array.isArray(b.enum) && b.enum.length > 0 && !isObject(b.properties),
  );
  if (allHaveEnum) {
    const nonNullTypes = new Set<string>();
    let branchHasNull = false;
    for (const b of branches) {
      if (typeof b.type === "string") {
        if (b.type === "null") branchHasNull = true;
        else nonNullTypes.add(b.type);
      } else if (Array.isArray(b.type)) {
        for (const t of b.type) {
          if (t === "null") branchHasNull = true;
          else if (typeof t === "string") nonNullTypes.add(t);
        }
      }
    }
    if (nonNullTypes.size === 1) {
      const baseType = Array.from(nonNullTypes)[0]!;
      const effectiveNull = hasNull || branchHasNull;
      const out: JsonSchema = {
        type: effectiveNull ? [baseType, "null"] : baseType,
        enum: dedupeEnums(branches),
      };
      const desc = mergeDescriptions(branches);
      if (desc) out.description = desc;
      return out;
    }
  }

  // b) All-object union
  if (branches.every(isObjectBranch)) {
    return mergeObjectBranches(branches, hasNull, true);
  }

  // c) Mixed-type union
  const out: JsonSchema = {};
  const t = collectTypes(branches, hasNull);
  if (t !== undefined) out.type = t;

  const mergedProps = mergePropertiesMap(branches);
  if (Object.keys(mergedProps).length > 0) {
    out.properties = mergedProps;
  }

  const itemSchemas = branches.map((b) => b.items).filter(isObject);
  if (itemSchemas.length === 1) {
    out.items = itemSchemas[0];
  } else if (itemSchemas.length > 1) {
    out.items = mergeUnionBranches(itemSchemas, false);
  }

  const desc = mergeDescriptions(branches);
  if (desc) out.description = desc;
  return out;
}

function inferConstType(constVal: unknown): string {
  if (typeof constVal === "number") return "number";
  if (typeof constVal === "boolean") return "boolean";
  if (Array.isArray(constVal)) return "array";
  if (constVal !== null && typeof constVal === "object") return "object";
  return "string";
}

function mergeSiblingFields(
  combined: JsonSchema,
  node: JsonSchema,
  root: JsonSchema,
  seenRefs: Set<string>,
  depth: number,
): JsonSchema {
  if (typeof node.description === "string") {
    combined.description = appendHint(combined.description, node.description);
  }

  if (Object.hasOwn(node, "const")) {
    const constVal = node.const;
    if (constVal === null) {
      combined.type = "null";
    } else {
      combined.enum = [constVal];
      if (!combined.type) {
        combined.type = inferConstType(constVal);
      }
    }
  }

  if (node.type !== undefined && combined.type === undefined) {
    combined.type = node.type;
  }

  if (typeof node.pattern === "string") {
    if (typeof combined.pattern !== "string") {
      combined.pattern = node.pattern;
    } else if (combined.pattern !== node.pattern) {
      combined.description = appendHint(combined.description, `Pattern constraint: ${node.pattern}`);
    }
    sanitizePattern(combined);
  }

  if (node.items !== undefined && combined.items === undefined) {
    if (Array.isArray(node.items)) {
      combined.items = node.items.length > 0 ? sanitizeNode(node.items[0], root, seenRefs, depth + 1) : { type: "string" };
    } else {
      combined.items = sanitizeNode(node.items, root, seenRefs, depth + 1);
    }
    if (!combined.type) {
      combined.type = "array";
    }
  }

  if (isObject(node.properties)) {
    const cleanSiblingProps: Record<string, unknown> = Object.create(null);
    for (const [propName, propSchema] of Object.entries(node.properties)) {
      cleanSiblingProps[propName] = sanitizeNode(propSchema, root, seenRefs, depth + 1);
    }
    const existingProps = isObject(combined.properties) ? combined.properties : {};
    combined.properties = { ...existingProps, ...cleanSiblingProps };
    if (!combined.type) {
      combined.type = "object";
    }
  }

  if (Array.isArray(node.required) || Array.isArray(combined.required)) {
    const reqSet = new Set<string>();
    if (Array.isArray(combined.required)) {
      for (const r of combined.required) {
        if (typeof r === "string") reqSet.add(r);
      }
    }
    if (Array.isArray(node.required)) {
      for (const r of node.required) {
        if (typeof r === "string") reqSet.add(r);
      }
    }
    if (isObject(combined.properties)) {
      const props = combined.properties;
      const filtered = Array.from(reqSet).filter((r) => Object.hasOwn(props, r));
      if (filtered.length > 0) {
        combined.required = filtered;
      } else {
        delete combined.required;
      }
    } else {
      delete combined.required;
    }
  }

  const constraints = Object.fromEntries(
    ["additionalProperties", "unevaluatedProperties", "patternProperties"]
      .filter((key) => Object.hasOwn(node, key))
      .map((key) => [key, node[key]]),
  );
  sanitizeObjectConstraints(constraints, root, seenRefs, depth);
  mergeObjectConstraints(combined, constraints);

  for (const [k, v] of Object.entries(node)) {
    if (
      k === "$schema" ||
      k === "$defs" ||
      k === "definitions" ||
      k === "$ref" ||
      k === "allOf" ||
      k === "anyOf" ||
      k === "oneOf" ||
      k === "description" ||
      k === "const" ||
      k === "type" ||
      k === "pattern" ||
      k === "items" ||
      k === "properties" ||
      k === "required" ||
      k === "additionalProperties" ||
      k === "unevaluatedProperties" ||
      k === "patternProperties"
    ) {
      continue;
    }
    if (combined[k] === undefined) {
      combined[k] = v;
    }
  }

  return combined;
}

function sanitizeObjectConstraints(
  out: JsonSchema,
  root: JsonSchema,
  seenRefs: Set<string>,
  depth: number,
): void {
  for (const key of ["additionalProperties", "unevaluatedProperties"]) {
    if (isObject(out[key])) {
      out[key] = sanitizeNode(out[key], root, seenRefs, depth + 1);
    }
  }
  if (isObject(out.patternProperties)) {
    out.patternProperties = Object.fromEntries(
      Object.entries(out.patternProperties).map(([pattern, schema]) => [
        pattern,
        typeof schema === "boolean" ? schema : sanitizeNode(schema, root, seenRefs, depth + 1),
      ]),
    );
  }
}

function sanitizeNode(
  node: unknown,
  root: JsonSchema,
  seenRefs: Set<string>,
  depth: number,
  openCurrentObject = true,
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

  const finishComposition = (schema: JsonSchema): JsonSchema => {
    const out = mergeSiblingFields(schema, node, root, seenRefs, depth);
    if (openCurrentObject) openEmptyObject(out, node);
    return out;
  };

  if (typeof node.$ref === "string") {
    if (seenRefs.has(node.$ref)) {
      return { type: "object", description: "Recursive schema reference." };
    }
    const target = resolvePointer(root, node.$ref);
    if (target) {
      const nextRefs = new Set(seenRefs);
      nextRefs.add(node.$ref);
      return finishComposition(sanitizeNode(target, root, nextRefs, depth + 1, false));
    }
  }

  if (Array.isArray(node.allOf) && node.allOf.length > 0) {
    const merged = mergeAllOf(node.allOf, root, seenRefs, depth);
    return finishComposition(merged);
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
      const inner = sanitizeNode(nonNull[0], root, seenRefs, depth + 1, false);
      if (hasNull && typeof inner.type === "string" && inner.type !== "null") {
        inner.type = [inner.type, "null"];
      }
      return finishComposition(inner);
    }
    if (nonNull.length > 1) {
      const sanitizedBranches = nonNull.map((b) => sanitizeNode(b, root, seenRefs, depth + 1, false));
      return finishComposition(mergeUnionBranches(sanitizedBranches, hasNull));
    }
    return finishComposition({ type: "null" });
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
        out.type = inferConstType(constVal);
      }
    }
  }

  sanitizePattern(out);

  if (out.items !== undefined && !out.type) {
    out.type = "array";
  }

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
    const cleanProps: Record<string, unknown> = Object.create(null);
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

  sanitizeObjectConstraints(out, root, seenRefs, depth);
  if (openCurrentObject) openEmptyObject(out, node);
  return out;
}

function isNameAvailable(name: string, usedNames: Set<string>): boolean {
  return (
    !usedNames.has(name) &&
    !RESERVED_MCP_TOOL_NAMES.includes(name as (typeof RESERVED_MCP_TOOL_NAMES)[number])
  );
}

export function normalizeMcpToolName(originalName: string, usedNames: Set<string>): string {
  let base = originalName.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, MAX_TOOL_NAME_LEN);
  if (!base) base = "tool";

  if (isNameAvailable(base, usedNames)) {
    usedNames.add(base);
    return base;
  }

  const hash = createHash("sha256").update(originalName).digest("hex").slice(0, 6);
  let candidate = `${base.slice(0, MAX_TOOL_NAME_LEN - 7)}_${hash}`;
  let suffix = 2;
  while (!isNameAvailable(candidate, usedNames)) {
    const suffixStr = `_${suffix}`;
    const prefixMaxLen = Math.max(1, MAX_TOOL_NAME_LEN - 7 - suffixStr.length);
    candidate = `${base.slice(0, prefixMaxLen)}_${hash}${suffixStr}`;
    suffix += 1;
  }
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
    openEmptyObject(sanitized, rawSchema);
    const props = sanitized.properties as Record<string, unknown>;
    const expectsToolSummary = Object.hasOwn(props, "toolSummary");
    if (Array.isArray(sanitized.required)) {
      sanitized.required = sanitized.required.filter(
        (r): r is string => typeof r === "string" && r !== "toolSummary" && Object.hasOwn(props, r),
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
      expectsToolSummary,
    });
  }

  return { tools, mcpToOriginal, originalToMcp };
}
