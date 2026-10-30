/**
 * The proxy's requests to its GOAT server that admit, confirm, release or close a call's
 * execution ticket (ADR-0023 D17). A lost answer grants no authority: the call does not run, and
 * any ticket the server took stays held until its driver is closed.
 *
 * @module ComputerUseLeaseProxyReservation
 */
import { ComputerUseCallAdmission, ComputerUseCallReservation } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const decodeAdmission = Schema.decodeUnknownOption(Schema.fromJsonString(ComputerUseCallAdmission));
const encodeReservation = Schema.encodeSync(Schema.fromJsonString(ComputerUseCallReservation));

const RESERVATION_TIMEOUT_MS = 2_000;

/** One POST of a reservation body to the lease route's calls endpoint. */
export type ReservationPost = (body: string, signal: AbortSignal) => Promise<Response>;

export const postReservation = Effect.fn("ComputerUseLeaseProxy.postReservation")(function* (
  post: ReservationPost,
  call: ComputerUseCallReservation,
) {
  const unauthorized: ComputerUseCallAdmission = { status: "refused", detail: "unauthorized" };
  return yield* Effect.tryPromise(async (signal) => {
    const response = await post(encodeReservation(call), signal);
    return response.ok ? decodeAdmission(await response.text()) : undefined;
  }).pipe(
    Effect.map((decision) => (decision?._tag === "Some" ? decision.value : unauthorized)),
    Effect.timeoutOrElse({
      duration: RESERVATION_TIMEOUT_MS,
      orElse: () => Effect.succeed(unauthorized),
    }),
    Effect.orElseSucceed(() => unauthorized),
  );
});
