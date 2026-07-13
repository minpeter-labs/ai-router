---
"@minpeter/ai-router": patch
---

Improve fallback coverage with structured failure classification, per-attempt
and total time budgets, first-content stream deadlines, max-attempt limits,
jittered backoff, result validation, candidate/key/family circuit breaking,
Retry-After support, shared routed-model state, and attempt observability. Also
handle provider-scoped 4xx failures, empty generations, incomplete streams, and
post-output stream errors more reliably.

Add shared health-store adapters and snapshots, half-open probe leases, a
sliding retry budget, strict stream lifecycle validation, hardened abort races,
and leak-free abortable backoff.

Recheck health before every attempt, deduplicate concurrent rate-limit
observations, protect newer successes from delayed failures, and support
per-credential `maxConcurrency` overflow routing.

Add abortable final-slot concurrency waiting, versioned atomic health-store
updates and leases, and AIMD adaptive concurrency controls.

Recompute health transitions after CAS conflicts, use one active probe scope,
make stream `willRetry` reflect completed admission, avoid waiting on cooling
candidates, namespace shared health keys, and replace millisecond ordering with
monotonic router-salted tokens.

Make retry budgets opt-in and expire observations after 60 seconds. Surface
exhausted health-store CAS retries through attempt observability, prune inactive
healthy tombstones after 24 hours, and isolate concurrency admission, waiting,
selection, and AIMD state in a dedicated internal controller.

Release admission slots and cancel upstream work on every terminal stream
failure, include stream-open failures in retry budgets, preserve CAS transition
observability for stream and success paths, and avoid holding capacity during
retry backoff. Ignore caller/request failures in outage and AIMD learning,
validate shared-key concurrency configuration, and reject finished streams that
contain no meaningful output.

Recheck health after concurrency admission, bound retry backoff by the remaining
total deadline, make already-aborted backoff fail immediately, and keep terminal
request-scoped 404 responses from poisoning provider health.

Stabilize observability indexes across filtering and selection, include
concurrency state on stream events, isolate round-robin cursors per compatible
candidate pool, prevent ambiguous namespace/logical-id health keys, and align
`willRetry` with request-level retry-budget limits.

Fail open when optional shared health-store operations throw, and prevent the
all-candidates-cooling recovery path from granting a half-open lease before the
configured cooldown actually expires.

Treat a valid stream `finish` as terminal even when the upstream transport never
closes, and share credential admission counters, wait queues, and AIMD state
across logical models belonging to the same router instance.

Share credential and provider-family cooldowns across logical models when an
explicit health namespace is used, while retaining logical-model isolation for
routing-unit failures.

Keep all healthy compatible candidates reachable after a sticky cooldown
survivor fails. Cooldown now promotes its survivor instead of skipping earlier
candidates by start offset, and least-inflight or round-robin selection applies
only to the fallback tail while that sticky head is active.

Release half-open probe leases when stream fallback admission is invalidated by
a concurrent health change, including after capacity waits, or when a capacity
wait rejects. Separate global
downstream output state from per-candidate stream commitment so post-output
fallbacks restart first-content validation and discard failed framing. Race
caller aborts locally for provider operations and open-stream reads so providers
that ignore their signal cannot leave routing hung.

Distinguish hard authentication failures from recoverable quota-like credential
failures, classify credential exhaustion carried by `400`/`404`/`503` bodies,
and parse provider reset headers in epoch, seconds, and duration forms.

Bind half-open probe leases to actual admitted attempts, claim them lazily, and
release owned leases early when concurrency, abort, or stream cancellation means
the provider was never reached.

Replace the 2039-unsafe numeric ordering multiplier with versioned opaque string
tokens while retaining legacy numeric store compatibility, and surface
capacity-only rejection through an exported `RouterConcurrencyError`.

Make `willRetry` account for current health and admission capacity, surface
all-cooling races through an exported `RouterHealthUnavailableError`, and retain
the final provider failure as the `cause` of multi-candidate `AggregateError`s.

Fingerprint credential and family identities in public health snapshots,
export `AdaptiveConcurrencyConfig`, document non-secret identity requirements,
and reject invalid negative, zero-string, NaN, or infinite cooldown intervals.

Make health snapshots independent of route call order and discover configured
unit, credential, and family records without instantiating provider factories.

Cache permanent invalid-model factory results without caching transient factory
throws, classify invalid models as long-lived routing-unit faults, and memoize
`supportedUrls` even when a non-conforming provider returns `undefined`.

Propagate downstream stream backpressure to upstream readers, unblock demand
waits on cancellation, release admission/probe resources exactly once, and cap
transparent pre-output framing at 1024 parts before falling back.

Record retry-budget outcomes once per completed request, so deep successful
fallback chains do not trip the outage budget, suppress caller/request failures,
and close the post-admission consumer-cancel resource race.

Allow retry-budget window, sample count, and trip/recovery hysteresis tuning;
validate pathological policies; and expose per-logical-model diagnostic budget
snapshots through the router API.

Bound provider error normalization by depth, nodes, properties, characters, and
header length; support circular bodies and hostile getters/proxies; and retain
both string head and tail without fully serializing large error payloads.

Expose per-candidate admission diagnostics, including shared in-flight and wait
counts plus adaptive limit and additive-increase progress, without returning
credential identities.

Isolate both synchronous observability-hook throws and asynchronous hook
rejections across generate and stream paths, preventing logging failures from
changing routing or becoming unhandled process rejections.

Bound retained round-robin candidate-pool cursors, wrap cursor counters, and
remove empty admission wait queues after successful wakeups for stable
long-running router memory. Honor the documented replacement semantics of a
custom `shouldRetry`, allowing it to broaden as well as restrict the default
retry policy.

Measure the first stream attempt from before `doStream` opens, matching later
fallback attempts and preventing provider opening latency from disappearing
from `onAttempt.durationMs` telemetry.

Reject empty provider-family identities and unknown runtime selection-policy
values instead of silently merging unrelated health or degrading to ordered
routing.

Route unrecognized file media types through an explicit generic `file`
modality, preventing application/vendor attachments from silently matching
text-only candidates while preserving universal catch-all entries.

Harden both bounded provider-error extraction and final aggregate-error
surfacing against throwing `Error.name`/`Error.message` accessors.

Validate every logical route eagerly without instantiating provider factories,
catch cross-model shared-admission conflicts before traffic, and treat inherited
object properties as unknown model ids. Normalize observability so skipped
events omit provider attempt numbers and post-output stream fallback skips use
the `stream-mid` phase.

Emit `healthTransition: "recovered"` only when a success clears an existing
failure or probe state, rather than labeling every health-enabled success as a
recovery.

Export `RouterTimeoutError` from the package root and expose its stable
`durationMs` diagnostic alongside the timeout code.

Use generic diagnostics for the shared duration parser, round positive
sub-millisecond durations up to 1ms, preserve caller abort reasons, calculate an
attempt's timeout duration and code atomically, and retain the configured total
timeout in mid-stream deadline errors.

Parse rate-limit reset metadata strictly: reject negative/trailing-garbage
values, keep oversized delays finite, isolate proxied native Headers failures,
and fall back from missing `responseHeaders` fields to `headers`. Verify
generate and stream aggregates preserve the final error as `.cause`.

Count every retryable non-request final failure—including credential `429`
outages—toward the opt-in request retry budget, while continuing to exclude
caller and terminal request-scoped errors.

Validate AIMD min/initial/max using the same effective defaults as admission,
omit false `ignored-stale` health transitions for request-scoped failures, and
emit a censored `cancelled` attempt event when a stream consumer stops early
without training provider health or concurrency control.

Expand strict V4 stream lifecycle validation to require call-level stream start,
single response metadata, unique tool-call IDs, and a final tool call for every
completed streamed tool input. Buffer strict partial tool arguments until that
final call and bound pre-output text buffering to 1 MiB in addition to the
existing 1024-part cap.

Require both `doGenerate` and `doStream` when validating cached V4 factory
results, and isolate rejected async `supportedUrls` discovery by conservatively
falling back to no native URL support.

Validate factory entry shape eagerly while keeping valid provider invocation
lazy, so missing providers or non-string model IDs fail as configuration errors
instead of recurring transient fallback attempts.

Isolate throwing optional stream request/response metadata getters, preserve
live metadata handoff to the fallback survivor, and verify that warnings/raw
prelude from failed candidates is discarded rather than mixed with survivor
provenance.

Validate and sanitize custom classifier/retry/response-validator return values,
treat validator contract bugs as terminal request errors, and snapshot mutable
factory model/provider, modality arrays, instance references, and AIMD config at
router creation so later caller mutation cannot bypass eager validation.

Validate V4 generate envelopes and content variants before returning them to
the SDK, including finish reason, warnings, usage shape, finite token counts,
and hostile metadata access. Apply equivalent mandatory finish/usage validation
to streams and route malformed or throwing finish metadata through normal
fallback and post-output retry policy.

Validate the complete V4 warning union for generate and stream results and
reject duplicate generated tool-call IDs while keeping provider-specific JSON
metadata opaque and pass-through compatible.

Harden synchronous health-store adapters against Promise-returning methods,
rejected async writes, throwing optional CAS getters, malformed CAS values, and
hostile/non-finite stored records. Normalize reads to plain records and build
snapshots from configured keys without materializing an unbounded store
iterator, enabling snapshots even when `entries` is absent.

Validate bounded v1 and finite legacy health ordering tokens, reject malformed
CAS versions/timestamps, compare variable-width v1 timestamps numerically, and
roll a saturated same-millisecond counter into the next logical millisecond to
preserve monotonic ordering during extreme bursts or clock rollback.

Classify arbitrary caller abort reasons from the caller signal instead of as
provider outages, and recompute retry-budget hysteresis when sliding-window
samples expire so stale failures cannot keep fallback constrained.

Cap oversized cooldown hints on both initial and deduplicated health failures,
preventing a repeated rate-limit response from extending health state beyond
the documented one-hour maximum.

Parse plain-object rate-limit headers even in runtimes without a global
`Headers` constructor.

Reject malformed candidate modalities, health identities, adaptive-concurrency
values, and retry-budget containers eagerly instead of silently changing their
meaning or failing on the first request.

Bound generate content, warning collections, and strict stream lifecycle ID
tracking so malformed provider output cannot consume unbounded validation CPU
or memory before fallback.

Snapshot ordinary JSON carried by raw stream chunks, charge it to the aggregate
stream JSON budget, and preserve opaque runtime raw values for V4 compatibility.
This prevents unbounded prelude retention and post-read mutation of parsed raw
provider events.

Capture unknown future stream-part types exactly once while preserving the
opaque part object's identity. Later getter results can no longer reinterpret a
validated future part as framing, error, or finish control flow.

Fail closed after one second when asynchronous `supportedUrls` discovery never
settles, preventing capability lookup from blocking an otherwise usable model
before fallback execution begins.

Roll back stream JSON and metadata validation budgets when a candidate fails
before commitment and its framing is discarded. Already-emitted output remains
cumulative, while failed preludes can no longer starve a healthy fallback's
validation allowance.

Cancel stream results that resolve only after their opening timeout or caller
abort has already won, so signal-ignoring providers cannot leave detached
upstream bodies running after fallback advances.

Copy structured failure classifications before exposing them to attempt
observability hooks, preventing event mutation from changing stream terminal
error surfacing or later routing state.

Copy record property descriptors at every public `MemoryRouterHealthStore`
boundary, preventing objects passed to `set` or returned by `get`/`entries`
from mutating stored cooldown and CAS state by alias without invoking hostile
getters or weakening malformed-store fail-open behavior.

Skip deferred provider invocation when caller cancellation wins before the
operation starts, while retaining abort forwarding and late-result cleanup for
operations that were already running.

Use a monotonic clock for total, backoff, admission, and first-content deadline
arithmetic, preventing system wall-clock rollback or forward jumps from
extending or prematurely exhausting fallback budgets.

Measure generate and stream attempt durations with the same monotonic clock,
keeping observability latency stable across wall-clock corrections.

Normalize structured failure classifications through one strict generate and
stream path: require literal scope strings, read fields once, avoid coercion,
and consume rejected native Promises returned by accidentally async hooks.

Consume resolved or rejected native Promises accidentally returned by
`validateResult`, surface a synchronous validator contract error, and avoid
reading arbitrary `then` extension getters on other invalid results.

Apply the same native-Promise consumption to `shouldRetry`: only literal
`true` can retry, rejected async returns cannot become unhandled rejections,
and arbitrary `then` properties remain unread.

