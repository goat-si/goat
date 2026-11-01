import { assert, describe, it } from "@effect/vitest";

import * as CodexSubagents from "./codexSubagents.ts";

const providerThread = { id: "provider-thread" };
interface Turn {
  readonly nativeTurnId: string;
  readonly providerThread: { readonly id: string };
  readonly subagent: Subagent | null;
}
interface Subagent {
  parentContext: Turn;
  workLineage: ReadonlyArray<string>;
}

// Subagents message each other across threads, so a move under a new parent turn could close a
// loop in the parent chain; every walk up would then spin forever and block Stop (#1643).
describe("Codex subagent parent chains", () => {
  it("never let a turn-start move close a loop that an earlier send_input opened", () => {
    // A person's turn U on one thread gave subagent B work; B then sends input to subagent A.
    const root: Turn = { nativeTurnId: "root", providerThread, subagent: null };
    const a: Subagent = { parentContext: root, workLineage: ["root"] };
    const u: Turn = { nativeTurnId: "u", providerThread, subagent: null };
    const b: Subagent = { parentContext: u, workLineage: ["u"] };
    const turnOfB: Turn = { nativeTurnId: "b-turn", providerThread, subagent: b };
    CodexSubagents.assign(
      new Map([["a", a]]),
      { tool: "sendInput", receiverThreadIds: ["a"] },
      turnOfB,
    );
    assert.strictEqual(a.parentContext, turnOfB);
    // A now runs a turn; B's next turn starting while it is current must not move B under A.
    const turnOfA: Turn = { nativeTurnId: "a-turn", providerThread, subagent: a };
    assert.isFalse(CodexSubagents.reparent(b, turnOfA));
    assert.strictEqual(b.parentContext, u);
    assert.deepEqual(CodexSubagents.lineage(turnOfA), ["a-turn", "b-turn", "u"]);
  });

  it("stops a walk at a turn it has already seen", () => {
    const loop: {
      nativeTurnId: string;
      providerThread: { id: string };
      subagent: Subagent | null;
    } = {
      nativeTurnId: "x",
      providerThread,
      subagent: null,
    };
    const s: Subagent = { parentContext: loop, workLineage: [] };
    loop.subagent = s;
    assert.deepEqual(CodexSubagents.lineage(loop), ["x"]);
    assert.isFalse(CodexSubagents.stoppedLineage([loop], new Set(["y"])));
  });
});
