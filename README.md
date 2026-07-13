# @minpeter/ai-router

Provider-agnostic, modality-aware language model router with fallback for the
[Vercel AI SDK](https://sdk.vercel.ai) (v7 / provider spec v4).

```bash
pnpm add @minpeter/ai-router ai @ai-sdk/openai-compatible
```

The package ships ESM/CJS entrypoints and Node16/NodeNext-compatible
declarations for the root API and every provider subpath. Published sourcemaps
contain only `src/**/*.ts`; build gates reject unexpected tarball entries,
missing export targets, non-canonical/non-source map inputs, incomplete embedded
sources, non-canonical nested export targets, and credential-shaped content
anywhere in the published text files.

## Router

```ts
import { createRouter } from '@minpeter/ai-router';
import { createFriendli } from '@minpeter/ai-router/friendli';
import { createOpenRouter } from '@minpeter/ai-router/openrouter';
import { generateText } from 'ai';

const friendli = createFriendli();
const openrouter = createOpenRouter();

const onError = ({ logicalId, error }) => console.warn(`[${logicalId}]`, error);

const router = createRouter({
  models: {
    kimi: [
      { provider: friendli,   model: 'moonshotai/Kimi-K2.5', supports: ['text'] },
      { provider: openrouter, model: 'moonshotai/kimi-k2.5', supports: ['text', 'image', 'video'] },
    ],
  },
  onError,
});

// `router('kimi')` returns a delegating model: it picks the first candidate
// whose `supports` covers the prompt's modalities, and falls back on error.
const model = router('kimi');

await generateText({
  model,             // the createRouter result
  messages,
  reasoning: 'low',  // forwarded to whichever candidate handles the request
});
```

For each request the router:

1. Detects the input modalities present in the prompt (`text`, `image`,
   `video`, `audio`, `pdf`, and generic `file` for other media types).
2. Keeps the candidate entries whose `supports` covers them, in order.
3. Tries each candidate, calling `onError` and falling through on **retryable**
   failures (see below).
4. Throws if no candidate matches the modalities, or all matching candidates
   fail.

## Entry shapes

A candidate may be written three ways, mixed freely in one list:

```ts
createRouter({
  models: {
    kimi: [
      { provider: friendli, model: 'moonshotai/Kimi-K2.5', supports: ['text'] }, // factory
      { model: openrouter('moonshotai/kimi-k2.5'), supports: ['text', 'image'] }, // instance + supports
      anthropic('claude-haiku-4-5'),                                              // bare instance
    ],
  },
});
```

`supports` is **optional** — omit it and the entry becomes a universal
candidate that matches any modality (a handy catch-all / fallback tail).
Capability arrays are copied by bounded index without invoking caller-defined
array methods or iterators. Candidate arrays receive the same indexed snapshot
before route construction.
Use `supports: ['file']` (usually alongside `text`) for non-image/audio/video/PDF
attachments such as CSV, JSON, or `application/octet-stream`; they are not
silently routed to explicitly text-only candidates.
Assistant reasoning files and files nested in tool-result content participate
in the same modality filtering as direct user file parts.

## Fallback & retries

Failures are **classified** (by HTTP `statusCode`) before the router falls
through:

- A retryable status — `5xx` and provider-scoped
  `400/401/402/403/408/409/412/413/422/429/498` failures — falls through to the
  next candidate. These commonly represent endpoint dialect, credentials,
  quota, or provider-side validation that can differ across candidates.
- A `404` falls through only when its error details identify a missing model or
  missing model-serving endpoint, or exhausted provider credit; unrelated
  resource-not-found errors still stop.
- A recognized non-retryable client error (a `4xx` carrying a `statusCode`,
  such as an unrelated `404`/`410`) **stops immediately** and is surfaced.
- A caller **abort / timeout** (your `abortSignal` fired, or a `TimeoutError`)
  **stops immediately** — it is never fanned out to other candidates.
- Abort-like Error names are captured once before matching, so accessor-backed
  provider errors cannot change identity between name variants.
- Runtimes exposing `Error.isError` also recognize genuine cross-realm abort
  errors without trusting plain objects that merely spoof an abort name.
- Anything else without a recognizable status (including a bare thrown `Error`)
  is treated as transient and retried — the historical behavior. Pass a custom
  `fallback.shouldRetry` for message-based, broader, or stricter policies; the
  custom boolean decision replaces the default retry decision.

Each provider attempt receives an isolated copy of mutable V4 option
containers, including prompt parts, tools, headers, stop sequences, schemas,
and provider JSON options. A failing provider therefore cannot rewrite the
request seen by a later fallback candidate or by the caller. Opaque binary and
URL leaves retain their identity. Hostile option accessors fail as terminal
request-contract errors before provider health or retry state is changed,
including the caller's initial `abortSignal` accessor.

All fallback tuning lives under one optional `fallback` object:

```ts
import { defaultShouldRetryThisError } from '@minpeter/ai-router';

createRouter({
  models,
  fallback: {
    // Replaces the default classifier. Compose on top of the bundled default:
    shouldRetry: (error) => isMyTransient(error) || defaultShouldRetryThisError(error),
    retryAfterOutput: false, // (default) — see below
    cooldown: '1m',          // see "Cooldown" below
    health: true,             // candidate/key/family circuit breaker
    healthNamespace: 'my-service:production',
    attemptTimeout: '20s',    // one provider opening a response
    firstContentTimeout: '10s',
    totalTimeout: '45s',
    maxAttempts: 3,
    backoff: '40ms',          // random 0..40ms between attempts
    retryBudget: true,         // opt-in 60s sliding outage circuit breaker
    // retryBudget: {
    //   window: '60s', minSamples: 5, maxSamples: 20,
    //   tripFailureRate: 0.8, recoveryFailureRate: 0.4,
    // },
    strictStreamValidation: true,
    selection: 'least-inflight', // or ordered / round-robin
    concurrencyWaitTimeout: '500ms',
  },
  onAttempt: event => metrics.record(event),
});
```

Internal attempt timeouts are retryable and move to the next provider. A
caller-owned `abortSignal` remains terminal and cancels the entire route, even
when a provider operation or already-open stream fails to observe its signal.
`totalTimeout` caps time spent opening fallback attempts, while
`firstContentTimeout` detects a stream that opened but never produced usable
output. Once a stream opens within that budget, `totalTimeout` does not cap its
normal generation/read duration; use caller cancellation and
`firstContentTimeout` for the corresponding live-stream boundaries. All timeout
and attempt limits are opt-in. If a fallback stream finishes opening only after
the total deadline, its transport is cancelled when it arrives; the timeout is
request-scoped, so that abandoned candidate does not train health, adaptive
concurrency, or the retry budget, while failures from earlier real attempts are
preserved. Caller abort during fallback opening follows the same cleanup and
censoring rules while preserving the caller's exact abort reason.
The exported `RouterTimeoutError` exposes `code` (`attempt_timeout`,
`first_content_timeout`, or `total_timeout`) and `durationMs` for typed handling.
Duration values are capped at 24 hours; positive fractional millisecond values
are rounded up so they cannot become accidental zero-delay timers.

**Mid-stream fallback.** An error that arrives _after_ the stream opens but
_before_ any content is emitted triggers a transparent fallback to the next
candidate — the failed candidate's error is swallowed, never shown to the
consumer. A stream that closes without a `finish` part, or emits `finish`
without meaningful text, reasoning, tool, or other output, is treated the same
way instead of being accepted as a successful empty/incomplete response. Once
content has streamed, the default (`fallback.retryAfterOutput:
false`) surfaces the error rather than risk duplicated output; set it `true` to
retry anyway (the next candidate re-emits from scratch, so output may
duplicate). This defaults `false` — unlike `ai-fallback`, which defaults `true`.

Non-streaming responses with no usable text, reasoning, tool call, or other
output payload are also treated as provider failures and fall through.
Generate envelopes are checked for known V4 content variants, required
finish/usage/warning fields, finite non-negative token counts, and readable
metadata. Stream finish metadata receives the same mandatory finish/usage
checks and follows `retryAfterOutput` if malformed after partial output.
Content, warning, finish, and stream-part discriminants must be literal bounded
strings; validation never invokes provider-defined string coercion.
Generate content is bounded at 10,000 parts and warning collections at 1,024
entries; strict stream lifecycle bookkeeping is likewise bounded to prevent a
malformed provider response from amplifying validation memory.
Warning variants are shape-checked on both paths, and generated tool-call IDs
must be unique. Provider-specific metadata is copied as bounded JSON so hostile
getters, cycles, sparse arrays, and later provider mutation cannot cross the
fallback boundary; standard JSON structure and values are preserved. Ordinary
JSON in raw stream chunks receives the same request-wide bounds and copy
isolation. Buffered metadata counting uses indexed bounded traversal and treats
hostile structure access as overflow without invoking custom array iterators.
Structured response format names and descriptions share the metadata
limits, preventing fallback attempts from repeatedly cloning oversized labels.
Unrecognized opaque runtime values such as `Response` remain pass-through
compatible; recognized byte arrays and URLs in file/raw parts are copied under
the payload budget described below. Unknown future stream-part objects also
retain identity, but their type is captured once so mutable/accessor-backed
values cannot later become router control parts. Validation budget consumed only by discarded pre-content
framing is rolled back before fallback, so a failed candidate cannot starve its
survivor; budget for already-emitted output remains cumulative.
Provider factories remain lazy. Successful models and permanent non-v4 results
are cached; a factory or model accessor that throws is not cached, so a later
request can recover after transient initialization failure. Permanent
invalid-model candidates use a one-hour routing-unit cooldown when health
tracking is enabled.
Accessor-backed factories are captured once and invoked with their original
entry receiver preserved, so method-style factories retain their `this`
contract while later accessor mutation remains isolated.
Model generate/stream methods retain the model receiver; specification,
provider, and model-id metadata are read once when the model is stabilized.
Optional `supportedUrls` remains lazy but is memoized after its first read and
fails closed on accessor errors. Missing provider/model-id metadata remains
compatible because the routed model supplies its own public identity.
Instance-entry model, modality, health identity, family, concurrency, and
adaptive-concurrency accessors are likewise read once during route
normalization; later entry mutation cannot redirect routing or admission.
Runtime model validation requires both V4 generate and stream methods. For a
single candidate, rejected async `supportedUrls` discovery degrades to `{}` so
the SDK downloads inputs conservatively instead of aborting an otherwise usable
model call. Discovery that never settles also degrades to `{}` after one second
instead of blocking model invocation indefinitely. Timer-cleanup failures
cannot leave an otherwise resolved discovery pending. URL capability maps are
mutation-isolated, cross-realm RegExp-aware,
prototype-safe, and bounded to 128 media types, 128 patterns per type, 1,024
patterns total, 4,096 characters per pattern, and 1 MiB of pattern source.
Each sync or async getter access receives fresh map, array, and RegExp copies,
so one consumer cannot mutate capability decisions for later SDK requests.
Async `supportedUrls` discovery accepts genuine Promises by native brand and
fails closed for custom thenables without reading or invoking their `then`
extension. Synchronous bounded capability maps remain supported.
Stream results that arrive only after their opening attempt timed out or was
aborted are cancelled best-effort, preventing detached upstream bodies from
continuing after fallback has moved on. Hostile result access, synchronous
cancel throws, and asynchronous cancel rejections are isolated because no
consumer remains. Native cancellation Promise rejections are consumed without
consulting arbitrary thenable extensions. Once a stream opens, `getReader`, `read`, `cancel`, and
`releaseLock` are each captured once with their receiver preserved, so provider
accessor mutation cannot change the reader contract between chunks or cleanup.
Each `read()` result is also snapshotted with one `done` and `value` read;
non-object or nonboolean envelopes become retryable pre-output stream failures.
`read()` must return a genuine Promise verified through the native Promise
brand operation; arbitrary thenable extension getters are never consulted.
Provider `doGenerate` and `doStream` operations obey the same genuine-Promise
contract in both timed and untimed paths, so a malformed thenable becomes a
retryable provider failure without executing its `then` extension.
Successful generate request and response bodies are copied within the shared
bounded JSON budget, preventing provider mutation from changing returned
diagnostic metadata after result validation.
Generated file strings, byte arrays, and URLs are bounded by a shared 64MiB
payload budget. `Uint8Array` and `URL` values are copied through intrinsic brand
operations, so provider mutation cannot change an accepted result and custom
iterators, species constructors, or `Symbol.toStringTag` extensions are not
invoked. The Uint8Array check calls the captured typed-array tag intrinsic
directly, retaining genuine cross-realm support. String and serialized URL
payloads are charged at two bytes per UTF-16 code unit. Generate and stream
parts use the same implementation; discarded pre-commit stream candidates roll
their charged payload budget back with the rest of the prelude budget.
Known `raw` stream parts deep-copy ordinary JSON and intrinsically copy
recognized byte-array/URL values under that budget. Unknown future part types
remain opaque and commit immediately: their schema cannot be traversed safely
without executing unknown extensions or breaking forward compatibility.
Every known stream part is copied by its declared fields, including ordinary
plain text/reasoning deltas; provider mutation after emission cannot alter the
object delivered to the consumer. Only unknown future types remain zero-copy.
Consumer cancellation is rechecked after asynchronous part snapshotting, so a
cancel in that boundary cannot emit content or record provider recovery.
If the local wrapper stream cannot be constructed, the opened upstream and its
admission/probe leases are released before the typed `RouterStreamError`
(`code: 'stream_unavailable'`) is surfaced.
Capacity and probe release hooks are isolated from one another and from stream
settlement, so a throwing cleanup adapter cannot suppress the other release,
interrupt fallback, or leave the pump marked active. Native Promise cleanup
results are consumed on setup failure, rollback, skip, cancellation, and normal
terminal release without inspecting arbitrary thenable extensions.
Optional health transitions, cooldown advancement, and retry-budget
classification/accounting are likewise isolated, so auxiliary state failures
cannot replace a successful stream or prevent the next candidate from opening.
Health-failure and retry-budget classifiers receive copies of the normalized
failure record, so hook mutation cannot rewrite later retry, terminal, budget,
or attempt-event decisions.
Health failure/success hooks also receive ownership-isolated candidate records:
`fullIndex` and probe-lease mutation cannot redirect the later capacity/probe
release, while model access remains lazy.
Native Promise results from ignored state hooks are consumed; budget
classification accepts only literal `true`, and arbitrary thenable extensions
remain uninspected.
Fallback request/response metadata becomes public only after the new reader is
successfully captured; a malformed intermediate candidate cannot temporarily
replace the last valid metadata snapshot.
If `getReader` access, invocation, or its returned shape fails before reader
ownership is established, the opened stream is cancelled best-effort before
fallback proceeds.
If reader method capture fails after `getReader()` has locked the upstream,
available cancel and release operations run immediately before fallback.
If caller cancellation wins before a
deferred provider operation starts, the provider is not invoked at all.
Total, backoff, admission, and first-content deadline arithmetic uses a
monotonic clock, so system wall-clock corrections do not extend or prematurely
exhaust request budgets. Attempt-duration observability uses the same clock, so
latency metrics do not spike or collapse during those corrections.
Throwing, negative, or non-finite platform clock samples degrade to a safe
zero sample instead of escaping from timeout, admission, or metrics paths.
Finite clock samples beyond the deadline-safe integer range are rejected as
well, preventing timeout arithmetic overflow.
Throwing/invalid random samples degrade to zero-delay backoff, and timer cleanup
failures cannot replace an already settled provider or admission outcome.
Backoff rechecks settlement immediately after timer registration, so a
non-standard synchronously firing timer cannot leave a late abort listener.
It performs the same recheck after listener registration, immediately invoking
the returned cleanup when registration itself synchronously delivers abort.
Timeout arbitration preserves the first captured caller reason, normalizing a
missing value once to `AbortError` without re-reading stateful abort accessors
in `catch`.
Ordering-token source creation also falls back to a process-local counter when
both Web Crypto and random entropy are unavailable.
Timer registration failure surfaces as the typed, request-scoped
`RouterTimerError` (`code: 'timer_unavailable'`) before a provider starts, so a
missing deadline mechanism cannot create detached attempts or fallback fan-out.
Provider operations with neither a timeout nor caller cancellation bypass
AbortController creation, preserving basic generation in minimal runtimes.
When cancellation infrastructure is required but unavailable, the request fails
before provider execution with `RouterCancellationError`
(`code: 'cancellation_unavailable'`) instead of fanning out. A throwing
`abort()` operation is isolated so the associated timeout or caller rejection
still settles.
Timeout and backoff cancellation recheck abort state after listener
registration, capture the reason once, and isolate listener cleanup failures.
The live fallback stream uses the same registration and cleanup guarantees for
its request-wide caller-abort forwarding.
Repeated delivery from a non-conforming signal is ignored after the first
abort, preserving one captured reason across every cancellation path.
Abort listener methods are captured once per signal with their receiver
preserved and reused for cleanup; registration that throws after attaching is
rolled back best-effort. Registered callbacks are deactivated before removal,
so a non-conforming cleanup that synchronously delivers or retains the listener
cannot invent a late abort or replace the original registration failure.
The captured callback also enforces once-only delivery itself, even when a
non-conforming signal ignores the registration's `{ once: true }` option.
If a signal delivers a real abort synchronously and then throws from listener
registration, the delivered caller reason remains authoritative across
generation, admission waiting, and stream pumping; the later registration
failure cannot replace it or start provider work.
Native Promise-valued add/remove method siblings are
consumed together before either accessor executes, preventing an earlier
accessor failure from leaking a later rejected method slot.
Attempt observability receives a copy of structured failure classification, so
logging hooks may annotate or mutate their event without changing retry,
health, or terminal error decisions.
Structured classifier results require a literal known string scope, read each
field once, and reject async results while consuming native Promise rejection;
objects are never accepted through string coercion.
Result validators follow the same synchronous-hook boundary: rejected native
Promises are consumed and rejected as contract errors without reading arbitrary
`then` extension getters.
Validators receive a separate bounded result snapshot, so container mutation
inside a successful predicate cannot rewrite the result returned to consumers.
Generate response timestamps are cloned like streamed response metadata, while
request/response bodies retain their V4-defined opaque identity.
Stream request/response metadata is read once per active fallback candidate;
public getters return fresh containers so provider or consumer mutation cannot
rewrite the captured provenance while survivor handoff remains live.
Unsupported genuine Promise values at request/response/body/header metadata
boundaries are consumed and discarded without unhandled rejections; arbitrary
thenable extensions are never inspected.
Generate envelopes apply the same synchronous-value contract across content,
warnings, usage, provider metadata, request/response bodies, and headers;
rejected genuine Promises become retryable invalid-result failures.
Sibling envelope/usage/response fields are pre-captured together, including
the known input/output token fields nested inside usage: after the first async
contract violation, remaining genuine Promise siblings are still consumed
before the result is rejected. Ordinary getter throws still stop capture
immediately.
This aggregate consumption also spans bounded content parts, warning entries,
and response-header values, including later metadata branches after an earlier
nested async violation.
Rejected genuine Promises nested inside bounded provider metadata, raw usage,
and request/response JSON bodies are consumed across sibling containers before
fallback; non-Promise thenable extensions remain uninspected.
Known stream parts use the same synchronous-field contract: sibling part fields,
finish reason and usage token fields, raw usage JSON, and warning entries consume
native Promise rejections before pre-output fallback.
Optional stream response metadata consumes every rejected native Promise header
value before discarding the unavailable header snapshot.
Stream source parts capture only the active URL or document variant, so inactive
variant accessors cannot execute or turn otherwise valid output into fallback.
Ordinary source discriminant and active-field getter failures pre-consume known
own-data Promise siblings before fallback. Stream known-field and warning-array
capture applies the same rule without invoking inactive accessors.
Generated and streamed file payload discriminants and active data/URL fields
also reject and consume native Promises without consulting thenable extensions.
Their `type`, `data`, and `url` own-data Promise siblings are pre-consumed before
the discriminant or active payload getter runs, including ordinary getter-error
paths, while inactive accessors remain untouched.
When a content, warning, source, stream-part, or file discriminant is itself an
unsupported Promise, bounded known own data fields are checked for sibling
Promises without invoking inactive accessors.
Within one generated content part, provider metadata and active file,
tool-result, or source transformations are aggregated so nested rejection in
one branch does not leave Promise rejections in another branch unobserved.
Generate response body/header transforms and usage input/output/raw transforms
are aggregated under the same rule.
When bounded generate or stream header metadata is discarded for invalid names,
values, or aggregate size, Promise-valued own data siblings are consumed without
executing header accessors.
Rejected native Promise error causes are consumed and retained as malformed
structured evidence, preventing an unsupported async wrapper from degrading
into an unknown retryable provider failure.
Known own-data error fields are pre-consumed even when an authoritative status
makes cause/message/detail access semantically inactive; inactive accessors are
still not invoked. Abort classification also consumes a Promise-valued `name`
on a branded wrapped Error/DOMException before treating it as non-abortive.
The same rule applies to top-level and wrapped-cause response containers used
for status and retry-header extraction.
Promise-valued structured status and code fields are likewise consumed and
marked unreadable, while arbitrary thenable extensions are not inspected.
Bounded generic and provider-semantic error summaries also consume Promise-valued
known diagnostic data fields, even after their text budget is exhausted.
Retry-delay extraction consumes unsupported Promise-valued response/cause
wrappers, plain header values, and bounded header-array items while retaining
usable synchronous sibling hints.
Promise-valued header sources and Headers-like `get` slots are also consumed;
plain header arrays use own length/index data descriptors without accessors.
Custom failure-classification fields are synchronously captured across the
bounded known schema: native Promise siblings are consumed before the contract
error, while arbitrary thenable extensions remain untouched.
Shared-health adapters recognize async results only by native Promise brand,
without `then` membership probes, and consume Promise-valued known record data
fields before rejecting malformed state. Object/function mutation returns remain
malformed without being treated as successful synchronous writes.
Jitter also consumes an invalid native Promise returned by the platform random
source before degrading to zero delay, without inspecting thenable extensions.
Promise-valued timer registration handles are consumed and surfaced as the
stable `timer_unavailable` request error instead of being retained as handles.
Rejected native Promises returned by timer cleanup are consumed and cannot
replace settled operation or capability-discovery outcomes.
Async supported-URL discovery also fails open to no native URL support when its
guard timer cannot be registered, including Promise-valued timer handles.
Abort-listener registration enforces the synchronous DOM contract for native
Promise returns and rolls back; cleanup Promise rejections are consumed without
inspecting arbitrary thenable extensions.
Promise-valued add/remove method slots are consumed together before the signal
shape is rejected.
Best-effort cancellation also consumes Promise-valued abort method slots and
call results without inspecting arbitrary thenables.
Stream, `getReader`, reader-result, and cancel/read/release method slots must be
synchronous; native Promise violations are consumed before fallback. Promise
release results are consumed during both partial and normal cleanup.
Read-result `done`/`value` own data Promise siblings are consumed together,
while a `done: true` envelope does not invoke an inactive value accessor.
Generate envelope fields, content/warning array entries, and every bounded JSON
object/array container pre-consume own data Promise siblings before invoking
ordinary getters. Getter failures retain precedence without leaking later
rejected sibling Promises. The bounded container counter used for stream
metadata budgets applies the same rule before traversing child values.
V4 model snapshots consume Promise-valued required operation/identity slots and
reject non-string `provider` and `modelId` metadata when present before caching
a model as valid; the existing missing-metadata compatibility remains intact.
Supported-URL schema normalization consumes Promise-valued bounded media-type
siblings and pattern-array entries before failing closed to `{}`.
Eager routing configuration applies the same synchronous contract to bounded
`supports`, adaptive-concurrency, and retry-budget fields.
Cooldown containers and reset intervals also consume native Promise violations
before synchronous configuration rejection.
The root fallback-options container captures all bounded known slots together,
consuming Promise-valued siblings before eager policy validation.
`createRouter` applies that contract to its root options, model-route values,
and bounded candidate-array entries, including observability hook slots.
Instance/factory candidate wrappers also pre-consume Promise-valued bounded own
slots and capture only the fields relevant to their selected shape.
Custom shared-health store method slots are captured together and native Promise
siblings are consumed before eager adapter-shape rejection.
Ordering-source entropy consumes Promise-valued UUID and both random samples
before falling back to the deterministic process-local counter.
Platform and injected performance, wall, ordering, health, cooldown,
retry-budget, and retry-delay clocks consume native Promise samples before
freezing or falling back to their existing safe time value.
Promise-valued caller abort signals are consumed before synchronous signal-shape
rejection.
Promise-valued `aborted` samples are consumed and cannot prove cancellation;
Promise-valued reasons are consumed and replaced with a stable `AbortError`.
Call options capture Promise-valued root scalar/container slots, bounded
prompt/stop/tool entries, and response-format/tool-choice discriminant siblings
before surfacing a request contract error. The same synchronous boundary covers
nested prompt messages and parts, file payloads/references, tool definitions and
outputs, and request headers. Known own-data Promise siblings are consumed as a
group, while inactive variant accessors and arbitrary thenable extensions are
not inspected. Initial `abortSignal` access happens only after all known root
own-data Promise siblings are consumed, so a throwing signal accessor cannot
leave unrelated rejected option Promises unobserved.
Generated and streamed response headers likewise consume all bounded own-data
Promise siblings before reading any header value, including when an earlier
ordinary value accessor throws.
Exported stream-wrapper setup captures every known argument own-data Promise
before reading `firstResult`, configuration, or hook accessors. Direct
`createFallbackStream` calls use the same in-body capture boundary rather than a
default parameter that could execute caller access before validation.
Late stream disposal consumes Promise-valued `stream` and `cancel` slots as well
as rejected cancellation results, without probing arbitrary thenables.
Custom `shouldRetry` follows this boundary as well: only literal `true` retries,
native Promise results are consumed and rejected, and arbitrary thenable-like
extensions are not inspected.
Direct stream control hooks enforce synchronous runtime contracts: availability
and preparation require booleans, admission requires a positive safe count or
`undefined`, and async ordering tokens are consumed before the local hardened
source is used. Diagnostic concurrency metrics expose only synchronous
non-negative safe integers and omit malformed or Promise results.
Read-only availability, admission, wait, and metric hooks receive
ownership-isolated candidate records, so `fullIndex` or probe-lease mutation
cannot redirect model selection or later release. Lease-mutating preparation
and probe-release hooks retain the canonical candidate handoff.
Async observability hook rejections are isolated through native Promise slots
as well; arbitrary thenable-like return extensions are ignored rather than
executed by logging infrastructure.

**When all candidates fail:** a single failure is re-thrown as-is; multiple
failures throw an `AggregateError` whose `.errors` holds every candidate error
and whose `.message` embeds the last one. The last failure is also preserved as
the aggregate's `.cause`. The summary text is captured when each failure is
recorded, so observability-hook mutation cannot rewrite the aggregate message;
original error identities remain available in `.errors` and `.cause`.
Aggregation first takes a bounded indexed data-descriptor snapshot, so source
array methods, iterators, holes, or accessors cannot alter its count/order or
execute extensions while the final error is constructed. The captured final
summary reads `message` only from an own data descriptor; message accessors
never execute during aggregation. Stream-open `priorErrors` uses the same
bounded length/index data-descriptor contract before the fallback pump starts,
without invoking accessors or iterators. Caller aborts and request-wide deadline errors remain
the directly surfaced error even after earlier provider failures, preserving
abort identity and typed timeout diagnostics.

## Cooldown (sticky fallback)

Opt in with `fallback.cooldown` to remember the surviving candidate per logical
id, so later requests skip a known-down primary and re-probe it after the
interval (default 3 min). Candidate health is enabled automatically with
cooldown, or independently with `fallback.health: true`. Health distinguishes
request, credential, routing-unit, provider-family, and transient failures,
uses exponential cooldowns, and honors `Retry-After`/`X-RateLimit-Reset`.
Connection-specific `421 Misdirected Request` and `425 Too Early` responses are
treated as transient so another candidate can serve the request.
Hard authentication failures such as invalid `401`/`498` credentials receive a
one-hour cooldown floor, while quota/rate/suspension-style credential failures
retain the shorter recoverable cooldown policy. Reset headers may use HTTP
dates, epoch timestamps, seconds, or `ms`/`s` duration forms.
When request and token reset hints coexist, health uses the longest valid delay
and shares it by `healthKey` across logical models. The credential stays skipped
until every reported quota can recover, then exactly one half-open probe may
re-enter. Generate failures and stream-open failures use the same boundary; all
provider-derived cooldowns remain capped at one hour. In-band stream errors use
the same rule both before output and after output when `retryAfterOutput` is
enabled, including exact expiry and shared half-open probe behavior. With the
default `retryAfterOutput: false`, partial output remains terminal for the
current request, but the 429 is still reported and trains the same shared
cooldown so subsequent requests avoid the exhausted credential.
Credential-scoped quota failures never cool the whole `providerFamily`: another
key in the same provider family remains immediately eligible for generate and
stream fallback. Only the exhausted `healthKey` is skipped until its longest
reset expires, after which it receives one probe before sibling routing resumes.
Conversely, a failure explicitly classified as `provider-family` cools every
credential in that family even when their `healthKey` values differ. Generate
and stream routing create one family record, no credential record, and continue
through a candidate outside the affected family.
After family cooldown expiry, one successful half-open probe through any
credential recovers the family for every sibling key. Generate and stream
routing clear the family failure/probe state, permit another credential
immediately, and leave no in-flight ownership behind.
Concurrent recovery is single-probe across logical models and credential keys.
For generate, a pending half-open call retains the family lease; for stream,
opening alone is insufficient and the lease remains until output is validated.
Concurrent siblings route to fallback, then become eligible immediately after
the one successful probe clears family health.
A failed family half-open probe removes its lease but increments the shared
failure count and reapplies exponential cooldown. Generate and stream both move
from the initial 15-second family cooldown to 30 seconds after the failed probe;
sibling keys remain skipped until the new boundary permits one next probe.
Consumer cancellation before a half-open stream produces validated output is
censored rather than treated as another family failure. It cancels upstream
once, preserves the existing failure count and request-budget samples, releases
the family lease, and lets a sibling credential immediately claim the next
probe and recover shared health.
Caller abort during a generate or pre-output stream family probe has the same
censored lease semantics while preserving exact abort identity. It adds no
family failure or request-budget sample, releases the probe, and permits a
sibling credential to immediately probe and recover the family.
Provider-side half-open timeouts are failures rather than censored control
events. Generate `attemptTimeout` and stream `firstContentTimeout` release the
lease, increment the shared family failure count, apply exponential recool, and
still let a successful fallback settle one request success while sibling keys
remain skipped.
Request-wide `totalTimeout` remains a censored control boundary during a family
probe. A timed-out generate call or stream open preserves the prior family
failure/cooldown and request-budget samples, releases the lease without provider
feedback, and lets a sibling credential immediately probe and recover health.
A tripped retry budget also cannot reserve a family probe it will not execute.
When generate or stream fallback fan-out stops after the current candidate
failure, the later family candidate is neither called nor leased; another
logical model with available budget may immediately claim the probe and recover
shared family health.
The same boundary applies to `maxAttempts`: candidates skipped after the real
attempt limit do not claim family or shared-credential probes, are reported
without an attempt number, and leave another logical model free to probe
immediately. Skipped lazy provider factories are not evaluated, including when
a pre-output in-band stream failure reaches the attempt limit. With
`retryAfterOutput: true`, the same rule preserves already-emitted partial text,
surfaces the original post-output error, and reports both the failure and tail
skip as `stream-mid` without evaluating the factory or reserving an expired
provider-family probe. Provider in-band error parts have the same boundary:
credential health and one failed request-budget sample are retained even though
the fallback tail is blocked, while another logical model skips the cooling key.
The regression harness consumes raw routed streams through one lock-safe helper,
so partial-output and exact-error assertions always release their reader lock.
Post-output reader rejections follow the same split. With retry disabled they
surface the original error, release capacity, and record one failed request;
with retry enabled a successful fallback records one request success. Both
paths retain `stream-mid` observability and the longest credential reset.
If a reader rejects before output commitment, buffered framing from the failed
candidate is discarded before fallback. The failed credential still receives
its longest shared cooldown, while a validated fallback records one request
success and releases the failed candidate's capacity.
Caller abort takes precedence when abort delivery itself causes a pending read
to reject with a provider-shaped error. The exact caller reason terminates the
stream, capacity is released, and no provider failure event, health/AIMD
feedback, retry-budget sample, or fallback attempt is created.
The same precedence holds when abort handling emits a provider-shaped in-band
error part instead of rejecting the read. The part is suppressed, the pending
consumer read rejects with the exact caller reason, and no provider feedback or
fallback state is created even under the default post-output fast path.
The pump captures the caller abort reason once and reuses that exact value for
operation abort, reader/error-part arbitration, and final settlement. Stateful
or non-conforming reason getters cannot substitute a later value.
If consumer cancellation follows an already observed caller abort, it performs
cleanup without replacing that first reason. Upstream cancellation receives the
captured caller identity and no consumer `cancelled` attempt event is invented;
consumer-first cancellation retains the normal active/pending event semantics.
Conversely, once consumer cancellation settles first, a later caller abort is
inert: the consumer reason reaches upstream exactly once, active or pending
`cancelled` observability is emitted exactly once, and no health, budget, queue,
or capacity state is rewritten.
First-content timeout arbitration is likewise settlement-ordered. Caller abort
before the deadline preserves its exact reason with no provider feedback; once
the timeout has failed the hanging candidate and a fallback succeeds, a later
caller abort cannot replace that success or duplicate health, budget, attempt,
reader, or capacity cleanup.
At an exactly equal timer timestamp, callback registration order is honored.
Abort-first produces zero provider feedback. Timeout-first records the primary
candidate timeout once, but a same-turn caller abort may still stop fallback
opening; the request then keeps the exact caller reason and censored budget with
no duplicate attempt or capacity ownership.
Equal-deadline consumer cancellation follows the same ordering. Cancel-first
produces one active `cancelled` event and no timeout feedback. Timeout-first
records one primary failure followed by one cancellation of the opening
fallback; request-budget settlement remains censored and all capacity is
released in either order.
Model 404s tied to subscription, current/paid plan, or pay-as-you-go access are
credential-scoped rather than incorrectly cooling only one routing unit.
LiteLLM-style `ExceededBudget` 400s and billing/spending/monthly-limit failures
are also credential-scoped and retain the recoverable cooldown policy.
Structured `rate_limit_error`, `insufficient_quota`, `quota_exceeded`,
`NO_MORE_CREDITS`, and `access_terminated_error` markers are recognized even
when the surrounding status/message is non-standard.
Explicit invalid-key/authentication/token/disabled-key codes likewise remain
credential-scoped and receive the hard-auth cooldown floor on odd statuses.
Markers discovered inside structured body text require nearby `code`, `type`,
or `tag` field context; similarly named object keys alone do not trigger fallback.
Explicit `model_not_found` and `model_not_available` codes remain retryable and
routing-unit scoped even when a gateway wraps them in an unusual status.
Natural-language provider/model availability failures are likewise scoped to
the routing unit, while subscription and plan-access failures remain
credential-scoped.
Gateway-normalized upstream WAF blocks and supported-model capability errors
also remain routing-unit scoped instead of disabling a credential shared by
unrelated models.
Natural-language WAF detection requires nearby block/reject/deny context, so an
echoed product name in a request body cannot weaken a real credential failure.
Structured and bounded JSON provider bodies contribute only error-semantic
fields to fallback classification; echoed prompt/input/request fields cannot
masquerade as model, quota, authentication, or WAF failures.
Semantic extraction reads a fixed allowlist and bounded error arrays directly,
so objects with huge numbers of unrelated fields cannot force full enumeration.
It validates array lengths without coercion and prioritizes core error/code/
message fields before verbose descriptive metadata consumes the text budget.
Generic error summaries also read only a fixed set of own diagnostic fields;
they do not enumerate arbitrary keys, traverse inherited properties, or invoke
own accessors. Standard Error data fields remain available.
Revoked or throwing semantic container brands are isolated as unavailable
instead of escaping from provider failure classification.
Provider-semantic object fields, array lengths, and indexes are likewise read
only from own data descriptors; accessors are ignored without execution.
JSON-like bodies must parse within 64 KiB before contributing classifier text;
one collector also has a 64 KiB aggregate nested-wrapper parse-attempt budget,
so many individually bounded strings cannot amplify parsing work. Malformed or
oversized structured bodies cannot bypass semantic-field filtering.
Axios-style `response.data.error` and nested object `body`/`data` wrappers are
supported. Nested wrapper strings are accepted only as bounded valid JSON and
are filtered again; plain primitive wrapper values and request fields remain excluded.
Axios-style `response.status`/`statusCode` values are also snapshotted once and
used after valid top-level status aliases for retry and health scope decisions.
Nested `response.headers`/`responseHeaders` participate in the same bounded,
deduplicated Retry-After/reset lookup without re-reading the response container.
Plain and Headers-like containers may return up to 16 string values per
rate-limit field; values are read by bounded indexes without iterators or coercion.
Throwing/revoked array-like brands and indexes are isolated as malformed values,
allowing valid secondary reset hints to remain usable.
Headers-like objects also receive one fixed-name own-data snapshot, used only
when their captured `get()` operation throws or returns no usable string values.
Plain header accessors and arbitrary keys are never read or enumerated.
Top-level stream response metadata snapshots at most 1,024 enumerable header
keys before reading values and rejects invalid HTTP names or control characters.
The same bounded key and HTTP syntax guards apply to generate response metadata
and per-attempt request-header cloning.
One wrapped `cause` is captured for SDK gateway errors: its status, semantic
body, response containers, and rate-limit headers are used only when the top
level lacks authoritative classification fields. `retry-after-ms` is supported
as the precise millisecond hint used by the AI SDK.
Rate-limit parsing completes the top-level/response tier first and consults the
cause tier only when no valid top-level hint exists; aliases remain single-read.
The boolean retry fast path does not capture cause after an authoritative
top-level status; structured health classification opts in when cause headers
may still supply cooldown timing.
Exported error normalization follows the same one-level cause and top-level
precedence rules for custom retry policies.
Standalone retry checks capture a top-level code without reading non-404 body or
message details; structured classification also recognizes nested body codes.
Malformed or negative reset values are ignored, oversized values remain finite,
and `headers` is consulted when `responseHeaders` lacks a requested field or
contains an unusable value for it.
Partially malformed combined `Retry-After` values retain valid numeric members,
and duplicate header containers use the longest valid retry delay at the same
precedence tier. Combined rate-limit reset headers likewise retain their
longest valid epoch or duration member when another member is malformed, so
request and token quotas must both recover before the credential is retried.
HTTP-date parser failures are isolated as malformed values, allowing a valid
secondary reset header to determine cooldown instead of terminating fallback.
HTTP-date and epoch reset arithmetic requires a finite, non-negative,
safe-range clock; invalid clocks cannot turn an absolute hint into a near-
permanent cooldown. Relative second/millisecond hints remain usable without it.
Both header containers are captured once per classification before checking all
Retry-After/reset names, so mutable or one-shot accessors cannot change the
decision between fields.
Plain header dictionaries use fixed descriptor lookups for lowercase and
standard canonical relevant names, so Proxy key enumeration is never required.
When `responseHeaders` and `headers` alias the same object, that physical
container is captured and queried only once.
For Headers-like containers, the `get` operation is likewise captured once and
then invoked with each bounded header name using its original receiver.
Rejected genuine Promise results are consumed and ignored; arbitrary thenable
extensions are never inspected or invoked.
Default structured classification also shares one bounded snapshot of
status/code/message/body fields between retry and scope/cooldown decisions;
standalone retry checks still avoid detail reads for unambiguous non-404 status.
Provider error classification uses bounded, circular-safe extraction rather
than serializing complete response bodies. It limits traversal depth, nodes,
properties, text size, and rate-limit header length while retaining both the
head and tail of oversized strings.

The sticky survivor is promoted to the front of each compatible candidate
pool, but every other healthy compatible candidate remains in the fallback
chain. If the survivor fails, routing can therefore recover through candidates
that originally appeared before it. When cooldown is combined with
`selection: 'least-inflight'` or `'round-robin'`, the sticky survivor (or the
first compatible candidate when it is filtered out) remains first and the
selection policy is applied only to the remaining fallback tail.
Round-robin retains at most 1,024 candidate-pool cursors, each under a bounded
order-sensitive fingerprint rather than a full candidate-index string.

`createRouter` caches one routed model per logical id, so calling `route('id')`
repeatedly shares its cooldown and health state.
All logical-route configuration is validated when `createRouter` runs, including
empty candidate lists and shared-credential concurrency conflicts; provider
factories themselves remain lazy until their candidate is attempted.
Nested cooldown and retry-budget configs are snapshotted without erasing
malformed container brands. Cross-realm plain records are accepted, while
arrays, functions, Dates, and class instances fail eager validation.
Logical ids are capped at 256 characters, with at most 10,000 logical routes,
10,000 candidates per route, and 100,000 candidates across one router.

Pass a shared synchronous `healthStore` or synchronous facade (the package exports
`MemoryRouterHealthStore`) to propagate health across multiple router
instances. Custom adapters implement `get`, `set`, and `delete`; `entries` is
optional and retained for adapter compatibility. Snapshots read only configured
keys and never enumerate the whole shared store. The in-memory store retains up
to 100,000 recently used records by default; pass a positive `maxRecords` to its
constructor to select a smaller bound. It copies records without invoking their
getters or enumerating arbitrary keys at its public read/write/iteration
boundary. Only known data descriptors are retained, so caller mutation cannot
rewrite stored cooldown or CAS state and accessor extensions cannot execute
later during CAS. `entries()` snapshots both structure and records before iteration, so LRU
refreshes or concurrent writes cannot repeat or inject entries. Expired
candidates use a single half-open probe
lease so concurrent recovery traffic does not stampede the same provider.
Each availability/probe decision captures one clock value and uses it for every
unit, credential, and family record, avoiding mixed states at cooldown edges.
One success likewise writes the same observed time to every cleared scope, and
diagnostic snapshots normalize all records against one captured clock value.
When no explicit attempt token is supplied, that same clock value is also used
as the success ordering token.
Failure transitions similarly share one observed time across record validation,
cooldown calculation, implicit ordering, and CAS retries.
Unsupported async health-store results fail open: native Promise rejections are
consumed, while custom thenable-like return extensions are detected without
invoking their `then` getters or functions.
Records returned by custom stores are normalized from the same bounded known
data descriptors as the memory store. Prototype properties and own accessors
are ignored without execution, so health reads cannot invoke adapter-supplied
record extensions.
Probe leases are claimed lazily immediately before admission and conditionally
released when capacity, abort, or consumer cancellation prevents an upstream
attempt, avoiding an unnecessary 30-second recovery delay.
Admission waiters recheck cancellation after listener registration so an abort
inside the subscription race cannot leave a stale waiter until timeout.
They also recheck settlement after timer and listener registration, preventing
synchronously firing platform callbacks from queuing a settled waiter or
leaking a late cancellation listener.
Throwing listener registration and unreadable abort reasons are also cleaned up
and settled immediately rather than leaking queue capacity.
Stream admission wait hooks must return a genuine Promise without consulting
arbitrary thenable extensions, and may resolve only to a positive safe in-flight
count or `undefined`. Immediate admission hooks obey the same resolved-value
contract; malformed ownership claims never open a provider.
If probe preparation or the post-acquisition health recheck throws, any
ownership already obtained at that stage is rolled back before the error is
surfaced, including capacity and the exact probe lease after a completed wait.
Admission availability, acquisition, waiting, probe preparation, release, and
diagnostic hooks are captured once with the original args receiver preserved;
later accessor mutation cannot change an in-flight fallback contract.
The stream candidate list is likewise copied by bounded indexed reads into a
plain pump-local array using length/index data descriptors, so accessors and
revoked Proxies are rejected without execution and later array mutation or
iterator extensions cannot redirect provider selection or lease cleanup.
Setup-failure cleanup uses the same own-data lookup instead of re-reading raw
candidate/start-index accessors.
The outer wrapper-construction failure path shares that helper as well, so a
missing `ReadableStream` cannot reopen hostile candidate accessors during
capacity/probe cleanup.
Each `ResolvedEntry` is also copied into a plain record from own data fields;
later mutation or entry/fullIndex/probeLease accessors cannot redirect a
fallback provider or change hook identity/index and cleanup ownership. The
router's intentional lazy `model` getter is captured once with its receiver,
evaluated only when attempted, and memoized on success.
Genuine Promise model values/results are consumed and rejected as a synchronous
candidate contract error, allowing fallback without unhandled rejections;
arbitrary thenable extensions are not inspected.
Initial probe leases are copied from bounded key/timestamp data fields so later
lease-object mutation cannot transfer or suppress cleanup ownership.
Deadlines, timeout/backoff budgets, attempt limits, call options, and validation
flags are captured once during the same setup boundary. Pre-open failure lists
are copied with at most 10,000 indexed reads and never invoke custom iterators.
Direct stream setup validates durations as positive values up to 24 hours,
ownership counters and attempt limits as safe integers, indexes against the
captured candidates, monotonic timestamps as finite values, and boolean/object
fields by exact runtime type before any additional provider opens.
The already-open `firstResult` is captured once before metadata inspection and
passed unchanged through pump setup, activation, and cleanup; a stateful getter
cannot substitute a different upstream between those phases.
Call options are deep-snapshotted with the same bounded contract used at the
router entrypoint, so caller mutation of prompts, tools, provider options, or
headers after the first stream opens cannot alter a later fallback request.
Best-effort stream request bodies are also copied as bounded JSON metadata;
post-open provider mutation cannot change a previously exposed request snapshot.
Each public request getter returns another bounded copy, so one metadata
consumer cannot mutate the value observed by a later consumer.
Cleanup hooks are captured independently before the remaining admission
contract. If a later accessor is unavailable or malformed, the initial upstream
and every capturable initial lease are released exactly once before the typed
stream setup error is surfaced.
General wrapper-construction failures use the same independent cleanup capture,
so an unreadable capacity-release accessor cannot mask the original error or
suppress an available probe release.
Corrupted shared waiter queues with unreadable or more than 10,000 entries are
discarded before release or diagnostics can traverse them. Valid bounded queue
indexes are copied into a plain array before mutation, isolating Proxy methods.
Non-array corruptions are rejected by brand before any `length` extension is
read. Waiter `acquire` and `resolve` method slots are aggregate-captured once,
native Promise-valued siblings are consumed, and the original waiter receiver
is preserved during wake-up.
Shared adaptive state is also read once into a plain validated record;
throwing or malformed values are rebuilt before routing or diagnostics use them.
They are also released if a concurrent health update makes the candidate
unavailable after admission or while waiting for its concurrency slot.
Stores may implement `compareAndSet(key, expectedVersion, value)` for atomic
health writes and probe leases across router instances. Without CAS, the router
falls back to process-local get/set semantics; distributed adapters should use
Redis `SET NX`/Lua, a conditional database update, or an equivalent primitive.
Custom store methods are captured once with their receiver preserved. Later
accessor mutation cannot change routing behavior, and routers sharing the same
source store reuse the captured adapter and ordering-token source.
Probe release is conditional on the exact lease timestamp, so a stale owner
cannot clear a newer lease written by another router.
Health storage is fail-open: adapter exceptions do not prevent provider routing,
and failed writes surface as `cas-exhausted` where an attempt event is available.
CAS adapters must return literal booleans. A malformed synchronous return is
rejected immediately for health updates instead of being retried as contention;
probe admission remains fail-open but records no unproven lease ownership.
`healthNamespace` should uniquely identify the service and environment whenever
one store is shared; namespace and logical-model segments are encoded
independently to prevent ambiguous shared-store keys. With an explicit
namespace, credential and provider-family health identities are shared across
logical models, while routing-unit health remains isolated per logical model.
Without a custom store, every logical model created by one router instance uses
the same bounded in-memory health store; separate router instances remain
isolated unless a store is explicitly shared.
Custom stores are validated eagerly as object-like synchronous adapters with
required `get`/`set`/`delete` methods and optional functional CAS/entry methods.

CAS retries re-run the health transition against the newest record, so an older
failure cannot overwrite a success inserted during a conflict. Probe admission
leases exactly one newest failure scope, avoiding partial unit/key/family leases.
Attempt ordering uses a monotonic, router-salted token rather than raw
millisecond timestamps, so same-millisecond attempts remain distinct. New
records use an opaque versioned string token that remains safe beyond the
JavaScript integer limit; numeric tokens from older shared stores remain
readable during migration.
All logical models in one router share the same token source, so cross-model
success/failure ordering remains causal even inside one wall-clock millisecond.
Router instances sharing the same process-local health-store object also share
that token source through a weak registry, preserving same-ms order across them.
Across distributed processes, same-ms tokens with different source salts are
treated as causally incomparable for recovery: they cannot clear a failure until
a strictly later timestamp succeeds.
The same ambiguity cannot suppress a failure or validate a pre-failure
selection; safety decisions preserve the failure until causal order is known.
Malformed/oversized string tokens are ignored, timestamps are compared
numerically before salt/counter ordering, and a saturated same-millisecond
counter advances a logical millisecond so clock rollback cannot invert order.
Shared health records with negative cooldown timestamps or non-HTTP
`lastStatus` values are also ignored fail-open rather than entering snapshots or
CAS transitions. A probe lease on a zero-failure record is inconsistent and is
likewise ignored, preventing a malformed healthy record from blocking routing.
If the platform clock throws or returns a negative, fractional, non-finite,
unsafe-integer, or out-of-Date-range value, ordering continues from the last
logical millisecond so every emitted token remains parser-compatible.
Direct stream-wrapper use without an explicit token callback uses the same
hardened process-local source, avoiding same-millisecond collisions and the
legacy numeric token encoding.
Malformed start tokens and invalid or throwing stream token callbacks also
degrade to that local source instead of skipping a healthy provider attempt.
After five unsuccessful CAS retries, routing continues and the failed attempt's
`onAttempt.healthTransition` is reported as `cas-exhausted`. Healthy ordering
tombstones in the internal memory store are removed after 24 hours once no
cooldown or probe lease is active. Custom shared stores should apply their own
TTL; the router never performs an unconditional stale delete that could race
with a fresh record written by another process.
`recovered` is emitted only when a success actually clears prior failed/probing
health; routine healthy successes omit `healthTransition`.
Retry-budget clocks that throw or return negative/non-finite/unsafe values freeze
at their last valid timestamp so the optional guard cannot fail a request.
If the entire compatible pool is circuit-open, the exported
`RouterHealthUnavailableError` (`code: 'health_unavailable'`) is thrown instead
of a generic provider failure.

```ts
const route = createRouter({
  models,
  fallback: { cooldown: '1m' },
  //         cooldown: true            // default (3 minutes)
  //         cooldown: 60_000          // milliseconds
  //         cooldown: { modelResetInterval: 60_000 }  // explicit
});
const chat = route('kimi'); // reuse this instance across requests
```

Candidates that share credentials or a provider account can declare shared
health identities:

```ts
{
  provider: openrouter,
  model: 'model-a',
  healthKey: 'openrouter-key-1',
  providerFamily: 'openrouter-account',
  maxConcurrency: 4, // overflow excess requests to the next candidate
  adaptiveConcurrency: {
    initial: 2,
    min: 1,
    max: 8,
    increaseAfterSuccesses: 10,
  },
}
```

Health is rechecked immediately before every fallback attempt, including
mid-stream provider switches. A failure observed by another concurrent request
therefore skips the newly cooling credential instead of repeating the same
known `429`. Concurrent failures inside one cooldown window are deduplicated so
they do not exponentially extend a single rate-limit event. Health updates use
attempt ordering: a delayed failure from an older attempt cannot overwrite a
newer successful recovery. Half-open probes are admitted only after the active
cooldown expires; an all-cooling pool is not immediately re-probed.

`maxConcurrency` is optional and scoped by `healthKey` (or by candidate when no
key is declared). When the limit is full, the router records a `concurrency`
skip and immediately overflows to the next compatible candidate.
Credential counters, wait queues, and AIMD state are shared across logical
models created by the same `createRouter` call, so reusing one `healthKey`
enforces one process-local credential limit across those models.
Candidates sharing one `healthKey` must declare identical fixed or adaptive
concurrency settings; conflicting configuration fails during model creation.
If every earlier candidate is full, `concurrencyWaitTimeout` optionally waits
for the final candidate's slot rather than failing immediately. The wait is
FIFO within one router, abortable, and bounded by the total fallback deadline.
If that deadline expires or the caller aborts while queued, the waiter is
removed before a later capacity release can grant it; the control failure is
censored from the retry budget while earlier real provider health remains.
Stream observability emits a `concurrency` skip only when capacity waiting
actually expires; a candidate admitted after waiting reports only its real
provider attempt outcome. Fallback skip events are buffered until the failure
that triggered selection is reported, then emitted in configured candidate
order so causality is preserved for metrics consumers.
This ordering also covers `max-attempts`: the failure that exhausts the
provider-attempt budget is emitted first, followed by attempt-number-free skips
for each remaining configured candidate.
Deferred dispatch stays bounded by the validated 10,000-candidate route limit
and drains in place, avoiding a second full-array copy at maximum skip fan-out.
Rejected Promise results from sampled or high-volume hooks are consumed per
event without delaying later dispatch or creating unhandled rejections.
If deadline or admission infrastructure terminates the final wait, its
provisional skip is discarded while legitimate skips from earlier saturated
candidates are retained after the triggering failure.
Each deferred event is dispatched through the same isolated observability
boundary, so one throwing or rejected metrics hook cannot suppress later skips,
the admitted fallback outcome, or stream delivery.
Concurrency fields are snapshotted when the skip is detected, so later capacity
or AIMD changes during admission waiting cannot rewrite buffered metrics.
Consumer cancellation during capacity waiting emits one attempt-number-free
`cancelled` control event after the triggering provider failure. Caller abort
instead preserves the request error without inventing a provider attempt or
leaving a deferred concurrency skip. The same control event covers cancellation
during fallback backoff, before the next provider attempt has started.
An active cancellation reports the attempt's owned pre-release `inFlight`;
an attempt-number-free pending cancellation reports the blocked candidate's
current in-flight and limit snapshot instead.
At the routed integration boundary, consumer cancellation emits that pending
event and censors the request budget; caller abort preserves its exact error and
emits no synthetic cancelled fallback event.
Pending cancellation is observability-only for that unstarted fallback: it
does not add health state, alter AIMD limit/success progress, or settle the
retry budget.
After the blocking capacity is released, the next request can admit that same
fallback immediately; its validated finish contributes one normal AIMD success
and one request-budget success without stale waiter/cancel state.
Repeated cancel/release/retry cycles remain clean: each cancel removes its
waiter and adds no AIMD/budget feedback, while only validated retries advance
additive recovery and request-success samples.
Even when logical models share one admission/AIMD key, cancellation events keep
their originating `logicalId` and logical-model-local configured index; shared
capacity does not merge observability identity.
Multiple waiters sharing that key can cancel in any order. Reverse cancellation
removes only the targeted queue entries, preserves zero AIMD feedback, and
leaves the next acquire immediately usable after the held slot is released.
If a sibling waiter cancels and release grants the surviving head, a late abort
for that already-granted waiter cannot revoke its slot or recreate a queue
entry; the owner must release it normally.
Deadline ordering is deterministic for multiple waiters: a release before the
deadline grants only the FIFO head while remaining waiters may time out; if the
deadline timers settle first, a later release grants none of the expired queue.
An AIMD decrease takes precedence over a near-deadline release: if remaining
in-flight usage is still at the reduced limit, waiters stay parked and expire
at their original deadline instead of being over-admitted.
After an AIMD increase, release skips an already-expired FIFO head and grants
the next still-live waiter without losing the newly available slot or retaining
the expired queue entry.
A malformed queue head is discarded before granting the next live waiter; that
waiter's deadline timer is cleared at grant and cannot later revoke or alter
the owned slot.
Even if platform timer cleanup throws after grant and leaves the callback
scheduled, the waiter's settled guard makes that stale deadline inert; it
cannot revoke ownership or reinsert queue state.
Abort-listener cleanup has the same settlement boundary: if removal throws and
the platform later delivers the retained listener, a granted admission remains
owned and the already settled result and empty queue remain unchanged.
If a corrupted head returns a rejected Promise from settlement, the provisional
slot is rolled back, the rejection is consumed, and the same release pass can
grant the next live FIFO waiter.
Admission/backoff infrastructure failures use the same censored request
settlement in both generate and stream routing rather than being misclassified
as another provider failure.
Fractional remaining admission deadlines are rounded up for timer scheduling,
preventing an early wake from surfacing the preceding provider error instead
of the configured total timeout.
If every compatible candidate is rejected only by admission, the router throws
the exported `RouterConcurrencyError` (`code: 'concurrency_exhausted'`) rather
than misreporting an upstream provider failure.

`adaptiveConcurrency` enables additive-increase/multiplicative-decrease (AIMD)
for a credential. After the configured number of successes its limit increases
by one; a `429`, credential-scoped failure, or retryable congestion response
(`408`, `425`, or `5xx`) halves the limit down to `min`. Retryable routing/model
failures without a congestion signal reset increase progress but do not reduce
the concurrency limit.
AIMD outcomes are ordered by their monotonic attempt-start time, not completion
time. A slow success that started before a newer congestion failure cannot
immediately retrain the reduced limit, and a stale congestion response cannot
halve capacity after a newer successful attempt has already completed.
When concurrent attempts share the same monotonic timestamp, their store-scoped
ordering tokens provide a deterministic tie-break. Token timestamps are
compared numerically across width changes before source/counter ordering, so a
logical-clock digit rollover cannot reverse AIMD causality.
If a decrease puts current in-flight usage above the new limit, queued requests
remain parked while existing attempts drain. FIFO admission resumes only after
a release makes a real slot available under the reduced limit; rollback of a
corrupted waiter cannot bypass that capacity check.
Health recovery does not reset AIMD capacity to its initial or maximum value.
A successful half-open probe contributes one ordinary success toward
`increaseAfterSuccesses`; subsequent healthy attempts restore capacity one slot
at a time. A failed probe remains a congestion outcome and may reduce the
already-lowered limit again.
Stream half-open failures feed health and AIMD exactly once whether surfaced as
an error part, read rejection, or open failure. Cleanup cancellation and reader
settlement cannot increment the health failure counter or apply a second
multiplicative decrease for the same attempt.
For candidates sharing a `healthKey`, credential-scoped `429` cooldown,
half-open recovery, AIMD limit, and success progress are shared across logical
models in the router. Transient `5xx` health cooldown remains routing-unit
scoped even though its congestion feedback reduces the shared credential AIMD
limit; an unrelated unit can therefore probe the credential while respecting
the lower capacity.
Lazy provider factory throws are retryable routing-unit availability failures:
the candidate releases admission immediately and enters health cooldown, while
a successful fallback keeps the request-level retry budget healthy. Because no
congestion status was observed, AIMD increase progress resets but its limit is
not reduced. The factory exception itself is not cached, so cooldown expiry can
retry construction and a valid recovered model is then cached normally.
The same contract applies before stream open. A throwing factory never leaves a
reader, admission slot, or half-open probe attached to the failed attempt; the
fallback stream can settle successfully, and a recovered factory/stream finish
after cooldown clears health and all ownership exactly once.
By contrast, a factory result that is definitively not a V4 model is a
permanent cached configuration error. It still counts as a candidate attempt
for `maxAttempts`, but health cooldown prevents that cached routing-unit failure
from consuming every request. Cooldown expiry re-evaluates the cached error and
advances failure backoff without invoking the invalid factory again.
`onAttempt.concurrencyLimit` exposes the current effective limit.
Consumer-cancelled streams emit one censored `onAttempt` event with
`outcome: 'cancelled'`; cancellation releases admission immediately but does
not train health, AIMD, or the retry budget as a provider failure.
Cancelling an active half-open stream also releases its probe lease immediately,
so the next request need not wait for the 30-second lease timeout.
Cancellation also aborts fallback backoff, capacity waiting, response opening,
and active reads, including the interval before a fallback has returned a
stream reader.
Synchronous or repeated caller-abort delivery captures one reason and removes
the forwarding listener exactly once at stream settlement.
Use `getAdmissionSnapshot(logicalId?)` for idle-time diagnostics. Each configured
candidate reports its stable index, adaptive flag, effective limit, in-flight
and waiting counts, plus AIMD min/max, success progress, and increase threshold.
Shared `healthKey` candidates expose the same shared counters without returning
the credential identity. `RouterAdmissionSnapshot` is exported.

`retryBudget` is opt-in. When enabled, it limits fallback amplification during
an outage using one final outcome per request, not one observation per provider
attempt. A request recovered by a deep fallback counts as success rather than an
outage burst. Observations expire after 60 seconds, so an old failure burst
cannot leave the router permanently constrained. Availability and snapshots
recompute hysteresis after expiry even when no new request outcome has arrived.
The bounded sample history uses a compacting head cursor and incremental failure
count, avoiding repeated full-array shifts and scans during sustained outages.
When the budget is tripped, its one-attempt request limit counts only candidates
that actually acquire admission and begin an attempt. Health/capacity skips do
not spend that slot, so a cooling or saturated primary cannot prevent the next
available candidate from serving as the single allowed attempt.
This accounting is identical for stream open: a skipped candidate emits no
attempt number and never opens its provider stream, while the next available
candidate becomes attempt one. Consumer cancellation of that live stream stays
censored rather than adding a request-budget outcome.
Successful fallback requests served while a primary is cooling still contribute
healthy request outcomes. Once their sliding-window failure rate reaches
`recoveryFailureRate`, the budget untrips and restores the configured
`maxAttempts`; a later primary failure can then use deeper fallback again.
A fallback stream contributes that recovery only after validated completion.
Cancelling the live stream keeps the request censored even when it was the sole
attempt allowed by a tripped budget: no success sample is added, the budget
remains tripped, and transport/admission ownership is still released.
Settlement order is explicit: cancellation before `finish` wins and censors the
request, while a validated `finish` records one success synchronously before it
is exposed downstream. Cancelling the reader immediately after receiving that
finish cannot remove the success or append another outcome.
The same winner controls all attempt feedback. Pre-finish cancellation emits one
`cancelled` attempt and contributes no health recovery or AIMD success; a
validated finish emits one `success`, records health/AIMD recovery, and a later
reader cancel cannot append a `cancelled` event or roll that feedback back.
Local retry windows and sticky cooldowns also rebase after wall-clock rollback,
so an NTP correction cannot extend them by the size of the clock adjustment.
Sticky cooldown time freezes at its last valid sample when its clock throws or
returns a negative, non-finite, or above-safe-integer value and resumes expiry
after recovery. Fractional millisecond clocks remain supported.
If an injected health clock throws or returns a negative, non-finite, or value
that cannot represent the configured cooldown arithmetic, health time freezes
at its last valid sample and resumes when the clock recovers. Large synthetic
distributed timelines and fractional millisecond samples remain supported.
Retryable credential/routing failures such as repeated `429` outcomes count as
outages too; terminal request-scoped client errors and caller aborts do not.
If a caller abort follows an earlier retryable provider failure in the same
request, the request-level abort suppresses that entire sample as censored.
Consumer cancellation is censored the same way, including while a fallback is
opening after an eligible failure. Conversely, a validated `finish` records one
success before the upstream transport is cancelled; a later close/read failure
cannot add a second outcome or convert that success into a failure.
Use `getRetryBudgetSnapshot(logicalId?)` to inspect sample/failure counts,
failure rate, window, availability, and trip state without exposing prompts or
credentials. `RetryBudgetConfig` and `RouterRetryBudgetSnapshot` are exported.

Provider `Retry-After` and rate-limit reset hints extend health cooldown for
subsequent admission; they do not sleep the active request before trying a
different provider. Only the configured jitter `backoff` delays an in-request
fallback, and both generate and stream fallback cap that delay to the remaining
`totalTimeout` before rechecking the deadline.
`firstContentTimeout` is candidate-scoped rather than a terminal request
deadline. A stream that opens but produces no output is cancelled and recorded
once as provider health/AIMD failure, then fallback may continue. If a later
stream finishes, only that final request success is added to the retry budget;
reader cancellation cannot add duplicate failure feedback.

When using AI SDK helpers, set `maxRetries: 0` if the router owns retry policy.
Otherwise the SDK may retry the entire routed model after the router has already
exhausted its candidate chain, multiplying provider attempts and observability
events:

```ts
await generateText({ model: route('chat'), prompt, maxRetries: 0 });
```

Use `fallback.classifyFailure` to return a structured `{ retryable, scope,
retryAfterMs?, cooldownMs? }` decision. It takes precedence over the legacy boolean
`shouldRetry` hook. `fallback.validateResult` can reject semantically unusable
non-streaming responses. `onAttempt` reports successes, failures, cooldown
skips, max-attempt skips, durations, and structured failure data.
A provider result is not successful until envelope and custom validation both
pass. Validator rejection records candidate health/AIMD failure, releases its
ownership, and can fall through; only an accepted final candidate contributes
the request-level retry-budget success. A rejected candidate therefore cannot
briefly clear health or train AIMD success before fallback.
Custom retry hooks must return the literal boolean `true` to retry. Structured
classifications are shape-checked, and `validateResult` must synchronously
return a boolean or rejection message; malformed/async/throwing validator
contracts stop as request errors instead of fanning out across providers.
Validator contract errors are censored infrastructure failures, not provider
outcomes: they release admission but do not cool health, reset AIMD progress,
append a retry-budget sample, or invoke another candidate. This differs from a
valid `false`/string rejection, which intentionally marks the result unusable
and can fall through.
The legacy boolean `shouldRetry` hook is fail-closed: throwing, async, or
non-boolean behavior cannot fan out. Unlike a classifier contract error, the
underlying provider failure is still classified and recorded in candidate
health/AIMD; only retry amplification and its request-budget failure sample are
suppressed, and admission is released normally.
For an already-open stream, the same rule applies to an error part or read
rejection: cancel/release the failed reader, record its provider health/AIMD
failure, add no amplification-budget sample, and do not open a later stream.
Malformed, async, or throwing custom failure classifiers follow the same
terminal boundary. Earlier provider failures retain their already-recorded
candidate health, but the classifier-contract attempt is request-scoped: it
does not train that candidate, fan out farther, or count the partially failed
request against the retry budget.
This boundary also applies inside an already-open fallback stream. If an
earlier error part was validly classified but a later error-part/read rejection
hits a classifier contract error, the router preserves only the earlier real
health transition, cancels and releases the current reader/ownership, censors
the request budget, and does not open another stream.
Malformed explicit HTTP statuses likewise stop default fallback when no valid
status alias, wrapped cause status, or recognized credential/model code remains;
they are not erased into a retryable unknown transport failure.
Throwing explicit status accessors follow the same rule. A later valid alias or
wrapped cause may recover classification, but an entirely unreadable status
cannot trigger provider fan-out.
Unreadable response/cause containers are tracked the same way when they could
be the only source of an HTTP status; an independently captured valid status
still remains authoritative.
An unreadable structured error-code accessor also cannot degrade into unknown
fallback fan-out when no valid status or recognized detail code remains.
Plain retry-header containers are snapshotted only from bounded own data
descriptors for lowercase and standard canonical names, without enumerating
arbitrary keys. Prototype and own accessors are never executed; standard
captured `Headers.get()`-style methods retain full case-insensitive support.
Retry hooks are evaluated exactly once per failure, including errors that arrive
inside an already-open stream, so stateful policies observe one decision point
per provider attempt.
Router-owned terminal error codes are likewise captured by one classification
layer for streamed failures rather than being re-read by the stream wrapper.
An actually aborted caller signal always remains terminal, even when a custom
classifier asks to retry. By contrast, an `AbortError`, `ResponseAborted`, or
`TimeoutError` originating from the provider while the caller signal is still
active may be classified as retryable by `classifyFailure`; the default policy
continues to treat those named errors as terminal.
Genuine cross-realm `Error` and `DOMException` aborts are recognized by their
runtime brands; plain objects that only spoof an abort-like `name` are not.
Unreadable synthetic signal properties are isolated: an unreadable `aborted`
flag does not prove cancellation, while an unreadable reason on a confirmed
abort produces a stable `AbortError` before any provider call starts.
`willRetry` checks the current health and concurrency admission state rather
than merely checking whether another configured array element exists.
Generate and stream attempt events report the AIMD limit after the current
success/failure feedback is applied, while `inFlight` is the attempt's owned
slot count immediately before release. This includes stream failures that must
release ownership before fallback admission begins, including post-output
`stream-mid` failures when `retryAfterOutput` is enabled.
Its `index` is always the stable position in the configured logical-model array,
even after modality filtering or dynamic candidate selection. Stream events
include the same concurrency fields as non-streaming events.
Avoid using raw prompts, full model IDs, or credential identities as unbounded
metrics labels. The returned router also exposes
`getHealthSnapshot(logicalId?)` for diagnostics.
Hooks receive the original `entry` and provider `error` for debugging, so do not
blindly JSON-serialize their full payload into logs. Select bounded fields such
as `logicalId`, `index`, `phase`, `outcome`, status, and duration. Synchronous
hook throws and rejected async hook results are isolated and never affect
routing or create unhandled rejections.
Snapshot credential and provider-family key segments are stable fingerprints;
raw `healthKey`/`providerFamily` values are not returned. These identities
should still be opaque non-secret labels rather than API keys.
Configured unit, credential, and family records can be inspected before the
first routed request; reading snapshots does not instantiate provider models.
Store records are normalized into plain finite snapshots; malformed records,
throwing accessors, and Promise-returning async adapters fail open. Async
rejections are consumed, but adapters should remain synchronous as typed.

`strictStreamValidation` checks text/reasoning/tool block ordering and rejects
duplicate starts, deltas or ends without a start, unfinished blocks at finish,
missing/duplicate call-level starts, duplicate response metadata/tool-call IDs,
and streamed tool inputs that never produce a final tool call. Strict mode
buffers partial tool input until its final tool-call so malformed candidates can
still fall back without leaking partial arguments. A valid `finish` is terminal: the
downstream closes without waiting for the provider transport to close. Strict
validation is opt-in because some third-party compatible APIs emit non-standard
lifecycle sequences.

The fallback stream propagates downstream backpressure to the active upstream
reader, so a slow consumer does not cause unbounded queued output. Transparent
pre-output framing is capped at 1024 parts and 1 MiB of buffered text; a provider
that exceeds either cap is cancelled and treated as a retryable stream failure.
Warnings, raw chunks, and response metadata buffered from a pre-output failed
candidate are discarded; only the survivor's prelude is forwarded. Optional
stream-result `request`/`response` metadata follows the currently active
candidate, and throwing provider metadata getters are isolated as unavailable.

## Providers

`./friendli`, `./opengateway`, `./openrouter`, and `./wafer` are thin
`@ai-sdk/openai-compatible` wrappers that translate the AI SDK's reasoning
request into each provider's native field (and strip unsupported foreign
reasoning fields):

