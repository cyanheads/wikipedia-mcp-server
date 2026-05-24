/**
 * @fileoverview Tests for wikipedia_get_sections tool.
 * @module tests/mcp-server/tools/definitions/wikipedia-get-sections.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { wikipediaGetSections } from '@/mcp-server/tools/definitions/wikipedia-get-sections.tool.js';
import * as svcModule from '@/services/wikipedia/wikipedia-service.js';

const mockSections = {
  pageid: 23862,
  sections: [
    { index: 1, number: '1', title: 'History', level: 2 },
    { index: 2, number: '2', title: 'Design philosophy', level: 2 },
    { index: 3, number: '2.1', title: 'Syntax', level: 3 },
  ],
};

describe('wikipediaGetSections', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns sections for a valid article', async () => {
    vi.spyOn(svcModule, 'getWikipediaService').mockReturnValue({
      getSections: vi.fn().mockResolvedValue(mockSections),
    } as unknown as svcModule.WikipediaService);

    const ctx = createMockContext();
    const input = wikipediaGetSections.input.parse({ title: 'Python (programming language)' });
    const result = await wikipediaGetSections.handler(input, ctx);

    expect(result.sections).toHaveLength(3);
    expect(result.sections[0]).toEqual({ index: 1, number: '1', title: 'History', level: 2 });
    expect(result.total_sections).toBe(3);
    expect(result.pageid).toBe(23862);
  });

  it('throws no_sections when article has no sections', async () => {
    vi.spyOn(svcModule, 'getWikipediaService').mockReturnValue({
      getSections: vi.fn().mockResolvedValue({ pageid: 1, sections: [] }),
    } as unknown as svcModule.WikipediaService);

    const ctx = createMockContext({ errors: wikipediaGetSections.errors });
    const input = wikipediaGetSections.input.parse({ title: 'Stub Article' });
    await expect(wikipediaGetSections.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_sections' },
    });
  });

  it('format renders section indices, levels, and titles', () => {
    const output = {
      title: 'Python',
      pageid: 23862,
      sections: [
        { index: 1, number: '1', title: 'History', level: 2 },
        { index: 2, number: '2', title: 'Design', level: 2 },
      ],
      total_sections: 2,
      language: 'en',
    };
    const blocks = wikipediaGetSections.format!(output);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('History');
    expect(text).toContain('Design');
    expect(text).toContain('index: 1');
    expect(text).toContain('index: 2');
    expect(text).toContain('2 sections');
  });
});
