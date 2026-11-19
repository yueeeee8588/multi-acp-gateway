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
});
