import type { RouterHealthRecord, RouterHealthStore } from "./types";

export interface LocalWriteFailureOverlay {
  expirations: Array<{ deadline: number; key: string }>;
  inactive: Map<string, true>;
  records: Map<string, RouterHealthRecord>;
}

export function probeExpiryBefore(
  left: { deadline: number; key: string },
  right: { deadline: number; key: string }
): boolean {
  return (
    left.deadline < right.deadline ||
    (left.deadline === right.deadline && left.key < right.key)
  );
}

export function pushProbeExpiry(
  heap: Array<{ deadline: number; key: string }>,
  expiry: { deadline: number; key: string }
): void {
  heap.push(expiry);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (!probeExpiryBefore(expiry, heap[parent])) {
      break;
    }
    heap[index] = heap[parent];
    index = parent;
  }
  heap[index] = expiry;
}

export function popProbeExpiry(
  heap: Array<{ deadline: number; key: string }>
): { deadline: number; key: string } | undefined {
  const first = heap[0];
  const last = heap.pop();
  if (first === undefined || last === undefined || heap.length === 0) {
    return first;
  }
  let index = 0;
  while (true) {
    const left = index * 2 + 1;
    const right = left + 1;
    if (left >= heap.length) {
      break;
    }
    const child =
      right < heap.length && probeExpiryBefore(heap[right], heap[left])
        ? right
        : left;
    if (!probeExpiryBefore(heap[child], last)) {
      break;
    }
    heap[index] = heap[child];
    index = child;
  }
  heap[index] = last;
  return first;
}

export const localWriteFailuresByStore = new WeakMap<
  RouterHealthStore,
  LocalWriteFailureOverlay
>();
