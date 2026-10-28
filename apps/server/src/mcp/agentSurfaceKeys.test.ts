import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  GoatGoalApplyInput,
  OrchestratorMcpFailure,
  ProviderInstanceId,
  ThreadId,
} from "@goat/contracts";
import type { AgentSurfaceEntry } from "@goat/contracts/agentSurface";
import type { AgentSurfaceResult } from "@goat/contracts/agentSurface/envelope";
import { deduplicatesClientRequestId, isKeyedWrite } from "@goat/contracts/agentSurface/resolve";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer, Tool } from "effect/ai";

import { testSpec } from "../fleet/goals/goalTestkit.ts";
import * as GoalService from "../fleet/goals/GoalService.ts";
import {
  catalog,
  client,
  dependencies,
  entries,
  toolkits as standardToolkits,
} from "./agentSurface.testkit.ts";
import { McpInvocationContext, type McpInvocationScope } from "./McpInvocationContext.ts";
import { ScreenToolkit } from "./toolkits/screen/tools.ts";

const toolkits = { ...standardToolkits, screen: ScreenToolkit };

type Entry = (typeof entries)[number];
const reasonOf = (entry: AgentSurfaceEntry) => entry.idempotencyReason;
const idempotencyOf = (entry: AgentSurfaceEntry) => entry.idempotency;
const keyIgnoredWithOf = (entry: AgentSurfaceEntry) => entry.keyIgnoredWith;
const inputProperties = (entry: Entry) => {
  const tools: Record<string, Tool.Any> = toolkits[entry.schemaRefs.toolkit].tools;
  const tool = tools[entry.schemaRefs.tool];
  expect(tool, entry.path).toBeDefined();
  return (Tool.getJsonSchema(tool!) as { readonly properties?: object }).properties ?? {};
};

it("takes clientRequestId on every write the registry says GOAT or its own store deduplicates", () => {
  const keyed = entries.filter((entry) => deduplicatesClientRequestId(entry));
  expect(keyed.length).toBeGreaterThan(0);
  for (const entry of keyed)
    expect(inputProperties(entry), entry.path).toHaveProperty("clientRequestId");
});

it("records why a write that takes its own clientRequestId keeps that key out of GOAT's store", () => {
  for (const entry of entries) {
    if (entry.effect === "read" || isKeyedWrite(entry)) continue;
    if ("clientRequestId" in inputProperties(entry))
      expect(reasonOf(entry), entry.path).toBeTruthy();
  }
});

it("declares the writes whose own store deduplicates clientRequestId, with the arguments that bypass it", () => {
  const domain = entries.filter((entry) => idempotencyOf(entry) === "domain");
  expect(domain.map((entry) => entry.path).sort()).toEqual([
    "channel.ingest",
    "goal.apply",
    "handoff.create",
    "origin.report",
    "review_findings.record",
    "task.create",
    "thread.create_many",
    "thread.interrupt",
    "thread.retry",
    "thread.send",
    "thread.update",
  ]);
  for (const entry of domain) {
    const properties = inputProperties(entry);
    for (const name of keyIgnoredWithOf(entry) ?? [])
      expect(properties, entry.path).toHaveProperty(name);
    // A routed call is keyed by the destination's dispatch session, which renews.
    if (entry.hostRoutable) expect(keyIgnoredWithOf(entry), entry.path).toContain("host");
  }
});

const failingGoals = Layer.mock(GoalService.GoalService)({
  apply: () =>
    Effect.fail(new OrchestratorMcpFailure({ code: "orchestration_error", message: "fixture" })),
});
const registeredWithFailingGoals = catalog.pipe(
  Layer.provide(Layer.mergeAll(dependencies, failingGoals)),
  Layer.provideMerge(McpServer.McpServer.layer),
);
const threadCaller: McpInvocationScope = {
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: "provider:thread",
  thread: {
    threadId: ThreadId.make("thread"),
    providerSessionId: "provider:thread",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
};
const create = Schema.encodeSync(Schema.toCodecJson(GoatGoalApplyInput))({
  title: "Ship",
  spec: testSpec(),
}) as object;

it.effect(
  "lets goat_call retry a failed goal create only when its key deduplicates the create",
  () =>
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const retryable = (args: object) =>
        server.callTool({ name: "goat_call", arguments: { path: "goal.apply", args } }).pipe(
          Effect.provideService(McpInvocationContext, threadCaller),
          Effect.provideService(McpSchema.McpServerClient, client),
          Effect.map((result) => {
            const envelope = result.structuredContent as AgentSurfaceResult;
            expect(envelope).toMatchObject({ status: "error", error: { code: "internal" } });
            return envelope.status === "error" && envelope.error.retryable;
          }),
        );
      expect(yield* retryable({ ...create, clientRequestId: "k" })).toBe(true);
      expect(yield* retryable({ ...create, id: null, clientRequestId: "k" })).toBe(true);
      // An update with id ignores the key, so a repeat can overwrite a later change.
      expect(yield* retryable({ ...create, id: "goal-1", clientRequestId: "k" })).toBe(false);
      expect(yield* retryable(create)).toBe(false);
    }).pipe(Effect.provide(registeredWithFailingGoals)),
);
