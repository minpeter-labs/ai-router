import type { CooldownConfig } from "./types";

const DEFAULT_RESET_INTERVAL = 180_000; // 3 minutes

/**
 * Per-logical-id sticky+reset state. Disabled by default — a {@link CooldownState}
 * is only constructed when `createRouter`'s `cooldown` option is set.
 *
 * It tracks an absolute index into the FULL (unfiltered) candidate array. After
 * the router switches away from the primary, that survivor stays sticky so the
 * next request skips the known-down primary; once `modelResetInterval` ms have
 * elapsed since the switch, the next request re-probes the primary.
 *
 * The `now` clock is injectable so tests can advance time deterministically.
 */
export class CooldownState {
  private activeFullIndex = 0;
  private lastReset: number;
  private readonly cfg: { modelResetInterval: number };
  private readonly now: () => number;

  constructor(
    cfg: { modelResetInterval: number },
    now: () => number = Date.now
  ) {
    this.cfg = cfg;
    this.now = now;
    this.lastReset = now();
  }

  /** Reset to the primary if the sticky window has elapsed. Call once per selection. */
  checkAndReset(): void {
    if (
      this.activeFullIndex !== 0 &&
      this.now() - this.lastReset >= this.cfg.modelResetInterval
    ) {
      this.activeFullIndex = 0;
      this.lastReset = this.now();
    }
  }

  /** The full-array index the next request should start probing from. */
  current(): number {
    return this.activeFullIndex;
  }

  /**
   * Commit a survivor. Starting the reset window only when leaving the primary
   * means a healthy primary keeps serving and the interval is measured from the
   * last real switch away from it.
   */
  advanceTo(fullIndex: number): void {
    if (fullIndex !== this.activeFullIndex) {
      this.activeFullIndex = fullIndex;
      if (fullIndex !== 0) {
        this.lastReset = this.now();
      }
    }
  }
}

/** Normalize the `cooldown` option to a concrete config, or `undefined` when off. */
export function resolveCooldown(
  opt?: CooldownConfig | boolean
): { modelResetInterval: number } | undefined {
  if (!opt) {
    return;
  }
  if (opt === true) {
    return { modelResetInterval: DEFAULT_RESET_INTERVAL };
  }
  return {
    modelResetInterval: opt.modelResetInterval ?? DEFAULT_RESET_INTERVAL,
  };
}
