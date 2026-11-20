import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServerConfig from "../config.ts";
import { resolveAntigravityInstanceDirectories } from "../provider/antigravityAuthSupport.ts";
import { describeAntigravitySubagentLaunches } from "../provider/acp/AntigravityChildWork.ts";
import {
  CHILD,
  invokeStep,
  LAUNCH,
  makeProfile,
  ROOT,
} from "../provider/acp/AntigravityChildWork.testkit.ts";
import * as NativeChildWorkQuery from "./NativeChildWorkQuery.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const childThreadId = ThreadId.make("child-original-session");

it.layer(
  Layer.mergeAll(
    NodeServices.layer,
    NodeCrypto.layer,
    ServerConfig.layerTest(process.cwd(), { prefix: "native-child-original-" }).pipe(
      Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    ),
  ),
)("native child origin", (it) => {
  it.effect.each(["origin", "missing"] as const)(
    "child history uses its original session when the launch attempt is %s",
    (mode) =>
      Effect.gen(function* () {
        const instanceId = ProviderInstanceId.make(`antigravity-${mode}`);
        const { stateDir } = yield* ServerConfig.ServerConfig;
        const { profile } = yield* resolveAntigravityInstanceDirectories(stateDir, instanceId);
        yield* makeProfile({
          profile,
          steps: (logUri) => [
            [
              2,
              127,
              invokeStep({ callId: "x", launches: [LAUNCH], children: [{ id: CHILD, logUri }] }),
            ],
          ],
        });
        const launch = describeAntigravitySubagentLaunches([LAUNCH]);
        const records = {
          thread: {
            id: childThreadId,
            creationSource: "provider",
            lineage: { parentThreadId: "thread-parent", relationshipToParent: "subagent" },
            forkedFrom: { type: "node", nodeId: "subagent-new" },
          },
          subagents: [
            {
              id: "subagent-new",
              childThreadId,
              driver: "antigravity",
              origin: "provider_native",
              providerInstanceId: instanceId,
              runId: "run-root",
              nativeTaskRef: { nativeId: "35bea692fa95447fbdae6333fec5515f" },
              ...launch,
            },
          ],
          runs: [
            { id: "run-root", providerThreadId: "provider-root", activeAttemptId: "attempt-new" },
          ],
          attempts: [
            { id: "attempt-original", runId: "run-root", nativeThreadId: ROOT, attemptOrdinal: 1 },
            {
              id: "attempt-new",
              runId: "run-root",
              nativeThreadId: "new-session",
              attemptOrdinal: 2,
            },
          ],
          nodes: [{ id: "subagent-new", providerTurnId: "original-turn" }],
          providerTurns: [
            {
              id: "original-turn",
              runAttemptId: mode === "missing" ? "missing-attempt" : "attempt-original",
            },
          ],
          providerThreads: [
            {
              id: "provider-root",
              providerInstanceId: instanceId,
              nativeThreadRef: { nativeId: mode === "missing" ? ROOT : "new-session" },
            },
          ],
        };
        const queryLayer = NativeChildWorkQuery.layer.pipe(
          Layer.provide(
            Layer.mock(ThreadManagement.ThreadManagementService)({
              getThreadRecords: () => Effect.succeed(records as never),
            }),
          ),
        );
        const children = yield* Effect.gen(function* () {
          return (yield* (yield* NativeChildWorkQuery.NativeChildWorkQuery).getNativeChildWork({
            threadId: childThreadId,
          })).children;
        }).pipe(Effect.provide(queryLayer));
        expect(children.map((child) => child.conversationId)).toEqual([CHILD]);
      }),
  );
});
