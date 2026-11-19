import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { OrchestrationV2ProviderTurnJson } from "./orchestrationV2.ts";

it("accepts older Pi turn records and an older peer stripping the optional session ref", () => {
  const { nativeThreadRef: _newField, ...oldFields } = OrchestrationV2ProviderTurnJson.fields;
  const oldSchema = Schema.Struct(oldFields);
  const readNew = Schema.decodeUnknownSync(OrchestrationV2ProviderTurnJson);
  const writeNew = Schema.encodeSync(OrchestrationV2ProviderTurnJson);
  const readOld = Schema.decodeUnknownSync(oldSchema);
  const writeOld = Schema.encodeSync(oldSchema);
  const oldTurn = {
    id: "turn",
    providerThreadId: "thread",
    nodeId: "node",
    runAttemptId: null,
    nativeTurnRef: { driver: "pi", nativeId: "entry", strength: "strong" },
    ordinal: 1,
    status: "completed",
    startedAt: null,
    completedAt: null,
  };
  const withSession = {
    ...oldTurn,
    nativeThreadRef: { driver: "pi", nativeId: "/session.jsonl", strength: "strong" },
  };
  expect(writeNew(readNew(withSession)).nativeThreadRef).toEqual(withSession.nativeThreadRef);
  expect(readNew(oldTurn).nativeThreadRef).toBeUndefined();
  const rewrittenByOld = writeOld(readOld(withSession));
  expect(readNew(rewrittenByOld).nativeThreadRef).toBeUndefined();
});