Consume async observability failures through native Promise internal slots
instead of broad thenable assimilation, so logging hooks cannot trigger
arbitrary `then` getters or functions after routing completes.

Fail open on Promise-like health-store results without broad assimilation:
consume native Promise rejections through internal slots and detect custom
thenable extensions without invoking their `then` getters or functions.

Clone mutable generate response `Date` timestamps at the provider boundary,
matching streamed response metadata while retaining opaque request/response
body identity required by the V4 contract.

Snapshot stream request/response provenance once per active fallback candidate
and return fresh public containers, preventing repeated provider getter effects
and consumer mutation while preserving live survivor metadata handoff.

Rewrite emitted declaration-relative imports with explicit `.js` extensions
and compile a self-package NodeNext consumer during every build. Packed ESM
installs now expose the root and provider subpath types without TS2834 errors.

Exercise the package export map during every build through both ESM import and
CJS require for the root plus all four provider subpaths, preventing runtime
entry drift from declaration coverage.

Audit npm tarball and sourcemap contents during every build: allow only package
metadata plus `dist`, require every export target, restrict map inputs to
`src/**/*.ts`, and reject credential-shaped source content.

Isolate corrupted shared admission waiters whose `resolve` throws after slot
acquisition, rolling the newly acquired in-flight count back and continuing
release cleanup without leaking capacity.

Validate corrupted shared waiter return shapes: roll back counter changes from
throwing, unavailable, or non-positive/non-integer acquire results; consume and
reject async resolve results; and continue waking the next valid FIFO waiter.

Capture corrupted shared waiter `acquire` and `resolve` method slots once before
wake-up, consume native Promise-valued siblings, and preserve the original
receiver so stateful accessors cannot change between validation and invocation.

Replace full candidate-index joins in retained round-robin cursor keys with a
fixed-length, order-sensitive dual fingerprint. Maximum-size candidate pools no
longer retain tens of kilobytes per cursor entry while rotation stays isolated.

Capture bounded failure summary text before observability hooks run and carry it
from stream-open failures into mid-stream fallback. Aggregate messages remain
stable while `.errors` and `.cause` preserve original provider error identity.

Harden the package artifact guard itself: restrict `dist` tarball entries to
runtime, declaration, and map extensions; inspect nested sourcemaps recursively;
and detect additional common credential prefixes.

Keep the memoized `supportedUrls` capability canonical private and return fresh
map, array, and RegExp copies for every synchronous or asynchronous getter
access, preventing one consumer from changing later URL handling decisions.

Snapshot the in-memory health store's entry list before returning its iterator,
so LRU `get()` refreshes and later writes cannot repeat, omit, or inject records
during public iteration.

Capture `responseHeaders` and `headers` once before inspecting Retry-After and
all rate-limit reset names, preserving fallback precedence without repeated
error-container getter effects.

Capture each Headers-like `get` operation once with its original receiver
before querying bounded rate-limit names, avoiding repeated method-property
getter effects while retaining cross-realm compatibility.

Share one bounded error-field snapshot between default retry and structured
scope/cooldown classification, eliminating repeated status/message/body getter
reads while keeping standalone non-404 retry checks detail-free.

Reject unsafe-integer health counters from shared stores and saturate local
failure counts at `Number.MAX_SAFE_INTEGER`, preserving numeric ordering and CAS
semantics during extreme long-lived operation.

Keep bounded provider-error extraction fail-safe when hostile proxies throw
during `instanceof Error` prototype inspection.

Guard abort detection against the same hostile proxy traps so retryable
provider failures remain classifiable.

Drain FIFO admission waiters up to newly increased AIMD capacity, and ignore
unmatched releases so they cannot admit requests without returning a real slot.

Release half-open health probe leases before concurrency waiting and reclaim
them only after a real slot is granted, preventing queued requests from
reserving or outliving recovery probes.

Clamp attempt durations to zero after wall-clock rollback so observability never
emits negative latency values.

Surface caller aborts and status-less request control-flow failures directly
after earlier provider failures instead of burying their identity and timeout
codes inside an `AggregateError`.

Forward caller cancellation through the router's own timeout controller instead
of requiring `AbortSignal.any`, while preserving the original abort reason.

Separate scheduled remaining delay from timeout diagnostics so total and
first-content errors always report the user's configured duration.

Validate router/model containers before iteration and preserve malformed
adaptive-concurrency values through snapshot validation so `null` or arrays
cannot silently become a default AIMD policy. Report invalid modality containers
as configuration errors instead of iterator failures.

Read accessor-backed candidate `model` and `provider` fields exactly once while
snapshotting configuration, avoiding time-of-check/time-of-use divergence.

Fail open without writing when a shared health record's numeric CAS version is
saturated, avoiding an unsafe next version that would invalidate the record.

Rebase local retry-budget samples and sticky cooldown anchors after wall-clock
rollback so NTP corrections do not extend configured recovery windows.

Propagate downstream stream cancellation through fallback backoff, admission
waiting, response opening, and reads. Ignore cancellation-driven opening/read
rejections for health, AIMD, and retry-budget learning while releasing slots and
probe leases exactly once.

Avoid duplicate probe-release callbacks when capacity waiting rejects or times
out after the pre-wait lease was already returned.

Reject already-aborted generate and stream calls before candidate selection so
cancelled requests cannot rotate round-robin cursors or mutate cooldown state.

Compare v1 ordering timestamps with `BigInt` so variable-width values beyond
the safe integer range cannot invert stale-success/failure ordering during
shared-store migration.

Validate health identity and namespace types and cap them at 256 characters,
bounding shared-store keys, fingerprint work, and diagnostic label size.

Verify health, admission, and retry-budget diagnostics return mutation-isolated
snapshot objects rather than exposing live internal or shared-store state.

Snapshot fallback configuration and observability hooks once per router,
including nested retry-budget and cooldown policies, so accessor-backed or
mutable options cannot diverge across logical models.

Snapshot only known fallback fields, ignoring unrelated enumerable extension
getters that should not participate in router configuration.

Validate minimum shapes for known stream part variants before reading delta,
ID, tool, file, or source fields, routing malformed parts through fallback
instead of an unexpected pump exception while retaining unknown future parts.

Validate the tagged data/url union of generated file and reasoning-file content
instead of accepting any non-null object as file data.

Consolidate first-content timeout reader cancellation into the common failure
cleanup path, normalize abort fallback reasons, and verify timeout/backoff timers
and caller listeners are removed after settlement.

Lock package-root public error exports and single/Aggregate identity contracts
with direct API regression coverage; generated ESM and CJS exports remain
symmetrical.

Truncate bounded provider error text on Unicode code-point boundaries so emoji
and other surrogate pairs remain valid in logs, URLs, and JSON diagnostics.

Normalize non-finite, negative, and fractional error-text limits so bounded
extraction cannot accidentally become unbounded.

Recognize common 404 credit exhaustion phrases such as “not enough”, “too low”,
“depleted”, and “run out of” as retryable credential-scoped failures.

Recognize common missing-credential word orders on 503 gateway failures as
hard credential faults instead of generic transient outages.

Merge cooldown hints from concurrent failures without letting a delayed older
attempt overwrite the newest failure status and ordering metadata.

Allow repeated health failures separated by probe windows to continue their
exponential cooldown progression until the documented one-hour safety cap.

Require safe positive integers for concurrency, AIMD, and attempt limits, and
refuse admission when an in-flight counter reaches the safe integer boundary
instead of allowing precision loss and slot undercounting.

Allow a retry budget configured with `recoveryFailureRate: 0` to recover once
its retained window contains zero failures instead of remaining tripped forever.

Detect assistant reasoning files and files nested in tool-result content during
modality routing so they cannot be sent to incompatible text-only candidates.

Sanitize and bound synchronous or asynchronous `supportedUrls` maps, clone
regular-expression patterns for mutation isolation, and fail closed to `{}` on
malformed discovery results.

Use the first valid integer HTTP status across `statusCode` and `status`, so a
malformed primary alias cannot hide a valid rate-limit status. Ignore fractional
pseudo-status values instead of treating them as terminal client failures.

Reject fractional `statusCode` values returned by custom structured classifiers
instead of feeding malformed HTTP status data into health and AIMD state.

Read cross-realm `Headers`-like objects through a guarded `get` method and use
the longest value from combined numeric `Retry-After` fields.

Keep caller abort/timeout and router contract errors terminal and request-scoped
before invoking custom retry classifiers, preventing hooks from poisoning
health, AIMD, or retry budgets with router control flow.

Treat malformed stream-result envelopes and reader-acquisition failures as
provider stream failures, allowing a healthy fallback candidate to take over.

Keep admission preflight consistent with acquisition at the safe-integer
in-flight boundary so retry diagnostics never promise an impossible attempt.

Snapshot only known adaptive-concurrency fields so unrelated extension getters
cannot break router construction or mutate admission policy after creation.

Distinguish an actually aborted caller signal from provider-origin abort and
timeout errors, allowing custom classifiers to retry the latter while caller
abort identity remains terminal and protected from overrides.

Account for the failed attempt's pending slot release when computing
`willRetry`, keeping observability truthful when consecutive candidates share
one credential admission scope.

Interpret rate-limit reset epoch thresholds inclusively so exact boundary
timestamps are not mistaken for enormous relative cooldown durations.

Reject delayed or duplicate failure tokens even after their cooldown window
expires, preserving newer failure ordering, status, and recovery barriers.

Reject null, array, and function cooldown containers instead of silently
enabling the default sticky interval or leaking an internal property error.

Reject malformed top-level fallback containers eagerly instead of interpreting
arrays and functions as empty option objects.

Validate fallback hooks and boolean policy fields eagerly so malformed runtime
configuration cannot silently disable retries or enable risky stream behavior.

Validate observability hook types at router creation instead of silently
discarding hook invocation type errors during live requests.

Validate provider-metadata accessors on generated content and stream parts
while fallback is still possible, preventing deferred downstream getter errors.

Validate response-metadata IDs and timestamps, accepting cross-realm Dates via
their internal Date slot while rejecting malformed fields and hostile getters.

Accept genuine cross-realm Uint8Array and URL file payloads using platform brand
operations without admitting typed-array or URL lookalikes.

Identify Uint8Array payloads with the captured typed-array `Symbol.toStringTag`
intrinsic getter instead of `Object.prototype.toString`, avoiding hostile own
tag accessors while preserving cross-realm internal-slot validation.

Validate nested generate request/response metadata and sanitize stream-result
telemetry, bounding headers and isolating hostile accessors before SDK use.

Copy special stream response-header names as own data properties so a
`__proto__` header cannot mutate the sanitized metadata object's prototype.

Classify callable provider errors as object-like values, preserving their HTTP
status, retry headers, bounded message text, aggregate cause, and retry scope.

Ignore out-of-range provider pseudo-status values while continuing to valid
aliases, and reject out-of-range custom classification status contracts.

Reject sparse candidate, capability, warning, and supported-URL pattern arrays
whose holes would otherwise bypass JavaScript every/map validation.

Apply collection caps before dense-array scans, bound capability lists to the
known modality set, and cap each logical route at 10,000 candidates to prevent
oversized sparse configuration from consuming unbounded validation time.

Read top-level generate envelope accessors exactly once and return stable copies
of validated content and warning arrays, closing validation/use races.

Snapshot standard finish-reason and usage fields, including raw usage, so nested
accessors cannot change token accounting or completion status after validation.

Snapshot generate request/response fields and bounded headers exactly once,
preserving special header names safely and isolating later provider mutation.

Snapshot all current V4 generate content part fields and tagged file data once,
retaining providerMetadata while ignoring unrelated extension getters.

Validate optional content-part flags, source metadata fields, and the outer
providerMetadata shape so malformed standard fields trigger fallback.

Apply the same optional-field and providerMetadata validation to known stream
parts before any malformed metadata reaches the consumer.

Move optional-field validators out of per-part hot paths to avoid repeated
closure allocation during long generated results and streams.

Snapshot every current V4 stream part and nested warning/file/finish structure
once while preserving unknown future part objects as opaque pass-through data.

Keep ordinary high-frequency text/reasoning delta objects on a zero-copy fast
path, snapshotting them only when known fields are accessor-backed or inherited.

Remove the temporary field-array allocation from stream fast-path accessor
checks so ordinary delta validation does not create helper garbage.

