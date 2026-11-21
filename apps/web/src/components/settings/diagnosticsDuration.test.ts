import { expect, it } from "vite-plus/test";
import { formatDuration } from "./diagnosticsDuration";

it("switches to seconds when rounded milliseconds reach one thousand", () => {
  expect(formatDuration(999.49)).toBe("999 ms");
  expect(formatDuration(999.5)).toBe("1.00 s");
  expect(formatDuration(1_000)).toBe("1.00 s");
});
