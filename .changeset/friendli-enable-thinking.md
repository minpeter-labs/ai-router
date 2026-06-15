---
"@minpeter/ai-router": patch
---

Friendli reasoning translation now sends both `chat_template_kwargs.thinking` and `chat_template_kwargs.enable_thinking` (same boolean). Friendli's reasoning toggle is model-dependent — most models read `thinking`, but some (e.g. Gemma 4) read `enable_thinking`. Emitting both makes the plain `reasoning` option drive thinking on/off regardless of which field the target model honors; a model ignores the field it doesn't recognize. Backward compatible.