Bound, validate, and snapshot generate-side provider JSON values, rejecting
cycles, sparse arrays, non-finite numbers, invalid primitives, excessive depth,
oversized graphs, and hostile getters before SDK consumption.

Apply bounded JSON snapshots to stream providerMetadata, tool results, and raw
usage so malformed payloads can fall back before committing output.

Snapshot provider model methods once and invoke them with their original model
as `this`, preventing validation/use accessor races without breaking bound
provider implementations. Keep identity metadata and supportedUrls lazy.

Clone mutable V4 call-option containers for every provider attempt so a failing
provider cannot mutate prompt parts, tools, headers, or stop sequences observed
by later fallback candidates or the caller.

Deep-copy valid JSON provider options, tool schemas/examples/args, tool inputs,
tool-result JSON, and response schemas per attempt while preserving opaque
binary and URL leaf identity.

Classify call-option clone failures as terminal request contract errors so
hostile caller accessors cannot poison provider health, AIMD, or retry budgets.

Bound and require dense prompt/message, tool, and stop-sequence arrays, and
validate bounded string-valued request headers before provider selection.

Validate finite/integer scalar options, reasoning and raw-chunk policies,
responseFormat, toolChoice, tool definitions, bounded header names/values, JSON
schemas/options, and AbortSignal shape as request contracts.

Validate and snapshot role-specific V4 prompt parts, tagged file payloads,
provider references, tool outputs, and approval responses before provider
selection. Read prompt message fields once to prevent accessor validation/use
races, and preserve special provider-reference keys without prototype mutation.

Snapshot only known top-level call-option, tool, response-format, and
tool-choice fields, reading accessor-backed values once and excluding unknown
properties. Reject invalid HTTP header names and control characters before a
caller contract failure can be misclassified as a provider fallback failure.

Reject duplicate or empty tool names, malformed provider-tool identifiers, and
specific tool choices without a matching definition before attempting any
provider. Require JSON snapshots to use genuine JSON containers so Date, Map,
Set, typed arrays, and class instances cannot be silently rewritten as objects;
cross-realm plain objects remain supported.

Align prompt cloning with the full V4 tool-output content union by accepting
custom output parts, while restricting reasoning files to their documented
data/URL payloads. Snapshot bounded prompt, content, stop-sequence, and tool
arrays index-by-index before validation so Proxy-backed collections cannot
change between dense checks and provider-attempt cloning.

Snapshot generate content/warnings, stream-start warnings, and nested JSON
arrays by captured length and one read per index. This prevents Proxy-backed
provider results from changing between shape validation and SDK consumption;
unreadable warning indexes now fall back before any primary output is exposed.

Avoid re-reading oversized generate response-header Proxies during validation,
and verify nested generate/stream finish and usage fields are snapshotted once.
Reject invalid request and result header names before evaluating their values,
preventing hostile getters from running when the key alone is already invalid.

Reject unknown generated and streamed file-data tags without evaluating
irrelevant payload getters, while preserving byte and URL identity as required
by the V4 no-unnecessary-conversion contract. Validate namespaced custom-content
kinds consistently across prompts, generate results, and streams.

Reject empty or oversized prompt, tool, generate, and stream identifiers before
they enter provider calls or strict lifecycle tracking sets. Bound unknown
future stream part type names and avoid tracking oversized unknown IDs, closing
count-bounded but byte-unbounded memory growth while retaining future parts.

Reduce strict lifecycle tracking to 1,024 bounded IDs and enforce a cumulative
10,000-container provider-metadata budget across buffered stream framing. Cache
per-part metadata weights, and fall back without exposing an oversized primary
prelude when individually valid metadata objects exceed the aggregate budget.

Track JSON container cost during snapshots and cap aggregate generate-side
provider metadata, tool results, and raw usage at 50,000 containers before the
entire envelope is copied. Add 1 MiB aggregate budgets for request/result
headers and generate/stream warning text, with 64 KiB per warning field, so
individually valid entries cannot multiply into unbounded metadata payloads.

Apply a 50,000-container aggregate JSON budget across each call-options clone,
covering prompt/message/part options, tool schemas/examples/args, tool inputs
and results, response schemas, and top-level provider options. Require JSON for
tool-call inputs, provider-tool args, function schemas, and JSON tool outputs
instead of falling back to mutation-leaking shallow copies. Bound each stop
sequence at 64 KiB, reject empty values, and cap their request total at 1 MiB.

Apply a request-wide 50,000-container JSON budget across all stream candidates,
including provider metadata, tool results, and raw finish usage, while leaving
metadata-free text/reasoning deltas on the zero-copy fast path. Treat a
post-commit budget overflow like other invalid stream metadata: surface it by
default, or continue to a survivor only when retry-after-output is enabled.

Measure JSON string values and object-key characters during snapshot traversal,
rejecting oversized keys before their value getters run. Apply a 4 MiB
aggregate character budget alongside container budgets for call options,
generate envelopes, and full multi-candidate streams, counting repeated shared
strings once per transmitted occurrence rather than once per object identity.

Separate unrestricted model body/file payload text from standard metadata and
apply a 4 MiB occurrence-based metadata budget across call options, generate
results, and streams. Bound individual filenames, source URLs/titles, finish
raw reasons, tool descriptions, response/model IDs, and media types, including
nested tool-output files and provider-reference IDs, without limiting generated
text/reasoning deltas.

Route HTTP-date Retry-After delays through the same finite/safe-integer clamp as
numeric resets, require finite clocks for date and explicit epoch reset values,
and retain clock-independent duration-style resets. Reject cooldown reset
intervals whose rounded milliseconds exceed JavaScript's safe-integer range;
configured timeout/backoff timers remain capped at 24 hours.

Treat shared health records as an external trust boundary: fail open for
cooldowns beyond the one-hour cap plus five minutes of clock skew, probe leases
beyond 30 seconds plus skew, future observed timestamps, and v1 ordering tokens
whose embedded wall clock is too far ahead. Preserve legacy numeric ordering
tokens and honor records exactly at the allowed distributed-clock boundary.

Freeze retry-budget time at the last valid safe-integer clock reading when a
clock returns NaN, Infinity, or an unsafe value, allowing normal expiry after
the clock recovers. Repair malformed shared admission counters and adaptive
state fail-open, preserve intentional MAX_SAFE_INTEGER saturation, validate
wait durations/deadlines, discard malformed queue entries, and cap waiters at
10,000 per shared capacity key.

Bound long-lived router cardinality to 10,000 logical routes, 10,000 candidates
per route, and 100,000 aggregate candidates, with 256-character non-empty
logical IDs and single-read route values before wrapper construction. Add a
configurable LRU bound to MemoryRouterHealthStore (100,000 records by default)
so sharing one in-memory store across many router lifetimes cannot grow without
limit; model caches and admission/health registries remain configuration-bound.

Keep provider factory/model accessor throws transient instead of collapsing
them into the permanent invalid-model cache, while continuing to memoize stable
non-v4 or method-incomplete shapes. Detect unsupported async factory returns by
the native Promise internal slot without reading arbitrary `then` extensions,
consume Promise rejections, and preserve one-time method snapshots with the
original model as `this`. Distinguish wrapper entries via the `model` field
before reading bare-model fields so alternate-shape extension getters stay idle.

Harden single-candidate supportedUrls discovery with one-read async thenable
assimilation, rejection cleanup, cross-realm RegExp internal-slot cloning, and
safe special-key writes. Snapshot Proxy-backed pattern arrays once and bound
capability maps to 128 media types, 128 patterns per type, 1,024 total patterns,
4,096 source characters per pattern, and 1 MiB aggregate source text.

Evaluate custom retry policy exactly once for failures inside an open stream;
previously the stream layer could invoke the already-applied hook a second time
and incorrectly veto fallback for stateful policies.

Avoid re-reading router-owned terminal error codes in the stream wrapper when
the router's structured classifier already enforces the terminal boundary.

Enumerate plain rate-limit header dictionaries once per error and snapshot only
bounded relevant names, preventing repeated Proxy structure traps across reset
header variants.

Preserve direct lowercase rate-limit header lookup when a hostile Proxy rejects
structural enumeration, without re-reading any captured header value.

Continue to a secondary header container when the preferred response header is
present but malformed, so a bad duplicate cannot hide a valid retry delay.

Deduplicate aliased `responseHeaders` and `headers` containers by identity so
one physical Headers-like source is never captured or queried twice.

Use one clock snapshot throughout each health availability, probe, and
post-selection availability decision, including shared-record normalization.

Use one observed clock value across every unit, credential, and family record
cleared by a success and across each diagnostic health snapshot.

Reuse the observed success time as its implicit ordering token, avoiding a
second clock read when no explicit attempt token is supplied.

Use one observed clock value throughout each failure transition, including
shared-record validation, cooldown calculation, implicit ordering, and CAS retries.

Freeze retry-budget time at the last valid timestamp when its clock throws or
returns a negative value, matching existing non-finite/unsafe clock handling.

Recognize provider 404 messages stating that no model-serving endpoint was
found, allowing fallback while unrelated resource 404s remain terminal.

Classify model-unavailable 404s tied to subscription/current/paid plans or
pay-as-you-go access as credential-scoped recoverable failures.

Recognize proxy budget, spend, billing, and monthly-limit exhaustion as
recoverable credential failures, including LiteLLM-style `ExceededBudget` 400s.

Recognize explicit structured provider credential-exhaustion codes independent
of natural-language phrasing; terminated-access codes receive the hard-auth floor.

Recognize a bounded allowlist of explicit invalid-key, authentication, token,
and disabled-key codes as hard credential failures even on non-standard statuses.

Treat explicit `model_not_found` and `model_not_available` codes as retryable
routing-unit failures independently of a gateway's surrounding status.

Capture top-level provider error codes in standalone retry checks while retaining
the no-body/message-read fast path for unambiguous non-404 statuses.

Share structured credential and model-code recognition between retry decisions
and health-scope classification so their allowlists cannot drift apart.

Recheck admission cancellation immediately after abort-listener registration,
closing the race where an abort could fire between the initial check and the
subscription and otherwise leave a waiter queued until timeout.

Roll back admission waiters and timers when abort-listener registration throws,
and fall back to a standard AbortError when a hostile signal reason is unreadable.

Discard corrupted admission queues whose length is unreadable or exceeds the
10,000-waiter bound before release and snapshot paths can traverse them.

Snapshot bounded waiter queues index-by-index into plain arrays before release,
removal, or diagnostics mutate them, isolating hostile Proxy collection methods.

Reject non-array waiter-queue corruptions by brand before reading a potentially
hostile `length` extension.

Capture abort-like Error names once before matching `AbortError`,
`ResponseAborted`, and `TimeoutError`, avoiding repeated hostile accessor reads.

Close abort-listener registration races in timeout and backoff helpers, capture
caller reasons once, and prevent listener-cleanup exceptions from replacing
successful operation outcomes.

Apply the same abort registration recheck, single reason capture, and cleanup
isolation to request-wide fallback stream cancellation forwarding.

Ignore repeated abort-listener delivery after first settlement in timeout,
backoff, and live-stream forwarding so reason accessors execute only once.

Use the platform `Error.isError` brand check when available so genuine
cross-realm abort errors remain terminal without accepting name-only lookalikes.

Use the native DOMException name accessor as a Web-IDL brand check so genuine
cross-realm abort DOMExceptions remain terminal without trusting plain objects.

Guard the stream classifier's caller-abort check so a hostile signal getter
cannot replace a provider failure or prevent a valid fallback attempt.

Fail safely before provider selection when a confirmed-aborted synthetic signal
has an unreadable reason, while treating an unreadable abort flag as unproven.

Apply the same fail-open abort-flag policy while waiting for admission so an
unreadable signal accessor cannot strand or spuriously reject a queued request.

Freeze health time at the last valid sample when an injected clock throws or
returns an invalid value, then resume cooldown expiry after clock recovery.

Sanitize both performance and wall-clock timeout samples so throwing, negative,
or non-finite platform clocks cannot break deadline and duration bookkeeping.

Guard the non-streaming caller-abort classification check so an unreadable
signal flag cannot replace a provider error or suppress a valid fallback.

Include structured response format names and descriptions in call metadata
bounds so repeated fallback cloning cannot amplify unbounded schema labels.

Keep logical attempt ordering and relative Retry-After hints operational when
the platform wall clock throws; absolute-date hints fail open without a clock.

Isolate HTTP-date parser failures so malformed absolute Retry-After values do
not hide valid secondary rate-limit reset headers.

