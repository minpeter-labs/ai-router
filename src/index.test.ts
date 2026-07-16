import { describe, expect, it } from "vitest";

import {
  RouterConcurrencyError,
  RouterHealthUnavailableError,
  RouterTimeoutError,
  surfaceFailure,
} from "./index";

describe("public error contracts", () => {
  it("exports stable named router errors from the package root", () => {
    expect(new RouterConcurrencyError("chat")).toMatchObject({
      code: "concurrency_exhausted",
      logicalId: "chat",
      name: "RouterConcurrencyError",
    });
    expect(new RouterHealthUnavailableError("chat")).toMatchObject({
      code: "health_unavailable",
      logicalId: "chat",
      name: "RouterHealthUnavailableError",
    });
    expect(new RouterTimeoutError("total_timeout", 50)).toMatchObject({
      code: "total_timeout",
      durationMs: 50,
      name: "RouterTimeoutError",
    });
  });

  it("preserves single-error identity and AggregateError cause", () => {
    const first = new Error("first");
    const last = new Error("last");

    expect(surfaceFailure([first], "chat")).toBe(first);
    const aggregate = surfaceFailure([first, last], "chat");
    expect(aggregate).toBeInstanceOf(AggregateError);
    expect(aggregate).toMatchObject({ cause: last, errors: [first, last] });
  });
});
