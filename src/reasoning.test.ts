import { describe, it, expect } from 'vitest';

import { reasoningMiddleware, translateReasoning } from './reasoning';

// Pure unit tests for translateReasoning. No AI SDK needed — it's a plain
// body-in / body-out transform.

describe('translateReasoning', () => {
  describe('friendli dialect (chat_template_kwargs.thinking)', () => {
    const transform = translateReasoning('friendli');

    for (const effort of ['low', 'medium', 'high', 'minimal', 'xhigh'] as const) {
      it(`maps reasoning_effort '${effort}' -> thinking=true`, () => {
        const out = transform({ model: 'm', reasoning_effort: effort });
        expect(out.chat_template_kwargs).toEqual({ thinking: true });
        expect('reasoning_effort' in out).toBe(false);
      });
    }

    it('maps reasoning_effort true -> thinking=true', () => {
      const out = transform({ reasoning_effort: true });
      expect(out.chat_template_kwargs).toEqual({ thinking: true });
      expect('reasoning_effort' in out).toBe(false);
    });

    it("maps reasoning_effort 'none' -> thinking=false", () => {
      const out = transform({ reasoning_effort: 'none' });
      expect(out.chat_template_kwargs).toEqual({ thinking: false });
      expect('reasoning_effort' in out).toBe(false);
    });

    it('maps reasoning_effort false -> thinking=false', () => {
      const out = transform({ reasoning_effort: false });
      expect(out.chat_template_kwargs).toEqual({ thinking: false });
      expect('reasoning_effort' in out).toBe(false);
    });

    it('merges into an existing chat_template_kwargs, preserving other keys', () => {
      const out = transform({
        reasoning_effort: 'high',
        chat_template_kwargs: { foo: 'bar', enable_thinking: 1 },
      });
      expect(out.chat_template_kwargs).toEqual({
        foo: 'bar',
        enable_thinking: 1,
        thinking: true,
      });
      expect('reasoning_effort' in out).toBe(false);
    });

    it('overrides an existing thinking key in chat_template_kwargs', () => {
      const out = transform({
        reasoning_effort: 'none',
        chat_template_kwargs: { thinking: true, keep: 'me' },
      });
      expect(out.chat_template_kwargs).toEqual({ thinking: false, keep: 'me' });
    });

    it('does not write a reasoning (openrouter) key', () => {
      const out = transform({ reasoning_effort: 'high' });
      expect('reasoning' in out).toBe(false);
    });
  });

  describe('openrouter dialect (reasoning.enabled)', () => {
    const transform = translateReasoning('openrouter');

    for (const effort of ['low', 'medium', 'high', 'minimal', 'xhigh'] as const) {
      it(`maps reasoning_effort '${effort}' -> reasoning.enabled=true`, () => {
        const out = transform({ model: 'm', reasoning_effort: effort });
        expect(out.reasoning).toEqual({ enabled: true });
        expect('reasoning_effort' in out).toBe(false);
      });
    }

    it('maps reasoning_effort true -> reasoning.enabled=true', () => {
      const out = transform({ reasoning_effort: true });
      expect(out.reasoning).toEqual({ enabled: true });
      expect('reasoning_effort' in out).toBe(false);
    });

    it("maps reasoning_effort 'none' -> reasoning.enabled=false", () => {
      const out = transform({ reasoning_effort: 'none' });
      expect(out.reasoning).toEqual({ enabled: false });
      expect('reasoning_effort' in out).toBe(false);
    });

    it('maps reasoning_effort false -> reasoning.enabled=false', () => {
      const out = transform({ reasoning_effort: false });
      expect(out.reasoning).toEqual({ enabled: false });
      expect('reasoning_effort' in out).toBe(false);
    });

    it('merges into an existing reasoning object, preserving other keys', () => {
      const out = transform({
        reasoning_effort: 'medium',
        reasoning: { max_tokens: 2048, exclude: false },
      });
      expect(out.reasoning).toEqual({
        max_tokens: 2048,
        exclude: false,
        enabled: true,
      });
      expect('reasoning_effort' in out).toBe(false);
    });

    it('overrides an existing enabled key in reasoning', () => {
      const out = transform({
        reasoning_effort: 'none',
        reasoning: { enabled: true, keep: 'me' },
      });
      expect(out.reasoning).toEqual({ enabled: false, keep: 'me' });
    });

    it('does not write a chat_template_kwargs (friendli) key', () => {
      const out = transform({ reasoning_effort: 'high' });
      expect('chat_template_kwargs' in out).toBe(false);
    });
  });

  describe('absent / nullish reasoning_effort -> body unchanged', () => {
    for (const dialect of ['friendli', 'openrouter'] as const) {
      const transform = translateReasoning(dialect);

      it(`${dialect}: absent reasoning_effort returns deep-equal body`, () => {
        const input = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };
        const out = transform(input);
        expect(out).toEqual(input);
        // No dialect-specific key should have been added.
        expect('chat_template_kwargs' in out).toBe(false);
        expect('reasoning' in out).toBe(false);
      });

      it(`${dialect}: explicit undefined reasoning_effort returns deep-equal body`, () => {
        const input = { model: 'm', reasoning_effort: undefined };
        const out = transform(input);
        expect(out).toEqual(input);
        expect('chat_template_kwargs' in out).toBe(false);
        expect('reasoning' in out).toBe(false);
      });

      it(`${dialect}: null reasoning_effort returns deep-equal body`, () => {
        const input = { model: 'm', reasoning_effort: null };
        const out = transform(input);
        expect(out).toEqual(input);
        expect('chat_template_kwargs' in out).toBe(false);
        expect('reasoning' in out).toBe(false);
      });

      it(`${dialect}: preserves an existing dialect object when no effort requested`, () => {
        const input =
          dialect === 'friendli'
            ? { model: 'm', chat_template_kwargs: { thinking: true } }
            : { model: 'm', reasoning: { enabled: true } };
        const out = transform(input);
        expect(out).toEqual(input);
      });
    }
  });

  describe('immutability', () => {
    for (const dialect of ['friendli', 'openrouter'] as const) {
      const transform = translateReasoning(dialect);

      it(`${dialect}: does not mutate input (input keeps reasoning_effort, output is a new reference)`, () => {
        const input = { model: 'm', reasoning_effort: 'high' };
        const out = transform(input);
        // Input untouched.
        expect(input.reasoning_effort).toBe('high');
        expect('chat_template_kwargs' in input).toBe(false);
        expect('reasoning' in input).toBe(false);
        // Output is a different object.
        expect(out).not.toBe(input);
      });

      it(`${dialect}: does not mutate a nested existing dialect object on the input`, () => {
        const nested =
          dialect === 'friendli'
            ? { foo: 'bar' }
            : { max_tokens: 100 };
        const input: Record<string, any> = { reasoning_effort: 'low' };
        if (dialect === 'friendli') input.chat_template_kwargs = nested;
        else input.reasoning = nested;

        const out = transform(input);

        // The nested object on the input is unchanged (new object on output).
        expect(nested).toEqual(
          dialect === 'friendli' ? { foo: 'bar' } : { max_tokens: 100 },
        );
        const outNested =
          dialect === 'friendli' ? out.chat_template_kwargs : out.reasoning;
        expect(outNested).not.toBe(nested);
      });

      it(`${dialect}: returns a new reference even when reasoning_effort is absent`, () => {
        const input = { model: 'm' };
        const out = transform(input);
        expect(out).not.toBe(input);
        expect(out).toEqual(input);
      });
    }
  });
});

