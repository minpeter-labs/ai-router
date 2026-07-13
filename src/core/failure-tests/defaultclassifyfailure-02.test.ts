import { describe, expect, it } from "vitest";
import { defaultClassifyFailure } from "../failure";

describe("defaultClassifyFailure", () => {
  it("keeps unrelated 404 failures request-scoped and terminal", () => {
    expect(
      defaultClassifyFailure({ statusCode: 404, message: "job not found" })
    ).toMatchObject({ retryable: false, scope: "request" });
    expect(
      defaultClassifyFailure({
        responseBody: {
          invalid_api_key: false,
          model_not_available: false,
        },
        statusCode: 404,
      })
    ).toEqual({ retryable: false, scope: "request", statusCode: 404 });
    for (const responseBody of [
      { prompt: "Why is model x not available?" },
      JSON.stringify({ prompt: "Why is model x not available?" }),
      '{"prompt":"model not available"',
      JSON.stringify({
        prompt: `model not available${"x".repeat(70_000)}`,
      }),
    ]) {
      expect(
        defaultClassifyFailure({
          message: "job not found",
          responseBody,
          statusCode: 404,
        })
      ).toEqual({ retryable: false, scope: "request", statusCode: 404 });
    }
  });

  it("classifies no-endpoint model 404s as routing-unit failures", () => {
    expect(
      defaultClassifyFailure({
        message: "No endpoints found for the requested model",
        statusCode: 404,
      })
    ).toMatchObject({
      retryable: true,
      scope: "routing-unit",
      statusCode: 404,
    });
  });

  it("keeps provider and model availability failures routing-unit scoped", () => {
    for (const [statusCode, message] of [
      [403, "The requested provider 'deepinfra' is not available."],
      [403, "The requested model is not available on this endpoint."],
      [404, "The requested provider 'deepinfra' is not available."],
      [
        403,
        "Requested model is not supported by any provider you have enabled",
      ],
      [403, "Unable to access model; see supported models"],
      [403, "upstream_waf_blocked"],
      [403, "Cloudflare WAF rejected the upstream request"],
    ] as const) {
      expect(defaultClassifyFailure({ message, statusCode })).toMatchObject({
        retryable: true,
        scope: "routing-unit",
        statusCode,
      });
    }
  });

  it("does not treat gateway WAF blocks as hard credential failures", () => {
    for (const message of ["upstream_waf_blocked", "Cloudflare WAF block"]) {
      const classification = defaultClassifyFailure({
        message,
        statusCode: 403,
      });
      expect(classification).toMatchObject({
        retryable: true,
        scope: "routing-unit",
      });
      expect(classification.cooldownMs).toBeUndefined();
    }
  });

  it("does not infer a WAF block from an echoed product name alone", () => {
    expect(
      defaultClassifyFailure({
        message: "forbidden",
        responseBody: { prompt: "Explain Cloudflare WAF" },
        statusCode: 403,
      })
    ).toMatchObject({
      cooldownMs: 3_600_000,
      retryable: true,
      scope: "credential",
    });
  });

  it("classifies model plan-access 404s as credential failures", () => {
    for (const message of [
      "Model x is not available on your subscription plan",
      "Model x does not exist for pay-as-you-go accounts",
      "Model x is not available on the current plan",
    ]) {
      expect(
        defaultClassifyFailure({ message, statusCode: 404 })
      ).toMatchObject({
        retryable: true,
        scope: "credential",
        statusCode: 404,
      });
    }
  });

  it("classifies proxy budget exhaustion as a credential failure", () => {
    expect(
      defaultClassifyFailure({
        message:
          "ExceededBudget: User is over budget. Spend=10.00, Budget=10.00",
        statusCode: 400,
      })
    ).toMatchObject({
      retryable: true,
      scope: "credential",
      statusCode: 400,
    });
    expect(
      defaultClassifyFailure({
        message: "Billing or monthly spending limit reached",
        statusCode: 403,
      })
    ).toMatchObject({
      retryable: true,
      scope: "credential",
    });
    expect(
      defaultClassifyFailure({
        message: "Billing or monthly spending limit reached",
        statusCode: 403,
      })
    ).not.toHaveProperty("cooldownMs", 3_600_000);
  });

  it("classifies structured provider exhaustion codes as credential failures", () => {
    expect(
      defaultClassifyFailure({
        responseBody: { error: { code: "insufficient_quota" } },
        statusCode: 404,
      })
    ).toMatchObject({ retryable: true, scope: "credential" });
    expect(
      defaultClassifyFailure({
        responseBody: { error: { code: "access_terminated_error" } },
        statusCode: 404,
      })
    ).toMatchObject({
      cooldownMs: 3_600_000,
      retryable: true,
      scope: "credential",
    });
  });

  it("applies the hard-auth floor to explicit auth codes on odd statuses", () => {
    for (const code of [
      "invalid_api_key",
      "authentication_error",
      "invalid_token",
      "api_key_disabled",
    ]) {
      expect(
        defaultClassifyFailure({
          responseBody: { error: { code } },
          statusCode: 400,
        })
      ).toMatchObject({
        cooldownMs: 3_600_000,
        retryable: true,
        scope: "credential",
      });
    }
    expect(defaultClassifyFailure({ code: "invalid_api_key" })).toMatchObject({
      cooldownMs: 3_600_000,
      retryable: true,
      scope: "credential",
    });
  });

  it("keeps explicit model-unavailable codes routing-unit scoped", () => {
    expect(
      defaultClassifyFailure({
        responseBody: { error: { code: "model_not_found" } },
        statusCode: 410,
      })
    ).toMatchObject({
      retryable: true,
      scope: "routing-unit",
      statusCode: 410,
    });
    expect(
      defaultClassifyFailure({
        code: "model_not_available",
        statusCode: 410,
      })
    ).toMatchObject({ retryable: true, scope: "routing-unit" });
    expect(
      defaultClassifyFailure({ code: "model_not_available" })
    ).toMatchObject({ retryable: true, scope: "routing-unit" });
  });
});