Isolate supported-URL discovery timer cleanup so a throwing clearTimeout cannot
leave an otherwise resolved capability lookup permanently pending.

Freeze sticky cooldown time at the last valid clock sample across throwing,
negative, or non-finite values, and resume expiry when the clock recovers.

Lock request-budget suppression after a caller abort that follows an earlier
provider failure, and verify aggregate errors snapshot their failure list.

Pass custom result validators an isolated bounded snapshot so predicate-side
container mutation cannot rewrite a successful result returned to consumers.

Count buffered JSON metadata with bounded indexed traversal, avoiding custom
array iterators and treating hostile structure access as overflow.

Cover late stream disposal against hostile result access, synchronous cancel
throws, and asynchronous cancel rejection without leaking detached failures.

Preserve malformed retry-budget array containers through configuration
snapshotting so eager validation rejects them instead of accepting defaults.

Accept cross-realm plain configuration records while rejecting Date, class,
array, and other runtime containers for nested fallback and admission configs.

Snapshot shared adaptive-concurrency state fields once and rebuild throwing or
malformed registry values before diagnostics or routing consume them.

Verify stale probe owners cannot conditionally release a newer lease written by
another router during shared-store contention.

Require code/type/tag field context for structured provider markers found in
body details so marker-shaped object keys do not trigger false fallback.


Reject sourcemap source traversal, non-empty source roots, and missing embedded
sources, and scan every published text artifact rather than only sourcemap
source content for credential-shaped values.

Walk nested package export conditions recursively with a bounded traversal and
reject absolute, backslash, or path-traversing targets before checking that
every exported file is present in the tarball.

Extract package artifact validation into directly tested pure guards and cover
malicious export targets, recursive condition trees, invalid sourcemaps,
unexpected tarball files, and credential-shaped published text.

Preserve valid numeric members in partially malformed combined `Retry-After`
headers, and choose the longest valid delay across duplicate response-header
containers instead of allowing a later preferred-container value to hide it.

Preserve valid epoch and duration members in partially malformed combined
rate-limit reset headers instead of discarding the entire provider hint.

Retry `421 Misdirected Request` and `425 Too Early` responses as transient
candidate failures instead of terminating fallback as generic client errors.

Classify natural-language requested-provider and model availability failures as
routing-unit faults, without misclassifying subscription-plan access failures.

Keep gateway WAF blocks and supported-model capability failures routing-unit
scoped so a model-specific rejection cannot cool a shared credential.

Verify through shared-health routing that a model-specific WAF rejection cannot
prevent a sibling logical model from trying the same credential independently.

Require block, reject, or deny context around natural-language Cloudflare WAF
markers so echoed request text cannot create a routing-unit false positive.

Restrict structured and bounded JSON provider-body classification to semantic
error fields, preventing echoed request content from triggering fallback or
credential/model health transitions.

Avoid structural enumeration during semantic provider-error extraction by
reading only fixed error fields and bounded array indexes.

Reject coercible semantic error-array lengths and prioritize core error fields
before verbose descriptions consume the bounded classification text budget.

Ignore malformed or oversized JSON-like provider bodies during semantic
classification instead of falling back to scanning echoed request content.

Recognize semantic provider failures inside Axios-style response/data/body
object wrappers while continuing to exclude primitive and request echo fields.

Parse bounded valid JSON strings nested inside provider response wrappers and
apply the same semantic filtering without admitting plain primitive echoes.

Read Axios-style nested response statuses once and use them as bounded HTTP
status aliases for retry and health-scope classification.

Keep exported error normalization aligned with the default classifier's nested
Axios response-status aliases.

Honor Axios-style nested response rate-limit headers while sharing one response
snapshot across status, body, and retry-delay classification.

Support bounded multi-value rate-limit header arrays from Node and Axios without
invoking custom iterators, coercing lengths, or trusting non-string members.

Fall back to one bounded own-field snapshot when a Headers-like getter throws or
returns no usable values, without repeating structural enumeration.

Avoid re-reading unusable exact lowercase rate-limit field getters during the
bounded case-variant enumeration pass.

Classify one wrapped SDK provider cause and honor its bounded response headers,
including precise `retry-after-ms`, while keeping valid top-level status/code
fields authoritative and reading wrapper containers once.

Align exported error normalization with one-level wrapped-cause status/message
fallback and top-level precedence.

Keep valid top-level rate-limit hints authoritative over wrapped causes, falling
through to cause headers only when the top tier has no usable delay and
deduplicating aliases across both tiers.

Preserve the boolean retry classifier's no-details fast path by avoiding cause
access after an authoritative top-level status, while structured health
classification explicitly captures cause headers for cooldown timing.

Verify wrapped credential causes end to end across generate and pre-output
stream fallback, including shared credential cooldown across logical models.

Verify a pre-output stream failure with a genuine wrapped abort cause remains
terminal, does not invoke a fallback provider, and does not poison health.

Share one default bounded in-memory health store across every logical model in a
router instance, making explicit-namespace credential/family sharing work
without requiring callers to provide a custom store.

Verify default stores remain isolated between router instances while
provider-family health is shared across logical models inside one instance.

Verify a newer success from another logical model clears shared credential
cooldown and lets the original route immediately retry its recovered primary.

Share one monotonic ordering-token source across all logical models in a router,
preventing an older same-millisecond cross-model success from erasing a newer
shared credential or family failure.

Reuse the ordering-token source across router instances that share one
process-local health-store object, with weak registration to avoid retaining
discarded stores.

Treat same-millisecond distributed tokens from different sources as causally
incomparable for health recovery, preventing lexical salt order from clearing a
failure until a strictly later success arrives.

Apply the same distributed ambiguity rule to failure suppression and
post-selection invalidation, preserving failures instead of trusting lexical
salt order.

Verify a long-lived stream that started earlier cannot clear a newer shared
credential failure when its successful finish arrives later.

Verify a stream that started after an older failure attempt clears shared
credential cooldown when it finishes successfully and re-enables the primary.

Validate custom health-store adapter shape eagerly before weak registration or
route construction, including required methods and optional CAS/entry methods.

Verify cancelling an older content-bearing stream does not clear a newer shared
credential failure, while upstream cancellation and admission release happen
exactly once.

Verify cancelling an active half-open stream releases its probe lease and
admission slot immediately, allowing another probe without waiting for expiry.

Verify post-output fallback records credential health and makes sibling logical
models skip the shared primary while preserving the explicitly duplicated text
semantics of `retryAfterOutput: true`.

Bound top-level stream response-header enumeration before value access and
reject invalid HTTP names or control-character values without invoking hostile
getters.

Share bounded header-key traversal and HTTP syntax validation across request
cloning, generate response metadata, and stream response metadata.

Reuse bounded own-key traversal for provider references, JSON values,
supported-URL maps, and logical route registries, rejecting oversized objects
before reading any values.

Normalize OpenGateway custom metadata through bounded JSON snapshots before
merging, limiting provider namespaces and preserving special keys without
prototype mutation while ignoring cyclic or hostile metadata.

Bound, snapshot, and deduplicate OpenGateway reasoning details without custom
iterators across response extraction and prompt replay, including aggregate and
per-detail JSON budgets.

Isolate optional OpenGateway metadata extractor failures across generate and
stream hooks, preserving built-in routing metadata and consuming rejected native
Promises returned from synchronous stream hook contracts.

Isolate optional reasoning-details store save/load failures and reject malformed
refs so persistence outages cannot turn successful OpenGateway responses into
fallback failures.

Validate the in-memory reasoning-details store configuration and clock, snapshot
public store inputs without custom iterators, preserve custom-store receivers,
and evict rejected memo entries so transient persistence failures can recover.

Capture reasoning-store methods once for both prompt replay and response
persistence, and use a monotonic wall-clock floor so backward clock corrections
cannot extend opaque-ref lifetimes.

Cap reasoning-store entry and TTL configuration, stop expiry scans at the first
live insertion, and retry random-ref collisions instead of overwriting existing
reasoning data.

Capture custom health-store methods once while preserving their receiver and
reuse the captured adapter by source-store identity across router instances.

Snapshot candidate `supports` arrays by bounded index without invoking custom
array methods or iterators.

Copy each logical route's bounded candidate array by index before construction,
preventing caller-defined array methods or iterators from entering fallback setup.

Require literal string generate and stream discriminants without invoking
provider-defined string coercion during result validation.

Capture the initial caller `abortSignal` getter inside the call-options contract
boundary so hostile access fails as a typed terminal request error.

Capture abort-listener methods once per signal across timeout, admission, and
stream forwarding, preserving receivers and rolling back partial registration.

Pre-consume native Promise-valued abort-listener method siblings before either
method accessor executes, preserving ordinary accessor-error precedence without
leaking a rejected sibling Promise.

Isolate timeout/admission timer cleanup failures and degrade an unavailable or
invalid random source to zero-delay backoff instead of aborting fallback.

Fall back to a process-local ordering-source counter when both Web Crypto and
random entropy are unavailable, preserving router construction and ordering.

Fail terminally with `RouterTimerError` before provider execution when timer
registration is unavailable, preventing detached attempts and futile fan-out.

Reject deadline-unsafe clock samples and bypass AbortController construction
when a call has neither timeout nor caller cancellation.

Fail terminally before provider execution when required AbortController
construction is unavailable, and isolate throwing abort operations from promise
settlement.

Preserve first-control identity when consumer cancellation follows caller abort.
Reuse the captured caller reason for upstream reader cancellation and suppress
the later consumer `cancelled` attempt event, while retaining normal
consumer-first active and pending cancellation observability.

Verify the reverse ordering for both active reads and pending fallback
admission. Consumer-first cancellation retains its upstream reason and exactly
one active or attempt-number-free pending `cancelled` event; a later caller
abort cannot duplicate events or rewrite health, budget, queue, or capacity.

Define first-content timeout versus caller-abort ordering. An abort before the
deadline wins with exact identity and zero provider feedback; a timeout that
settles first may fail the hanging candidate and complete a fallback once, and
a later abort cannot replace or duplicate the settled health, budget, attempt,
reader, or capacity outcome.

Verify equal-timestamp first-content timeout and caller-abort callbacks in both
registration orders. Abort-first creates no provider feedback. Timeout-first
records one primary candidate failure, while the same-turn abort still cancels
fallback opening with exact identity and censored request budget, without
duplicate events or capacity ownership.

Verify equal-timestamp first-content timeout and consumer cancellation in both
registration orders. Cancel-first emits one active cancellation and no timeout
feedback. Timeout-first emits one primary failure and one opening-fallback
cancellation, with censored request budget and complete capacity release in
both cases.

Capture stream reader acquisition, read, cancellation, and lock-release methods
once with their original receivers preserved.

Consume native stream-cancellation Promise rejections without consulting
arbitrary thenable extension getters or functions.

Snapshot each stream read-result envelope once and route malformed `done`/value
containers through pre-output fallback instead of terminating the pump.

Cancel an already-open upstream and release its admission/probe leases when
local wrapper-stream construction fails, surfacing `RouterStreamError`.

Recheck consumer cancellation after asynchronous part snapshotting, preventing
post-cancel enqueue, success events, or health recovery.

Validate and capture a fallback reader before activating its public metadata,
preventing malformed intermediate candidates from leaking provenance.

Cancel opened streams best-effort when `getReader` access, invocation, or its
returned reader shape fails before reader ownership can be established.

Cancel and release partially captured readers when a method accessor fails
after `getReader()` has already locked the upstream.

Require reader `read()` to return a genuine Promise without consulting
arbitrary thenable extension getters or functions.

Require asynchronous reasoning-store load/store results to be genuine Promises
without consulting arbitrary thenable extensions.

Await genuine generate-metadata extractor Promises by native brand while
treating non-Promise values synchronously without consulting thenable extensions.

Bound optional generate-metadata hooks to one second so a never-settling custom
extractor cannot stall an otherwise successful provider response.

Bound optional reasoning-store load/store operations to one second so a
never-settling persistence adapter cannot stall generation or prompt replay.

Deduplicate prompt-local reasoning-ref loads and cap memoized load/store keys at
1,024 to bound optional persistence call, timer, and memory cardinality.

Limit prompt reasoning replay to 32 concurrent loads and one second overall,
returning untouched messages for optional work that does not finish in time.

Make prompt replay timeout all-or-nothing, discarding partial transformations
so reasoning context is deterministic across store completion orderings.

