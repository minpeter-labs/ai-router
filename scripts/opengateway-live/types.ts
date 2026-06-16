export interface JsonRecord {
  readonly [key: string]: unknown;
}

export interface LiveCheckResult {
  readonly baseURL: string;
  readonly candidates: readonly string[];
  readonly generatedAt: string;
  readonly modelCatalog: {
    readonly status: number;
    readonly count: number;
    readonly ids: readonly string[];
  };
  readonly results: readonly ModelResult[];
}

export interface ModelResult {
  readonly model: string;
  readonly raw: {
    readonly none: RawCallResult;
    readonly high: RawCallResult;
    readonly tool: RawCallResult;
  };
  readonly sdk: {
    readonly none: SdkCallResult;
    readonly high: SdkCallResult;
    readonly streamHigh: SdkCallResult;
    readonly tool: SdkToolResult;
  };
}

export type RawCallResult = RawCallPass | CallFailure;
export type SdkCallResult = SdkCallPass | CallFailure;
export type SdkToolResult = SdkToolPass | CallFailure;

export interface CallFailure {
  readonly errorType: string;
  readonly message: string;
  readonly ok: false;
  readonly status?: number;
}

export interface RawCallPass {
  readonly contentLength: number;
  readonly debug: ValueShape;
  readonly extraKeys: readonly string[];
  readonly finishReason?: string;
  readonly messageKeys: readonly string[];
  readonly normalizations: ValueShape;
  readonly ok: true;
  readonly reasoningContentLength: number;
  readonly reasoningDetails: ValueShape;
  readonly reasoningLength: number;
  readonly routing: ValueShape;
  readonly status: number;
  readonly toolCallCount: number;
  readonly toolCallNames: readonly string[];
  readonly topLevelKeys: readonly string[];
  readonly usage: ValueShape;
}

export interface SdkCallPass {
  readonly finishReason: string;
  readonly ok: true;
  readonly providerMetadata: ValueShape;
  readonly rawFinishReason?: string;
  readonly reasoningPartCount: number;
  readonly reasoningTextLength: number;
  readonly textLength: number;
  readonly usage: ValueShape;
}

export interface SdkToolPass {
  readonly finishReason: string;
  readonly ok: true;
  readonly stepCount: number;
  readonly textLength: number;
  readonly toolCallCount: number;
  readonly toolNames: readonly string[];
  readonly toolResultCount: number;
}

export interface ValueShape {
  readonly keys?: readonly string[];
  readonly kind: string;
  readonly length?: number;
}
