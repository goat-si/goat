import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  ConnectionCatalogDocument,
  EMPTY_CONNECTION_CATALOG_DOCUMENT,
  decodeConnectionCatalogStorage,
  encodeConnectionCatalogStorage,
} from "./storageDocument.ts";

// A fixed seed: the same catalogs every run, so a failure reproduces.
let seed = 12345;
const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = <A>(values: ReadonlyArray<A>) => values[Math.floor(random() * values.length)]!;
const decodeDocument = Schema.decodeUnknownSync(ConnectionCatalogDocument);
const mesh = "m".repeat(26);

const route = (kind: "bearer" | "hub" | "pen", n: number) => {
  const environmentId = `env-${kind}-${n}`;
  if (kind === "bearer") {
    const connectionId = `bearer-${n}`;
    return {
      connectionId,
      target: { _tag: "BearerConnectionTarget", environmentId, label: "B", connectionId },
      profile: {
        _tag: "BearerConnectionProfile",
        environmentId,
        label: "B",
        connectionId,
        httpBaseUrl: "https://box.ts.net",
        wsBaseUrl: "wss://box.ts.net",
      },
    };
  }
  if (kind === "hub") {
    const connectionId = `hub:x:${n}`;
    return {
      connectionId,
      target: { _tag: "HubProxyConnectionTarget", environmentId, label: "H", connectionId },
      profile: {
        _tag: "HubProxyConnectionProfile",
        environmentId,
        label: "H",
        connectionId,
        hubEnvironmentId: "hub",
        hubConnectionId: "primary",
        nodeId: `n${n}`,
      },
    };
  }
  const nodeId = String.fromCharCode(97 + n).repeat(26);
  const connectionId = `pen:${mesh}:${nodeId}`;
  return {
    connectionId,
    target: { _tag: "PenConnectionTarget", environmentId, label: "P", connectionId },
    profile: {
      _tag: "PenConnectionProfile",
      environmentId,
      label: "P",
      connectionId,
      meshId: mesh,
      nodeId,
      noisePub: "k".repeat(43),
    },
  };
};

it.effect(
  "a damaged hub or Pen record never costs another record, nor its order when only its value is damaged",
  () =>
    Effect.gen(function* () {
      for (let run = 0; run < 1500; run++) {
        const routes = Array.from({ length: Math.floor(random() * 7) }, (_, n) =>
          route(pick(["bearer", "hub", "pen"] as const), n),
        );
        const profileOrder = routes.toSorted(() => random() - 0.5);
        const stored = JSON.parse(
          yield* encodeConnectionCatalogStorage(
            decodeDocument({
              ...EMPTY_CONNECTION_CATALOG_DOCUMENT,
              targets: routes.map((value) => value.target),
              profiles: profileOrder.map((value) => value.profile),
            }),
          ),
        );
        const lostTargets = new Set<string>();
        const lostProfiles = new Set<string>();
        let positionLost = false;
        for (const [field, lost] of [
          ["hubProxyTargets", lostTargets],
          ["penTargets", lostTargets],
          ["hubProxyProfiles", lostProfiles],
          ["penProfiles", lostProfiles],
        ] as const) {
          const records = stored[field] ?? [];
          for (const record of records) {
            if (random() > 0.3) continue;
            // Another record's index: both are valid, only their order is open.
            const indexed = records.filter(
              (other: { index?: unknown }) =>
                other !== record && typeof other.index === "number" && other.index >= 0,
            );
            if (random() < 0.25 && indexed.length > 0) {
              record.index = pick(indexed).index;
              positionLost = true;
              continue;
            }
            lost.add(record.value.connectionId);
            const damage = pick(["no value", "wrong kind", "bad index", "no index"] as const);
            if (damage === "no value") record.value = null;
            else if (damage === "wrong kind")
              record.value = { _tag: "PenConnectionTarget", environmentId: "e", connectionId: 7 };
            else {
              positionLost = true;
              if (damage === "bad index") record.index = -1;
              else delete record.index;
            }
          }
        }
        const raw = JSON.stringify(stored);
        const decoded = yield* decodeConnectionCatalogStorage(raw);
        // A Pen route is one target and one profile: losing either loses both.
        const unpaired = new Set(
          routes
            .filter((value) => value.target._tag === "PenConnectionTarget")
            .map((value) => value.connectionId)
            .filter((id) => lostTargets.has(id) || lostProfiles.has(id)),
        );
        const kept = (order: typeof routes, lost: ReadonlySet<string>) =>
          order
            .map((value) => value.connectionId)
            .filter((id) => !lost.has(id) && !unpaired.has(id));
        // A record whose position is unknown leaves the others' order open; never their presence.
        const compare = (values: ReadonlyArray<string>) =>
          positionLost ? values.toSorted() : values;
        const actual = {
          targets: compare(
            decoded.targets.map((value) => ("connectionId" in value ? value.connectionId : "")),
          ),
          profiles: compare(decoded.profiles.map((value) => value.connectionId)),
        };
        const expected = {
          targets: compare(kept(routes, lostTargets)),
          profiles: compare(kept(profileOrder, lostProfiles)),
        };
        expect(actual, raw).toEqual(expected);
        const reloaded = yield* decodeConnectionCatalogStorage(
          yield* encodeConnectionCatalogStorage(decoded),
        );
        expect(reloaded, raw).toEqual(decoded);
      }
    }),
);
