/**
 * Whether a run admits a control on every app. Strict input guards off admits every run; with
 * them on, full access does (ADR-0023 D16). The host setting `cuaFullAccessAutoAdmit` decides
 * nothing. The kind keeps what still differs by origin: unattended work holds the screen alone,
 * so two of its threads never mix their input.
 *
 * @module ComputerUseFullAccess
 */
import type { ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

/** Who a full access control on every app is for: a run someone directs, or unattended work. */
export type EveryAppKind = "person" | "unattended";

/** The kind a turn would get, or undefined outside full access. */
export const everyAppKind = (input: {
  readonly runtimeMode: string | undefined;
  readonly unattended: boolean;
}): EveryAppKind | undefined => {
  if (input.runtimeMode !== "full-access") return undefined;
  return input.unattended ? "unattended" : "person";
};

/** Strict-off or full access keeps the control admitted. A failed read ends it. */
export const makeFullAccessAdmitted = <E>(
  sql: SqlClient.SqlClient,
  strictInputGuards: Effect.Effect<boolean, E>,
) =>
  Effect.fn("ComputerUseLeases.fullAccessAdmitted")(
    function* (threadId: ThreadId) {
      if (!(yield* strictInputGuards)) return true;
      const rows = yield* sql<{ readonly runtime_mode: string }>`
        SELECT runtime_mode FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}
      `;
      return rows[0]?.runtime_mode === "full-access";
    },
    Effect.orElseSucceed(() => false),
  );
