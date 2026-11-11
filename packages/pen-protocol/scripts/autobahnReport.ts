// The Autobahn report check, apart from the socket plumbing so it can be tested: every expected case reported and
// passing, nothing unexpected, and the six cases design 10.2 refuses ending with the client's 1009.

/** Messages of more than 1,024 fragments are refused by design 10.2 with 1009. */
export const REFUSED_BY_DESIGN: ReadonlyMap<string, number> = new Map([
  ["9.3.1", 1009],
  ["9.3.2", 1009],
  ["9.3.3", 1009],
  ["9.4.1", 1009],
  ["9.4.2", 1009],
  ["9.4.3", 1009],
]);

const PASSING = new Set(["OK", "NON-STRICT", "INFORMATIONAL"]);

export interface CaseResult {
  readonly behavior: string;
  readonly behaviorClose: string;
}

/**
 * Problems with a report, empty when it passes.
 * @param expectedIds the case ids the server announced (getCaseInfo), independent of the report
 * @param clientClose the close code the report records from the client for a case
 */
export function checkAutobahnReport(
  expectedIds: ReadonlyArray<string>,
  results: Readonly<Record<string, CaseResult>>,
  clientClose: (id: string) => number | undefined,
): Array<string> {
  const problems: Array<string> = [];
  const expected = new Set(expectedIds);
  for (const id of REFUSED_BY_DESIGN.keys()) {
    if (!expected.has(id) || results[id] === undefined)
      problems.push(id + " must run and end with the client's 1009");
  }
  for (const id of expected) {
    if (results[id] === undefined && !REFUSED_BY_DESIGN.has(id))
      problems.push(id + " was expected but not reported");
  }
  for (const id of Object.keys(results)) {
    if (!expected.has(id)) problems.push(id + " was reported but not expected");
  }
  for (const [id, result] of Object.entries(results)) {
    if (!expected.has(id)) continue;
    const refusal = REFUSED_BY_DESIGN.get(id);
    if (refusal !== undefined) {
      const code = clientClose(id);
      if (code !== refusal)
        problems.push(id + " expected a " + refusal + " close from the client, saw " + code);
    } else if (!PASSING.has(result.behavior) || !PASSING.has(result.behaviorClose)) {
      problems.push(id + " " + result.behavior + "/" + result.behaviorClose);
    }
  }
  return problems;
}