Canonicalize JSON object-key order for reasoning-detail deduplication and memo
keys, reusing refs for semantically identical provider details.

Maintain retry-budget windows with a compacting head cursor and incremental
failure count, avoiding repeated full-array shifts and scans.

Verify retry-budget counts remain exact across repeated cursor compaction,
wall-clock rollback rebasing, and subsequent full-window expiry.

Keep ordering tokens parser-compatible when the platform clock throws or
returns a negative, fractional, non-finite, unsafe-integer, or out-of-Date-range
value.

Share the hardened ordering-token source with direct stream-wrapper fallback,
removing same-millisecond collisions and hostile-clock failures from its legacy
numeric token fallback.

Isolate stream capacity and probe release hooks independently, preventing a
throwing cleanup adapter from interrupting fallback or suppressing the other
lease release.

Consume native Promise results from capacity and probe release hooks through
the shared cleanup path across setup failure, rollback, skip, cancellation, and
normal terminal release without inspecting arbitrary thenables.

Isolate optional stream health, cooldown, and retry-budget state hooks so their
failures cannot alter provider fallback or final stream settlement.

Pass copied failure classifications to stream health and retry-budget hooks so
hook mutation cannot change subsequent retry, terminal, budget, or attempt-event
decisions.

Pass ownership-isolated candidate records to stream health failure/success
hooks so `fullIndex` or probe-lease mutation cannot redirect later release,
while preserving lazy model access.

Consume native Promise results from stream health-transition, cooldown, and
request-outcome hooks. Require retry-budget classification to return literal
`true` without inspecting arbitrary thenable extensions.

Validate direct stream start tokens and degrade invalid or throwing token
callbacks to the hardened local source instead of skipping provider attempts.

Require stream admission waits to return genuine Promises and validate their
resolved in-flight ownership counts without invoking arbitrary thenable
extensions.

Require direct stream availability/preparation hooks to return synchronous
booleans, consume async admission and ordering-token results, and expose only
synchronous non-negative safe diagnostic concurrency metrics.

Pass ownership-isolated candidate records to read-only availability, admission,
wait, and metric hooks so argument mutation cannot redirect model selection or
later release, while retaining canonical handoff for probe-lease mutation hooks.

Validate immediate stream admission ownership counts before opening a provider.

Roll back stream capacity and probe ownership when post-admission health checks
or probe preparation hooks throw before a provider opens.

Capture stream admission and release hook accessors once with their original
receiver preserved, preventing mid-request contract mutation.

Release the initial upstream and capturable admission/probe ownership exactly
once when admission hook capture fails during stream setup.

Preserve wrapper-construction failures across hostile cleanup accessors while
still running every independently capturable release hook.

Snapshot stream candidates with bounded indexed reads so later array mutation
cannot redirect fallback attempts or ownership cleanup.

Capture stream deadline, timeout, attempt, options, and validation settings once
and snapshot prior failures with bounded indexed reads instead of iterators.

Validate direct stream-wrapper scalar settings before provider execution,
including duration, safe-integer, index, finite-clock, boolean, and object
contracts.

Capture the initial stream result once for metadata, pump setup, activation, and
cleanup so stateful accessors cannot substitute a different upstream.

Deep-snapshot direct stream call options before fallback so later caller
mutation cannot alter prompts or provider request configuration.

Snapshot stream request bodies as bounded JSON metadata instead of retaining a
mutable provider-owned object reference.

Return a fresh bounded request-body copy from each stream metadata getter.

Require timed and untimed provider operations to return genuine Promises
without assimilating arbitrary thenable extensions.

Snapshot successful generate request and response bodies within the bounded
result JSON budget instead of returning provider-owned object references.

Bound generated file payloads to 64MiB aggregate and intrinsically copy mutable
byte arrays and URLs before accepting a provider result.

Apply the same intrinsic file snapshot and aggregate payload budget to streamed
file parts, including pre-commit fallback budget rollback.

Intrinsically snapshot recognized mutable byte-array and URL values in known
raw stream parts while retaining opaque forward compatibility for unknown part
types.

Snapshot every known stream part, removing the plain-object zero-copy fast path
that allowed later provider mutation of emitted deltas.

Require genuine Promises for async supported-URL discovery and fail closed for
custom thenables without reading their `then` extensions.

Invoke captured provider factories with their original entry receiver
preserved.

Snapshot model provider/model-id metadata once and lazily memoize supported URL
metadata while preserving receiver binding and existing missing-metadata
compatibility.

Verify instance routing, health, modality, and concurrency accessors remain
single-read snapshots across later entry mutation.

Freeze sticky cooldown time on above-safe-integer clock samples while retaining
fractional millisecond precision.

Reject negative cooldown timestamps and invalid HTTP status values in shared
health records before snapshots or CAS transitions.

Reject probe leases attached to zero-failure health records so malformed shared
state cannot block a healthy candidate.

Require custom health-store CAS methods to return literal booleans. Reject a
malformed update result immediately instead of retrying it as contention, while
probe admission remains fail-open without recording unproven lease ownership.

Freeze shared-health time at the last valid sample when an injected clock cannot
advance by the minimum cooldown or overflows maximum-cooldown arithmetic, while
preserving large synthetic timelines, fractional precision, and later recovery.

Restrict automatic stale health-tombstone deletion to the internal synchronous
memory store. Custom shared stores retain control of TTL so an unconditional
delete cannot erase a fresh failure concurrently written by another process.

Snapshot in-memory health records through a bounded list of known data
descriptors. Do not enumerate arbitrary keys or preserve accessors that could
execute later during reads, snapshots, or compare-and-set operations.

Normalize custom health-store records through bounded own data descriptors,
ignoring prototype fields and accessors without invoking their extensions.

Preserve malformed explicit HTTP-status evidence in retry snapshots so invalid
fractional or out-of-range statuses cannot become retryable unknown failures.
Valid aliases, wrapped cause statuses, and recognized provider codes still win.
Short-circuit status aliases after the first valid value so lower-precedence
accessors cannot run after an authoritative provider status is captured.

Preserve throwing explicit status accessors as malformed evidence instead of
erasing them into retryable unknown failures, while still accepting a later
valid alias or wrapped cause status.

Track unreadable response and cause containers when they may be the only status
source, preventing a throwing wrapper accessor from becoming an unknown
retryable failure while retaining valid independently captured statuses.

Preserve unreadable structured error-code accessors so they cannot degrade into
unknown fallback fan-out when no valid status or recognized detail code remains.

Snapshot plain retry headers from bounded own data descriptors without invoking
prototype or own accessors or enumerating arbitrary keys. Lowercase and standard
canonical names remain supported, while captured `Headers.get()` retains full
case-insensitive lookup.

Consume rejected genuine Promises returned by unsupported async
`Headers.get()` adapters without consulting arbitrary thenable extensions.

Isolate throwing or revoked Proxy header-value brand checks so one malformed
array-like value cannot suppress a valid secondary retry-delay hint.

Reject negative, non-finite, and above-safe clocks for absolute Retry-After date
and epoch-reset arithmetic, while retaining relative duration hints when the
wall clock is unavailable.

Build generic error summaries from a fixed bounded set of own diagnostic fields
without enumerating arbitrary keys or traversing inherited properties.

Read generic Error identity and diagnostic values only from own data
descriptors, preventing name/message or other accessors from executing during
fallback summaries.

Isolate revoked Proxy array-brand checks in provider-semantic error traversal so
malformed containers cannot escape from fallback classification.

Read provider-semantic fields, array lengths, and indexes only from own data
descriptors, preventing error-body accessors from executing during fallback
classification.

Apply a 64 KiB aggregate nested-wrapper JSON parse-attempt budget per semantic
error collector so many individually bounded strings cannot amplify fallback
classification work.

Construct final failure aggregates from a bounded indexed data-descriptor
snapshot, avoiding source array methods, iterators, and accessors while keeping
error identity, order, count, and cause consistent.

Capture final aggregate messages from own data descriptors without executing
hostile Error message accessors.

Snapshot stream-open prior failures through bounded length/index data
descriptors without invoking array accessors, iterators, or revoked Proxies.

Snapshot direct-stream candidate arrays and setup-failure cleanup targets from
own length/index data descriptors, rejecting accessors and revoked Proxies
without executing them.

Copy each direct-stream `ResolvedEntry` from own entry/fullIndex/probeLease data
fields while capturing the intentional lazy model getter once with its receiver.
Later mutation cannot redirect fallback or alter hook and cleanup identity.

Copy initial probe-lease key/timestamp scalars so later lease-object mutation
cannot transfer or suppress stream cleanup ownership.

Consume genuine Promise values returned by direct candidate model fields or
lazy getters and classify them as synchronous candidate contract failures,
without consulting arbitrary thenable extensions.

Recheck backoff settlement immediately after timer registration so a
non-standard synchronously firing timer cannot install a leaked abort listener.

Recheck backoff settlement after abort-listener registration and immediately
run the returned cleanup when registration synchronously delivers cancellation.

Preserve the first normalized caller-abort reason without re-reading stateful
aborted/reason accessors during timeout arbitration.

Recheck admission-wait settlement after timer and abort-listener registration
so synchronous platform callbacks cannot queue a settled waiter or leak a late
listener.

Reuse safe own-data candidate lookup for outer stream-wrapper construction
cleanup instead of re-reading raw candidate/start-index accessors.

Verify synchronous and repeated stream-abort delivery captures one reason and
removes its forwarding listener exactly once at settlement.

Consume unsupported genuine Promise values at stream request, response, body,
headers, and header-value metadata boundaries without consulting arbitrary
thenable extensions.

Apply the same genuine-Promise consumption contract across generate content,
warnings, usage, provider metadata, request/response bodies, and headers before
falling back from an invalid result.

Pre-capture sibling generate envelope, usage, finish-reason, and response fields
so every genuine Promise sibling is consumed after an async contract violation,
while ordinary getter failures still stop immediately.

Aggregate capture across nested input/output usage token fields as well, so
multiple rejected provider Promises are consumed before healthy fallback while
arbitrary thenable extensions remain untouched.

Continue aggregate capture across bounded generate content parts, warning
entries, response-header values, and later envelope branches so one nested async
contract violation cannot leave sibling Promise rejections unobserved.

Consume rejected genuine Promises nested in bounded JSON snapshots and preserve
their async-contract classification through generate envelope aggregation,
covering provider metadata, raw usage, and request/response bodies.

Pre-consume own data Promise siblings in generate envelope fields,
content/warning arrays, and every nested bounded JSON container before invoking
ordinary getters, preserving getter-error precedence without unhandled sibling
rejections.

Apply the same Promise-sibling pre-consumption to bounded JSON container
counting used by stream metadata budgets before child getters are traversed.

Apply aggregate native-Promise consumption to known stream-part fields, nested
finish/usage metadata, raw usage JSON, and warning entries before pre-output
fallback, while preserving ordinary getter-failure semantics.

Consume all rejected native Promise values in optional stream response headers
before discarding malformed metadata, rather than stopping at the first header.

Capture stream source union fields by the active URL/document variant so
inactive field accessors are never invoked during validation or fallback.

Pre-consume known own-data Promise siblings after ordinary stream/source
discriminant failures, before active stream-field getters, and across bounded
warning arrays without invoking inactive variant accessors.

Consume rejected native Promises in generated and streamed file payload
discriminants and active data/URL fields, preserving async fallback
classification without reading arbitrary thenable extensions.

Pre-consume tagged file payload `type`, `data`, and `url` own-data Promise
siblings before discriminant or active payload getters run, preserving ordinary
getter-error precedence without invoking inactive variant accessors.

After an async content, warning, source, stream-part, or file discriminant,
consume Promise-valued bounded own data siblings through descriptors without
invoking inactive variant accessors.

Aggregate provider-metadata and active file, tool-result, or source transforms
within each generated content part so nested async failures in sibling branches
are all consumed before fallback.

Aggregate generate response body/header and usage input/output/raw transforms
so nested Promise rejection in one branch cannot short-circuit sibling cleanup.

Before discarding bounded generate or stream headers for invalid names, values,
or aggregate size, consume Promise-valued own data siblings without invoking
header accessors.

Consume rejected native Promise error causes during retry snapshotting and
normalization, treating them as malformed evidence instead of retryable unknown
provider failures.

Pre-consume known own-data retry error fields before authoritative-status
short-circuiting, preventing inactive cause/detail Promise rejections without
invoking their accessors.

Consume Promise-valued abort names on branded wrapped Error/DOMException causes
before failing closed to a non-abort classification.

