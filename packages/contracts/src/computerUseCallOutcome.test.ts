import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { ComputerUseLeaseReport } from "./cua.ts";

const decode = Schema.decodeUnknownSync(ComputerUseLeaseReport);
it("decodes a call outcome and existing lease reports", () => {
  assert.deepEqual(
    decode({
      type: "callOutcome",
      controlId: "control:1",
      tool: "click",
      app: { id: "fixture.app", name: "Fixture" },
      verdict: "sent",
    }),
    {
      type: "callOutcome",
      controlId: "control:1",
      tool: "click",
      app: { id: "fixture.app", name: "Fixture" },
      verdict: "sent",
    },
  );
  assert.deepEqual(decode({ controlId: "control:1", pid: 10, windowId: 20 }), {
    controlId: "control:1",
    pid: 10,
    windowId: 20,
  });
});
