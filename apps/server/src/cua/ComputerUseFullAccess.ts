/**
 * Whether full access admits a control on every app. Any run whose thread is in full access gets
 * one, whatever started it (ADR-0023 D16); the host setting `cuaFullAccessAutoAdmit` decides
 * nothing. The kind keeps what still differs by origin: unattended work holds the screen alone
 * and asks for the foreground; every other run takes the foreground without asking.
 *
 * @module ComputerUseFullAccess
 */
import type { ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

/** Who a full access control on every app is for: work a person directs, or unattended work. */
export type EveryAppKind = "directed" | "unattended";

/** The kind a turn would get, or undefined outside full access. */
export const everyAppKind = (input: {
  readonly runtimeMode: string | undefined;
  readonly unattended: boolean;
}): EveryAppKind | undefined => {
  if (input.runtimeMode !== "full-access") return undefined;
  return input.unattended ? "unattended" : "directed";
};

/** Whether the thread is still in full access. A failed read admits nothing, so the control ends. */
export const makeFullAccessAdmitted = (sql: SqlClient.SqlClient) =>
  Effect.fn("ComputerUseLeases.fullAccessAdmitted")(
    function* (threadId: ThreadId) {
      const rows = yield* sql<{ readonly runtime_mode: string }>`
        SELECT runtime_mode FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}
      `;
      return rows[0]?.runtime_mode === "full-access";
    },
    Effect.orElseSucceed(() => false),
  );