Apply the same Promise consumption and malformed-evidence rule to top-level and
wrapped-cause response containers used for status and header extraction.

Consume Promise-valued structured status and code fields as unreadable evidence
without inspecting arbitrary thenable extensions.

Consume Promise-valued known diagnostic data fields during bounded generic and
provider-semantic error summarization, including after text-budget exhaustion.

Consume unsupported Promise-valued retry response/cause wrappers, plain header
values, and bounded header-array items while retaining synchronous sibling
delay hints.

Consume Promise-valued retry header sources and Headers-like get slots, and read
plain header-array lengths/indexes through own data descriptors.

Enforce the synchronous custom failure-classification schema across all bounded
known fields, consuming native Promise siblings without inspecting arbitrary
thenable extensions.

Recognize async shared-health adapter results only by native Promise brand and
consume Promise-valued bounded record data fields before rejecting malformed
state, without probing `then` membership. Keep object/function mutation returns
malformed instead of treating them as synchronous write success.

Consume invalid native Promise results from the platform random source before
degrading jitter to zero delay, without inspecting arbitrary thenables.

Consume Promise-valued timer registration handles and surface them as stable
timer-unavailable request errors.

Consume rejected native Promise results from timer cleanup and reuse the safe
cleanup path for async capability discovery.

Fail optional async supported-URL discovery open to no native URL support when
its guard timer registration throws or returns a Promise handle.

Reject and roll back native Promise abort-listener registrations, consume async
cleanup rejections, and avoid inspecting arbitrary thenable returns.

Consume Promise-valued abort add/remove method slots together before rejecting
the signal contract.

Consume Promise-valued AbortController abort method slots and call results in
best-effort cancellation without inspecting arbitrary thenables.

Consume Promise-valued stream/getReader/reader and reader-method slots before
fallback, plus async release results during partial and normal cleanup.

Consume Promise-valued read-result done/value own data siblings without
invoking an inactive value accessor after `done: true`.

Consume Promise-valued required V4 model operation/identity slots and require
literal string provider/model IDs when present before caching a model as valid,
while preserving missing-metadata compatibility.

Consume Promise-valued bounded supported-URL media-type siblings and pattern
array entries before failing malformed capability schemas closed.

Consume Promise-valued bounded supports, adaptive-concurrency, and retry-budget
configuration fields before eager contract rejection.

Consume Promise-valued cooldown containers and reset intervals before rejecting
the synchronous configuration contract.

Capture every bounded root fallback-option slot together and consume native
Promise siblings before eager policy validation.

Consume Promise-valued createRouter root options, model-route values, bounded
candidate entries, and observability hook siblings before eager validation.

Pre-consume Promise-valued bounded instance/factory entry slots while reading
only accessors relevant to the selected candidate shape.

Capture custom shared-health store method slots together and consume native
Promise siblings before eager adapter-shape rejection.

Consume Promise-valued ordering UUID and both random entropy samples before
falling back to the deterministic process-local counter.

Consume Promise-valued platform and injected clock samples across timeout,
ordering, health, cooldown, retry-budget, and retry-delay paths before applying
their existing safe fallback time.

Consume Promise-valued caller abort signals before rejecting the synchronous
signal-shape contract.

Consume Promise-valued aborted samples and reasons, treating the former as
unproven cancellation and replacing the latter with a stable AbortError.

Consume Promise-valued call-option root fields, bounded prompt/stop/tool entries,
and response-format/tool-choice discriminant siblings before contract rejection.

Extend synchronous call-option enforcement to nested messages, prompt parts,
file payloads and references, tool definitions and outputs, and request headers.
Consume bounded own-data Promise siblings before rejection without invoking
inactive variant accessors or inspecting arbitrary thenable extensions.

Consume all known initial call-option own-data Promise siblings before reading
the caller's `abortSignal`, preventing a throwing signal accessor from leaking
unobserved sibling rejections outside the request contract boundary.

Consume bounded generated and streamed response-header own-data Promise
siblings before reading header values, so an earlier throwing value accessor
cannot leak a later rejected Promise during fallback or optional sanitization.

Pre-consume every known exported stream-wrapper argument own-data Promise before
capturing `firstResult`, configuration, or hook accessors. Move direct
`createFallbackStream` first-result lookup out of its default parameter so the
same synchronous validation boundary always runs first.

Consume unsupported Promise-valued late-result `stream` and `cancel` slots
during best-effort disposal, in addition to rejected cancellation results,
without inspecting arbitrary thenable extensions.

Pre-consume known OpenGateway generate and stream metadata extractor method
slots before optional accessor capture. Consume Promise-valued extractor
objects and method slots while preserving receiver binding, fail-open built-in
metadata, and arbitrary-thenable isolation.

Require synchronous OpenGateway reasoning-details store objects and method
slots, consuming rejected native Promise method siblings before accessor or
shape failures while preserving captured receiver binding.

Capture OpenGateway reasoning-details store settings inside the validated
function body, consuming all known native Promise option siblings before any
getter can fail instead of relying on eager parameter destructuring.

Validate reasoning-details store operation arguments before adapter or memo
access. Consume Promise-valued refs without invoking custom loads, reject async
detail containers, and snapshot bounded entries before custom store calls.

Snapshot synchronous and async custom reasoning-details load arrays before
returning or memoizing them, and validate custom store refs at the capture
boundary. Preserve memo compatibility by normalizing synchronous adapter
failures to rejected Promises.

Consume Promise-valued reasoning-store clock samples and require safe integers.
Capture Web Crypto method slots with their receiver and require synchronous
bounded random UUID or exact random-byte results without probing thenables.

Consume in-flight optional reasoning-store Promises when timeout registration
fails before returning the stable timer-unavailable rejection.

Apply the same in-body synchronous settings capture to the OpenGateway provider
factory and reasoning-roundtrip middleware. Consume all documented own-data
Promise siblings before provider configuration and forward only supported
OpenAI-compatible option slots.

Share synchronous documented-setting capture across Friendli, OpenRouter,
OpenGateway, and Wafer provider factories. Bound and snapshot provider header
maps after consuming native Promise value siblings, and apply Wafer's enforced
ZDR header only to that stable snapshot.

Validate provider header names before reading value accessors while consuming
all own-data Promise siblings. Enforce HTTP value syntax, 65,536 characters per
value, and 1 MiB aggregate text before SDK configuration.

Require Friendli, OpenRouter, OpenGateway, and Wafer model factory IDs to be
synchronous non-empty strings of at most 4,096 characters, consuming native
Promise IDs without inspecting arbitrary thenables.

Snapshot documented Wafer ZDR `RequestInit` fields and bound record/tuple
headers to 1,024 entries before enforcing the required header. Consume nested
Promise siblings without changing ordinary getter precedence, and require a
genuine Promise from the wrapped fetch without probing thenables.

Bound and shallow-snapshot reasoning request bodies before rest/spread cloning,
consuming native Promise field siblings across provider options, nested dialect
objects, and Wafer preservation aliases. Require synchronous bounded provider
names and custom reasoning callback slots/results without probing thenables.

Replace eager reasoning middleware hook-argument destructuring with aggregate
in-body capture. Consume generate/stream functions, params, and nested model
operation/identity Promise slots before invocation, preserving the model
receiver for OpenGateway stream calls.

Bound OpenGateway reasoning middleware generate and stream results to 128 own
fields before spread, consuming native Promise siblings across generated
content, nested response metadata, stream metadata, and the `pipeThrough` method
slot while preserving method receivers.

Cancel already-open OpenGateway provider streams when reasoning transform
construction or `pipeThrough` fails. Consume and reject Promise-valued or
non-object pipe results through provider-local safe cancellation, avoiding a
dependency on the full router stream runtime.

Bound reasoning content arrays to 10,000 dense entries and capture content and
stream part discriminants after consuming known own-data Promise siblings. Read
only active variant accessors and bounded-JSON snapshot provider metadata before
attaching reasoning-details references.

Capture reasoning replay prompts through the canonical call-options validator
before concurrent store loads. Pre-consume prompt-entry and store-method Promise
siblings across both arguments, merge only JSON-object provider options, and
isolate in-flight replay from caller mutation.

Pre-consume native Promise reasoning-details containers and up to 1,024 bounded
entries before JSON snapshotting. Reuse the stable deduplicated snapshot across
exported input/output helpers, store load results, and stream raw chunks so
caller mutation cannot change persisted details.

Bound raw OpenGateway response bodies used by routing and reasoning extraction
to 50,000 JSON containers and 4 MiB of text. Snapshot before reading choices,
messages, deltas, or routing so native Promise branches are consumed together.

Add explicit JavaScript artifact byte budgets for every public entry and a
100 KiB ceiling for shared ESM chunks, catching accidental provider-to-router
runtime coupling during package validation.

Bound and snapshot provider query-parameter maps across all four factories to
1,024 entries, 65,536 characters per value, and 1 MiB aggregate text. Consume
native Promise values and isolate later request URLs from caller mutation.

Eagerly validate common provider setting shapes for bounded API/base URL
strings, boolean flags, function hooks, and object metadata/URL capability
containers. Validate Wafer `zdr` and `preserveReasoning` before construction.

Capture provider `supportedUrls` callbacks with their settings receiver and
snapshot synchronous or genuine-Promise results. Bound media types and RegExp
arrays, consume Promise siblings, and clone pattern source/flags from internal
slots before SDK capability exposure.

Capture Friendli, OpenRouter, and Wafer metadata extractor method slots with
their receivers. Require genuine generate-hook Promises, consume invalid async
stream-hook results, and bound metadata output to 10,000 JSON containers and
4 MiB before SDK exposure.

Capture provider `convertUsage` callbacks with their settings receiver and
require synchronous results. Snapshot known input/output token fields with
non-negative finite-number validation and bound optional raw usage JSON to
10,000 containers and 1 MiB.

Capture custom provider fetch callbacks with their settings receiver, normalize
synchronous throws to rejected Promises, and require genuine Promise results
without inspecting arbitrary thenable return extensions.

Snapshot bounded JSON inputs before invoking provider metadata and usage
callbacks. Optional metadata hooks skip invalid or asynchronous raw bodies and
chunks, while usage converters reject invalid inputs, preventing either hook
from mutating SDK-owned response data.

Apply bounded input snapshots to composed OpenGateway user metadata hooks as
well, preserving built-in routing extraction while preventing generate and
stream callbacks from mutating SDK-owned raw response values.

Reject custom provider fetch Promises that resolve to primitive or null values
at the provider boundary, while retaining cross-realm and Response-like object
compatibility without probing response accessors.

Isolate candidate objects passed to stream capacity-release hooks while keeping
probe cleanup on the canonical candidate, preventing custom capacity cleanup
mutation from corrupting the following half-open probe-lease release.

Release prepared stream probe leases when admission acquisition throws or
returns an invalid synchronous result, preventing terminal hook failures from
leaving half-open probes reserved until lease expiry.

Release partially prepared probe leases when stream preparation returns
`false`, including re-preparation after a capacity wait, while continuing to
release any waited capacity ownership independently.

Isolate candidate identity fields passed to stream preparation hooks and hand
back only a validated probe lease. Preserve that lease handoff even when the
hook throws after claiming it, allowing the existing error cleanup to release
the canonical lease without permitting index, entry, or model redirection.

Consume rejected native Promises supplied as probe-lease containers, keys, or
deadlines before rejecting their synchronous shape, preventing malformed custom
preparation hooks from leaking unhandled rejections.

Run stream probe-release hooks against identity-isolated candidate snapshots
and hand back only validated lease state, preventing cleanup mutation from
redirecting later capacity waits or retries while preserving canonical lease
clearing.

Track generate and stream-open capacity ownership through final-candidate
waiting and release both admission capacity and probe state when post-wait
preparation or another admission step throws after granting a slot.

Finally-guard stream-open admission release around failure-policy handling, so
an unexpected routing or aggregate exception cannot strand capacity after the
provider fails to open a stream.

Make router-owned capacity and probe cleanup independent with a `finally`, and
clear canonical probe ownership before health-store release so infrastructure
throws cannot suppress sibling cleanup or retain stale local leases.

