import {
  type HubDeviceMcpResult,
  type HubDeviceOperationResult,
  type HubDeviceStep,
  OrchestratorMcpFailure,
  hasCloudMachineAliasPrefix,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import { type HubOcxError, SAFE_ALIAS } from "./HubOcx.ts";

/**
 * The Remote Link GOAT's own setup added for a cloud machine it created, and the release GOAT owes
 * once that machine is deleted or forgotten. Only a link recorded here is ever revoked, so a link a
 * person added, or one that later took the alias over, stays. A release stays pending until the
 * Home shows the link and its tunnel gone, so a failed one is retried after a restart.
 *
 * Every join takes the hub permit and reads link status first, and so does a release. That makes
 * an add whose outcome GOAT never learned (a lost response, a crash) safe to settle on the next
 * read: no one else could have linked the alias in between.
 */

interface HomeLink {
  readonly id: string;
  readonly alias: string;
  readonly tunnelPort?: number | undefined;
}
type HomeLinks = { readonly links: ReadonlyArray<HomeLink> } | undefined;

interface Row {
  readonly link_id: string | null;
  readonly tunnel_port: number | null;
  readonly adding_since: string | null;
  readonly release_requested_at: string | null;
  readonly released_at: string | null;
}

export interface ProvisionedLinkReleases {
  /**
   * Records that a cloud machine is being deleted or forgotten, before its catalog entry goes.
   * From then on GOAT never links it again. Takes no hub permit, so it never waits on a join.
   */
  readonly requestRelease: (alias: string) => Effect.Effect<void, OrchestratorMcpFailure>;
  /** Machines whose release has not finished, including ones that failed before a restart. */
  readonly pendingReleases: Effect.Effect<ReadonlyArray<string>, OrchestratorMcpFailure>;
  /**
   * Revokes the link GOAT recorded for a machine whose release was requested and proves the link
   * record and its tunnel gone. A link that is already gone counts as released.
   */
  readonly releaseProvisioned: (
    alias: string,
  ) => Effect.Effect<HubDeviceMcpResult, OrchestratorMcpFailure>;
}

const CLOUD_CALLER = { actor: "goat:cloud-machine", profile: "hub" };
const storageFailure = () =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: "The hub's cloud machine link records are unavailable.",
  });

