import type { CallFailure, ValueShape } from "../opengateway-live/types";

export interface RoundtripReport {
  readonly baseURL: string;
  readonly generatedAt: string;
  readonly results: readonly ModelRoundtrip[];
}

export interface ModelRoundtrip {
  readonly model: string;
  readonly raw: RoundtripResult;
  readonly sdk: RoundtripResult;
}

export type RoundtripResult = CallFailure | RoundtripPass;

export interface RoundtripPass {
  readonly first: {
    readonly contentLength: number;
    readonly finishReason?: string;
    readonly reasoningContentLength: number;
    readonly reasoningDetails: ValueShape;
  };
  readonly followup: {
    readonly assistantMessageKeys: readonly string[];
    readonly reasoningContentLength: number;
    readonly reasoningDetails: ValueShape;
    readonly status?: number;
  };
  readonly ok: true;
}
