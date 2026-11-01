import * as CloudPty from "@goat/shared/PtyAdapter";
import * as Layer from "effect/Layer";
import * as OpenCodexInventory from "../opencodex/OpenCodexInventory.ts";
import * as CloudProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as CloudProjection from "../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as CloudPullRequests from "../pullRequest/PullRequestService.ts";
import * as CodexRoute from "./CodexRouteService.ts";

/** Services a hydrated registry needs beyond settings; its instances keep the default route. */
export const layerHydrationTestServices = Layer.mergeAll(
  Layer.mock(CloudPty.PtyAdapter)({}),
  Layer.mock(CloudPullRequests.PullRequestService)({}),
  Layer.mock(CloudProjection.ProjectionStoreV2)({}),
  Layer.mock(CloudProjectStore.ProjectStoreV2)({}),
  SqlitePersistence.layerMemory,
  CodexRoute.layerState,
  Layer.mock(OpenCodexInventory.OpenCodexInventory)({}),
  Layer.mock(ProcessRunner.ProcessRunner)({}),
);
