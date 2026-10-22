import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  PreviewAutomationHost,
  PreviewAutomationOpenInput,
  PreviewAutomationStatus,
  PreviewAutomationLogsInput,
} from "./previewAutomation.ts";

const decodeOpenInput = Schema.decodeUnknownSync(PreviewAutomationOpenInput);
const decodeAutomationHost = Schema.decodeUnknownSync(PreviewAutomationHost);
const decodeAutomationStatus = Schema.decodeUnknownSync(PreviewAutomationStatus);

describe("PreviewAutomationLogsInput", () => {
  const decode = Schema.decodeUnknownSync(PreviewAutomationLogsInput);
  it("accepts combined filters and rejects unbounded inputs", () => {
    const input = {
      limit: 100,
      consoleLevels: ["warning", "error"],
      text: "failure",
      url: "/api",
      status: 503,
      failed: false,
      method: "POST",
      includeConsole: false,
    };
    expect(decode(input)).toEqual(input);
    for (const invalid of [
      { limit: 0 },
      { limit: 101 },
      { limit: 1.5 },
      { status: 99 },
      { status: 600 },
      { text: "x".repeat(257) },
      { consoleLevels: Array.from({ length: 21 }, () => "error") },
    ]) {
      expect(() => decode(invalid)).toThrow();
    }
  });
});

describe("PreviewAutomationOpenInput", () => {
  it("retains the legacy show visibility alias", () => {
    expect(decodeOpenInput({ show: false })).toEqual({ show: false });
  });
});

describe("PreviewAutomationHost", () => {
  it("accepts legacy hosts and current operation advertisements", () => {
    expect(decodeAutomationHost({ clientId: "legacy", environmentId: "environment-1" })).toEqual({
      clientId: "legacy",
      environmentId: "environment-1",
    });
    expect(
      decodeAutomationHost({
        clientId: "current",
        environmentId: "environment-1",
        supportedOperations: ["status", "resize"],
      }).supportedOperations,
    ).toEqual(["status", "resize"]);
  });
});

describe("PreviewAutomationStatus", () => {
  it("accepts old hosts without viewport data and exposes it from current hosts", () => {
    const base = {
      available: true,
      visible: false,
      tabId: "preview-t",
      url: "https://example.com",
      title: "Example",
      loading: false,
    };
    expect(decodeAutomationStatus(base)).toEqual(base);
    expect(
      decodeAutomationStatus({
        ...base,
        viewportSetting: { _tag: "preset", presetId: "pixel-8", width: 412, height: 915 },
        viewport: { width: 412, height: 915 },
      }).viewport,
    ).toEqual({ width: 412, height: 915 });
  });
});
