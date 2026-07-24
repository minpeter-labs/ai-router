import type { ResolvedEntry } from "./stream";
import { monotonicNow, RouterTimeoutError } from "./timeout";
import type { RouterOrderingToken } from "./types";

/**
 * A candidate entry normalized to a single internal shape, regardless of which
 * of the three accepted `ProviderEntry` forms the user wrote.
 */

import { RouterAttemptObservability } from "./router-attempt-observability";

export class RouterAttemptAdmission extends RouterAttemptObservability {
  protected releaseCandidateProbe(candidate: ResolvedEntry): void {
    const lease = candidate.probeLease;
    candidate.probeLease = undefined;
    this.health.releaseProbe(lease);
  }

  protected releaseCandidateOwnership(candidate: ResolvedEntry): void {
    try {
      this.admission.release(candidate.fullIndex);
    } finally {
      this.releaseCandidateProbe(candidate);
    }
  }

  protected prepareCandidate(candidate: ResolvedEntry): boolean {
    if (!this.healthEnabled) {
      return true;
    }
    const entry = this.normalized[candidate.fullIndex];
    if (
      !this.health.claimProbe(
        candidate.fullIndex,
        entry.healthKey,
        entry.providerFamily
      )
    ) {
      return false;
    }
    candidate.probeLease = this.health.takeProbeLease(
      candidate.fullIndex,
      entry.healthKey,
      entry.providerFamily
    );
    return true;
  }

  protected acceptAdmission(
    candidate: ResolvedEntry,
    inFlight: number | undefined,
    selectedAt: RouterOrderingToken,
    phase: "generate" | "stream-open"
  ): inFlight is number {
    if (inFlight === undefined) {
      this.releaseCandidateProbe(candidate);
      this.emitSkipped([candidate], phase, "concurrency");
      return false;
    }
    if (this.becameUnavailable(candidate.fullIndex, selectedAt)) {
      this.releaseCandidateOwnership(candidate);
      this.emitSkipped([candidate], phase, "cooldown");
      return false;
    }
    return true;
  }

  protected async admitCandidate(
    candidate: ResolvedEntry,
    isLast: boolean,
    signal: AbortSignal | undefined,
    deadline: number | undefined,
    selectedAt: RouterOrderingToken,
    phase: "generate" | "stream-open"
  ): Promise<{
    capacitySkipped: boolean;
    healthSkipped: boolean;
    inFlight?: number;
  }> {
    let ownsCapacity = false;
    try {
      if (!this.prepareCandidate(candidate)) {
        this.emitSkipped([candidate], phase, "cooldown");
        return { capacitySkipped: false, healthSkipped: true };
      }
      let inFlight = this.admission.acquire(candidate.fullIndex);
      ownsCapacity = inFlight !== undefined;
      if (
        inFlight === undefined &&
        isLast &&
        this.concurrencyWaitTimeout !== undefined
      ) {
        // A queued request is not probing the provider yet. Do not reserve the
        // half-open lease while waiting (possibly longer than the lease itself);
        // reclaim it only after admission grants a real slot.
        this.releaseCandidateProbe(candidate);
        inFlight = await this.admission.waitFor(
          candidate.fullIndex,
          signal,
          deadline
        );
        ownsCapacity = inFlight !== undefined;
        if (
          inFlight === undefined &&
          deadline !== undefined &&
          monotonicNow() >= deadline
        ) {
          throw new RouterTimeoutError("total_timeout", this.totalTimeout ?? 0);
        }
        if (inFlight !== undefined && !this.prepareCandidate(candidate)) {
          this.releaseCandidateOwnership(candidate);
          ownsCapacity = false;
          this.emitSkipped([candidate], phase, "cooldown");
          return { capacitySkipped: false, healthSkipped: true };
        }
      }
      const capacitySkipped = inFlight === undefined;
      const accepted = this.acceptAdmission(
        candidate,
        inFlight,
        selectedAt,
        phase
      );
      ownsCapacity = false;
      return accepted
        ? { capacitySkipped, healthSkipped: false, inFlight }
        : { capacitySkipped, healthSkipped: !capacitySkipped };
    } catch (error) {
      if (ownsCapacity) {
        this.releaseCandidateOwnership(candidate);
      } else {
        this.releaseCandidateProbe(candidate);
      }
      throw error;
    }
  }
}
