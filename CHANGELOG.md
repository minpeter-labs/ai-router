# @minpeter/ai-router

## 0.0.1

### Patch Changes

- bd99b0d: The plain `reasoning` option now controls reasoning on **and** off. A `transformParams` middleware on each provider promotes the call-level `reasoning` value (including `'none'`, which the AI SDK would otherwise drop) into `providerOptions.<provider>.reasoningEffort`, so `reasoning: 'none'` disables thinking without needing `providerOptions`.
