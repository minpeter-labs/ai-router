import { consumeGenuinePromise } from "./runtime-types";
import { snapshotCandidateForStateHook } from "./stream-candidate-hooks";
import {
  consumeCandidateSnapshotPromiseMutations,
  ownCandidateField,
  snapshotCandidateProbeLease,
  snapshotResolvedEntry,
} from "./stream-candidate-snapshot";
import type { FallbackStreamArgs, ResolvedEntry } from "./stream-types";

export function runCandidateCleanup(
  cleanup: ((candidate: ResolvedEntry) => void) | undefined,
  candidate: ResolvedEntry | undefined
): void {
  try {
    consumeGenuinePromise(cleanup?.(candidate as ResolvedEntry));
  } catch {
    // Capacity and probe release are independent best-effort cleanup hooks.
  }
}

export function runIsolatedCandidateCleanup(
  cleanup: ((candidate: ResolvedEntry) => void) | undefined,
  candidate: ResolvedEntry | undefined
): void {
  if (candidate === undefined) {
    runCandidateCleanup(cleanup, candidate);
    return;
  }
  const hookCandidate = snapshotCandidateForStateHook(candidate);
  runCandidateCleanup(cleanup, hookCandidate);
  consumeCandidateSnapshotPromiseMutations(hookCandidate);
}

export function runProbeCandidateCleanup(
  cleanup: ((candidate: ResolvedEntry) => void) | undefined,
  candidate: ResolvedEntry | undefined
): void {
  if (candidate === undefined) {
    runCandidateCleanup(cleanup, candidate);
    return;
  }
  let hookCandidate: ResolvedEntry;
  try {
    hookCandidate = snapshotCandidateForStateHook(candidate);
  } catch {
    runCandidateCleanup(cleanup, candidate);
    return;
  }
  runCandidateCleanup(cleanup, hookCandidate);
  consumeCandidateSnapshotPromiseMutations(hookCandidate);
  try {
    candidate.probeLease = snapshotCandidateProbeLease(
      ownCandidateField(hookCandidate, "probeLease"),
      candidate.fullIndex
    );
  } catch {
    // Keep the last validated canonical lease after malformed cleanup mutation.
  }
}

export function setupCleanupCandidate(
  args: FallbackStreamArgs
): ResolvedEntry | undefined {
  try {
    const candidatesDescriptor = Object.getOwnPropertyDescriptor(
      args,
      "candidates"
    );
    const indexDescriptor = Object.getOwnPropertyDescriptor(args, "startIndex");
    if (
      candidatesDescriptor === undefined ||
      !("value" in candidatesDescriptor) ||
      indexDescriptor === undefined ||
      !("value" in indexDescriptor) ||
      !Number.isSafeInteger(indexDescriptor.value) ||
      indexDescriptor.value < 0
    ) {
      return;
    }
    const candidateDescriptor = Object.getOwnPropertyDescriptor(
      candidatesDescriptor.value,
      String(indexDescriptor.value)
    );
    const candidate =
      candidateDescriptor !== undefined && "value" in candidateDescriptor
        ? candidateDescriptor.value
        : undefined;
    return snapshotResolvedEntry(candidate, indexDescriptor.value);
  } catch {
    return;
  }
}

export function runSetupCandidateCleanup(
  args: FallbackStreamArgs,
  releaseCandidate: FallbackStreamArgs["releaseCandidate"],
  releaseProbeCandidate: FallbackStreamArgs["releaseProbeCandidate"]
): void {
  const candidate = setupCleanupCandidate(args);
  runIsolatedCandidateCleanup(releaseCandidate, candidate);
  runProbeCandidateCleanup(releaseProbeCandidate, candidate);
}
