import { afterEach, describe, expect, it } from "vitest";
import {
  errorResult,
  redactedDiagnosticMessage,
  requiredOpenGatewayBaseURL,
} from "../../../scripts/opengateway-live/json";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("OpenGateway live script safety helpers", () => {
  it("rejects custom base URLs unless explicitly allowed", () => {
    process.env.AI_BASE_URL = "https://example.test/v1";
    delete process.env.OPENGATEWAY_ALLOW_CUSTOM_BASE_URL;

    expect(() => requiredOpenGatewayBaseURL()).toThrow(
      "AI_BASE_URL must be an HTTPS opengateway.ai URL"
    );

    process.env.OPENGATEWAY_ALLOW_CUSTOM_BASE_URL = "1";

    expect(requiredOpenGatewayBaseURL()).toBe("https://example.test/v1");
  });

  it("redacts reasoning details and bearer material from diagnostics", () => {
    const message = redactedDiagnosticMessage(
      'bad {"reasoning_details":[{"data":"secret"}]} Bearer token'
    );

    expect(message).not.toContain("secret");
    expect(message).not.toContain("Bearer token");
    expect(message).toContain("reasoning details");
  });

  it("does not stringify raw upstream error bodies", () => {
    const result = errorResult(
      { choices: [{ message: { reasoning_details: [{ data: "secret" }] } }] },
      500
    );

    expect(result.message).toBe("upstream response body redacted");
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});
