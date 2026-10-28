import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Configuration from "../Config.ts";
import * as Dpop from "../auth/DpopProofs.ts";
import * as Tokens from "../auth/RelayTokens.ts";
import * as HookInbox from "../hooks/HookInbox.ts";
import { postgresFixture, postgresPolicyFixture } from "../auth/connectPostgres.testkit.ts";
import * as Intents from "./ManagedProvisioningIntents.ts";
import * as Provider from "./ManagedEndpointProvider.ts";
import * as Reservations from "./ConnectLinkReservations.ts";
import * as RetiredCollector from "./RetiredEndpointCollector.ts";
import * as Linker from "./EnvironmentLinker.ts";
import { config } from "./EnvironmentLinker.testkit.ts";

/** Link recovery over the fixture database, with in-memory Cloudflare tunnels and DNS that a test can pause. */
export function fixture(gate?: {
  readonly at: "create" | "token" | "delete";
  readonly wait: Effect.Effect<void>;
  readonly replacementWait?: Effect.Effect<void>;
}) {
  let heldToken = false;
  const tunnels = new Map<string, string>();
  const dns = new Map<
    string,
    { readonly name: string; readonly type: string; readonly content: string }
  >();
  let sequence = 0;
  let failDelete = false;
  const tunnelClient = Provider.layerTunnelClient({
    get: (id) =>
      Effect.suspend(() =>
        tunnels.has(id)
          ? Effect.succeed({ id, name: tunnels.get(id) ?? null })
          : Effect.fail(
              new Provider.ManagedEndpointTunnelClientError({
                operation: "get",
                tunnelId: id,
                cause: { _tag: "NotFound" },
              }),
            ),
      ),
    list: () => Effect.sync(() => ({ result: [...tunnels].map(([id, name]) => ({ id, name })) })),
    create: Effect.fn("ConnectLinkRecovery.tunnels.create")(function* ({ name }) {
      const id = `tunnel-${++sequence}`;
      tunnels.set(id, name);
      if (gate?.at === "create" && !heldToken) {
        heldToken = true;
        yield* gate.wait;
      } else if (gate?.at === "create" && gate.replacementWait) {
        yield* gate.replacementWait;
      }
      return { id, name };
    }),
    putConfiguration: () => Effect.void,
    getToken: Effect.fn("ConnectLinkRecovery.tunnels.getToken")(function* (id) {
      if (gate?.at === "token" && !heldToken) {
        heldToken = true;
        yield* gate.wait;
      }
      return `connector:${id}`;
    }),
    delete: Effect.fn("ConnectLinkRecovery.tunnels.delete")(function* (id) {
      if (gate?.at === "delete") yield* gate.wait;
      if (failDelete)
        return yield* new Provider.ManagedEndpointTunnelClientError({
          operation: "delete",
          tunnelId: id,
          cause: "unavailable",
        });
      tunnels.delete(id);
    }),
  });
  const dnsClient = Provider.layerDnsClient({
    listRecords: (name) =>
      Effect.sync(() =>
        [...dns]
          .filter(([, value]) => value.name === name)
          .map(([id, record]) => ({ id, ...record })),
      ),
    createRecord: (record) =>
      Effect.sync(() => {
        const id = `dns-${++sequence}`;
        dns.set(id, record);
        return { id };
      }),
    updateRecord: (id, record) =>
      Effect.sync(() => {
        dns.set(id, record);
      }),
    deleteRecord: (id) =>
      Effect.sync(() => {
        dns.delete(id);
      }),
  });
  const provider = Layer.effect(Provider.ManagedEndpointProvider, Provider.make).pipe(
    Layer.provide(Layer.mergeAll(tunnelClient, dnsClient, Intents.layer)),
  );
  const layer = Linker.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(provider, Reservations.layer, Tokens.layer, Dpop.layer)),
    Layer.provideMerge(postgresPolicyFixture),
    Layer.provideMerge(postgresFixture),
    Layer.provideMerge(
      Configuration.layer({
        ...config,
        subjectDigestKey: Redacted.make("connect-recovery-subject-digest-key-32-bytes"),
        managedEndpointBaseDomain: "connect.example.test",
        managedEndpointNamespace: "test",
      }),
    ),
    Layer.provideMerge(NodeCryptoLayer.layer),
    Layer.provideMerge(Layer.mock(HookInbox.HookInbox, { clear: () => Effect.void })),
  );
  const inventory = Layer.succeed(RetiredCollector.RetiredEndpointInventory, {
    tunnels: () => Effect.sync(() => [...tunnels].map(([id, name]) => ({ id, name }))),
    dns: () => Effect.sync(() => [...dns].map(([id, record]) => ({ id, name: record.name }))),
    disconnect: () => Effect.void,
    deleteTunnel: (id) =>
      Effect.sync(() => {
        tunnels.delete(id);
      }),
    deleteDns: (id) =>
      Effect.sync(() => {
        dns.delete(id);
      }),
  });
  return {
    layer,
    tunnels,
    dns,
    /** One retired-endpoint collector pass over these tunnels and DNS records. */
    collectRetired: Effect.flatMap(
      RetiredCollector.RetiredEndpointCollector,
      (collector) => collector.sweep,
    ).pipe(Effect.provide(RetiredCollector.layer.pipe(Layer.provide(inventory)))),
    setDeleteFailure: (value: boolean) => {
      failDelete = value;
    },
  };
}
