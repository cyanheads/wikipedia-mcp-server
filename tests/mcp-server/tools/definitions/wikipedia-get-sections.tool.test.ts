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

  it('throws invalid_language with data.reason when language code is malformed (issue #5)', async () => {
    const ctx = createMockContext({ errors: wikipediaGetSections.errors });
    const input = wikipediaGetSections.input.parse({ title: 'Python', language: 'INVALID!!' });
    await expect(wikipediaGetSections.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_language' },
    });
  });

  it('throws not_found with data.reason when article is missing (issue #12)', async () => {
    const { notFound } = await import('@cyanheads/mcp-ts-core/errors');
    vi.spyOn(svcModule, 'getWikipediaService').mockReturnValue({
      getSections: vi
        .fn()
        .mockRejectedValue(
          notFound('No Wikipedia article found for "ZZZMissing" in language "en".'),
        ),
    } as unknown as svcModule.WikipediaService);

    const ctx = createMockContext({ errors: wikipediaGetSections.errors });
    const input = wikipediaGetSections.input.parse({ title: 'ZZZMissing' });
    await expect(wikipediaGetSections.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'not_found' },
    });
  });

  it('passes non-default language to service', async () => {
    const getSectionsFn = vi.fn().mockResolvedValue({
      pageid: 9999,
      sections: [{ index: 1, number: '1', title: 'Histoire', level: 2 }],
    });
    vi.spyOn(svcModule, 'getWikipediaService').mockReturnValue({
      getSections: getSectionsFn,
    } as unknown as svcModule.WikipediaService);

    const ctx = createMockContext();
    const input = wikipediaGetSections.input.parse({ title: 'Python (langage)', language: 'fr' });
    const result = await wikipediaGetSections.handler(input, ctx);

    expect(getSectionsFn).toHaveBeenCalledWith('Python (langage)', 'fr', ctx);
    expect(result.language).toBe('fr');
  });

  it('total_sections matches sections array length', async () => {
    vi.spyOn(svcModule, 'getWikipediaService').mockReturnValue({
      getSections: vi.fn().mockResolvedValue(mockSections),
    } as unknown as svcModule.WikipediaService);

    const ctx = createMockContext();
    const input = wikipediaGetSections.input.parse({ title: 'Python (programming language)' });
    const result = await wikipediaGetSections.handler(input, ctx);

    expect(result.total_sections).toBe(result.sections.length);
  });

  it('format renders nested section hierarchy with indentation', () => {
    const output = {
      title: 'Python',
      pageid: 23862,
      sections: [
        { index: 1, number: '1', title: 'History', level: 2 },
        { index: 2, number: '2', title: 'Design', level: 2 },
        { index: 3, number: '2.1', title: 'Syntax', level: 3 },
      ],
      total_sections: 3,
      language: 'en',
    };
    const blocks = wikipediaGetSections.format!(output);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('Syntax');
    expect(text).toContain('2.1');
    expect(text).toContain('3 sections');
  });

  it('format output does not expose secrets or env var names', () => {
    const output = {
      title: 'Python',
      pageid: 1,
      sections: [{ index: 1, number: '1', title: 'Intro', level: 2 }],
      total_sections: 1,
      language: 'en',
    };
    const blocks = wikipediaGetSections.format!(output);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).not.toMatch(/WIKIPEDIA_USER_AGENT|WIKIPEDIA_BASE_URL|process\.env/i);
    expect(text).not.toMatch(/Bearer\s+\S+|Authorization:/i);
  });

  it('non-McpError from service propagates without wrapping', async () => {
    vi.spyOn(svcModule, 'getWikipediaService').mockReturnValue({
      getSections: vi.fn().mockRejectedValue(new Error('Network failure')),
    } as unknown as svcModule.WikipediaService);

    const ctx = createMockContext({ errors: wikipediaGetSections.errors });
    const input = wikipediaGetSections.input.parse({ title: 'Python' });
    await expect(wikipediaGetSections.handler(input, ctx)).rejects.toThrow('Network failure');
  });
});
