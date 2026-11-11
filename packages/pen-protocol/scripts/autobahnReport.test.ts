import { describe, expect, it } from "vite-plus/test";
import { checkAutobahnReport, REFUSED_BY_DESIGN } from "./autobahnReport.ts";

const ok = { behavior: "OK", behaviorClose: "OK" };
const expected = ["1.1.1", "1.1.2", ...REFUSED_BY_DESIGN.keys()];
const complete = () => {
  const results: Record<string, { behavior: string; behaviorClose: string }> = {};
  for (const id of expected)
    results[id] = REFUSED_BY_DESIGN.has(id) ? { behavior: "FAILED", behaviorClose: "OK" } : ok;
  return results;
};
const closes = (code: number) => (id: string) => (REFUSED_BY_DESIGN.has(id) ? code : undefined);

describe("Autobahn report acceptance (design 10.2 exit criterion)", () => {
  it("passes when every expected case is reported, passing, and the six refusals end with the client's 1009", () => {
    expect(checkAutobahnReport(expected, complete(), closes(1009))).toEqual([]);
  });

  it("fails when an expected case is missing even if an unexpected passing case keeps the count", () => {
    const results = complete();
    delete results["1.1.2"];
    results["1.1.99"] = ok;
    expect(checkAutobahnReport(expected, results, closes(1009))).toEqual([
      "1.1.2 was expected but not reported",
      "1.1.99 was reported but not expected",
    ]);
  });

  it("fails when the server did not run one of the six refused-by-design cases", () => {
    const withoutOne = expected.filter((id) => id !== "9.4.3");
    const results = complete();
    delete results["9.4.3"];
    expect(checkAutobahnReport(withoutOne, results, closes(1009))).toEqual([
      "9.4.3 must run and end with the client's 1009",
    ]);
  });

  it("fails when a refused-by-design case ends another way, or another case fails", () => {
    const results = complete();
    results["1.1.1"] = { behavior: "FAILED", behaviorClose: "OK" };
    expect(checkAutobahnReport(expected, results, closes(1000))).toEqual([
      "1.1.1 FAILED/OK",
      ...[...REFUSED_BY_DESIGN.keys()].map(
        (id) => id + " expected a 1009 close from the client, saw 1000",
      ),
    ]);
  });
});
