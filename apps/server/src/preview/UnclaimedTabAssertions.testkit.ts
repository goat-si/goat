import { PreviewTabId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";
import type * as Broker from "../mcp/PreviewAutomationBroker.ts";
import * as Manager from "./Manager.ts";

type Scope = typeof import("./ServerBrowser.test.ts").scope;
export const assertForeignEvaluateRejected = (
  broker: Broker.PreviewAutomationBroker["Service"],
  scope: Scope,
  ownedTabId: PreviewTabId,
) =>
  Effect.gen(function* () {
    const foreignScope = { ...scope, thread: { ...scope.thread, providerSessionId: "agent-b" } };
    const foreignEvaluate = yield* broker
      .invoke<void>({
        scope: foreignScope,
        tabId: ownedTabId,
        operation: "evaluate",
        input: { expression: "read()" },
      })
      .pipe(Effect.flip);
    expect(foreignEvaluate).toMatchObject({
      _tag: "PreviewAutomationControlInterruptedError",
      reason: "agentMismatch",
    });
  });

export const assertUnclaimedClose = (
  broker: Broker.PreviewAutomationBroker["Service"],
  scope: Scope,
  ownedTabId: PreviewTabId,
) =>
  Effect.gen(function* () {
    const manager = yield* Manager.PreviewManager;
    const foreignScope = { ...scope, thread: { ...scope.thread, providerSessionId: "agent-b" } };
    const foreign = yield* broker
      .invoke<void>({ scope: foreignScope, tabId: ownedTabId, operation: "close", input: {} })
      .pipe(Effect.flip);
    expect(foreign).toMatchObject({
      _tag: "PreviewAutomationControlInterruptedError",
      reason: "agentMismatch",
    });
    const tab = yield* manager.open({ threadId: scope.thread.threadId, runtime: "server" });
    const result = yield* broker
      .invoke<void>({ scope, tabId: PreviewTabId.make(tab.tabId), operation: "close", input: {} })
      .pipe(Effect.flip);
    expect(result).toMatchObject({
      _tag: "PreviewAutomationExecutionError",
      reason: "This tab has no agent owner. Ask the user to close it in the browser panel.",
    });
    expect((yield* manager.list({ threadId: scope.thread.threadId })).sessions).toContainEqual(
      expect.objectContaining({ tabId: tab.tabId }),
    );
  });
