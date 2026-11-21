import { expect, it } from "vite-plus/test";
import { formatCpuTime, formatCpuTimeMs } from "./cpuTime";

it("promotes rounded CPU time at minute and hour boundaries", () => {
  expect(formatCpuTime(59.94)).toBe("59.9s");
  expect(formatCpuTime(59.96)).toBe("1.00m");
  expect(formatCpuTime(3_599)).toBe("1.00h");
  expect(formatCpuTimeMs(59_960)).toBe("1.00m");
  expect(formatCpuTimeMs(3_599_000)).toBe("1.00h");
});
