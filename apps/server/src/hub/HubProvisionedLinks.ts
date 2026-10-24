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
 * Only the link id OpenCodex returned for GOAT's own `ocx link add` proves a link is GOAT's. Anyone
 * with ocx on this machine can link the alias at any time, so an add whose answer was lost (or
 * that GOAT never saw finish) claims nothing: its release revokes no link that holds the alias and
 * is audited as unproven.
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

  /** After `ocx link add`: records the id it returned and that link's tunnel port. */
  const finishAdd = Effect.fn("HubProvisionedLinks.finishAdd")(function* (
    alias: string,
    linkId: string | undefined,
    homeLinks: Effect.Effect<HomeLinks, HubOcxError>,
  ) {
    // Without an id the attempt stays unresolved.
    if (linkId === undefined) return;
    const status = yield* homeLinks.pipe(Effect.orElseSucceed((): HomeLinks => undefined));
    const port = status?.links.find((entry) => entry.id === linkId)?.tunnelPort ?? null;
    yield* sql`UPDATE hub_provisioned_links
      SET link_id = ${linkId}, tunnel_port = ${port}, adding_since = NULL WHERE alias = ${alias}`;
  }, Effect.mapError(storageFailure));

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
      alias: string | undefined,
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
    /** Ends the release; the audit row and the completion commit together. */
    const finish = (alias: string, outcome: "ready" | "unproven" | undefined) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            if (outcome !== undefined)
              yield* home.audit(CLOUD_CALLER, "hub.release", alias, outcome, undefined);
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
        yield* finish(alias, undefined);
        return result(alias, "ready", "GOAT added no link for this machine.", steps);
      }
      const status = yield* home.homeLinks;
      if (status === undefined) {
        steps.push({ step: "revoke", outcome: "failed", detail: "Link status is unavailable." });
        return undefined;
      }
      const port = before.tunnel_port ?? undefined;
      const recorded =
        before.link_id === null
          ? undefined
          : status.links.find((entry) => entry.id === before.link_id);
      const holder = status.links.find((entry) => entry.alias === alias);
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
      } else {
        if (
          holder !== undefined &&
          (before.adding_since !== null || port === undefined || holder.tunnelPort === port)
        ) {
          // A link GOAT cannot prove is its own holds the alias, and its tunnel cannot be told
          // apart from GOAT's old one. Both stay; the audit says so.
          steps.push({
            step: "revoke",
            outcome: "deferred",
            detail: `Link ${holder.id} holds ${alias}, and GOAT cannot prove it or its tunnel is GOAT's.`,
          });
          yield* finish(alias, "unproven");
          return result(
            alias,
            "degraded",
            `GOAT left link ${holder.id} on ${alias} in place: it cannot prove it added it.`,
            steps,
          );
        }
        // GOAT's link record is gone. With no link under the alias any tunnel to it is GOAT's;
        // with a newer link there, only GOAT's old port is.
        const tunnels = yield* home.homeTunnels(holder === undefined ? alias : undefined, port);
        gone = tunnels === 0;
        steps.push({
          step: "link_removed",
          outcome: gone ? "ok" : "failed",
          detail: gone
            ? "GOAT's link is already gone, with no ssh -R tunnel left."
            : tunnels === undefined
              ? "This Home's ssh tunnels could not be listed."
              : `${tunnels} ssh -R tunnel for the old link is still running.`,
        });
      }
      if (!gone) return undefined;
      yield* finish(alias, "ready");
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

  return { beginAdd, finishAdd, releases };
});
