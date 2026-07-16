import {
  consumeGenuinePromise,
  consumeOwnDataPromiseFields,
  isUint8ArrayValue,
  isUrlValue,
} from "./runtime-types";

export const MAX_FILE_PAYLOAD_BYTES = 67_108_864;

export interface FilePayloadBudget {
  remainingFileBytes: number;
}

const NativeUint8Array = Uint8Array;
const nativeUint8ArraySet = Uint8Array.prototype.set;
const typedArrayByteLengthGetter = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  "byteLength"
)?.get;
const NativeURL = URL;
const nativeUrlToString = URL.prototype.toString;

export class AsyncFilePayloadError extends Error {}

function synchronousFileValue(value: unknown): unknown {
  if (consumeGenuinePromise(value)) {
    throw new AsyncFilePayloadError(
      "async file payload fields are unsupported"
    );
  }
  return value;
}

function consumeFileBytes(budget: FilePayloadBudget, amount: number): void {
  budget.remainingFileBytes -= amount;
  if (budget.remainingFileBytes < 0) {
    throw new Error(
      `file payloads exceed ${MAX_FILE_PAYLOAD_BYTES} aggregate bytes`
    );
  }
}

export function snapshotFileData(
  value: unknown,
  budget: FilePayloadBudget
): unknown {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  consumeOwnDataPromiseFields(value, ["type", "data", "url"]);
  const type = synchronousFileValue(Reflect.get(value, "type"));
  if (type === "data") {
    const data = synchronousFileValue(Reflect.get(value, "data"));
    if (typeof data === "string") {
      consumeFileBytes(budget, data.length * 2);
      return { data, type };
    }
    if (typedArrayByteLengthGetter === undefined) {
      throw new Error("Uint8Array byte-length intrinsic is unavailable");
    }
    if (!isUint8ArrayValue(data)) {
      return { data, type };
    }
    const byteLength = Reflect.apply(typedArrayByteLengthGetter, data, []);
    consumeFileBytes(budget, byteLength);
    const snapshot = new NativeUint8Array(byteLength);
    Reflect.apply(nativeUint8ArraySet, snapshot, [data]);
    return { data: snapshot, type };
  }
  if (type === "url") {
    const url = synchronousFileValue(Reflect.get(value, "url"));
    if (!isUrlValue(url)) {
      return { type, url };
    }
    const serialized = Reflect.apply(nativeUrlToString, url, []);
    consumeFileBytes(budget, serialized.length * 2);
    return { type, url: new NativeURL(serialized) };
  }
  return { type };
}
