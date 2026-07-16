import { describe, expect, it } from "vitest";
import { captureProviderSupportedUrls } from "../provider-settings-urls";
import { MUTATED_PATTERN, SOUND_PATTERN, STABLE_PATTERN } from "./test-kit";

describe("captureProviderSupportedUrls", () => {
  it("preserves the callback receiver and snapshots sync and async maps", async () => {
    const patterns = [STABLE_PATTERN];
    const settings = {
      supportedUrls(this: unknown) {
        expect(this).toBe(settings);
        return { "image/*": patterns };
      },
    };
    const captured = captureProviderSupportedUrls(
      settings.supportedUrls,
      "TestProvider",
      settings
    );
    const snapshot = captured?.();
    patterns[0] = MUTATED_PATTERN;
    expect(snapshot).toEqual({ "image/*": [STABLE_PATTERN] });

    const asyncCaptured = captureProviderSupportedUrls(
      () => Promise.resolve({ "audio/*": [SOUND_PATTERN] }),
      "TestProvider",
      settings
    );
    await expect(asyncCaptured?.()).resolves.toEqual({
      "audio/*": [SOUND_PATTERN],
    });
  });

  it("consumes Promise-valued media and pattern siblings", async () => {
    const captured = captureProviderSupportedUrls(
      () =>
        ({
          "audio/*": [
            Promise.reject(new Error("async pattern one")),
            Promise.reject(new Error("async pattern two")),
          ],
          "image/*": Promise.reject(new Error("async media patterns")),
        }) as never,
      "TestProvider",
      {}
    );

    expect(() => captured?.()).toThrow(
      "TestProvider supportedUrls must be synchronous"
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("does not inspect arbitrary thenable callback results", () => {
    let thenReads = 0;
    const extension = Object.defineProperty({}, ["th", "en"].join(""), {
      get() {
        thenReads += 1;
        throw new Error("then must not be inspected");
      },
    });
    const captured = captureProviderSupportedUrls(
      () => extension as never,
      "TestProvider",
      {}
    );

    expect(captured?.()).toEqual({});
    expect(thenReads).toBe(0);
  });
});