export const makeProvisionedLinks = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const read = (alias: string) =>
    sql<Row>`SELECT link_id, tunnel_port, adding_since, release_requested_at, released_at
      FROM hub_provisioned_links WHERE alias = ${alias}`.pipe(Effect.map((rows) => rows[0]));

  const recordAdded = (alias: string, linkId: string | undefined) =>
    linkId === undefined
      ? sql`UPDATE hub_provisioned_links SET adding_since = NULL WHERE alias = ${alias}`
      : sql`UPDATE hub_provisioned_links
          SET link_id = ${linkId}, tunnel_port = NULL, adding_since = NULL WHERE alias = ${alias}`;

  /** Settles an unfinished add: the link under the alias, if any, is the one GOAT was adding. */
  const settle = Effect.fn("HubProvisionedLinks.settle")(function* (
    alias: string,
    status: NonNullable<HomeLinks>,
  ) {
    if ((yield* read(alias))?.adding_since == null) return;
    yield* recordAdded(alias, status.links.find((entry) => entry.alias === alias)?.id);
  }, Effect.mapError(storageFailure));

  /**
   * Under the hub permit, before `ocx link add` for a machine GOAT created. False when that machine
   * is being removed; otherwise notes the attempt so its outcome is settled even if it is lost.
   */
  const beginAdd = Effect.fn("HubProvisionedLinks.beginAdd")(function* (alias: string) {
    if ((yield* read(alias))?.release_requested_at != null) return false;
    yield* sql`INSERT INTO hub_provisioned_links (alias, adding_since) VALUES (${alias}, ${yield* now})
        ON CONFLICT (alias) DO UPDATE SET adding_since = excluded.adding_since`;
    return true;
  }, Effect.mapError(storageFailure));

  /** After `ocx link add`; without an id from it, the Home's link status decides. */
  const finishAdd = Effect.fn("HubProvisionedLinks.finishAdd")(function* (
    alias: string,
    linkId: string | undefined,
    homeLinks: Effect.Effect<HomeLinks, HubOcxError>,
  ) {
    if (linkId !== undefined)
      return yield* recordAdded(alias, linkId).pipe(Effect.mapError(storageFailure));
    // Unreadable status leaves the attempt noted for the next read to settle.
    const status = yield* homeLinks.pipe(Effect.orElseSucceed((): HomeLinks => undefined));
    if (status !== undefined) yield* settle(alias, status);
  });

  const releases = (home: {
    readonly permit: Semaphore.Semaphore;
    readonly audit: (
      caller: typeof CLOUD_CALLER,
      action: string,
      target: string,
      outcome: string,
      decisionId: undefined,
    ) => Effect.Effect<void, OrchestratorMcpFailure>;
    readonly homeLinks: Effect.Effect<HomeLinks, HubOcxError>;
    readonly revokeOnHome: (
      alias: string,
      record: HomeLink,
      steps: HubDeviceStep[],
    ) => Effect.Effect<boolean, HubOcxError>;
    readonly homeTunnels: (
      alias: string,
      tunnelPort: number | undefined,
    ) => Effect.Effect<number | undefined>;
  }): ProvisionedLinkReleases => {
    const guard = (alias: string) =>
      SAFE_ALIAS.test(alias) && hasCloudMachineAliasPrefix(alias)
        ? Effect.void
        : Effect.fail(
            new OrchestratorMcpFailure({
              code: "invalid_request",
              message: "Only a cloud machine GOAT created has a link GOAT releases.",
            }),
          );
    const result = (
      alias: string,
      state: HubDeviceOperationResult["state"],
      message: string,
      steps: ReadonlyArray<HubDeviceStep>,
    ): HubDeviceMcpResult => ({
      deviceAlias: alias,
      action: "leave",
      state,
      message,
      steps,
      transport: "remote-link",
    });
    const finish = (alias: string, audited: boolean) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            if (audited) yield* home.audit(CLOUD_CALLER, "hub.release", alias, "ready", undefined);
            yield* sql`UPDATE hub_provisioned_links
              SET link_id = NULL, tunnel_port = NULL, adding_since = NULL, released_at = ${yield* now}
              WHERE alias = ${alias}`;
          }),
        )
        .pipe(Effect.mapError(storageFailure));

    const release = Effect.fn("HubProvisionedLinks.release")(function* (
      alias: string,
      steps: HubDeviceStep[],
    ) {
      const before = yield* read(alias).pipe(Effect.mapError(storageFailure));
      if (before?.release_requested_at == null || before.released_at !== null)
        return result(alias, "ready", "No release is pending for this machine.", steps);
      if (before.link_id === null && before.adding_since === null) {
        yield* finish(alias, false);
        return result(alias, "ready", "GOAT added no link for this machine.", steps);
      }
      const status = yield* home.homeLinks;
      if (status === undefined) {
        steps.push({ step: "revoke", outcome: "failed", detail: "Link status is unavailable." });
        return undefined;
      }
      yield* settle(alias, status);
      const row = yield* read(alias).pipe(Effect.mapError(storageFailure));
      if (row?.link_id == null) {
        yield* finish(alias, false);
        return result(alias, "ready", "GOAT's add left no link for this machine.", steps);
      }
      const recorded = status.links.find((entry) => entry.id === row.link_id);
      let gone: boolean;
      if (recorded !== undefined) {
        if (recorded.alias !== alias) {
          steps.push({
            step: "revoke",
            outcome: "failed",
            detail: `Link ${recorded.id} now names ${recorded.alias}; it was left in place.`,
          });
          return undefined;
        }
        // Kept for a retry, which then checks this link's tunnel after its record is gone.
        if (recorded.tunnelPort !== undefined)
          yield* sql`UPDATE hub_provisioned_links SET tunnel_port = ${recorded.tunnelPort}
            WHERE alias = ${alias}`.pipe(Effect.mapError(storageFailure));
        gone = yield* home.revokeOnHome(alias, recorded, steps);
      } else if (status.links.some((entry) => entry.alias === alias)) {
        // Another link took the alias over, which only a leave or re-link that revoked and
        // checked GOAT's link can do; that link is not GOAT's to touch.
        steps.push({
          step: "revoke",
          outcome: "ok",
          detail: `${row.link_id} was already replaced.`,
        });
        gone = true;
      } else {
        // No link names the alias, so any tunnel to it is what is left of GOAT's.
        const tunnels = yield* home.homeTunnels(alias, row.tunnel_port ?? undefined);
        gone = tunnels === 0;
        steps.push({
          step: "link_removed",
          outcome: gone ? "ok" : "failed",
          detail: gone
            ? `${row.link_id} is already gone, with no ssh -R tunnel left.`
            : tunnels === undefined
              ? "This Home's ssh tunnels could not be listed."
              : `${tunnels} ssh -R tunnel for the old link is still running.`,
        });
      }
      if (!gone) return undefined;
      yield* finish(alias, true);
      return result(alias, "ready", `The link GOAT added for ${alias} is revoked.`, steps);
    });

    return {
      requestRelease: (alias) =>
        guard(alias).pipe(
          Effect.andThen(
            Effect.gen(function* () {
              yield* sql`INSERT INTO hub_provisioned_links (alias, release_requested_at)
                VALUES (${alias}, ${yield* now})
                ON CONFLICT (alias) DO UPDATE SET
                  release_requested_at = COALESCE(release_requested_at, excluded.release_requested_at),
                  released_at = NULL`;
            }).pipe(Effect.mapError(storageFailure)),
          ),
        ),
      pendingReleases: sql<{ readonly alias: string }>`SELECT alias FROM hub_provisioned_links
        WHERE release_requested_at IS NOT NULL AND released_at IS NULL ORDER BY alias`.pipe(
        Effect.map((rows) => rows.map((row) => row.alias)),
        Effect.mapError(storageFailure),
      ),
      releaseProvisioned: (alias) =>
        guard(alias).pipe(
          Effect.andThen(
            home.permit.withPermits(1)(
              Effect.gen(function* () {
                const steps: HubDeviceStep[] = [];
                const done = yield* release(alias, steps).pipe(
                  Effect.catchTags({
                    HubOcxError: (error) =>
                      Effect.sync(() => {
                        steps.push({ step: "revoke", outcome: "failed", detail: error.message });
                        return undefined;
                      }),
                  }),
                );
                if (done !== undefined) return done;
                yield* home.audit(CLOUD_CALLER, "hub.release", alias, "failed", undefined);
                return result(
                  alias,
                  "failed",
                  "GOAT could not prove the link it added is gone; it tries again after a restart.",
                  steps,
                );
              }),
            ),
          ),
        ),
    };
  };

  return { beginAdd, finishAdd, settle, releases };
});
