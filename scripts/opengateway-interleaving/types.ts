export interface ModelProbe {
  readonly model: string;
  readonly raw: StreamProbe;
  readonly sdk: StreamProbe;
}

export interface ProbeReport {
  readonly baseURL: string;
  readonly generatedAt: string;
  readonly results: readonly ModelProbe[];
}

export interface StreamEvent {
  readonly contentLength: number;
  readonly finishReason?: string;
  readonly index: number;
  readonly keys: readonly string[];
  readonly reasoningContentLength: number;
  readonly reasoningLength: number;
  readonly textDeltaLength: number;
  readonly type?: string;
}

export type StreamProbe = StreamProbeFailure | StreamProbePass;

export interface StreamProbeFailure {
  readonly message: string;
  readonly ok: false;
  readonly status?: number;
}

export interface StreamProbePass {
  readonly contentEventCount: number;
  readonly eventCount: number;
  readonly events: readonly StreamEvent[];
  readonly finalReasoningPartCount?: number;
  readonly finalReasoningProviderDetailsLength?: number;
  readonly finalReasoningTextLength?: number;
  readonly ok: true;
  readonly providerMetadataKeys?: readonly string[];
  readonly providerReasoningDetailsLength?: number;
  readonly reasoningEventCount: number;
  readonly sequence: readonly string[];
}

export interface StreamProbeExtras {
  readonly finalReasoningPartCount?: number;
  readonly finalReasoningProviderDetailsLength?: number;
  readonly finalReasoningTextLength?: number;
  readonly providerMetadataKeys?: readonly string[];
  readonly providerReasoningDetailsLength?: number;
}
