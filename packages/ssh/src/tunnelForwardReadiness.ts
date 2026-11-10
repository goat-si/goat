import * as NetService from "@goat/shared/Net";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

import { SshReadinessError } from "./errors.ts";
import { type SshReadinessBudget, waitForHttpReady } from "./sshReadiness.ts";

const FORWARD_PROBE_INTERVAL_MS = 100;

/**
 * ssh only binds the forward after it connects, which can take ConnectTimeout per dead
 * address, so the forward's own arrival is what readiness waits for first.
 */
export const waitForTunnelForward = Effect.fn("ssh/tunnel.waitForTunnelForward")(function* (input: {
  readonly alias: string;
  readonly localPort: number;
  readonly connectTimeoutMs: number;
}) {
  const net = yield* NetService.NetService;
  yield* net.hasListenerOnHost(input.localPort, "127.0.0.1").pipe(
    Effect.repeat({
      schedule: Schedule.spaced(Duration.millis(FORWARD_PROBE_INTERVAL_MS)),
      until: (listening) => listening,
    }),
    Effect.timeoutOrElse({
      duration: Duration.millis(input.connectTimeoutMs),
      orElse: () =>
        Effect.fail(
          new SshReadinessError({
            message: `SSH connection to ${input.alias} did not come up within ${input.connectTimeoutMs}ms.`,
          }),
        ),
    }),
  );
});

/** The forward must exist before its HTTP probe means anything. */
export const waitForTunnelReady = (input: {
  readonly alias: string;
  readonly localPort: number;
  readonly connectTimeoutMs: number;
  readonly httpBaseUrl: string;
  readonly readiness: SshReadinessBudget;
}) =>
  waitForTunnelForward(input).pipe(
    Effect.andThen(
      waitForHttpReady({
        baseUrl: input.httpBaseUrl,
        timeoutMs: input.readiness.timeoutMs,
        probeTimeoutMs: input.readiness.probeTimeoutMs,
      }),
    ),
  );
