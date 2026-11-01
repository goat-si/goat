import * as NodeServices from "@effect/platform-node/NodeServices";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import { CommandId } from "@goat/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as RuntimeLayer from "./runtimeLayer.ts";

const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "goat-runtime-layer-receipt-store-",
});

const layerPlatformTest = Layer.merge(
  NodeServices.layer,
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("unused title link"),
  }),
);

// The smallest honest stack: the real SQL-backed stores and config, mocks only where the
// probe never reaches.
const layerTest = RuntimeLayer.layer.pipe(
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(McpProviderSessions.layer),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(
    CheckpointStore.layer.pipe(
      Layer.provide(
        VcsDriverRegistry.layer.pipe(
          Layer.provide(VcsProcess.layer),
          Layer.provide(layerServerConfig),
          Layer.provide(layerPlatformTest),
        ),
      ),
    ),
  ),
  Layer.provide(layerServerConfig),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(
    Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
      getInstance: () => Effect.succeed(undefined),
      listInstances: Effect.succeed([]),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(
    Layer.mock(GitWorkflow.GitWorkflowService)({
      pruneWorktrees: () => Effect.void,
      createWorktree: () => Effect.succeed({} as never),
    }),
  ),
  Layer.provide(
    Layer.mock(ProjectService.ProjectService)({
      getById: () => Effect.succeed(Option.none()),
    }),
  ),
  Layer.provide(layerPlatformTest),
);

it.effect(
  "the exported runtime layer exposes the command receipt store to per-call resolution",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const buildScope = yield* Effect.scope;
        const context = yield* Layer.buildWithScope(layerTest, buildScope);
        // MCP services resolve the store per call from the ambient server context; a
        // provide-only wiring answers None here and silently disables commit certainty.
        const found = yield* Effect.serviceOption(CommandReceiptStore.CommandReceiptStoreV2).pipe(
          Effect.provide(context),
        );
        assert.isTrue(Option.isSome(found));
        if (Option.isNone(found)) return;
        const receipt = yield* found.value
          .getByCommandId(CommandId.make("cmd-never-ran"))
          .pipe(Effect.provide(context));
        assert.isTrue(Option.isNone(receipt));
      }),
    ),
);
