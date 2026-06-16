---
"@minpeter/ai-router": patch
---

Add an OpenGateway provider entrypoint at `@minpeter/ai-router/opengateway`. It defaults to `https://apis.opengateway.ai/v1`, reads `OPENGATEWAY_API_KEY`, passes supported AI SDK `reasoning` levels through as OpenGateway's OpenAI-compatible `reasoning_effort` field, and preserves OpenGateway `reasoning_content` / `reasoning_details` across AI SDK multi-step and multi-turn messages.