| Provider    | becomes                                                  |
| ----------- | -------------------------------------------------------- |
| Friendli    | `chat_template_kwargs.{thinking, enable_thinking}: bool` |
| OpenGateway | `reasoning_effort: "minimal", "low", "medium", ...`      |
| OpenRouter  | `reasoning.enabled: boolean`                             |
| Wafer       | `reasoning_effort: <level>` (on) / `thinking.type: 'disabled'` (off) |

OpenGateway keeps OpenGateway's OpenAI-compatible reasoning surface and lets the
AI SDK omit `reasoning: 'none'` instead of sending a model-specific unsupported
`reasoning_effort` value. OpenGateway also round-trips assistant
`reasoning_content` and `reasoning_details` through AI SDK multi-step /
multi-turn messages.

Wafer keeps the granular effort level rather than collapsing to on/off:
`low`/`medium`/`high` pass through, AI SDK `minimal` maps to `low`, AI SDK
`xhigh` maps to Wafer's `max`, and Wafer's extra `max` level is reachable via
`providerOptions.wafer.reasoningEffort: 'max'`. `MiniMax-M3` returns reasoning
inline as `<think>...</think>`, which the provider extracts into a reasoning
part. Preserving previous `reasoning_content` into later turns is separate and
is controlled by `createWafer({ preserveReasoning })`.

