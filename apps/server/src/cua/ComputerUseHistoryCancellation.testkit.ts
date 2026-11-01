import {
  ThreadId,
  type ComputerUseCallAdmission,
  type ComputerUseCallReservation,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import { runMigrations } from "../persistence/Migrations.ts";
import { makeComputerUseHistory } from "./ComputerUseHistory.ts";
import { recordAdmittedCall } from "./ComputerUseHistoryAdmission.ts";

export const cancellationHistoryFixture = Effect.gen(function* () {
  yield* runMigrations();
  const history = yield* makeComputerUseHistory;
  const threadId = ThreadId.make("thread:history-cancellation");
  const reservation = (request: ComputerUseCallReservation) =>
    request.action === "reserve"
      ? recordAdmittedCall(history, threadId, request, { reservationId: "ticket:cancelled" }).pipe(
          Effect.orDie,
          Effect.as<ComputerUseCallAdmission>({
            status: "admitted",
            reservationId: "ticket:cancelled",
          }),
        )
      : Effect.succeed<ComputerUseCallAdmission>({ status: "released" });
  return { history, threadId, reservation };
});
