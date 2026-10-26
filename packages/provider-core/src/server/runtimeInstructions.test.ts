import { assert, describe, it } from "@effect/vitest";

import { GOAT_ORCHESTRATION_INSTRUCTIONS } from "./orchestrationInstructions.ts";

describe("GOAT pull request instructions", () => {
  it("links PRs the agent creates, takes over, or pushes to, and no others", () => {
    const instructions = GOAT_ORCHESTRATION_INSTRUCTIONS;

    assert.include(instructions, "Link each PR you create, take over, or push to");
    assert.include(instructions, "goat_pull_request_link (full URL, each stack layer)");
    assert.include(instructions, "Skip PRs you only read or review");
    assert.include(instructions, "If linking fails, say so.");
    assert.notInclude(instructions, "git log -1");
    assert.notInclude(instructions, "work on");
    // Listing linked PRs as an end-of-work check found nothing to add in audited threads.
    assert.notInclude(instructions, "pull_request.list");
  });

  it("waits on a PR only with the watch, never with a poll loop", () => {
    const instructions = GOAT_ORCHESTRATION_INSTRUCTIONS;

    assert.notInclude(instructions, "Creation, pending checks, or a merge ask alone is not enough");
    assert.include(instructions, "Links and watches persist across pushes.");
    // The wake message itself carries the do-not-re-watch rule.
    assert.notInclude(instructions, "On a wake");
    assert.include(
      instructions,
      "Call goat_pull_request_watch when asked to monitor, or when your work (a merge) waits on checks or reviews",
    );
    assert.notInclude(instructions, "merge it now");
    assert.include(instructions, "Otherwise act now or hand back.");
    assert.include(instructions, "then watch and end your turn");
    assert.include(instructions, "Children never watch, even if told to");
    assert.include(
      instructions,
      "their last line: PR <full URL>, head <SHA>, checks and reviews <state>.",
    );
    assert.include(instructions, "Never poll or sleep.");
    assert.include(instructions, "call goat_pull_request_unwatch");
  });
});