```ts
import { createFriendli } from '@minpeter/ai-router/friendli';
import { createOpenGateway } from '@minpeter/ai-router/opengateway';
import { streamText } from 'ai';

// The plain `reasoning` option drives it on AND off — no providerOptions needed.
// (A built-in transformParams middleware keeps `reasoning: 'none'` alive, which
// the AI SDK would otherwise drop before the wrapper sees it.)
await streamText({
  model: createFriendli()('moonshotai/Kimi-K2.5'),
  reasoning: 'high', // any level (low|medium|high|…) -> thinking = true
  prompt: '...',
});

await streamText({
  model: createFriendli()('moonshotai/Kimi-K2.5'),
  reasoning: 'none', // -> thinking = false
  prompt: '...',
});

await streamText({
  model: createOpenGateway()('openai/gpt-4o-mini'),
  reasoning: 'high', // -> reasoning_effort = "high"
  prompt: '...',
});
```

OpenGateway `message.reasoning_content` is exposed through the AI SDK's
`reasoningText`/`finalStep.reasoningText` when a routed model returns it, and
`extra.routing` is preserved under `providerMetadata.opengateway`. By default,
model-specific `message.reasoning_details` is not exposed as raw public metadata:
response message parts carry an opaque
`providerOptions.opengateway.reasoningDetailsRef`, and the provider resolves that
ref back to the OpenGateway request field `message.reasoning_details`. The
default ref store is scoped to the `createOpenGateway()` provider instance and
bounded by TTL/entry count. If you persist `response.messages` across workers or
restarts, provide a durable `reasoningDetailsStore`; callers that already persist
raw details can also send `providerOptions.opengateway.reasoningDetails`
directly. Store inputs are bounded JSON snapshots, custom methods are captured
once while retaining their receiver, and transient store rejections are not
memoized, allowing later persistence attempts to recover. Async custom-store
results must be genuine Promises checked through the native brand operation;
arbitrary thenable extensions are never consulted. Optional load/store
operations are discarded after one second so persistence cannot stall
generation or prompt replay. Prompt-local loads are deduplicated by ref and
capped at 1,024 unique refs, with at most 32 concurrent loads and one second of
total replay wait, bounding optional store calls, timers, and latency. If the
prompt-wide deadline wins, all partial replay changes are discarded so context
does not depend on load completion order. The
default store also clamps backward wall-clock movement so it cannot extend ref lifetime,
limits configuration to 100,000 entries and a 30-day TTL, and retries random-ref
collisions without overwriting existing reasoning data.

