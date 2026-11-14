import { expect, it } from "@effect/vitest";

import { enrollMessage, readOperation } from "./enrollModel.ts";

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

it("a failed operation that may have left the Child enrolled reads as residual", () => {
  const expected = { operationId: "a.link.1", alias: "pen-x" };
  const stdout = JSON.stringify({
    operationId: "a.link.1",
    kind: "enroll",
    alias: "pen-x",
    state: "failed_clean",
    error: { code: "child_port_busy", status: 409 },
    childResidual: true,
  });
  expect(readOperation({ code: 0, stdout }, expected)).toEqual({
    kind: "unsettled",
    state: "residual",
  });
});

it("every text about the key's path fits the wire's 500 characters, and only the user's own folder gets chmod", () => {
  const name = "m".repeat(63);
  const waiting = (outcome: string, keyDir: string) =>
    enrollMessage("attaching", name, {
      reach: { outcome: "ok", at: "" },
      link: { attempt: 0, intentAtMs: 0, outcome },
      keyDir,
    })?.message ?? "";
  const codes = ["key_dir_unsafe", "key_dir_shared", "key_dir_foreign", "key_symlink_foreign"];
  for (const outcome of codes)
    for (const length of [10, 140, 240, 1000]) {
      const message = waiting(outcome, "/" + "a".repeat(length - 1));
      expect(message.length).toBeLessThanOrEqual(500);
      expect(message.includes("chmod")).toBe(outcome === "key_dir_unsafe" && length <= 140);
    }
  expect(waiting("key_dir_unreadable", "/x")).not.toContain("chmod");
  for (const stop of ["identity_file_directory", "identity_file_ancestor", "link_not_started"]) {
    const message = enrollMessage("paused", name, { stop })?.message ?? "";
    expect(message.length).toBeLessThanOrEqual(500);
    expect(message).not.toContain("chmod");
  }
});
