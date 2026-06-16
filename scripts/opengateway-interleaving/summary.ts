import type { StreamEvent, StreamProbeExtras, StreamProbePass } from "./types";

function labelEvent(event: StreamEvent): string {
  if (event.type !== undefined) {
    return event.type;
  }
  const hasReasoning =
    event.reasoningContentLength > 0 || event.reasoningLength > 0;
  const hasContent = event.contentLength > 0 || event.textDeltaLength > 0;
  if (hasReasoning && hasContent) {
    return "reasoning+content";
  }
  if (hasReasoning) {
    return "reasoning";
  }
  return hasContent ? "content" : "";
}

function isContentEvent(event: StreamEvent): boolean {
  return event.contentLength > 0 || event.textDeltaLength > 0;
}

function isReasoningEvent(event: StreamEvent): boolean {
  return (
    event.reasoningContentLength > 0 ||
    event.reasoningLength > 0 ||
    event.type?.includes("reasoning") === true
  );
}

export function summarizeEvents(
  events: readonly StreamEvent[],
  extras: StreamProbeExtras = {}
): StreamProbePass {
  return {
    contentEventCount: events.filter(isContentEvent).length,
    eventCount: events.length,
    events: events.slice(0, 80),
    ...extras,
    ok: true,
    reasoningEventCount: events.filter(isReasoningEvent).length,
    sequence: events.map(labelEvent).filter((label) => label.length > 0),
  };
}