```ts
import type { JSONValue } from '@ai-sdk/provider';

const store = new Map<string, readonly JSONValue[]>();

const opengateway = createOpenGateway({
  reasoningDetailsStore: {
    store(details) {
      const ref = crypto.randomUUID();
      store.set(ref, [...details]);
      return ref;
    },
    load(ref) {
      return store.get(ref);
    },
  },
});
```

The OpenGateway live diagnostic scripts use `OPENGATEWAY_API_KEY` and default to
`https://apis.opengateway.ai/v1`. If you set `AI_BASE_URL` to a proxy or custom
host, also set `OPENGATEWAY_ALLOW_CUSTOM_BASE_URL=1`; otherwise the scripts
refuse to send the bearer token outside `*.opengateway.ai`.
Custom OpenGateway metadata extractors are normalized through bounded JSON
snapshots before merge: at most 128 provider namespaces, 10,000 containers, and
4 MiB of JSON text, with hostile getters/cycles rejected and special keys copied
without prototype mutation.
OpenGateway reasoning details are likewise copied without iterators, deduplicated
after snapshotting, and capped at 1,024 entries, 10,000 containers, and 1 MiB of
JSON text with a 64 KiB per-detail character limit.
Deduplication uses canonical JSON object-key ordering, so semantically identical
details and memo refs do not vary with provider property insertion order.
Optional custom metadata hook throws/rejections are isolated from successful
provider responses. Stream hooks are captured once, invoked with their original
receiver, and invalid async returns are consumed rather than leaked.
Known generate/stream extractor method slots are pre-consumed as a group, so a
throwing accessor cannot leak a rejected Promise sibling; Promise-valued
extractor objects and method slots fail open to built-in metadata only.
Generate hook Promises are recognized by native brand without consulting
arbitrary thenable extensions; synchronous metadata remains supported. A
never-settling optional generate hook is discarded after one second so built-in
routing metadata and the provider response can continue.
Optional reasoning-details store save/load failures and malformed refs only
disable persistence for that result or prompt; they do not fail generation or
streaming. Store objects and their `load`/`store` method slots must be
synchronous native values; rejected Promise siblings are consumed together
before accessor or shape failures are surfaced. Store construction settings use
the same pre-capture rule instead of parameter destructuring, so an early option
getter failure cannot leak later rejected Promise settings.
Store operations consume and reject Promise-valued detail containers, snapshot
valid bounded entries before invoking custom stores, and consume invalid or
Promise-valued refs before local or memo lookup without calling the adapter.
Captured custom load results are snapshotted for both synchronous and async
arrays before returning or memoizing, and custom store refs are validated at the
capture boundary. Memo wrappers normalize synchronous adapter failures back to
rejected Promises for stable async behavior.
Reasoning store clocks consume Promise-valued samples before requiring safe
integers. Web Crypto method slots and `randomUUID`/`getRandomValues` results must
be synchronous, bounded, and receiver-correct; arbitrary thenable results are
rejected without reading their extensions.
If an optional reasoning-store timeout cannot be registered, the in-flight load
or store Promise is consumed before the stable timer-unavailable rejection is
returned, preventing the provider's original rejection from leaking separately.
The OpenGateway provider factory and reasoning-roundtrip middleware also reject
Promise-valued settings synchronously after consuming every known own-data
sibling, and forward only documented OpenAI-compatible configuration slots.
Friendli, OpenRouter, and Wafer provider factories share the same capture
boundary. Provider header maps are bounded and snapshotted after consuming all
native Promise values, preventing mutation and rejected sibling leakage; Wafer
applies this before enforcing its ZDR header.
Provider header names are validated before any value accessor runs, while all
own-data Promise siblings are still consumed. Values enforce HTTP control-byte,
65,536-character, and 1 MiB aggregate limits before SDK configuration.
All four provider model factories consume native Promise IDs and require a
non-empty string of at most 4,096 characters before calling the underlying SDK,
without inspecting arbitrary thenable extensions.
Wafer's ZDR transport snapshots documented `RequestInit` fields, bounds record
or tuple headers to 1,024 entries, consumes nested Promise siblings while
preserving ordinary getter precedence, and requires the wrapped fetch to return
a genuine Promise without inspecting arbitrary thenables.
Reasoning request transforms and middleware shallow-snapshot at most 10,000 own
body fields after aggregate native-Promise consumption. This covers provider
options, nested dialect objects, Wafer's preservation alias, provider names,
and custom reasoning callbacks without inspecting arbitrary thenables.
Reasoning middleware hook argument objects are captured inside each hook rather
than through eager parameter destructuring. Generate/stream function slots,
params, model identity/operation slots, and their Promise siblings are consumed
together before invocation; OpenGateway stream calls preserve the model method
receiver explicitly.
OpenGateway reasoning middleware also bounds generate/stream result snapshots to
128 own fields before result spread. Generate content/response fields and stream
request/response/stream plus `pipeThrough` slots are consumed together before
reasoning metadata transformation, preventing post-provider rejection leaks.
If OpenGateway reasoning stream transform construction or `pipeThrough` fails,
the already-open provider stream is cancelled through the same safe late-result
cleanup semantics without importing the router stream runtime. Promise-valued or non-object pipe results are consumed, rejected,
and cleaned up instead of escaping as malformed stream results.
Reasoning content arrays are dense and capped at 10,000 entries. Content and
stream discriminants pre-consume known own-data Promise siblings, read only the
selected variant's active accessors, and snapshot nested provider metadata as
bounded JSON before adding a reasoning-details reference.
Reasoning replay input reuses the canonical call-options prompt snapshot before
starting up to 32 load workers. Prompt entries and store method Promise siblings
are pre-consumed across both arguments, provider-option containers are merged
only as JSON objects, and caller mutation cannot alter an in-flight replay.
Reasoning-details containers are capped at 1,024 entries and snapshot each
bounded JSON detail after pre-consuming native Promise entries. Exported input
and output helpers, store load results, and stream raw chunks share this path,
so rejected containers/entries and caller mutation cannot escape persistence.
Raw OpenGateway response bodies used for routing and reasoning extraction are
bounded to 50,000 JSON containers and 4 MiB of text before any `choices`,
message, delta, or routing access, consuming malformed Promise branches as one
stable snapshot.

