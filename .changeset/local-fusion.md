---
'@minpeter/ai-router': minor
---

Add `createFusion` (`@minpeter/ai-router/fusion`): a local, provider-agnostic
multi-model deliberation model. A panel answers in parallel, a judge compares the
answers into structured analysis (consensus / contradictions / partial coverage /
unique insights / blind spots), and a synth model writes the final answer — all
built on `LanguageModelV4` calls, with no dependency on any hosted fusion service.

Returns a `LanguageModelV4`, so it drops straight into `generateText`/`streamText`
and composes with `createRouter` both ways (fusion-as-candidate and router-as-panel-member).
Features: parallel fault-tolerant panel with per-member fallback, modality-aware
panel selection, structured-JSON judging that degrades gracefully, synth fallback
ladder, streaming of the final answer only, lifecycle `onEvent` tracing, and a
recursion guard.
