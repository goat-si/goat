import {
  DEFAULT_HUB_RELAY_WARNING_DEVICE_GB_PER_DAY,
  DEFAULT_HUB_RELAY_WARNING_HUB_GB_PER_DAY,
  type OpenCodexHubRelayWarning,
  type OpenCodexInventorySnapshot,
} from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as Schema from "effect/Schema";

import * as Settings from "../serverSettings.ts";
import { decodeLinkRowRoute, type LinkRowObservationFields } from "./hubOcxJson.ts";
import { makeLinkTrafficBook, type LinkTrafficView } from "./linkTrafficBook.ts";
import { readPenConfig } from "./penConfigFile.ts";
import { penConfigHosts } from "./penSshRoute.ts";

type Link = OpenCodexInventorySnapshot["link"]["links"][number];
type Base = Omit<Link, "traffic" | "route" | "transport">;
type Observations = Schema.Struct.Type<typeof LinkRowObservationFields>;
/** A Home's link row as `ocx link status --json` printed it. */
export type LinkStatusRow = Base & Observations;

export interface LinkTrafficThresholds {
  /** Relay bytes both ways per device in 24 hours; 0 never warns. */
  readonly deviceBytes: number;
  readonly hubBytes: number;
}

const GB = 1_000_000_000;

/** A row without what OpenCodex printed beyond the base fields. */
export const baseLinkRow = ({
  traffic: _t,
  routes: _rs,
  route: _r,
  ws: _w,
  ...base
}: LinkStatusRow) => base;

/**
 * The route the row's proven tunnel uses. A link with several routes names it, and one whose
 * route does not decode has none known; a one-route link, as every older Home has, can only use
 * its alias, and does once its tunnel is connected.
 */
function routeOf(row: LinkStatusRow, penAliases: ReadonlySet<string> | undefined) {
  const multi = row.routes !== undefined || row.route !== undefined;
  const named = multi ? Option.getOrNull(decodeLinkRowRoute(row.route)) : null;
  const proven =
    named !== null
      ? { name: named.name, since: Date.parse(named.since) }
      : !multi && row.state === "connected"
        ? { name: row.alias, since: Number.NaN }
        : undefined;
  if (proven === undefined) return undefined;
  return {
    name: proven.name,
    ...(penAliases === undefined
      ? {}
      : { via: penAliases.has(proven.name) ? ("relay" as const) : ("direct" as const) }),
    ...(Number.isFinite(proven.since) ? { since: proven.since } : {}),
  };
}

const relayBytes = (view: LinkTrafficView) =>
  view.day.relayToHomeBytes + view.day.relayFromHomeBytes;

/** Feeds one status pass into the book and returns the rows as the snapshot carries them. */
export function deriveLinkRows(
  book: ReturnType<typeof makeLinkTrafficBook>,
  rows: ReadonlyArray<LinkStatusRow>,
  at: number,
  penAliases: ReadonlySet<string> | undefined,
  thresholds: LinkTrafficThresholds,
): { readonly links: ReadonlyArray<Link>; readonly relayWarning?: OpenCodexHubRelayWarning } {
  const routed = rows.map((row) => ({ row, route: routeOf(row, penAliases) }));
  book.observe(
    routed.flatMap(({ row, route }) =>
      row.traffic === undefined ? [] : [{ linkId: row.id, traffic: row.traffic, route }],
    ),
    at,
  );
  const links = routed.map(({ row, route }): Link => {
    const view = row.traffic === undefined ? undefined : book.view(row.id, at);
    const warned =
      view !== undefined &&
      thresholds.deviceBytes > 0 &&
      relayBytes(view) >= thresholds.deviceBytes;
    return {
      ...baseLinkRow(row),
      ...(view === undefined
        ? {}
        : {
            traffic: {
              ...view,
              ...(warned ? { warning: { thresholdBytes: thresholds.deviceBytes } } : {}),
            },
          }),
      ...(route === undefined ? {} : { route }),
      ...(row.ws === undefined ? {} : { transport: row.ws.open > 0 ? "websocket" : "http" }),
    };
  });
  const hubRelay = book.relayDayBytes(at);
  return {
    links,
    ...(thresholds.hubBytes > 0 && hubRelay >= thresholds.hubBytes
      ? { relayWarning: { relayBytes: hubRelay, thresholdBytes: thresholds.hubBytes } }
      : {}),
  };
}

/**
 * What the Home's links carried, derived from each `ocx link status` pass the inventory already
 * makes. It adds no read of its own besides Pen's ssh config on that pass.
 */
export class HubLinkTraffic extends Context.Service<
  HubLinkTraffic,
  {
    readonly observe: (
      rows: ReadonlyArray<LinkStatusRow>,
    ) => Effect.Effect<ReturnType<typeof deriveLinkRows>>;
  }
>()("goat/hub/HubLinkTraffic") {}

export const make = Effect.fn("HubLinkTraffic.make")(function* (
  penAliases: Effect.Effect<ReadonlySet<string> | undefined>,
) {
  const settings = yield* Settings.ServerSettingsService;
  const book = makeLinkTrafficBook();
  const observe = Effect.fn("HubLinkTraffic.observe")(function* (
    rows: ReadonlyArray<LinkStatusRow>,
  ) {
    const at = yield* Clock.currentTimeMillis;
    const aliases = rows.length === 0 ? undefined : yield* penAliases;
    // A settings read that fails warns at the defaults rather than not at all.
    const configured = yield* settings.getSettings.pipe(
      Effect.orElseSucceed(() => ({
        hubRelayWarningDeviceGbPerDay: DEFAULT_HUB_RELAY_WARNING_DEVICE_GB_PER_DAY,
        hubRelayWarningHubGbPerDay: DEFAULT_HUB_RELAY_WARNING_HUB_GB_PER_DAY,
      })),
    );
    const thresholds: LinkTrafficThresholds = {
      deviceBytes: Math.round(configured.hubRelayWarningDeviceGbPerDay * GB),
      hubBytes: Math.round(configured.hubRelayWarningHubGbPerDay * GB),
    };
    return deriveLinkRows(book, rows, at, aliases, thresholds);
  });
  return HubLinkTraffic.of({ observe });
});

/** Pen's aliases are the Host blocks of its own ssh config; a failed read classifies no route. */
export const layer = Layer.effect(
  HubLinkTraffic,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* HostProcess.HomeDirectory;
    const file = path.join(home, ".ssh", "pen", "config");
    return yield* make(
      readPenConfig(fs, file).pipe(
        Effect.map((config): ReadonlySet<string> => new Set(penConfigHosts(config))),
        Effect.orElseSucceed(() => undefined),
      ),
    );
  }),
);
