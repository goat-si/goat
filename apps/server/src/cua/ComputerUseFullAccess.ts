/**
 * Whether full access still admits a control on every app: a run a person started needs only
 * its thread in full access; other runs also need the host's unattended setting.
 *
 * @module ComputerUseFullAccess
 */
import type { ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as SqlClient from "effect/sql/SqlClient";

import type * as ServerSettings from "../serverSettings.ts";

/** What admitted a control on every app: a person's run, or the host setting. */
export type EveryAppKind = "person" | "interactive" | "unattended";

/** The kind a turn would get, or undefined when full access admits nothing for it. */
export const everyAppKind = (input: {
  readonly runtimeMode: string | undefined;
  readonly unattended: boolean;
  readonly personStarted: boolean;
  readonly setting: boolean;
}): EveryAppKind | undefined => {
  if (input.runtimeMode !== "full-access") return undefined;
  if (input.unattended) return input.setting ? "unattended" : undefined;
  if (input.personStarted) return "person";
  return input.setting ? "interactive" : undefined;
};

/** A failed read admits nothing, so a control living on full access ends. */
export const makeFullAccessAdmitted = (
  sql: SqlClient.SqlClient,
  settings: Option.Option<ServerSettings.ServerSettingsService["Service"]>,
) =>
  Effect.fn("ComputerUseLeases.fullAccessAdmitted")(
    function* (threadId: ThreadId, kind: EveryAppKind) {
      if (kind !== "person") {
        if (Option.isNone(settings)) return false;
        if (!(yield* settings.value.getSettings).cuaFullAccessAutoAdmit) return false;
      }
      const rows = yield* sql<{ readonly runtime_mode: string }>`
        SELECT runtime_mode FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}
      `;
      return rows[0]?.runtime_mode === "full-access";
    },
    Effect.orElseSucceed(() => false),
  );
