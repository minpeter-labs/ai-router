import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import { createRouter } from "../router";
import type { Modality } from "../types";
import { okModel } from "./test-kit";

describe("createRouter — configuration errors", () => {
  it("rejects malformed retry budget containers eagerly", () => {
    for (const retryBudget of [null, [], new Date(), () => undefined]) {
      expect(() =>
        createRouter({
          fallback: { retryBudget: retryBudget as never },
          models: { chat: [okModel()] },
        })
      ).toThrow("retryBudget must be a boolean or config object");
    }
  });

  it("rejects malformed cooldown containers eagerly", () => {
    for (const cooldown of [null, [], new Date(), () => undefined]) {
      expect(() =>
        createRouter({
          fallback: { cooldown: cooldown as never },
          models: { chat: [okModel()] },
        })
      ).toThrow("cooldown must be a boolean, duration, or config object");
    }
  });

  it("rejects malformed fallback containers eagerly", () => {
    for (const fallback of [null, [], () => undefined, true]) {
      expect(() =>
        createRouter({
          fallback: fallback as never,
          models: { chat: [okModel()] },
        })
      ).toThrow("fallback must be an options object");
    }
  });

  it("consumes Promise-valued root fallback option siblings", async () => {
    expect(() =>
      createRouter({
        fallback: Promise.reject(
          new Error("async fallback container")
        ) as never,
        models: { chat: [okModel()] },
      })
    ).toThrow("synchronous");
    expect(() =>
      createRouter({
        fallback: {
          attemptTimeout: Promise.reject(new Error("async attempt timeout")),
          backoff: Promise.reject(new Error("async backoff")),
          classifyFailure: Promise.reject(new Error("async classifier")),
          cooldown: Promise.reject(new Error("async cooldown")),
          healthStore: Promise.reject(new Error("async health store")),
          retryBudget: Promise.reject(new Error("async retry budget")),
          shouldRetry: Promise.reject(new Error("async retry hook")),
          validateResult: Promise.reject(new Error("async validator")),
        } as never,
        models: { chat: [okModel()] },
      })
    ).toThrow("synchronous");
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("rejects malformed fallback hooks and boolean policies eagerly", () => {
    for (const name of ["classifyFailure", "shouldRetry", "validateResult"]) {
      expect(() =>
        createRouter({
          fallback: { [name]: true } as never,
          models: { chat: [okModel()] },
        })
      ).toThrow(`fallback.${name} must be a function`);
    }
    for (const name of [
      "health",
      "retryAfterOutput",
      "strictStreamValidation",
    ]) {
      expect(() =>
        createRouter({
          fallback: { [name]: "yes" } as never,
          models: { chat: [okModel()] },
        })
      ).toThrow(`fallback.${name} must be a boolean`);
    }
  });

  it("rejects malformed observability hooks eagerly", () => {
    expect(() =>
      createRouter({
        models: { chat: [okModel()] },
        onAttempt: true as never,
      })
    ).toThrow("onAttempt must be a function");
    expect(() =>
      createRouter({
        models: { chat: [okModel()] },
        onError: "log" as never,
      })
    ).toThrow("onError must be a function");
  });

  it("consumes Promise-valued root router and route siblings", async () => {
    expect(() =>
      createRouter(Promise.reject(new Error("async router options")) as never)
    ).toThrow("synchronous");
    expect(() =>
      createRouter({
        fallback: Promise.reject(new Error("async root fallback")) as never,
        models: Promise.reject(new Error("async root models")) as never,
        onAttempt: Promise.reject(new Error("async attempt hook")) as never,
        onError: Promise.reject(new Error("async error hook")) as never,
      })
    ).toThrow("synchronous");
    expect(() =>
      createRouter({
        models: {
          first: Promise.reject(new Error("async first route")) as never,
          second: Promise.reject(new Error("async second route")) as never,
        },
      })
    ).toThrow("synchronous");
    expect(() =>
      createRouter({
        models: {
          chat: [
            Promise.reject(new Error("async first candidate")),
            Promise.reject(new Error("async second candidate")),
          ] as never,
        },
      })
    ).toThrow("synchronous");
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("snapshots mutable entry configuration at router creation", async () => {
    const supports: Modality[] = ["text"];
    const adaptive = { initial: 1, max: 2, min: 1 };
    const original = okModel("original");
    const replacement = okModel("replacement");
    const entry = {
      adaptiveConcurrency: adaptive,
      model: "original-id",
      provider: (modelId: string) =>
        modelId === "original-id" ? original : replacement,
      supports,
    };
    const route = createRouter({ models: { chat: [entry] } });

    entry.model = "replacement-id";
    entry.provider = () => replacement;
    supports.length = 0;
    adaptive.initial = 99;

    await expect(
      generateText({ model: route("chat"), prompt: "hi" })
    ).resolves.toMatchObject({ text: "original" });
    expect(route.getAdmissionSnapshot("chat")[0]).toMatchObject({
      limit: 1,
      max: 2,
      min: 1,
    });
    expect(replacement.doGenerateCalls).toHaveLength(0);
  });
});