Retain confirmed failure cooldowns in a bounded process-local overlay when an
optional health-store write throws or exhausts CAS retries, preventing the same
credential or family from being retried during the active store outage. Clear
the overlay on provider recovery, make it half-open after cooldown expiry,
expose it through isolated redacted health snapshots, and enforce it during
concurrent probe admission.
Retain expired overlay evidence for a single process-local half-open lease while
the shared store remains unavailable, with conditional early lease release.
Keep local lease release ownership-conditional across router instances so an
expired stale lease cannot clear a newer probe.
Reconcile local overlay evidence with the shared store before availability and
probe decisions, allowing newer same-clock ordering-token recovery to retire a
stale local cooldown immediately after store recovery.
Clear pending local probe handoff state at the same boundary, preventing a
shared recovery observed after claim from attaching stale lease ownership to a
candidate.
Tag local-origin handoffs and revalidate their store-scoped deadline when taken,
covering recovery observed by a different router instance.
Preserve local lease provenance through stream candidate snapshots and keep its
release path entirely separate from recovered shared-store ownership.
Bound each store-scoped local overlay to 100,000 LRU-refreshed records so
long-lived processes cannot accumulate unbounded fallback state across router
instances and namespaces while a shared store remains unavailable.
Protect active local probe records during overlay eviction; prefer an inactive
LRU record, or drop a new inactive failure when every retained record owns a
live lease.
Maintain a store-scoped inactive-key LRU index so cap enforcement remains
O(1) for candidate selection without scanning up to 100,000 active probe
records.
Track local probe deadlines in a bounded lazy min-heap and promote expirations
before eviction, preventing a full set of expired leases from repeatedly
dropping newly observed failures with amortized O(log n) deadline maintenance.

Prune expired untaken local probe claims across all candidate health scopes
before a new claim, preventing an older unit lease from shadowing a newer
credential or provider-family lease during handoff.

Consume native Promises written into known fields of discarded preparation,
capacity-release, and probe-release candidate snapshots, preventing isolated
hook mutations from leaking unhandled rejections.

Apply the same discarded-snapshot Promise consumption to read-only candidate
availability, admission acquire/wait, diagnostic, and health-outcome hooks
without changing their synchronous result contracts.

Consume Promise mutations to every known field of copied failure
classifications after candidate-health and retry-budget hooks, preserving the
canonical routing decision without leaking rejected callback-input mutations.

Validate candidate health-hook transition results against the documented
literal union before telemetry exposure, consuming native Promises while
leaving arbitrary thenable extensions uninspected.

Post-process bounded known fields of stream and generate `onAttempt` payloads,
including nested failure classifications, consuming rejected Promise mutations
without enumerating hook-added properties or invoking replacement accessors.
Route cooldown, concurrency, and max-attempt skipped events through the same
boundary.

Apply bounded post-call Promise consumption to the six known fields of generate
and stream `onError` payloads, preventing rejected mutation Promises from
escaping optional error reporting.

Consume rejected Promise mutations to all seven known top-level fields of the
discarded custom-validator generate envelope through own-data descriptors,
without changing the validated result or invoking replacement accessors.

Consume rejected Promise mutations in bounded nested validator content and
warning variants, finish reason, request/response metadata, usage, and token
subfields while inspecting only documented own-data slots.

Pre-capture up to 200,000 existing fields in bounded validator JSON graphs and
consume deep rejected Promise mutations afterward, without following hook-added
containers or keys.

Reuse pre-captured bounded JSON mutation cleanup for composed OpenGateway user
generate and stream metadata inputs, consuming deep rejected mutations after
the appropriate async or synchronous callback boundary without growing smaller
provider-only entries.

Clean OpenGateway stream metadata callback inputs both immediately and after an
invalid native-Promise result settles, consuming post-`await` mutations while
dropping retained mutation targets after one second for never-settling hooks.

Apply immediate and post-settlement bounded mutation cleanup to isolated custom
OpenGateway reasoning `store(details)` inputs, consuming synchronous and
post-`await` rejected mutations with the same one-second retention cap.

Reuse existing generate-metadata and reasoning-store settlement timeouts for
post-callback cleanup instead of scheduling duplicate retention timers; retain
the separate timer only for invalid async stream hooks.

Detach active stream readers before propagating consumer cancellation to avoid
double-cancel in the pump `finally` path. Release the reader lock after cancel
settlement, with a one-second best-effort retention bound for never-settling
custom cancellation.

Consume Promise-valued consumer stream-cancellation reasons and forward a
stable `AbortError` instead, while preserving ordinary cancellation reason
identity.

Cancel readers whose pending read rejects or loses a first-content timeout race
before advancing fallback, and deduplicate subsequent failure-path cancellation
and successful lock release per reader.

Lock admission wait release/abort ordering with explicit race coverage:
release-first retains the granted slot, while abort-first removes the waiter
without leaking capacity or queue state.

Preserve admission queues created synchronously during waiter settlement.
Delete only the queue identity being drained, and continue into a replacement
queue immediately when a corrupted settlement rolls its acquired slot back.

Lock retry-budget sliding-window semantics with explicit boundary coverage:
samples remain at exactly the configured window, expire immediately afterward,
and availability is recomputed after pruning.

Verify stream-open routing matches generate sticky cooldown semantics: retain
the sticky head and round-robin the complete fallback tail without dropping a
compatible candidate.

Replace probabilistic round-robin pool hashes with exact ordered index
identities, bounded by the existing 1,024-pool LRU and a one-MiB aggregate key
budget so distinct filtered pools cannot share a cursor through a hash
collision.

Route every upstream reader-cancel path through one deduplicated
cancel-and-settled-lock-release primitive, preventing fallback, finish, error,
timeout, and consumer-cancel races from orphaning lock cleanup.

Start late stream-open transport cancellation before bounded request/response
metadata cleanup, consuming rejected native Promises in discarded result
siblings, request bodies, response headers, and cancel method slots.
Keep metadata cleanup isolated from late stream cancellation when request or
response accessors are hostile.

Dispose generate results that resolve after their attempt timeout through the
bounded generate-envelope snapshot, consuming rejected native Promise fields
that would otherwise bypass validation after fallback has already succeeded.
Process each late generate envelope field independently so one hostile accessor
cannot suppress bounded rejected-Promise cleanup in later siblings.
Give each late field an independent bounded JSON/file budget so an oversized
earlier sibling cannot starve cleanup of later request, response, or usage data.
Consume genuine Promise results returned by timeout late-result disposers,
without probing arbitrary thenables, so async cleanup rejection remains
independent from the already-settled request and timer/abort teardown.

Preserve local/shared probe-lease provenance through final-candidate capacity
waiting and consumer cancellation, with regression coverage proving post-wait
decline and cancellation release the exact lease once per ownership handoff.

Retain successful recovery in the bounded store-scoped overlay when a shared
health store can read an old cooldown but exhausts recovery CAS writes. Mask the
stale shared failure across router instances, retire the local success only for
causally newer shared state, and prevent late older failures from reopening the
recovered circuit.

Reconcile partially committed recovery across unit, credential, and provider
family health scopes, combining successful shared writes with contended local
success tombstones while retaining any causally newer failed scope for
admission.

Fall back to one store-scoped local half-open lease when a readable shared
failure cannot persist lease ownership because CAS throws, returns a malformed
non-boolean result, or reaches the safe-integer version limit. Continue to
honor literal `false` CAS as genuine cross-process contention.

Lock stream retry-budget settlement to one request outcome: censor consumer
cancellation even after an eligible fallback failure, and retain exactly one
success when a clean finish is followed by transport cancellation or a read
failure.

Verify stream fallback, like generate fallback, bounds configured jitter
backoff by the remaining total deadline. Keep provider `Retry-After` hints as
subsequent health-admission cooldown rather than delaying the active request.

Treat retryable `408`, `425`, and `5xx` responses as AIMD congestion signals,
halving adaptive concurrency like `429` while leaving non-congestion
routing/model failures at the current limit.

Order AIMD feedback by monotonic attempt-start time across concurrent generate
and stream attempts. Ignore late stale successes after a newer congestion
decrease and late stale failures after a newer success, instead of training
capacity from completion order.

Break equal-monotonic AIMD ties with the attempt ordering token, comparing
variable-width token timestamps numerically before source and counter fields so
clock digit rollover cannot restore completion-order races.

Verify queued admission remains below a newly reduced AIMD limit: keep FIFO
waiters parked while existing in-flight usage drains to the limit, then admit
only the slots made genuinely available by later releases.

Verify a successful half-open health probe contributes one normal AIMD success
instead of resetting reduced capacity. Restore concurrency additively only
after the configured healthy-success threshold is reached.

Verify each failed stream half-open probe increments health failures and
decreases AIMD capacity exactly once, without duplicate feedback from reader
cancellation or stream settlement cleanup.

Verify one `healthKey` shares credential-scoped cooldown, half-open recovery,
AIMD limit, and additive success progress across logical models. Preserve
unit-scoped `5xx` health isolation while sharing its credential-level AIMD
congestion reduction.

Verify transient lazy provider-factory throws release admission, cool only the
routing unit, leave AIMD capacity unchanged, and count a successful fallback as
a healthy request-budget outcome. Retry the uncached factory after cooldown and
cache the recovered valid model.

Apply the same transient-factory recovery contract before stream open: settle a
fallback without leaking reader, admission, or probe ownership, suppress
factory rebuild during cooldown, then cache the recovered stream model and
clear health on its validated finish.

Verify permanent non-V4 factory results reuse one cached routing error across
fallbacks. Health cooldown skips repeated candidate attempts, cooldown expiry
advances failure backoff without rebuilding the invalid factory, and admission
ownership remains clear.

Keep tripped retry-budget accounting on actual provider attempts: health and
capacity skips do not consume the one allowed attempt, allowing the next
available fallback to serve while a primary remains cooling or saturated.

Apply the same tripped-budget accounting to stream open: emit cooling candidates
as unnumbered skips without opening them, then use the next available stream as
the single allowed attempt while retaining cancellation censoring.

Let successful requests served around a cooling primary recover retry-budget
hysteresis. Untrip when the sliding failure rate reaches the recovery threshold
and restore deeper `maxAttempts` fallback for subsequent requests.

Do not recover a tripped retry budget from a consumer-cancelled live fallback
stream. Keep the request censored with no added sample while cancelling its
transport and releasing admission ownership.

Define the stream settlement winner around validated finish: pre-finish cancel
censors the request, while post-finish cancel preserves exactly one recovery
success without adding a duplicate outcome.

Use that settlement winner for attempt observability, health, and AIMD too:
pre-finish cancel emits one cancelled attempt with no recovery feedback, while
post-finish cancel preserves one success event and one AIMD/health success.

Keep generate success provisional through envelope and custom validation.
Record validator rejection as candidate health/AIMD failure, then count only an
accepted fallback as the final request-budget success.

Keep malformed, async, or throwing validator contracts terminal and censored:
release admission without cooling health, resetting AIMD progress, adding a
retry-budget sample, or fanning out to another provider.

Censor malformed, async, or throwing custom classifier contracts after any
earlier provider failure. Preserve health already recorded for real attempts,
but do not train the classifier-contract candidate, fan out farther, or add a
request-budget sample.

Apply classifier-contract censoring inside stream fallback too: preserve an
earlier valid error-part transition, release the current reader/admission/probe,
add no budget sample, and do not open a later stream candidate.

Keep legacy `shouldRetry` contract failures fail-closed without erasing the
real provider outcome: retain candidate health/AIMD failure, suppress fallback
fan-out and request-budget amplification, and release admission normally.

Apply legacy retry-hook fail-closed behavior to stream error parts/read
rejections, cancelling the failed reader and preserving provider feedback while
opening no later stream and adding no amplification-budget sample.

Verify first-content timeout cancels a silent upstream, records one candidate
health/AIMD failure, releases ownership, and lets a validated fallback finish
contribute the sole request-budget success.

Clarify that stream `totalTimeout` bounds fallback backoff and stream opening,
not the normal read duration after a stream opens within budget; live reads are
bounded by first-content timeout and caller cancellation instead.

Verify a fallback stream-open that crosses the total deadline is censored and
releases admission/probe ownership without training candidate health, AIMD, or
the retry budget. Preserve earlier provider health, open no later fallback, and
cancel the timed-out transport if its opening promise resolves late.

Apply the same late-opening cleanup to caller aborts: preserve exact abort
identity and earlier provider health, release the abandoned candidate without
training health/AIMD/budget state, and cancel its transport on late resolution.

Censor stream fallback admission waits that terminate on the total deadline or
caller abort. Remove the FIFO waiter before later capacity release, preserve
earlier provider health and exact abort identity, open no timed-out candidate,
and avoid converting the earlier failure into a retry-budget sample.