### Wafer Preserved Reasoning

`preserveReasoning` controls Wafer's multi-turn reasoning retention fields. It
does not turn reasoning on by itself; keep using the AI SDK `reasoning` option
for effort level (`'none'`, `'low'`, `'medium'`, `'high'`, or Wafer's `'max'`
through `providerOptions.wafer.reasoningEffort`).

```ts
import { createWafer } from '@minpeter/ai-router/wafer';

const wafer = createWafer({ preserveReasoning: 'auto' });

await streamText({
  model: wafer('GLM-5.1'),
  reasoning: 'high',
  prompt: '...',
});
```

Modes:

| value    | behavior                                                                 |
| -------- | ------------------------------------------------------------------------ |
| `false`  | Default. Do not add Wafer preserved-reasoning fields.                    |
| `'auto'` | Add `preserve_thinking: true` and `thinking.keep: 'all'` only for `GLM-5.1` and `Kimi-K2.6`. |
| `true`   | Force those fields for every Wafer model, useful when probing new model support. |

You can override the provider default per call:

```ts
await streamText({
  model: wafer('GLM-5.1'),
  reasoning: 'high',
  providerOptions: { wafer: { preserveReasoning: false } },
  prompt: '...',
});
```

### Wafer Zero Data Retention

`createWafer` takes an extra `zdr` flag. When `true`, every request carries
`Wafer-ZDR: required`, so Wafer rejects the request unless it can guarantee
prompts and completions are never written to durable storage. It's off by
default — `required` fails the request closed when the account isn't
ZDR-entitled — but it doesn't change Wafer's per-token cost on an entitled
account. The provider enforces this header at fetch time as well, so per-call
headers cannot weaken `zdr: true`.

