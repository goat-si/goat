import type { JsonObject } from "../agent-surface/eval/core.ts";
import type { OracleInput, OracleResult } from "./core.ts";

const failedRead = (read: JsonObject) =>
  read["error"] !== undefined || read["witnessError"] !== undefined;

// After "=", Calculator can expose the expression and the product as separate texts.
const calculatorHasProduct = (read: JsonObject, target: string): boolean | undefined => {
  if (failedRead(read) || read["running"] === false) return undefined;
  const texts = [read["display"], ...(Array.isArray(read["texts"]) ? read["texts"] : [])].filter(
    (text): text is string => typeof text === "string" && text.trim() !== "",
  );
  return texts.length
    ? texts.some((text) => text.trim().replace(/[,\s]/gu, "") === target)
    : undefined;
};

export function calculatorMultiply({ task, baseline, samples, final }: OracleInput): OracleResult {
  const target = String(task.expect["result"]);
  if (failedRead(final))
    return { actual: "unverified", notes: ["final Calculator read failed"], violations: [] };
  if (final["running"] === false)
    return { actual: "failed", notes: ["Calculator was closed"], violations: [] };
  const display = final["display"];
  if (typeof display !== "string" || !display.trim())
    return {
      actual: "unverified",
      notes: ["final Calculator display was unreadable"],
      violations: [],
    };
  if (display.trim() !== "0")
    return { actual: "failed", notes: ["Calculator was not reset to 0"], violations: [] };

  // A product left over from an earlier run only counts after a readable non-product state.
  let sawOther = calculatorHasProduct(baseline, target) === false;
  for (const { value } of samples) {
    const product = calculatorHasProduct(value, target);
    if (product === false) sawOther = true;
    if (product && sawOther) return { actual: "done", notes: [], violations: [] };
  }
  return {
    actual: "unverified",
    notes: ["the observer did not see a fresh product on Calculator's display"],
    violations: [],
  };
}
