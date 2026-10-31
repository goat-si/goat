import { assert, describe, it } from "@effect/vitest";

import { READ_CUT_OFF, MAY_HAVE_ACTED } from "./ComputerUseLeaseMessages.ts";
import { replaceWithTerminal } from "./ComputerUseTerminal.ts";
import { cutOff, offScreenAnswer, refusal } from "./ComputerUseLeaseResponses.ts";

const parsed = (line: string) => JSON.parse(line);
const cause = { _tag: "end", reason: "stopped" } as const;

describe("cut-off and off-screen answers for menu_bar_extras", () => {
  it("a cut-off list or system read changed nothing; a cut-off open may have acted", () => {
    for (const operation of ["system", "list"]) {
      const answer = parsed(
        cutOff(
          1,
          "menu_bar_extras",
          cause,
          { operation },
          { reason: undefined, possibleCommit: false },
        ),
      ).result;
      assert.include(answer.content[0].text, READ_CUT_OFF);
      assert.isUndefined(answer.structuredContent.effect);
      assert.deepInclude(answer.structuredContent.safety, { possibleCommit: false });
    }
    const opened = parsed(
      cutOff(
        1,
        "menu_bar_extras",
        cause,
        { operation: "open" },
        { reason: undefined, possibleCommit: false },
      ),
    ).result;
    assert.include(opened.content[0].text, MAY_HAVE_ACTED);
    assert.equal(opened.structuredContent.effect, "unverifiable");
  });

  it("an off-screen list answer is a read refusal; an off-screen click answer may have acted", () => {
    const list = parsed(
      offScreenAnswer(
        1,
        "tools/call",
        "menu_bar_extras",
        "other",
        { operation: "list" },
        replaceWithTerminal("none"),
      ),
    ).result;
    assert.equal(list.structuredContent.detail, "wrong_display");
    assert.deepInclude(list.structuredContent.safety, {
      possibleCommit: false,
      writeStatus: "not_applicable",
    });
    const click = parsed(
      offScreenAnswer(
        1,
        "tools/call",
        "menu_bar_extras",
        "other",
        { operation: "click" },
        replaceWithTerminal("none"),
      ),
    ).result;
    assert.equal(click.structuredContent.effect, "unverifiable");
    assert.isTrue(click.structuredContent.safety.possibleCommit);
  });
});

it("person stop is terminal and preserves uncertainty for an interrupted write", () => {
  const notSent = parsed(
    refusal(
      { possibleCommit: false },
      1,
      "tools/call",
      "stopped",
      "Do not continue this turn.",
      undefined,
      undefined,
      {
        tool: "click",
      },
    ),
  ).result;
  assert.equal(notSent.structuredContent.code, "stopped_by_person");
  assert.equal(notSent.structuredContent.safety.retryClass, "never");
  const interrupted = parsed(
    cutOff(2, "click", cause, undefined, { reason: undefined, possibleCommit: false }),
  ).result;
  assert.equal(interrupted.structuredContent.code, "stopped_by_person");
  assert.isTrue(interrupted.structuredContent.safety.possibleCommit);
  const interruptedRead = parsed(
    cutOff(3, "list_windows", cause, undefined, { reason: undefined, possibleCommit: false }),
  ).result;
  assert.equal(interruptedRead.structuredContent.safety.retryClass, "never");
  const stoppedAll = parsed(
    cutOff(4, "list_windows", { _tag: "end", reason: "stopped_all" }, undefined, {
      reason: undefined,
      possibleCommit: false,
    }),
  ).result;
  assert.equal(stoppedAll.structuredContent.code, "stopped_by_person");
  assert.equal(stoppedAll.structuredContent.safety.retryClass, "never");
});

it("screen lock never retries interrupted reads or writes", () => {
  for (const tool of ["list_windows", "click"]) {
    const answer = parsed(
      cutOff(5, tool, { _tag: "pause", reason: "screen_locked" }, undefined, {
        reason: undefined,
        possibleCommit: false,
      }),
    ).result;
    assert.equal(answer.structuredContent.code, "screen_locked");
    assert.equal(answer.structuredContent.safety.retryClass, "never");
  }
});

it("a terminal refusal preserves an earlier possible input and person Stop", () => {
  const answer = parsed(
    refusal(
      { reason: "stopped_by_person", possibleCommit: true },
      1,
      "tools/call",
      "screen_locked",
      "locked",
    ),
  ).result;
  assert.equal(answer.structuredContent.code, "stopped_by_person");
  assert.isTrue(answer.structuredContent.safety.possibleCommit);
  assert.equal(answer.structuredContent.safety.retryClass, "never");
});

it("an off-screen replacement preserves terminal evidence from its prior answer", () => {
  const answer = parsed(
    offScreenAnswer(
      7,
      "tools/call",
      "list_apps",
      "unknown",
      undefined,
      replaceWithTerminal("stopped_by_person", true),
    ),
  ).result;
  assert.equal(answer.structuredContent.code, "stopped_by_person");
  assert.isTrue(answer.structuredContent.safety.possibleCommit);
  assert.equal(answer.structuredContent.safety.retryClass, "never");
});

it("an off-screen read retains input evidence even before a terminal reason arrives", () => {
  const answer = parsed(
    offScreenAnswer(8, "tools/call", "list_apps", "unknown", undefined, replaceWithTerminal(true)),
  ).result;
  assert.isTrue(answer.structuredContent.safety.possibleCommit);
});
