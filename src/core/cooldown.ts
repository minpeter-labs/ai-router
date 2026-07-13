import {
  consumeGenuinePromise,
  consumeOwnDataPromiseFields,
  isPlainObjectValue,
} from "./runtime-types";
import type { CooldownOption } from "./types";

const DEFAULT_RESET_INTERVAL = 180_000; // 3 minutes

const DURATION_RE = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/;
const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
};

function validInterval(value: number): number {
  const rounded = Math.ceil(value);
  if (!Number.isFinite(value) || value <= 0 || !Number.isSafeInteger(rounded)) {
    throw new Error(
      "ai-router: invalid cooldown interval (must be a positive safe duration)"
    );
  }
  // JavaScript timers truncate fractional milliseconds. Preserve the meaning
  // of every positive configured interval instead of silently turning values
  // such as `0.1ms` into an immediate (0ms) timer.
  return rounded;
}

/** Parse a duration string like `'500ms'`, `'30s'`, `'1m'`, `'2h'` to milliseconds. */
export function parseDuration(value: string): number {
  const match = DURATION_RE.exec(value.trim());
  if (match === null) {
    throw new Error(
      `ai-router: invalid duration "${value}" (use e.g. '500ms', '30s', '1m', '2h')`
    );
  }
  return Number(match[1]) * UNIT_MS[match[2]];
}

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
  private lastValidNow = 0;

  constructor(
    cfg: { modelResetInterval: number },
    now: () => number = Date.now
  ) {
    this.cfg = cfg;
    this.now = now;
    this.lastReset = this.clockNow();
  }

  /** Reset to the primary if the sticky window has elapsed. Call once per selection. */
  checkAndReset(): void {
    const now = this.clockNow();
    if (now < this.lastReset) {
      // Wall-clock rollback must not extend a local sticky window by the size
      // of the clock correction. Restart the interval from the new clock.
      this.lastReset = now;
    }
    if (
      this.activeFullIndex !== 0 &&
      now - this.lastReset >= this.cfg.modelResetInterval
    ) {
      this.activeFullIndex = 0;
      this.lastReset = now;
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
        this.lastReset = this.clockNow();
      }
    }
  }

  private clockNow(): number {
    try {
      const value = this.now();
      if (consumeGenuinePromise(value)) {
        throw new Error("async cooldown clock is unsupported");
      }
      if (
        Number.isFinite(value) &&
        value >= 0 &&
        value <= Number.MAX_SAFE_INTEGER
      ) {
        this.lastValidNow = value;
        return value;
      }
    } catch {
      // Optional sticky routing must not fail when its clock is unavailable.
    }
    return this.lastValidNow;
  }
}

/** Normalize the `cooldown` option to a concrete config, or `undefined` when off. */
export function resolveCooldown(
  opt?: CooldownOption
): { modelResetInterval: number } | undefined {
  if (consumeGenuinePromise(opt)) {
    throw new Error("ai-router: cooldown must be synchronous");
  }
  if (opt === undefined || opt === false || opt === 0) {
    return; // false / undefined / 0
  }
  if (opt === true) {
    return { modelResetInterval: DEFAULT_RESET_INTERVAL };
  }
  if (typeof opt === "number") {
    return { modelResetInterval: validInterval(opt) };
  }
  if (typeof opt === "string") {
    return { modelResetInterval: validInterval(parseDuration(opt)) };
  }
  if (!isPlainObjectValue(opt)) {
    throw new Error(
      "ai-router: cooldown must be a boolean, duration, or config object"
    );
  }
  consumeOwnDataPromiseFields(opt, ["modelResetInterval"]);
  const modelResetInterval = opt.modelResetInterval;
  if (consumeGenuinePromise(modelResetInterval)) {
    throw new Error("ai-router: cooldown must be synchronous");
  }
  return {
    modelResetInterval: validInterval(
      modelResetInterval ?? DEFAULT_RESET_INTERVAL
    ),
  };
}
