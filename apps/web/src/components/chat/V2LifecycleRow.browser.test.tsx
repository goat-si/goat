import {
  EnvironmentId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import { expect, it } from "vite-plus/test";
import { render } from "../../../test/render";
import { V2LifecycleRow } from "./V2LifecycleRow";

it("renders subagent progress without image markup or link URL tails", async () => {
  const item: OrchestrationV2TurnItem = {
    id: TurnItemId.make("item"),
    threadId: ThreadId.make("thread"),
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    title: "Research",
    startedAt: null,
    completedAt: null,
    updatedAt: DateTime.makeUnsafe(0),
    status: "running",
    type: "subagent",
    subagentId: NodeId.make("child"),
    origin: "provider_native",
    driver: ProviderDriverKind.make("codex"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    childThreadId: null,
    prompt: "Research",
    result: null,
    progress: "![screenshot](shot.png) [docs](https://example.com/wiki/T3_(protocol))",
  };
  await using screen = await render(
    <V2LifecycleRow
      item={item}
      environmentId={EnvironmentId.make("env")}
      createdAt="2026-01-01T00:00:00Z"
      timestampFormat="12-hour"
      runs={[]}
      onOpenThread={() => {}}
    />,
  );
  await expect.element(screen.getByText("screenshot docs", { exact: true })).toBeVisible();
});
