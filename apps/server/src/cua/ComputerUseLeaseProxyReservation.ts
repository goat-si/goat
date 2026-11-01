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

/** A loaded host's server can stall for several seconds; an admission waits that out. */
const ADMISSION_TIMEOUT_MS = 10_000;
/** Release and close are best effort and run under the proxy's lifecycle lock. */
const RELEASE_TIMEOUT_MS = 2_000;

const UNAUTHORIZED: ComputerUseCallAdmission = { status: "refused", detail: "unauthorized" };
/** GOAT did not answer in time or could not judge the call: nothing ran, and it may be retried. */
const UNANSWERED: ComputerUseCallAdmission = { status: "refused", detail: "reconnecting" };

/** One POST of a reservation body to the lease route's calls endpoint. */
export type ReservationPost = (body: string, signal: AbortSignal) => Promise<Response>;

/** Only the server's own 401 says the agent session is no longer accepted. */
export const postReservation = Effect.fn("ComputerUseLeaseProxy.postReservation")(function* (
  post: ReservationPost,
  call: ComputerUseCallReservation,
) {
  return yield* Effect.tryPromise(async (signal) => {
    const response = await post(encodeReservation(call), signal);
    if (response.status === 401) return UNAUTHORIZED;
    if (!response.ok) return UNANSWERED;
    const decision = decodeAdmission(await response.text());
    return decision._tag === "Some" ? decision.value : UNANSWERED;
  }).pipe(
    Effect.timeoutOrElse({
      duration:
        call.action === "reserve" || call.action === "validate"
          ? ADMISSION_TIMEOUT_MS
          : RELEASE_TIMEOUT_MS,
      orElse: () => Effect.succeed(UNANSWERED),
    }),
    Effect.orElseSucceed(() => UNANSWERED),
  );
});
