import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { OrchestrationV2ThreadCapabilities as Current } from "./providerCapabilityParts.ts";
import { OrchestrationV2ThreadCapabilities as Base } from "./test-snapshots/ThreadCapabilities.base.ts";

const decodeBase = Schema.decodeSync(Base);
const decodeCurrent = Schema.decodeSync(Current);

it("old and current capability schemas decode each other's wire payloads", () => {
  const oldValue = {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: false,
    canRollbackThread: true,
    canForkThread: true,
    canForkFromTurn: true,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: true,
  };
  const newer = { ...oldValue, canForkWhileSourceRunning: true };
  assert.deepEqual(decodeBase(newer), oldValue);
  assert.deepEqual(decodeCurrent(oldValue), oldValue);
  assert.deepEqual(decodeCurrent(newer), newer);
});
