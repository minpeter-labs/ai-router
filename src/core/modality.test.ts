import { describe, expect, it } from 'vitest';

import { detectModalities, supportsAll } from './modality';
import type { Modality } from './types';

// Helpers ---------------------------------------------------------------------

/** A model-level (V4) file part. `data` is irrelevant to detection — only
 *  `mediaType` is read — so a URL tag is used (no fetch happens in detection). */
function filePart(mediaType: string) {
  return {
    type: 'file' as const,
    mediaType,
    data: { type: 'url' as const, url: new URL('https://x/y.bin') },
  };
}

/** detectModalities returns a Set; assert as a sorted array for determinism. */
function sortedModalities(
  prompt: Parameters<typeof detectModalities>[0],
): Modality[] {
  return [...detectModalities(prompt)].sort();
}

function sorted(mods: Modality[]): Modality[] {
  return [...mods].sort();
}

describe('detectModalities', () => {
  it('maps a system message to text', () => {
    expect(sortedModalities([{ role: 'system', content: 'be nice' }])).toEqual([
      'text',
    ]);
  });

  it('maps a text part to text', () => {
    expect(
      sortedModalities([
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      ]),
    ).toEqual(['text']);
  });

  it('maps a reasoning part to text', () => {
    expect(
      sortedModalities([
        {
          role: 'assistant',
          content: [{ type: 'reasoning', text: 'thinking...' }],
        },
      ]),
    ).toEqual(['text']);
  });

  it('maps image via full media type (image/png) to image', () => {
    expect(
      sortedModalities([{ role: 'user', content: [filePart('image/png')] }]),
    ).toEqual(['image']);
  });

  it('maps image via wildcard media type (image/*) to image', () => {
    expect(
      sortedModalities([{ role: 'user', content: [filePart('image/*')] }]),
    ).toEqual(['image']);
  });

  it('maps image via bare top-level media type (image) to image', () => {
    expect(
      sortedModalities([{ role: 'user', content: [filePart('image')] }]),
    ).toEqual(['image']);
  });

  it('maps video (video/mp4) to video', () => {
    expect(
      sortedModalities([{ role: 'user', content: [filePart('video/mp4')] }]),
    ).toEqual(['video']);
  });

  it('maps audio (audio/mpeg) to audio', () => {
    expect(
      sortedModalities([{ role: 'user', content: [filePart('audio/mpeg')] }]),
    ).toEqual(['audio']);
  });

  it('maps pdf via application/pdf to pdf', () => {
    expect(
      sortedModalities([
        { role: 'user', content: [filePart('application/pdf')] },
      ]),
    ).toEqual(['pdf']);
  });

  it('maps pdf via application/x-pdf to pdf', () => {
    expect(
      sortedModalities([
        { role: 'user', content: [filePart('application/x-pdf')] },
      ]),
    ).toEqual(['pdf']);
  });

  it('ignores unknown media types (application/octet-stream) — not added', () => {
    expect(
      sortedModalities([
        { role: 'user', content: [filePart('application/octet-stream')] },
      ]),
    ).toEqual([]);
  });

  it('collects the set of all modalities across mixed parts (text + image + pdf)', () => {
    expect(
      sortedModalities([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look at these' },
            filePart('image/png'),
            filePart('application/pdf'),
          ],
        },
      ]),
    ).toEqual(sorted(['text', 'image', 'pdf']));
  });

  it('returns an empty set for an empty prompt', () => {
    expect(sortedModalities([])).toEqual([]);
  });

  it('ignores tool-call and tool-result parts', () => {
    expect(
      sortedModalities([
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 't1',
              toolName: 'lookup',
              input: { q: 'x' },
            },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 't1',
              toolName: 'lookup',
              output: { type: 'text', value: 'result' },
            },
          ],
        },
      ]),
    ).toEqual([]);
  });

  it('detects only real modalities when tool parts are mixed with content', () => {
    expect(
      sortedModalities([
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'calling tool' },
            {
              type: 'tool-call',
              toolCallId: 't1',
              toolName: 'lookup',
              input: { q: 'x' },
            },
          ],
        },
        {
          role: 'user',
          content: [filePart('audio/mpeg')],
        },
      ]),
    ).toEqual(sorted(['text', 'audio']));
  });
});

describe('supportsAll', () => {
  it('returns true when required is a subset of supports', () => {
    expect(
      supportsAll(['text', 'image', 'pdf'], new Set(['text', 'image'])),
    ).toBe(true);
  });

  it('returns true when required equals supports', () => {
    expect(supportsAll(['text', 'image'], new Set(['text', 'image']))).toBe(
      true,
    );
  });

  it('returns false when a required modality is missing from supports', () => {
    expect(supportsAll(['text'], new Set(['text', 'image']))).toBe(false);
  });

  it('returns true for an empty required set', () => {
    expect(supportsAll(['text'], new Set())).toBe(true);
  });

  it('returns true for an empty required set even when supports is empty', () => {
    expect(supportsAll([], new Set())).toBe(true);
  });

  it('returns false when supports is empty but a modality is required', () => {
    expect(supportsAll([], new Set(['text']))).toBe(false);
  });
});
