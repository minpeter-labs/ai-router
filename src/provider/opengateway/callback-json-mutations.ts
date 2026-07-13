import { boundedEnumerableOwnKeys } from "../../core/http-headers";
import {
  captureGenuinePromise,
  consumeOwnDataPromiseFields,
} from "../../core/runtime-types";
import { clearTimerSafely, scheduleTimer } from "../../core/timeout";

const MAX_FIELDS = 200_000;
const MAX_OBJECT_KEYS = 1024;
const LATE_MUTATION_RETENTION_MS = 1000;

export interface CallbackJsonMutationTarget {
  keys: (string | number)[];
  value: object;
}

function mutationKeys(
  value: object,
  remaining: number
): (string | number)[] | undefined {
  try {
    if (Array.isArray(value)) {
      const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
      return typeof length === "number" &&
        Number.isSafeInteger(length) &&
        length >= 0 &&
        length <= remaining
        ? Array.from({ length }, (_, index) => index)
        : undefined;
    }
    const keys = boundedEnumerableOwnKeys(value, MAX_OBJECT_KEYS);
    return keys !== undefined && keys.length <= remaining ? keys : undefined;
  } catch {
    return;
  }
}

export function captureCallbackJsonMutationTargets(
  root: unknown
): CallbackJsonMutationTarget[] {
  if (typeof root !== "object" || root === null) {
    return [];
  }
  const targets: CallbackJsonMutationTarget[] = [];
  const pending: object[] = [root];
  const seen = new WeakSet<object>();
  let remaining = MAX_FIELDS;
  while (pending.length > 0 && remaining > 0) {
    const value = pending.pop();
    if (value === undefined || seen.has(value)) {
      continue;
    }
    seen.add(value);
    const keys = mutationKeys(value, remaining);
    if (keys === undefined) {
      continue;
    }
    remaining -= keys.length;
    targets.push({ keys, value });
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      const child =
        descriptor !== undefined && "value" in descriptor
          ? descriptor.value
          : undefined;
      if (typeof child === "object" && child !== null) {
        pending.push(child);
      }
    }
  }
  return targets;
}

export function consumeCallbackJsonMutationPromises(
  targets: CallbackJsonMutationTarget[]
): void {
  for (const target of targets) {
    consumeOwnDataPromiseFields(target.value, target.keys);
  }
}

export function consumeCallbackMutationsNowAndAfterPromise(
  value: unknown,
  targets: CallbackJsonMutationTarget[]
): void {
  consumeCallbackJsonMutationPromises(targets);
  const promise = captureGenuinePromise(value);
  if (promise === undefined) {
    return;
  }
  let pendingTargets: CallbackJsonMutationTarget[] | undefined = targets;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = () => {
    if (pendingTargets !== undefined) {
      consumeCallbackJsonMutationPromises(pendingTargets);
      pendingTargets = undefined;
    }
    clearTimerSafely(timer);
  };
  try {
    timer = scheduleTimer(() => {
      pendingTargets = undefined;
    }, LATE_MUTATION_RETENTION_MS);
  } catch {
    pendingTargets = undefined;
  }
  promise.then(finish, finish);
}
