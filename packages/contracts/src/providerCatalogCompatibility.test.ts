import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";
import { WsServerRefreshProvidersRpc, WsSubscribeServerConfigRpc } from "./rpc.ts";

const encodeConfig = Schema.encodeSync(WsSubscribeServerConfigRpc.payloadSchema);
const encodeRefresh = Schema.encodeSync(WsServerRefreshProvidersRpc.payloadSchema);
const decodeLegacyConfig = Schema.decodeUnknownSync(
  Schema.Struct({
    workspaceSnapshotsOnDemand: Schema.optional(Schema.Boolean),
    providerStatusChanges: Schema.optional(Schema.Boolean),
  }),
);
const decodeLegacyRefresh = Schema.decodeUnknownSync(
  Schema.Struct({
    workspaceSnapshotsOnDemand: Schema.optional(Schema.Boolean),
  }),
);

it("older config and refresh schemas ignore the catalog and reply opt-ins", () => {
  const config = { workspaceSnapshotsOnDemand: true, providerStatusChanges: true };
  const encodedConfig = encodeConfig({
    ...config,
    providerCatalogsOnDemand: true,
    providerCatalogDigests: true,
  });
  expect(decodeLegacyConfig(encodedConfig)).toEqual(config);

  const refresh = { workspaceSnapshotsOnDemand: true };
  const encodedRefresh = encodeRefresh({
    ...refresh,
    omitProviders: true,
    providerCatalogsOnDemand: true,
    machineCatalog: true,
  });
  expect(decodeLegacyRefresh(encodedRefresh)).toEqual(refresh);
});

it("the refresh payload cannot send a loaded catalog digest", () => {
  const request = { machineCatalog: true, loadedCatalogDigest: "client-only" };
  expect(encodeRefresh(request)).toEqual({
    machineCatalog: true,
  });
});
