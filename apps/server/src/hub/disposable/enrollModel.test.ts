import { expect, it } from "@effect/vitest";

import { readOperation } from "./enrollModel.ts";

const entry = (code: string) =>
  JSON.stringify({
    operationId: "a.link.1",
    kind: "enroll",
    alias: "pen-x",
    state: "failed_clean",
    error: { code, status: 409 },
  });

it("a journal code that would not fit a status step reads as a plain failure", () => {
  const expected = { operationId: "a.link.1", alias: "pen-x" };
  expect(readOperation({ code: 0, stdout: entry("child_port_busy") }, expected)).toEqual({
    kind: "failed_clean",
    code: "child_port_busy",
  });
  // HubMachineStep.outcome carries at most 40 characters; a longer code would fail every status.
  expect(readOperation({ code: 0, stdout: entry("a".repeat(41)) }, expected)).toEqual({
    kind: "failed_clean",
    code: "failed",
  });
});
