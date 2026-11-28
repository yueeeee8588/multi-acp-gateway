import { describe, expect, it } from 'bun:test';
import {
  normalizeMcpToolName,
  sanitizeToolDeclarations,
} from '../src/acp/schema-sanitizer';

describe('acp/schema-sanitizer', () => {
  it('resolves $ref, allOf, const, nullable, array items, and RE2 regexes', () => {
    const result = sanitizeToolDeclarations([
      {
        name: 'complex_tool',
        description: 'A complex tool',
        parameters: {
          type: 'object',
          $defs: {
            Address: {
              type: 'object',
              properties: {
                city: { type: 'string' },
                zip: { type: ['string', 'null'], pattern: '^[0-9]{5}$' },
              },
              required: ['city'],
            },
          },
          properties: {
            mode: { const: 'fast' },
            address: { $ref: '#/$defs/Address' },
            tags: {
              type: 'array',
              items: {
                allOf: [
                  { type: 'object', properties: { id: { type: 'string' } } },
                  { type: 'object', properties: { label: { type: 'string' } }, required: ['id'] },
                ],
              },
            },
          },
          required: ['mode', 'address'],
        },
      },
    ]);

    expect(result.tools.length).toBe(1);
    const schema = result.tools[0].inputSchema as Record<string, any>;
    expect(schema.$defs).toBeUndefined();
    expect(schema.properties.mode.enum).toEqual(['fast']);
    expect(schema.properties.mode.const).toBeUndefined();
    expect(schema.properties.address.type).toBe('object');
    expect(schema.properties.address.properties.zip.type).toEqual(['string', 'null']);
    expect(schema.properties.address.properties.zip.pattern).toBe('^[0-9]{5}$');
    expect(schema.properties.tags.items.properties.id.type).toBe('string');
    expect(schema.properties.tags.items.properties.label.type).toBe('string');
  });

  it('explicitly opens empty object schemas after tool root normalization and in nested properties', () => {
    const { tools } = sanitizeToolDeclarations([
      { name: 'no_parameters' },
      { name: 'no_properties', parameters: { type: 'object' } },
      {
        name: 'nested',
        parameters: { properties: {
          missing: { type: 'object' },
          empty: { type: 'object', properties: {} },
          unevaluatedAllowed: { type: 'object', unevaluatedProperties: true },
          emptyPatterns: { type: 'object', patternProperties: {} },
        } },
      },
    ]);

    expect(tools[0].inputSchema).toEqual({ type: 'object', properties: {}, additionalProperties: true });
    expect(tools[1].inputSchema).toEqual(tools[0].inputSchema);
    expect(tools[2].inputSchema).toEqual({ type: 'object', properties: {
      missing: { type: 'object', additionalProperties: true },
      empty: { type: 'object', properties: {}, additionalProperties: true },
      unevaluatedAllowed: { type: 'object', unevaluatedProperties: true, additionalProperties: true },
      emptyPatterns: { type: 'object', patternProperties: {}, additionalProperties: true },
    } });
  });

  it.each([
    { additionalProperties: false },
    { additionalProperties: { type: 'string' } },
    { unevaluatedProperties: false },
    { unevaluatedProperties: { type: 'string' } },
    { properties: { known: { type: 'string' } } },
    { patternProperties: { '^known': { type: 'string' } } },
  ])('preserves object constraints %j', (constraint) => {
    const { tools } = sanitizeToolDeclarations([
      { name: 'constrained', parameters: { type: 'object', ...constraint } },
    ]);
    expect(tools[0].inputSchema).toEqual({ type: 'object', properties: {}, ...constraint });
  });

  it('retains an allOf branch or sibling closure and preserves known properties', () => {
    const { tools } = sanitizeToolDeclarations([
      { name: 'branch_closed', parameters: { allOf: [
        { type: 'object', additionalProperties: false },
        { type: 'object', properties: {} },
        { type: 'object', additionalProperties: true },
      ] } },
      { name: 'sibling_closed', parameters: { additionalProperties: false, allOf: [
        { type: 'object', properties: {} },
      ] } },
      { name: 'known_branch', parameters: { allOf: [
        { type: 'object' }, { properties: { known: { type: 'string' } } },
      ] } },
      { name: 'branch_unevaluated', parameters: { allOf: [
        { type: 'object' }, { unevaluatedProperties: false },
      ] } },
      { name: 'branch_pattern', parameters: { allOf: [
        { type: 'object' }, { patternProperties: { '^known': false } },
      ] } },
    ]);
    const closed = { type: 'object', properties: {}, additionalProperties: false };
    expect(tools.map(({ inputSchema }) => inputSchema)).toEqual([
      closed,
      closed,
      { type: 'object', properties: { known: { type: 'string' } } },
      { type: 'object', properties: {}, unevaluatedProperties: false },
      { type: 'object', properties: {}, patternProperties: { '^known': false } },
    ]);
  });

  it('truncates long tool names and avoids reserved names with collision-free mapping', () => {
    const used = new Set<string>();
    const reserved = normalizeMcpToolName('await_result', used);
    expect(reserved).not.toBe('await_result');

    const longName = 'a'.repeat(80);
    const sanitizedLong = normalizeMcpToolName(longName, used);
    expect(sanitizedLong.length).toBeLessThanOrEqual(64);

    const sanitizedLong2 = normalizeMcpToolName(longName, used);
    expect(sanitizedLong2.length).toBeLessThanOrEqual(64);
    expect(sanitizedLong2).not.toBe(sanitizedLong);
  });

  it('strips toolSummary from top-level required while preserving properties.toolSummary and setting expectsToolSummary', () => {
    const result = sanitizeToolDeclarations([
      {
        name: 'run_command',
        description: 'Run a shell command',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string' },
            toolSummary: { type: 'string', description: 'Short summary' },
          },
          required: ['command', 'toolSummary'],
        },
      },
      {
        name: 'custom_only_summary',
        description: 'Tool whose only required field is toolSummary',
        parameters: {
          type: 'object',
          properties: {
            toolSummary: { type: 'string' },
            optionalFlag: { type: 'boolean' },
          },
          required: ['toolSummary'],
        },
      },
      {
        name: 'plain_tool',
        description: 'Tool without toolSummary',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
          },
          required: ['query'],
        },
      },
    ]);

    expect(result.tools.length).toBe(3);

    const runCmd = result.tools[0]!;
    expect(runCmd.expectsToolSummary).toBe(true);
    expect((runCmd.inputSchema.properties as Record<string, unknown>).toolSummary).toEqual({
      type: 'string',
      description: 'Short summary',
    });
    expect(runCmd.inputSchema.required).toEqual(['command']);

    const onlySummary = result.tools[1]!;
    expect(onlySummary.expectsToolSummary).toBe(true);
    expect((onlySummary.inputSchema.properties as Record<string, unknown>).toolSummary).toEqual({
      type: 'string',
    });
    expect(onlySummary.inputSchema.required).toBeUndefined();

    const plain = result.tools[2]!;
    expect(plain.expectsToolSummary).toBe(false);
    expect(plain.inputSchema.required).toEqual(['query']);
  });
});
