import type { ProcessExit } from "@muse-code/sdk";
import type { MuseSdkHost } from "./sdk.ts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";

type HostEntry =
  | { type: "notification"; method: string; params: unknown; epoch: number }
  | { type: "failure"; cause: unknown; epoch: number };

const MAX_INBOX_ENTRIES = 2_048;

export const makeMuseInbox = Effect.fn("Muse.makeInbox")(function* <Turn>() {
  const queue = yield* Queue.bounded<HostEntry | { type: "flush"; turn: Turn }>(MAX_INBOX_ENTRIES);
  let overflow: number | undefined;
  return {
    queue,
    watchHost(host: MuseSdkHost, epoch: number, currentEpoch: () => number | undefined) {
      const offer = (entry: HostEntry) => {
        if (epoch !== currentEpoch() || overflow === epoch) return;
        if (!Queue.offerUnsafe(queue, entry)) overflow = epoch;
      };
      const fail = (cause: unknown) => offer({ type: "failure", cause, epoch });
      host.connection.onNotification(({ method, params }) =>
        offer({ type: "notification", method, params, epoch }),
      );
      host.connection.onProtocolError(fail);
      host.connection.onServerRequest(async (request) => {
        if (request.method === "approval/request" || request.method === "userInput/request")
          return {};
        throw new Error(`Unsupported Muse server request: ${request.method}`);
      });
      void host.connection.closed.then(() =>
        fail(new Error("Muse connection closed unexpectedly")),
      );
      const reportExit = (exit: ProcessExit) => {
        if (epoch !== currentEpoch()) return;
        const reason = host
          .stderrTail?.()
          .findLast((line) => line.trim())
          ?.trim();
        fail(
          new Error(
            `Muse exited unexpectedly (${exit.code ?? exit.signal})${reason ? `: ${reason}` : ""}`,
          ),
        );
      };
      void host.exited.then(reportExit);
      return reportExit;
    },
    didOverflow(epoch: number) {
      if (overflow !== epoch) return false;
      overflow = undefined;
      return true;
    },
  };
});