```ts
import { createWafer } from '@minpeter/ai-router/wafer';

const wafer = createWafer({ zdr: true });
await streamText({ model: wafer('GLM-5.1'), reasoning: 'high', prompt: '...' });
```

### Package artifact budgets

Package validation enforces explicit JavaScript byte budgets for every public
entry and a 100 KiB ceiling for shared ESM chunks. This prevents provider-local
changes from silently importing the full router runtime.
Provider query-parameter maps share the header snapshot boundary: at most 1,024
entries, 65,536 characters per value, and 1 MiB aggregate key/value text. Native
Promise values are consumed before rejection and caller mutation cannot alter
later request URLs.
Common provider settings fail eagerly for malformed bounded API/base URL
strings, boolean usage/structured-output flags, function-valued fetch/usage
converters, and object-valued metadata/URL capability containers. Wafer also
validates `zdr` and `preserveReasoning` before provider construction.
Provider `supportedUrls` callbacks are captured with their original settings
receiver. Synchronous or genuine-Promise results are bounded to 128 media types,
128 patterns per type, 1,024 total patterns, and 1 MiB aggregate pattern text;
RegExp source/flags are cloned from internal slots before capability exposure.
Friendli, OpenRouter, and Wafer metadata extractors capture generate/stream
method slots once with their original receivers. Generate hooks require genuine
Promises, synchronous stream hooks consume invalid async results, and metadata
inputs and outputs are bounded to 10,000 JSON containers and 4 MiB. Input
snapshots prevent optional hooks from mutating SDK-owned response bodies or
stream chunks.
OpenGateway's composed metadata extractor applies the same bounded input
isolation to user hooks while independently preserving its built-in routing
metadata extraction and per-hook failure isolation.
Provider `convertUsage` callbacks are captured with their settings receiver and
must return synchronously. SDK-owned callback input is bounded and copied before
invocation; output token containers are copied from known fields with
non-negative finite-number validation, while optional raw usage is bounded to
10,000 JSON containers and 1 MiB.
Custom provider fetch callbacks are captured with the settings receiver, turn
synchronous throws into rejected Promises, require genuine Promise results, and
reject primitive/null resolved values before they reach SDK response handling.
Response-like objects remain compatible without realm-specific brand checks;
arbitrary thenable return extensions are rejected without being inspected.
Stream capacity-release hooks receive ownership-isolated candidate snapshots,
so custom admission cleanup cannot corrupt the canonical half-open probe lease
that is released immediately afterward. Prepared probe leases are also released
when a synchronous admission-acquire hook throws or violates its result
contract, before the stream terminates.
Probe cleanup also runs when preparation synchronously declines admission,
covering hooks that partially claimed a lease before returning `false`, both
before immediate acquisition and after a capacity wait.
Preparation hooks receive an identity-isolated candidate: mutations to the
entry, model, or index cannot redirect later admission. Only a structurally
validated probe lease is handed back to the canonical candidate, including
when the hook throws after claiming it so cleanup can still release the lease.
Promise-valued probe-lease containers and known lease fields remain invalid for
this synchronous contract, but native Promise rejections are consumed before
the stable shape error is surfaced.
Probe-release hooks use the same identity isolation and return only their
validated lease state to the canonical candidate. A custom release hook cannot
redirect a later capacity wait or retry by mutating the candidate index, entry,
or model while still retaining the intended lease-clear handoff.
Generate and stream-open admission explicitly track capacity ownership across
the final-candidate wait path. If post-wait probe preparation or another
admission step throws after a slot is granted, both the slot and probe are
released before the infrastructure error escapes.
Stream-open capacity release is also `finally`-guarded around failure-policy
handling, so an unexpected classifier, aggregate, or routing-policy exception
cannot strand the slot before fallback advances or terminates.
Router-owned capacity and probe cleanup are independent: probe release runs in
a `finally` even if admission release fails, and the canonical lease is cleared
before health-store release so an infrastructure throw cannot leave stale local
probe ownership behind.
The probe lease's local/shared provenance is preserved through final-candidate
capacity waiting, post-wait preparation, consumer cancellation, and isolated
capacity-cleanup snapshots. Each exit therefore releases exactly the ownership
that was claimed without converting a local outage lease into a shared-store
write.
When a confirmed provider failure cannot be persisted because the optional
health store exhausts CAS retries or throws, a bounded process-local cooldown
overlay preserves that exact routing decision. Same-credential and same-family
candidates are therefore still skipped during the active request/store outage;
a later provider success clears the cooldown. If that recovery cannot be
persisted either, a local success tombstone masks the older shared cooldown
until the store accepts the recovery or a causally newer shared failure arrives.
Late failures older than the local recovery cannot reopen the circuit. Active
overlay records are included in isolated, redacted health snapshots and participate in
probe admission, so diagnostics and concurrent requests observe the same state.
Recovery of unit, credential, and provider-family scopes tolerates partial
shared-store commits: successfully written scopes use shared state while a
contended scope uses the store-scoped local success tombstone. All scopes are
combined for admission, so one causally newer failed scope still keeps the
candidate unavailable even when the other recovery writes succeeded.
Expired local cooldown records remain as recovery evidence and grant only one
process-local half-open lease while the shared store is unavailable; releasing
an unused lease permits the next probe without waiting for another timeout.
The same store-scoped coordination is used when a shared failure record remains
readable but lease CAS throws, returns a malformed non-boolean result, or cannot
advance a saturated version. A literal `false` CAS still means real contention
and is never converted into local ownership. This keeps routing fail-open for a
partial store outage without allowing every router instance in the process to
probe simultaneously.
Local lease release is ownership-conditional: a stale router cannot clear a
newer lease claimed by another router after the original lease expired.
Every availability/probe read reconciles the overlay with recovered shared
state first. A newer shared success or failure, including an ordering-token
transition at the same wall-clock millisecond, retires stale local evidence.
Retiring local evidence also clears any not-yet-handed-off probe lease in that
health state, so a recovery observed between claim and candidate preparation
cannot attach stale cleanup ownership to the candidate.
Local-origin handoffs additionally revalidate their store-scoped overlay
deadline at `takeProbeLease`, covering recovery observed by a different router
instance whose private handoff map cannot be directly cleared.
Lease provenance survives stream candidate snapshots and hook isolation. A
local-origin release clears only the local overlay and never writes to a
recovered shared store, even if that store now contains a lease with the same
key and deadline.
Each shared-store overlay retains at most 100,000 LRU-refreshed health records,
so repeated router creation with new namespaces cannot grow outage fallback
state without bound.
LRU eviction never removes a record with an active process-local probe while an
inactive record is available. If every retained record owns a live lease, a new
inactive failure is dropped instead of revoking existing cleanup ownership.
A store-scoped inactive-key LRU index keeps eviction-candidate selection O(1)
even when all 100,000 retained records own active leases; failure, probe,
release, recovery, and shared-state reconciliation update both indexes
atomically.
A bounded min-heap promotes expired probe leases into that inactive index before
cap enforcement, so a full overlay of recently expired probes cannot starve new
failure evidence. Stale heap nodes are lazily discarded and periodically rebuilt
from the capped record map, keeping deadline maintenance amortized O(log n).
Before claiming a new half-open probe, expired local claims for every applicable
unit, credential, and family key are pruned. An untaken old unit lease can no
longer shadow a newer credential or family lease during candidate handoff.
After preparation, capacity-release, or probe-release hooks return, native
Promises written into known fields of their discarded candidate snapshots are
consumed. Identity isolation therefore cannot turn hostile async mutations into
unhandled process rejections.
The same post-call consumption boundary covers read-only candidate hooks for
availability, acquire/wait admission, diagnostic metrics, and candidate health
outcomes, while preserving their synchronous result contracts.
Copied failure classifications passed to candidate-health and retry-budget
hooks receive equivalent post-call handling: Promise mutations to cooldown,
retry delay, retryability, scope, or status are consumed without changing the
canonical routing decision.
Candidate health hooks expose only the documented `HealthTransition` literals
to attempt telemetry. Invalid strings and objects are omitted, native Promises
are consumed, and arbitrary thenable extensions remain uninspected.
Stream and generate `onAttempt` hooks share bounded post-call cleanup for known
event fields and nested failure fields. Rejected Promise mutations are consumed
without enumerating hook-added properties or invoking replacement accessors,
including cooldown, concurrency, and max-attempt skipped events.
Generate and stream `onError` payloads apply the same bounded policy to entry,
error, index, logical id, phase, and retry fields, preventing rejected mutation
Promises from escaping optional error reporting.
Custom generate validators receive an isolated envelope whose seven known
top-level fields are post-processed through own-data descriptors. Rejected
Promise mutations are consumed without changing the already validated result
or invoking validator-added accessors.
Bounded nested validator inputs receive the same treatment for content and
warning variants, finish reason, request/response metadata, usage, and token
subfields. Only documented own-data slots are inspected.
Existing fields in bounded validator JSON graphs are pre-captured before the
hook runs (up to 200,000 fields) and revisited afterward. Deep rejected Promise
mutations in provider metadata, response bodies, raw usage, or content metadata
are consumed without following hook-added containers or keys.
Composed OpenGateway user metadata callbacks reuse the same pre-captured
JSON-field boundary. Generate metadata waits through async hook settlement and
stream chunks clean up immediately, without adding the callback traversal
runtime to smaller provider-only package entries.
If a synchronous OpenGateway stream metadata hook incorrectly returns a native
Promise, input cleanup runs both immediately and again when it settles so
post-`await` mutations are consumed. Never-settling hooks drop retained mutation
targets after one second.
Custom OpenGateway reasoning-details stores apply the same immediate and
post-settlement cleanup to their isolated `store(details)` input. Synchronous
and post-`await` rejected mutations are consumed without changing caller-owned
details, with the same one-second retention bound.
Async generate metadata and reasoning-store cleanup reuse their existing
one-second settlement timeout rather than scheduling a second retention timer;
only invalid async stream hooks need the separate late-mutation timer.
Consumer stream cancellation detaches the active reader before propagating
upstream cancellation, preventing the pump `finally` path from cancelling the
same reader twice. Its lock is released after cancellation settles, or after a
one-second best-effort retention bound when a custom cancel never settles.
Promise-valued consumer cancellation reasons are consumed and replaced with a
stable `AbortError` before abort forwarding or upstream cancellation; ordinary
reasons retain their identity.
Rejected or timed-out upstream reads now start reader cancellation before
fallback advances, so a signal-ignoring pending read cannot retain its transport
or lock. Reader-level guards deduplicate the subsequent failure-path cancel and
successful lock release.
Admission wait settlement is ordering-stable: release-first permanently grants
the slot despite a later abort, while abort-first removes the waiter before the
holder release and leaves no in-flight ownership or queue entry.
Admission release also tracks queue identity across synchronous settlement
reentrancy. A waiter enqueued by a custom/corrupted settlement callback remains
queued behind a granted slot, or is drained immediately when that settlement
rolls its slot back, instead of being deleted with the obsolete empty queue.
Retry-budget windows use an inclusive age boundary: a sample remains active at
exactly `window`, expires at `window + 1`, and availability/hysteresis is
recomputed immediately after pruning.
Sticky cooldown ordering is identical for generate and stream-open routing:
the sticky survivor remains first while round-robin rotates only the complete
fallback tail, keeping every compatible candidate reachable.
Round-robin cursor identities encode the exact ordered candidate indexes rather
than a collision-prone hash. Their LRU retention is bounded by both 1,024 pools
and one MiB of aggregate key text, preserving exact pool isolation without
allowing large dynamic candidate sets to grow memory without limit.
All upstream reader-cancel entry points now share that cancel-and-release
primitive, including finish, in-band error, unexpected failure, timeout, and
consumer cancellation, so fallback/backoff races cannot orphan lock cleanup.
Late stream-open results start transport cancellation before reusing the bounded
request/response metadata snapshot. Rejected native Promises in discarded top-level fields,
request bodies, response headers, and cancel slots are consumed even though the
result arrived after its attempt timeout and never enters normal validation.
Hostile request or response metadata cleanup remains independent from stream
cancellation, so an unreadable discarded envelope cannot strand the late
transport.
Generate attempts use the same late-resolution discipline: a result that arrives
after timeout is traversed through the bounded generate envelope snapshot so
rejected content, usage, request, response, warning, and provider-metadata
Promises cannot escape solely because fallback already returned another model.
Each top-level generate field is cleaned independently, so a throwing content
or usage accessor cannot prevent rejected siblings deeper in request/response
metadata from being observed.
Late fields also receive independent JSON/file budgets; a maximum-size content
or provider-metadata graph cannot exhaust the cleanup allowance needed by a
later request, response, or usage sibling.
The timeout primitive consumes genuine Promise results returned by late-result
disposers while leaving arbitrary thenable extensions uninspected. Async cleanup
rejections therefore cannot escape after timer and caller-abort listeners have
already been released.

## License

MIT
