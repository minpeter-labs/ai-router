import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import {
  cloneHeaders,
  cloneTool,
  validateCallMetadataStrings,
  validateToolConfiguration,
} from "./call-options-extras";
import {
  cloneResponseFormat,
  cloneToolChoice,
  synchronousCallField,
  validateAbortSignal,
} from "./call-options-output";
import {
  CALL_OPTION_FIELD_KEYS,
  cloneRequiredJson,
  consumeBoundedArrayPromiseItems,
  MAX_CALL_JSON_CHARACTERS,
  MAX_CALL_JSON_CONTAINERS,
  MAX_PROMPT_MESSAGES,
  MAX_STOP_SEQUENCE_CHARS,
  MAX_STOP_SEQUENCE_LENGTH,
  MAX_STOP_SEQUENCES,
  MAX_TOOLS,
  snapshotDenseBounded,
  validateScalarOptions,
} from "./call-options-primitives";
import { clonePrompt } from "./call-options-prompt";
import {
  consumeGenuinePromise,
  consumeOwnDataPromiseFields,
} from "./runtime-types";
export class CallOptionsContractError extends Error {
  readonly code = "call_options_contract_error";

  constructor(cause: unknown) {
    super("ai-router: call options could not be safely copied", { cause });
    this.name = "CallOptionsContractError";
  }
}

function consumeCallOptionPromiseFields(
  source: LanguageModelV4CallOptions
): void {
  consumeBoundedArrayPromiseItems(source.prompt, MAX_PROMPT_MESSAGES);
  consumeBoundedArrayPromiseItems(source.stopSequences, MAX_STOP_SEQUENCES);
  consumeBoundedArrayPromiseItems(source.tools, MAX_TOOLS);
  if (
    typeof source.responseFormat === "object" &&
    source.responseFormat !== null
  ) {
    consumeOwnDataPromiseFields(source.responseFormat, [
      "description",
      "name",
      "schema",
      "type",
    ]);
  }
  if (typeof source.toolChoice === "object" && source.toolChoice !== null) {
    consumeOwnDataPromiseFields(source.toolChoice, ["toolName", "type"]);
  }
  let asyncField = false;
  for (const value of Object.values(source)) {
    if (consumeGenuinePromise(value)) {
      asyncField = true;
    }
  }
  if (asyncField) {
    throw new Error("call options fields must be synchronous");
  }
}

function cloneCallOptionsUnsafe(
  options: LanguageModelV4CallOptions,
  abortSignal: AbortSignal | undefined
): LanguageModelV4CallOptions {
  if (consumeGenuinePromise(options)) {
    throw new Error("call options must be synchronous");
  }
  consumeOwnDataPromiseFields(options, CALL_OPTION_FIELD_KEYS);
  const source: LanguageModelV4CallOptions = {
    abortSignal,
    frequencyPenalty: Reflect.get(options, "frequencyPenalty"),
    headers: Reflect.get(options, "headers"),
    includeRawChunks: Reflect.get(options, "includeRawChunks"),
    maxOutputTokens: Reflect.get(options, "maxOutputTokens"),
    presencePenalty: Reflect.get(options, "presencePenalty"),
    prompt: Reflect.get(options, "prompt"),
    providerOptions: Reflect.get(options, "providerOptions"),
    reasoning: Reflect.get(options, "reasoning"),
    responseFormat: Reflect.get(options, "responseFormat"),
    seed: Reflect.get(options, "seed"),
    stopSequences: Reflect.get(options, "stopSequences"),
    temperature: Reflect.get(options, "temperature"),
    toolChoice: Reflect.get(options, "toolChoice"),
    tools: Reflect.get(options, "tools"),
    topK: Reflect.get(options, "topK"),
    topP: Reflect.get(options, "topP"),
  };
  consumeCallOptionPromiseFields(source);
  validateAbortSignal(abortSignal);
  validateScalarOptions(source);
  const jsonBudget = {
    remaining: MAX_CALL_JSON_CONTAINERS,
    remainingCharacters: MAX_CALL_JSON_CHARACTERS,
  };
  const stopSequences =
    source.stopSequences === undefined
      ? undefined
      : snapshotDenseBounded<unknown>(
          source.stopSequences,
          MAX_STOP_SEQUENCES,
          "stopSequences"
        );
  if (stopSequences !== undefined) {
    let totalChars = 0;
    for (const value of stopSequences) {
      if (
        typeof value !== "string" ||
        value.length === 0 ||
        value.length > MAX_STOP_SEQUENCE_LENGTH
      ) {
        throw new Error("stopSequences must contain bounded non-empty strings");
      }
      totalChars += value.length;
      if (totalChars > MAX_STOP_SEQUENCE_CHARS) {
        throw new Error("stopSequences exceed the aggregate size limit");
      }
    }
  }
  const rawTools =
    source.tools === undefined
      ? undefined
      : snapshotDenseBounded<unknown>(source.tools, MAX_TOOLS, "tools");
  if (
    rawTools !== undefined &&
    !rawTools.every((tool) => typeof tool === "object" && tool !== null)
  ) {
    throw new Error("tools must contain objects");
  }
  const tools = rawTools?.map((tool) =>
    cloneTool(
      tool as NonNullable<LanguageModelV4CallOptions["tools"]>[number],
      jsonBudget
    )
  );
  const toolChoice = cloneToolChoice(source.toolChoice);
  validateToolConfiguration(tools, toolChoice);
  const cloned = {
    ...source,
    abortSignal,
    headers: cloneHeaders(source.headers),
    prompt: clonePrompt(source.prompt, jsonBudget),
    providerOptions: cloneRequiredJson(
      source.providerOptions,
      "providerOptions",
      jsonBudget
    ),
    responseFormat: cloneResponseFormat(source.responseFormat, jsonBudget),
    stopSequences: stopSequences as string[] | undefined,
    toolChoice,
    tools,
  };
  validateCallMetadataStrings(cloned);
  return cloned;
}

/** Isolate mutable option containers for one provider attempt. */
export function cloneCallOptions(
  options: LanguageModelV4CallOptions,
  abortSignal: AbortSignal | undefined
): LanguageModelV4CallOptions {
  try {
    return cloneCallOptionsUnsafe(options, abortSignal);
  } catch (error) {
    throw new CallOptionsContractError(error);
  }
}

/** Capture the caller-owned signal inside the same contract-error boundary. */
export function cloneInitialCallOptions(
  options: LanguageModelV4CallOptions
): LanguageModelV4CallOptions {
  try {
    if (consumeGenuinePromise(options)) {
      throw new Error("call options must be synchronous");
    }
    consumeOwnDataPromiseFields(options, [
      "abortSignal",
      ...CALL_OPTION_FIELD_KEYS,
    ]);
    return cloneCallOptionsUnsafe(
      options,
      synchronousCallField(options, "abortSignal", "abortSignal") as
        | AbortSignal
        | undefined
    );
  } catch (error) {
    if (error instanceof CallOptionsContractError) {
      throw error;
    }
    throw new CallOptionsContractError(error);
  }
}
