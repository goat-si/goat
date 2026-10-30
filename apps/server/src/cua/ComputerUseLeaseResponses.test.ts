import { assert, describe, it } from "@effect/vitest";

import { READ_CUT_OFF, MAY_HAVE_ACTED } from "./ComputerUseLeaseMessages.ts";
import { cutOff, offScreenAnswer, refusal } from "./ComputerUseLeaseResponses.ts";

const parsed = (line: string) => JSON.parse(line);
const cause = { _tag: "end", reason: "stopped" } as const;

describe("cut-off and off-screen answers for menu_bar_extras", () => {
  it("a cut-off list or system read changed nothing; a cut-off open may have acted", () => {
    for (const operation of ["system", "list"]) {
      const answer = parsed(cutOff(1, "menu_bar_extras", cause, { operation })).result;
      assert.include(answer.content[0].text, READ_CUT_OFF);
      assert.isUndefined(answer.structuredContent.effect);
      assert.deepInclude(answer.structuredContent.safety, { possibleCommit: false });
    }
    const opened = parsed(cutOff(1, "menu_bar_extras", cause, { operation: "open" })).result;
    assert.include(opened.content[0].text, MAY_HAVE_ACTED);
    assert.equal(opened.structuredContent.effect, "unverifiable");
  });

  it("an off-screen list answer is a read refusal; an off-screen click answer may have acted", () => {
    const list = parsed(
      offScreenAnswer(1, "tools/call", "menu_bar_extras", "other", { operation: "list" }),
    ).result;
    assert.equal(list.structuredContent.detail, "wrong_display");
    assert.deepInclude(list.structuredContent.safety, {
      possibleCommit: false,
      writeStatus: "not_applicable",
    });
    const click = parsed(
      offScreenAnswer(1, "tools/call", "menu_bar_extras", "other", { operation: "click" }),
    ).result;
    assert.equal(click.structuredContent.effect, "unverifiable");
    assert.isTrue(click.structuredContent.safety.possibleCommit);
  });
});

it("person stop is terminal and preserves uncertainty for an interrupted write", () => {
  const notSent = parsed(
    refusal(1, "tools/call", "stopped", "Do not continue this turn.", undefined, undefined, {
      tool: "click",
    }),
  ).result;
  assert.equal(notSent.structuredContent.code, "stopped_by_person");
  assert.equal(notSent.structuredContent.safety.retryClass, "never");
  const interrupted = parsed(cutOff(2, "click", cause)).result;
  assert.equal(interrupted.structuredContent.code, "stopped_by_person");
  assert.isTrue(interrupted.structuredContent.safety.possibleCommit);
  const interruptedRead = parsed(cutOff(3, "list_windows", cause)).result;
  assert.equal(interruptedRead.structuredContent.safety.retryClass, "never");
});
