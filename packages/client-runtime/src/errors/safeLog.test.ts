import { describe, expect, it } from "vite-plus/test";

import { safeErrorLogAttributes } from "./safeLog.ts";

describe("safeErrorLogAttributes", () => {
  it("keeps correlation and stack frames without serializing messages or nested causes", () => {
    const cause = Object.assign(new Error("nested-cause-secret-sentinel"), {
      traceId: "trace-safe-123",
    });
    const error = Object.assign(new Error("outer-error-secret-sentinel", { cause }), {
      _tag: "ProjectRemovalError",
    });
    error.stack = [
      "ProjectRemovalError: outer-error-secret-sentinel",
      "    at removeProject (https://user:password@example.com/project.ts?token=secret#fragment)",
    ].join("\n");

    const attributes = safeErrorLogAttributes(error);

    expect(attributes).toMatchObject({
      errorType: "error",
      errorName: "Error",
      errorTag: "ProjectRemovalError",
      traceId: "trace-safe-123",
      stack: "    at removeProject (https://example.com/project.ts)",
    });
    const diagnosticText = Object.values(attributes).map(String).join("\n");
    expect(diagnosticText).not.toContain("outer-error-secret-sentinel");
    expect(diagnosticText).not.toContain("nested-cause-secret-sentinel");
    expect(diagnosticText).not.toContain("user:password");
    expect(diagnosticText).not.toContain("token=secret");
  });

  it("redacts numeric query and fragment secrets that resemble stack positions", () => {
    const error = new Error("failure");
    error.stack = [
      "    at query (https://example.com/app.js?token=secret:123456)",
      "    at fragment (https://example.com/app.js#secret:123456)",
      "    at queryPair (https://example.com/app.js?token=secret:123:456)",
      "    at fragmentPair (https://example.com/app.js#secret:123:456)",
      "    at positioned (https://example.com/app.js:12:5)",
    ].join("\n");

    expect(safeErrorLogAttributes(error).stack).toBe(
      [
        "    at query (https://example.com/app.js)",
        "    at fragment (https://example.com/app.js)",
        "    at queryPair (https://example.com/app.js)",
        "    at fragmentPair (https://example.com/app.js)",
        "    at positioned (https://example.com/app.js:12:5)",
      ].join("\n"),
    );
  });

  it("does not trust arbitrary object messages or tags", () => {
    const attributes = safeErrorLogAttributes({
      _tag: "payload-secret-sentinel",
      message: "message-secret-sentinel",
      cause: { traceId: "trace id with unsafe whitespace" },
    });

    expect(attributes).toEqual({ errorType: "object" });
  });
});
