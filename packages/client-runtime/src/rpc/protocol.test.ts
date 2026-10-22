import { expect, it } from "@effect/vitest";
import { WS_METHODS } from "@goat/contracts";
import { WsRpcGroup } from "./protocol.ts";

it("activates the 15 core, four administration and one import route", () => {
  const methods = [...WsRpcGroup.requests.keys()].filter((tag) => tag.startsWith("memory."));
  expect(methods).toHaveLength(20);
  expect(methods).toContain(WS_METHODS.memoryOwnerSourceReadPolicyGet);
  expect(methods).toContain(WS_METHODS.memoryOwnerSourceReadPolicyUpdate);
  expect(methods).toContain(WS_METHODS.memoryResetReportAttempts);
  expect(methods).toContain(WS_METHODS.memoryHubReconcile);
  expect(methods).toContain(WS_METHODS.memoryChanges);
  expect(methods).toContain(WS_METHODS.memoryImportProvider);
});

it("installs every hub node RPC for web, desktop and mobile clients", () => {
  expect([...WsRpcGroup.requests.keys()].filter((tag) => tag.startsWith("hub.nodes."))).toEqual([
    "hub.nodes.list",
    "hub.nodes.subscribe",
    "hub.nodes.add",
    "hub.nodes.remove",
    "hub.nodes.check",
    "hub.nodes.import",
    "hub.nodes.dismissNotice",
  ]);
});
