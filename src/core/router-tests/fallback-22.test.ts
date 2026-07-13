import { generateText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { createRouter } from "../router";
import { asV4, finishReason, genOptions, okModel, usage } from "./test-kit";

describe("createRouter — fallback", () => {
  it("shares health and gradual AIMD recovery across logical models with one credential", async () => {
    let now = 1000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      let firstCalls = 0;
      const firstPrimary = new MockLanguageModelV4({
        doGenerate: () => {
          firstCalls += 1;
          if (firstCalls === 1) {
            return Promise.reject(
              Object.assign(new Error("shared rate limit"), { statusCode: 429 })
            );
          }
          return Promise.resolve({
            content: [{ type: "text", text: "first recovered" }],
            finishReason,
            usage,
            warnings: [],
          });
        },
      });
      const secondPrimary = okModel("second recovered");
      const adaptiveConcurrency = {
        increaseAfterSuccesses: 2,
        initial: 4,
        max: 8,
        min: 1,
      };
      const route = createRouter({
        fallback: { health: true, healthNamespace: "shared-recovery" },
        models: {
          first: [
            {
              adaptiveConcurrency,
              healthKey: "shared-credential",
              model: firstPrimary,
            },
            { model: okModel("first fallback") },
          ],
          second: [
            {
              adaptiveConcurrency,
              healthKey: "shared-credential",
              model: secondPrimary,
            },
            { model: okModel("second fallback") },
          ],
        },
      });

      await expect(
        generateText({ model: route("first"), prompt: "fail" })
      ).resolves.toMatchObject({
        text: "first fallback",
      });
      expect(route.getAdmissionSnapshot("first")[0]).toMatchObject({
        limit: 2,
      });
      expect(route.getAdmissionSnapshot("second")[0]).toMatchObject({
        limit: 2,
      });

      await expect(
        generateText({ model: route("second"), prompt: "cooling" })
      ).resolves.toMatchObject({
        text: "second fallback",
      });
      expect(secondPrimary.doGenerateCalls).toHaveLength(0);

      const cooldownUntil = route
        .getHealthSnapshot()
        .find(({ key }) => key.includes(":credential:"))?.record.cooldownUntil;
      if (cooldownUntil === undefined) {
        throw new Error("expected shared credential cooldown");
      }
      now = cooldownUntil + 1;
      await expect(
        generateText({ model: route("second"), prompt: "probe" })
      ).resolves.toMatchObject({
        text: "second recovered",
      });
      expect(route.getAdmissionSnapshot("first")[0]).toMatchObject({
        limit: 2,
        successes: 1,
      });

      await expect(
        generateText({ model: route("first"), prompt: "healthy" })
      ).resolves.toMatchObject({
        text: "first recovered",
      });
      expect(route.getAdmissionSnapshot("second")[0]).toMatchObject({
        limit: 3,
        successes: 0,
      });
    } finally {
      clock.mockRestore();
    }
  });

  it("rejects conflicting concurrency settings for a shared health key", () => {
    expect(() => {
      const route = createRouter({
        models: {
          chat: [
            { model: okModel("a"), healthKey: "shared", maxConcurrency: 1 },
            { model: okModel("b"), healthKey: "shared", maxConcurrency: 2 },
          ],
        },
      });
      route("chat");
    }).toThrow("must use identical concurrency settings");
  });

  it("rejects empty provider families and unknown selection policies", () => {
    expect(() => {
      const route = createRouter({
        models: { chat: [{ model: okModel(), providerFamily: " " }] },
      });
      route("chat");
    }).toThrow("providerFamily must not be empty");

    expect(() => {
      const route = createRouter({
        fallback: { selection: "random" as never },
        models: { chat: [okModel()] },
      });
      route("chat");
    }).toThrow("selection must be");
  });

  it("rejects sparse candidate arrays eagerly", () => {
    expect(() =>
      createRouter({
        models: { chat: new Array(1) as never },
      })
    ).toThrow("candidate array must not contain holes");
    expect(() =>
      createRouter({
        models: { chat: new Array(10_001) as never },
      })
    ).toThrow("exceeds 10000 candidates");
  });

  it("rejects conflicting effective AIMD initial limits", () => {
    expect(() =>
      createRouter({
        models: {
          chat: [
            {
              adaptiveConcurrency: { max: 2 },
              maxConcurrency: 4,
              model: okModel(),
            },
          ],
        },
      })
    ).toThrow("min <= initial <= max");
    expect(() =>
      createRouter({
        models: {
          chat: [
            {
              adaptiveConcurrency: { min: 3 },
              maxConcurrency: 2,
              model: okModel(),
            },
          ],
        },
      })
    ).toThrow("min <= initial <= max");
  });

  it("supports round-robin candidate selection", async () => {
    const route = createRouter({
      fallback: { selection: "round-robin" },
      models: { chat: [okModel("a"), okModel("b")] },
    });

    const outputs: string[] = [];
    for (const prompt of ["one", "two", "three"]) {
      outputs.push((await generateText({ model: route("chat"), prompt })).text);
    }
    expect(outputs).toEqual(["a", "b", "a"]);
  });

  it("does not rotate round-robin state for an already-aborted request", async () => {
    const first = okModel("a");
    const second = okModel("b");
    const route = createRouter({
      fallback: { selection: "round-robin" },
      models: { chat: [first, second] },
    });
    const controller = new AbortController();
    const reason = new Error("cancelled before routing");
    controller.abort(reason);

    await expect(
      asV4(route("chat")).doGenerate({
        ...genOptions,
        abortSignal: controller.signal,
      })
    ).rejects.toBe(reason);
    await expect(
      generateText({ model: route("chat"), prompt: "real request" })
    ).resolves.toMatchObject({ text: "a" });
    expect(first.doGenerateCalls).toHaveLength(1);
    expect(second.doGenerateCalls).toHaveLength(0);
  });
});