// Unit tests for the `reasoningMiddleware` transformParams hook. It runs on the
// call options (where `reasoning` still carries 'none') and promotes that value
// into `providerOptions.<name>.reasoningEffort` so the downstream body keeps it.
describe('reasoningMiddleware', () => {
  const transform = (params: Record<string, any>, name = 'friendli') => {
    const mw = reasoningMiddleware(name);
    // transformParams is the only hook this middleware defines.
    return mw.transformParams!({
      params: params as any,
      type: 'generate',
      model: {} as any,
    });
  };

  for (const reasoning of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const) {
    it(`promotes reasoning '${reasoning}' into providerOptions.<name>.reasoningEffort`, async () => {
      const out = await transform({ reasoning });
      expect(out.providerOptions).toEqual({ friendli: { reasoningEffort: reasoning } });
      // The original `reasoning` option is left in place; providerOptions wins downstream.
      expect(out.reasoning).toBe(reasoning);
    });
  }

  it('uses the provider name as the providerOptions key', async () => {
    const out = await transform({ reasoning: 'none' }, 'openrouter');
    expect(out.providerOptions).toEqual({ openrouter: { reasoningEffort: 'none' } });
  });

  it('merges into existing providerOptions for other providers', async () => {
    const out = await transform({
      reasoning: 'high',
      providerOptions: { openrouter: { somethingElse: true } },
    });
    expect(out.providerOptions).toEqual({
      openrouter: { somethingElse: true },
      friendli: { reasoningEffort: 'high' },
    });
  });

  it('preserves other keys already under the same provider', async () => {
    const out = await transform({
      reasoning: 'low',
      providerOptions: { friendli: { user: 'u' } },
    });
    expect(out.providerOptions).toEqual({
      friendli: { user: 'u', reasoningEffort: 'low' },
    });
  });

  it('does not clobber an explicit reasoningEffort', async () => {
    const params = {
      reasoning: 'high',
      providerOptions: { friendli: { reasoningEffort: 'none' } },
    };
    const out = await transform(params);
    expect(out.providerOptions).toEqual({ friendli: { reasoningEffort: 'none' } });
    // Returned verbatim — nothing to promote.
    expect(out).toBe(params);
  });

  for (const reasoning of [undefined, 'provider-default'] as const) {
    it(`leaves params untouched when reasoning is ${reasoning ?? 'absent'}`, async () => {
      const params = reasoning === undefined ? { foo: 1 } : { reasoning, foo: 1 };
      const out = await transform(params);
      expect(out).toBe(params);
      expect('providerOptions' in out).toBe(false);
    });
  }

  it('does not mutate the input params', async () => {
    const params: Record<string, any> = {
      reasoning: 'high',
      providerOptions: { friendli: { user: 'u' } },
    };
    await transform(params);
    expect(params.providerOptions).toEqual({ friendli: { user: 'u' } });
  });
});
