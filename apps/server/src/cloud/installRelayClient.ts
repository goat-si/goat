import {
  RelayClientInstallFailedError,
  type RelayClientInstallProgressEvent,
} from "@goat/contracts";
import { GOAT_CONNECT_COMING_SOON, isGoatConnectEnabled } from "@goat/shared/goatConnect";
import type { RelayClient } from "@goat/shared/relayClient";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

export const installRelayClient = (relayClient: RelayClient["Service"]) =>
  !isGoatConnectEnabled()
    ? Stream.fail(
        new RelayClientInstallFailedError({
          reason: "unsupported_platform",
          message: `${GOAT_CONNECT_COMING_SOON.title} is ${GOAT_CONNECT_COMING_SOON.status.toLowerCase()}. ${GOAT_CONNECT_COMING_SOON.description}`,
        }),
      )
    : Stream.callback<RelayClientInstallProgressEvent, RelayClientInstallFailedError>((queue) =>
        relayClient
          .installWithProgress((event) => Queue.offer(queue, event).pipe(Effect.asVoid))
          .pipe(
            Effect.flatMap((status) =>
              Queue.offer(queue, {
                type: "complete",
                status,
              }),
            ),
            Effect.catchTags({
              RelayClientInstallError: (error) =>
                Queue.fail(
                  queue,
                  new RelayClientInstallFailedError({
                    reason: error.reason,
                    message: error.message,
                  }),
                ),
            }),
            Effect.andThen(Queue.end(queue)),
            Effect.forkScoped,
          ),
      );
