import * as Effect from "effect/Effect";

/**
 * Whether this process may open SSH to other machines. Process-wide rather than a Context
 * reference: a server sets it once at start, and no fiber, layer or captured context can then
 * see SSH as allowed again.
 */
let refusal: string | undefined;

export const DEV_SSH_REFUSAL =
  "SSH to other machines is off on this dev server. Restart it with GOAT_DEV_SSH=on to test remote features.";

export const refuseSshHosts = (message: string) =>
  Effect.sync(() => {
    refusal = message;
  });

export const allowSshHosts = Effect.sync(() => {
  refusal = undefined;
});

/** The reason SSH is refused in this process, or undefined while it is allowed. */
export const sshHostsRefusal = Effect.sync(() => refusal);

/** For tests: refuses SSH for the scope, then allows it again. */
export const refuseSshHostsScoped = (message: string = DEV_SSH_REFUSAL) =>
  Effect.acquireRelease(refuseSshHosts(message), () => allowSshHosts);
