import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ComputerUseLeaseThreadUpdate,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServer, HttpServerRequest } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  prepareThreadAttachment,
  threadAttachmentLayer,
} from "./ComputerUseAttachment.thread.testkit.ts";
import * as LeaseRoute from "./ComputerUseLeaseRoute.ts";
import * as ComputerUseLeases from "./ComputerUseLeases.ts";
import { grant, run } from "./ComputerUseLeases.projection.testkit.ts";

const decode = Schema.decodeSync(Schema.fromJsonString(ComputerUseLeaseThreadUpdate));

// Reuse the real attachment/lease assembly; only a requested admission-read failure is injected.
export const threadRouteFixture = Effect.fn("ThreadLeaseRouteTest.fixture")(function* () {
  const context = yield* Layer.build(threadAttachmentLayer);
  return yield* Effect.gen(function* () {
    yield* runMigrations();
    const threadId = ThreadId.make("thread:settings-recovery");
    yield* run(threadId, "run:settings-recovery", 0, "running");
    const settings = yield* ServerSettings.ServerSettingsService;
    const leases = yield* ComputerUseLeases.ComputerUseLeases;
    const registry = yield* McpSessionRegistry.__testing.make().pipe(
      Effect.provideService(HttpServer.HttpServer, {
        address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43123),
        serve: () => Effect.void,
      }),
      Effect.provideService(ServerEnvironment.ServerEnvironment, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make("environment:test")),
        getDescriptor: Effect.die("unused"),
      }),
      Effect.provide(NodeServices.layer),
    );
    const credential = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    const failRead = yield* Ref.make(false);
    const handler = yield* HttpRouter.toHttpEffect(LeaseRoute.layer);
    const open = Effect.fn("ThreadLeaseRouteTest.open")(function* () {
      const response = yield* handler.pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(
            new Request(`http://goat.test/api/computer-use/lease?thread=${threadId}`, {
              headers: { authorization: credential.config.authorizationHeader },
            }),
          ),
        ),
        Effect.provideService(McpSessionRegistry.McpSessionRegistry, registry),
        Effect.provideService(ComputerUseLeases.ComputerUseLeases, {
          ...leases,
          controlState: (owner, id) =>
            Ref.get(failRead).pipe(
              Effect.flatMap((fail) =>
                fail
                  ? Effect.fail(
                      new ComputerUseLeases.ComputerUseLeaseError({
                        cause: new Error("fixture read failure"),
                      }),
                    )
                  : leases.controlState(owner, id),
              ),
            ),
        }),
      );
      if (response.status !== 200 || response.body._tag !== "Stream")
        return yield* Effect.die("expected lease stream");
      const updates = yield* response.body.stream.pipe(
        Stream.orDie,
        Stream.decodeText,
        Stream.splitLines,
        Stream.map((line) => decode(line)),
        Stream.toQueue({ capacity: "unbounded" }),
      );
      return {
        stream: Stream.fromQueue(updates),
        next: Queue.take(updates).pipe(Effect.catchTags({ Done: () => Effect.undefined })),
      };
    }, Effect.provideContext(context));
    let approvals = 0;
    const attach = Effect.fn("ThreadLeaseRouteTest.attach")(function* () {
      yield* grant(threadId, `handoff:recovery:${approvals++}`, ["fixture.calculator"]);
      return yield* prepareThreadAttachment(credential.config);
    }, Effect.provideContext(context));
    return {
      threadId,
      leases,
      registry,
      attach,
      open,
      enable: settings.updateSettings({ enableCua: true }),
      disable: settings.updateSettings({ enableCua: false }).pipe(Effect.andThen(leases.disable)),
      failControlRead: Ref.set(failRead, true).pipe(Effect.andThen(leases.changed)),
      restoreControlRead: Ref.set(failRead, false),
    };
  }).pipe(Effect.provideContext(context));
});
