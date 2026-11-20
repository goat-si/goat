import { expect, it } from "vite-plus/test";
import { formatSampleInterval } from "./ResourceTelemetryDiagnostics.logic";

it("distinguishes on-demand sampling from an active interval", () => {
  expect(formatSampleInterval(0)).toBe("on demand");
  expect(formatSampleInterval(-1)).toBe("on demand");
  expect(formatSampleInterval(250)).toBe("250 ms");
  expect(formatSampleInterval(1_000)).toBe("1 second");
});
