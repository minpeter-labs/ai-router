import { describe, it, expect } from 'vitest';

import {
  defaultShouldRetryThisError,
  normalizeError,
  surfaceFailure,
} from './retry';

describe('defaultShouldRetryThisError', () => {
  it('retries the explicit retryable status codes', () => {
    for (const statusCode of [401, 403, 408, 409, 413, 429, 498]) {
      expect(defaultShouldRetryThisError({ statusCode })).toBe(true);
    }
  });

  it('retries any 5xx status code', () => {
    for (const statusCode of [500, 502, 503, 504, 599]) {
      expect(defaultShouldRetryThisError({ statusCode })).toBe(true);
    }
  });

  it('STOPS on a 4xx client error that is not in the retryable set', () => {
    for (const statusCode of [400, 404, 410, 422]) {
      expect(defaultShouldRetryThisError({ statusCode })).toBe(false);
    }
  });

  it('retries any error without a recognizable status (preserves legacy retry-on-any-throw)', () => {
    // No statusCode -> treated as transient/unknown -> retried, regardless of message.
    expect(defaultShouldRetryThisError(new Error('boom'))).toBe(true);
    expect(defaultShouldRetryThisError(new Error('first failure'))).toBe(true);
    expect(defaultShouldRetryThisError(new Error('overloaded'))).toBe(true);
    expect(defaultShouldRetryThisError('overloaded 503')).toBe(true);
    expect(defaultShouldRetryThisError({ error: 'capacity exceeded' })).toBe(true);
    expect(defaultShouldRetryThisError(null)).toBe(true);
  });

  it('still retries a transient status even when the message looks terminal', () => {
    expect(defaultShouldRetryThisError({ statusCode: 503, message: 'bad request' })).toBe(true);
  });
});

describe('normalizeError', () => {
  it('reads statusCode from statusCode and status', () => {
    expect(normalizeError({ statusCode: 429 }).statusCode).toBe(429);
    expect(normalizeError({ status: 503 }).statusCode).toBe(503);
  });

  it('ignores a non-numeric code (e.g. ECONNRESET) and lowercases the message', () => {
    const out = normalizeError({ code: 'ECONNRESET', message: 'Socket HANG UP' });
    expect(out.statusCode).toBeUndefined();
    expect(out.message).toBe('socket hang up');
  });

  it('JSON-stringifies an object error that lacks a message string', () => {
    const out = normalizeError({ error: 'Capacity' });
    expect(out.message).toContain('capacity');
  });

  it('handles null/undefined and primitive errors', () => {
    expect(normalizeError(null).message).toBe('');
    expect(normalizeError('Boom').message).toBe('boom');
  });
});

describe('surfaceFailure', () => {
  it('returns the single error verbatim (identity preserved)', () => {
    const e = new Error('only failure');
    expect(surfaceFailure([e], 'chat')).toBe(e);
  });

  it('aggregates multiple errors with the last message embedded', () => {
    const e1 = new Error('first failure');
    const e2 = new Error('second failure');
    const e3 = new Error('last failure');
    const surfaced = surfaceFailure([e1, e2, e3], 'chat') as AggregateError;

    expect(surfaced).toBeInstanceOf(AggregateError);
    expect(surfaced.errors).toHaveLength(3);
    expect(surfaced.errors).toEqual([e1, e2, e3]);
    expect(surfaced.message).toContain('last failure');
    expect(surfaced.message).toContain('chat');
  });
});
