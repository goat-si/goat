import { expect, it } from "@effect/vitest";
import { type OrchestrationV2ThreadShell, type RemoteRelaySend, ThreadId } from "@goat/contracts";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import migration from "../persistence/Migrations/071_RemoteReports.ts";
import dispatchMigration from "../persistence/Migrations/072_RemoteDispatches.ts";
import threadRunResultsMigration from "../persistence/Migrations/075_ThreadRunResults.ts";
import relayMigration from "../persistence/Migrations/076_RemoteReportRelay.ts";
import observedChecksMigration from "../persistence/Migrations/093_ThreadRunObservedChecks.ts";
import inboxRunIdMigration from "../persistence/Migrations/103_RemoteReportInboxRunId.ts";
import fencesMigration from "../persistence/Migrations/107_RemoteReportFences.ts";
import * as RemoteReportService from "./RemoteReportService.ts";

const binding = (correlationId: string) => ({
  correlationId,
  originLabel: "origin laptop",
  originThreadId: ThreadId.make("origin-thread"),
  // Relays never read reports, so any well-formed key hash does.
  readKeyHash: "0".repeat(64),
  relaySend: true,
});
const send: RemoteRelaySend = { host: "sibling", threadId: ThreadId.make("target"), message: "hi" };
const asked: RemoteRelaySend = { ...send, capabilities: ["browser"] };

it.effect("a relay asking for turn capabilities goes only to an origin that delivers them", () =>
  Effect.gen(function* () {
    for (const step of [migration, dispatchMigration, threadRunResultsMigration]) yield* step;
    for (const step of [observedChecksMigration, relayMigration, inboxRunIdMigration]) yield* step;
    yield* fencesMigration;
    const orchestrator = Layer.mock(Orchestrator.OrchestratorV2)({
      getThreadShell: (threadId) =>
        Effect.succeed({
          id: threadId,
          activeRunId: null,
          latestRunId: null,
          deletedAt: null,
        } as unknown as OrchestrationV2ThreadShell),
    });
    const service = Context.get(
      yield* Layer.build(RemoteReportService.layer.pipe(Layer.provide(orchestrator))),
      RemoteReportService.RemoteReportService,
    );
    // An origin older than turn capabilities declares relaySend alone and would drop them.
    const older = ThreadId.make("launched-by-older-origin");
    yield* service.bind(older, binding("older"));
    const refused = yield* service.relay(older, asked).pipe(Effect.flip);
    expect(refused.reason).toBe("relay_unsupported");
    expect(yield* service.relay(older, send)).toEqual({ sequence: 1 });
    const aware = ThreadId.make("launched-by-current-origin");
    yield* service.bind(aware, { ...binding("aware"), relayCapabilities: true });
    expect(yield* service.relay(aware, asked)).toEqual({ sequence: 1 });
  }).pipe(Effect.scoped, Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