Generalize that censoring to admission and backoff infrastructure failures, so
a rejected wait hook or control-plane failure cannot turn an earlier eligible
provider failure into a request-budget observation.

Round fractional remaining admission deadlines up before scheduling timers.
Avoid waking just before the total deadline and incorrectly surfacing the
preceding provider error instead of `total_timeout`.

Verify generate admission waits match stream settlement for total deadlines
and caller aborts: retain earlier provider health, remove the waiter, preserve
abort identity, add no retry-budget sample, and reject late capacity grants.

Verify generate and stream backoff timer-registration failures are censored
control-plane outcomes. Preserve prior provider health/AIMD feedback, release
admission, add no request-budget sample, and open no later fallback.

Defer stream `concurrency` skip observability for the candidate selected for
capacity waiting. Emit the skip only if the wait expires; if a slot is granted,
report only the candidate's actual provider outcome instead of both skipped and
attempted events.

Buffer stream fallback skip observability while admission is resolved. Emit the
triggering provider failure first, then concurrency/cooldown/max-attempt skips
in configured candidate order, while removing the waited candidate's pending
skip if it is admitted.

Report consumer cancellation during stream capacity waiting as one censored,
attempt-number-free `cancelled` event after the triggering provider failure.
Keep caller abort request-scoped with no invented fallback attempt, and clear
the deferred concurrency skip in both cancellation paths.

Track the pending fallback candidate across backoff as well as capacity waiting,
so consumer cancellation before provider start still emits one censored,
attempt-number-free `cancelled` event after the triggering failure.

Verify total deadlines, rejected wait infrastructure, and backoff timer errors
leave no provisional event for the unstarted final fallback. Retain configured
order and legitimate concurrency skips from earlier saturated candidates after
the triggering provider failure.

Keep deferred skip dispatch isolated per event. A throwing or rejected
`onAttempt` callback for one buffered skip cannot suppress later candidate
events, the admitted fallback success, or downstream stream output.

Order stream `max-attempts` observability after the provider failure that
exhausted the attempt budget, with one attempt-number-free skip for every
remaining configured candidate.

Drain deferred stream attempt events in place instead of copying the entire
queue with `splice(0)`. Verify all 10,000 bounded candidate events are emitted
exactly once at the supported per-route limit without opening skipped models.

Consume rejected Promise results independently during maximum-candidate
deferred dispatch. Sample hook rejections across the 10,000-event fan-out while
preserving complete delivery and producing no unhandled rejection.

Snapshot deferred skip concurrency metrics at detection time. Later in-flight
or limit changes while the final candidate waits for admission cannot rewrite
the earlier saturated candidate's buffered event.

Preserve the failed stream attempt's `inFlight` metric across ownership release
before fallback admission. Match generate observability by reporting post-AIMD
limits and the pre-release owned slot count for both success and failure.

Apply the same observability point to post-output `stream-mid` failures under
`retryAfterOutput`: preserve phase, report the post-congestion AIMD limit, and
retain the failed attempt's pre-release in-flight ownership.

Verify cancellation metric semantics: active stream cancellation reports its
owned pre-release in-flight count, while pending capacity cancellation has no
attempt number and snapshots the blocked candidate's current in-flight/limit.

Verify the same distinction through the full routed shared-capacity path:
consumer cancellation emits the pending control event, while caller abort keeps
exact error identity and emits no synthetic cancelled fallback attempt. Both
remove the waiter, preserve earlier health, and censor retry-budget settlement.

Verify a pending cancelled event does not train the unstarted adaptive
fallback. Preserve its AIMD limit and success progress, create no fallback
health record, and leave request-budget settlement censored.

Verify recovery after pending cancellation: once the blocking capacity is
released, the same fallback admits immediately, finishes normally, and records
exactly one AIMD success plus one request-budget success without stale waiters.

Exercise repeated hold, pending-cancel, release, and successful-retry cycles.
Ensure waiters and deferred cancellation state do not accumulate, cancellations
add no AIMD/budget feedback, and only validated retries drive additive recovery.

Keep observability identity local while admission is shared. Repeated `hold`
and `chat` cancellation events retain their originating logical id, local index,
and active-vs-pending attempt numbering despite one shared adaptive key.

Verify multiple waiters on one shared adaptive key can be cancelled in reverse
queue order. Remove only targeted entries, preserve AIMD state, and allow a
clean acquire through either logical index after the held slot is released.

Cover the multi-waiter cancel/release race: cancel a sibling, grant the surviving
FIFO head, then deliver a late abort. Keep the granted slot owned, leave no
ghost waiter, and require the normal owner release to return in-flight to zero.

Define multi-waiter release/timeout ordering at the deadline. A pre-deadline
release grants only the FIFO head and leaves later timeout ownership intact;
when timeout settles first, a later release cannot resurrect expired waiters.

Keep near-deadline waiters parked after an AIMD decrease. A release that only
drains usage down to the reduced limit cannot grant a new slot; queued entries
expire at their original deadline and leave clean ownership for later acquire.

Verify AIMD increase and release skip an expired FIFO head while granting the
next live waiter. Preserve the newly available slot, remove stale queue state,
and retain correct in-flight ownership at the increased limit.

Combine corrupted waiter recovery with deadline cleanup. Skip a malformed queue
head, grant the next live waiter, clear its timer, and prove the old deadline
cannot later revoke or mutate the granted ownership.

After an async corrupted waiter settlement, consume its rejected Promise,
rollback the provisional slot, and continue the same release pass so the live
FIFO tail receives the recovered capacity without waiting for another release.

Harden granted ownership against failed timer cleanup. If `clearTimeout` throws
and the stale wait deadline later fires, its settled guard leaves the granted
slot and empty queue unchanged until the real owner releases.

Verify the equivalent abort-listener cleanup boundary. If listener removal
throws and the retained callback is delivered after admission, preserve the
granted result, slot ownership, and empty queue until the real owner releases.

Deactivate captured abort callbacks before listener removal. A non-conforming
cleanup that synchronously invokes or retains the callback can no longer invent
an abort during registration rollback, replace the registration failure, or
re-enter an already settled admission wait.

Enforce once-only abort delivery inside the captured callback rather than
trusting a custom signal to honor `{ once: true }`. Repeated synchronous or late
delivery can no longer re-enter timeout, backoff, admission, or stream cleanup.

Define the competing registration outcome when a custom signal synchronously
delivers a real abort and then throws from `addEventListener`. Preserve the
delivered caller reason in generate, admission, and stream paths, prevent
provider output, and retain normal queue, capacity, and stream cleanup.

Verify per-credential quota isolation within one provider family. Generate and
stream 429s cool only the exhausted `healthKey`, leave a sibling Friendli-style
credential immediately eligible, skip only the failed key on later requests,
and probe it once after the longest reset without creating family health.

Verify the converse provider-family boundary across distinct credential keys.
Generate and stream family outages create one shared family record, no
credential record, skip sibling keys in that family across logical models, and
recover through candidates outside the affected family.

Verify provider-family recovery across credential keys. After cooldown expiry,
one successful generate or stream half-open probe clears the shared family
failure and lease, immediately re-enables another credential, and leaves health
and capacity ownership clean.

Prevent cross-key thundering herds during provider-family recovery. Permit one
concurrent generate probe across logical models, and retain a stream probe lease
after opening until output is validated. Concurrent sibling keys use fallback,
then become eligible immediately after the single successful probe.

Verify failed provider-family half-open probes in generate and stream routing.
Release the probe lease, increment shared failures, expand the initial 15-second
cooldown to 30 seconds, keep sibling credentials skipped through the new
boundary, and permit only one next probe after expiry.

Verify cancellation of a provider-family half-open stream before output. Cancel
upstream once, retain the prior family failure count and request-budget samples,
release the probe lease without new feedback, and let a sibling credential
immediately probe and recover the family.

Apply the same provider-family probe cancellation boundary to caller aborts in
generate and stream routing. Preserve exact caller identity, retain the prior
family failure and request-budget samples, release the lease without feedback,
and let a sibling credential immediately probe and recover shared health.

Distinguish provider-side half-open timeouts from caller cancellation. Generate
attempt timeouts and stream first-content timeouts release the lease, increment
family failures, apply exponential recool, preserve sibling skips, and allow a
successful fallback to settle one request-budget success.

Keep request-wide total timeout distinct from provider-side probe timeouts.
Generate and stream-open total deadlines retain the prior family failure,
cooldown, and budget samples, release the lease without provider feedback, and
allow a sibling credential to immediately probe and recover shared health.

Prevent tripped retry budgets from reserving unexecuted provider-family probes.
Generate and stream fallback stop after the current failure without calling or
leasing the later family candidate, leaving a healthy-budget logical model free
to immediately probe and recover shared health.

Prevent `maxAttempts` from reserving unexecuted provider-family probes in both
generate and stream routing. Emit the blocked candidate as an attempt-number-free
skip, leave the family lease unclaimed, and allow another logical model to probe
and recover shared health immediately.

Apply the same `maxAttempts` lease boundary to shared credential health in
generate and stream routing. A blocked fallback does not call or lease the
credential, so another logical model can immediately probe and recover it.

Keep provider factories lazy when `maxAttempts` skips the fallback tail. Both
generate and pre-output in-band stream failures emit attempt-number-free skip
events without evaluating an unexecuted candidate factory.

Preserve the post-output `maxAttempts` boundary with `retryAfterOutput` enabled.
Already-emitted text and the original stream error remain intact, failure and
tail-skip observability stay `stream-mid`, and the blocked factory and expired
provider-family probe remain unclaimed.

Apply post-output `maxAttempts` accounting equally to provider in-band error
parts. Preserve partial text and the original error, learn credential cooldown,
record one failed request-budget sample, and keep the blocked factory lazy.

Refactor raw routed-stream regression reads through one lock-safe test helper.
Remove duplicated reader loops and release every reader lock in `finally` while
preserving partial-output and exact-error assertions.

Make routed admission total-deadline coverage deterministic. Replace the
real-time 200 ms race with a synchronous failing stream and fake monotonic
timers, proving waiter registration, exact deadline removal, censored request
budget, and post-holder-release cleanup without load-dependent flakiness.

Combine multiple valid rate-limit hints conservatively within each precedence
tier. Use the longest duplicate `Retry-After`, precise retry-after-ms, or
request/token reset delay so fallback does not re-admit a credential while any
reported quota remains exhausted; retain the existing configured cooldown cap.

Verify that longest-delay parsing reaches routed health end to end. A shared
credential with distinct request and token resets stays skipped across logical
models through the longer boundary, then permits one half-open retry immediately
after expiry while retaining the one-hour provider-hint cap.

Apply the same routed longest-reset proof to stream-open 429 failures. Shared
credentials remain skipped across logical stream models through the exact
boundary and permit one post-expiry probe, matching generate health behavior.

Extend longest-reset parity to in-band stream failures. Both pre-output error
parts and post-output errors under `retryAfterOutput` share the credential
cooldown across logical models, remain skipped through the longer reset, and
permit one probe immediately after expiry.

Preserve health learning when post-output retry is disabled. Forward the
original in-band 429 without opening a fallback for the current partial stream,
while applying its longest reset to shared credential health so later logical
models skip it until one post-expiry probe is allowed.

Verify post-output reader rejection parity separately from in-band error parts.
Without retry, preserve the original 429, one request-budget failure,
`stream-mid` ownership metrics, capacity release, and shared longest cooldown.
With retry enabled, emit partial plus fallback output and settle one request
success without losing the failed credential's health feedback.

Cover reader rejection before output commitment. Drop the failed candidate's
buffered prelude, emit only the fallback stream, retain longest-reset shared
health, settle one final request success, release capacity, and permit one
probe immediately after cooldown expiry.

Give caller abort request-scoped precedence when it races a pending reader
rejection. Even if abort handling rejects the read with a provider-shaped 429,
preserve the exact caller reason, release capacity, and suppress provider
attempt failure observability, health/AIMD feedback, retry-budget settlement,
and fallback admission.

Verify caller-abort precedence when abort handling emits an in-band 429 error
part rather than rejecting the reader. Suppress the synthetic provider part,
reject the pending direct reader with the exact caller reason, release capacity,
and retain zero attempt, health, retry-budget, or fallback feedback.

Capture the fallback pump's caller abort reason exactly once. Reuse the same
identity for operation cancellation and read/error-part termination so a
stateful custom signal cannot replace the original reason during final
settlement.
