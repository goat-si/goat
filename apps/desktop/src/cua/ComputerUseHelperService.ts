// @effect-diagnostics nodeBuiltinImport:off -- Session tokens come from Node's CSPRNG and liveness from a signal-0 probe.
import * as NodeCrypto from "node:crypto";

import type { HelperSession } from "./ComputerUseHelper.ts";

/** What the manager needs of an open helper service. */
type ServiceSession = Pick<
  HelperSession,
  "pid" | "ended" | "close" | "openSession" | "stopSession" | "closeSession"
>;

/** One running helper service of a channel, the parent of the drivers it starts. */
export interface HelperService<S extends ServiceSession = HelperSession> {
  readonly pid: number;
  /** The real path of the executable it was launched from. */
  readonly executable: string;
  /** Counts the services this manager started; a replacement always has a higher one. */
  readonly generation: number;
  readonly session: S;
  /** The service has exited; it is never handed out again. */
  readonly ended: () => boolean;
}

/** A desktop host's or an agent session's hold on a service. */
export interface HelperServiceClaim<S extends ServiceSession = HelperSession> {
  readonly service: HelperService<S>;
  readonly owner: string;
  /** Names this claim alone, so one session can never act as another. */
  readonly token: string;
  /** Idempotent. A service ends with its last claim. */
  readonly release: () => Promise<void>;
}

/**
 * What an agent connection needs to attach to its session on the channel's service (stage c):
 * the socket, this launch's token and the session's own, and the service it must find there.
 */
export interface AgentSessionDescriptor {
  readonly sessionId: string;
  readonly socketPath: string;
  readonly launch: string;
  readonly token: string;
  readonly servicePid: number;
  readonly generation: number;
  readonly executable: string;
}

/** One agent session's hold on the channel's service. */
export interface AgentSession {
  /** Rejects when the session could not be opened, or was closed first. */
  readonly opened: Promise<AgentSessionDescriptor>;
  /**
   * Ends the driver the session runs, and no other session's; the session may attach again. Before
   * it has opened nothing runs, so it returns at once.
   */
  readonly stop: () => Promise<void>;
  /** Idempotent. Cancels an open still running, forgets the session and releases its claim. */
  readonly close: () => Promise<void>;
}

const unlessAborted = async <A>(promise: Promise<A>, signal: AbortSignal): Promise<A> => {
  let cancel: () => void = () => undefined;
  const aborted = new Promise<never>((_, reject) => {
    cancel = () => reject(signal.reason);
    if (signal.aborted) cancel();
    else signal.addEventListener("abort", cancel, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
};

const processAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * The single owner of one channel's helper service (ADR-0023 D3 amendment 3). Claims run one at
 * a time; a live service from the same executable is reused, any other replaced, and observers
 * (hosts that own its watch and captures) never share one. A replaced service is never killed:
 * it serves its claims and stops with the last. One manager serves one bundle id.
 */
export function makeHelperServiceManager<S extends ServiceSession = HelperSession>(options: {
  /** Opens a service; an aborted signal should end a launch that has not answered yet. */
  readonly open: (executable: string, signal?: AbortSignal) => Promise<S>;
  readonly alive?: (pid: number) => boolean;
}) {
  interface Running {
    readonly service: HelperService<S>;
    readonly claims: Set<HelperServiceClaim<S>>;
    observer?: HelperServiceClaim<S> | undefined;
    stopping?: Promise<void>;
  }
  const alive = options.alive ?? processAlive;
  const sessions = new Map<string, HelperServiceClaim<S>>();
  let current: Running | undefined;
  let generation = 0;
  let queue: Promise<unknown> = Promise.resolve();
  const serialized = <A>(run: () => Promise<A>): Promise<A> => {
    const result = queue.then(run);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const stopIfUnclaimed = async (running: Running) => {
    if (running.claims.size > 0) return;
    if (current === running) current = undefined;
    running.stopping ??= running.service.session.close();
    await running.stopping;
  };
  const start = async (executable: string, signal?: AbortSignal): Promise<Running> => {
    const session = await options.open(executable, signal);
    let ended = false;
    void session.ended.then(() => {
      ended = true;
    });
    const running: Running = {
      service: {
        pid: session.pid,
        executable,
        generation: ++generation,
        session,
        ended: () => ended,
      },
      claims: new Set(),
    };
    current = running;
    return running;
  };
  const manager = {
    /**
     * An observing claim gets a service no other observer holds. A claim whose signal aborts
     * first rejects with its reason and holds nothing. Waiting for its turn, it rejects at once
     * and its turn does nothing; once its turn began, the cancelled open and the close of a
     * service it started finish first.
     */
    claim: (
      executable: string,
      owner: string,
      claimOptions: { readonly observe?: boolean; readonly signal?: AbortSignal } = {},
    ) => {
      const signal = claimOptions.signal;
      let begun = false;
      const claimed = serialized(async (): Promise<HelperServiceClaim<S>> => {
        begun = true;
        signal?.throwIfAborted();
        let running = current;
        if (
          running &&
          (running.service.ended() ||
            running.service.executable !== executable ||
            !alive(running.service.pid) ||
            (claimOptions.observe === true && running.observer !== undefined))
        ) {
          current = undefined;
          await stopIfUnclaimed(running);
          running = undefined;
        }
        running ??= await start(executable, signal);
        if (signal?.aborted) {
          await stopIfUnclaimed(running);
          signal.throwIfAborted();
        }
        const owned = running;
        const token = NodeCrypto.randomBytes(32).toString("base64url");
        const claim: HelperServiceClaim<S> = {
          service: owned.service,
          owner,
          token,
          // Not queued behind claims: a stop never waits for another service's start. A claim
          // decides on reuse and adds itself with no await between, so this cannot split it.
          release: async () => {
            if (!owned.claims.delete(claim)) return;
            sessions.delete(token);
            if (owned.observer === claim) {
              owned.observer = undefined;
              // What it watched and captured may still run, so no later claim inherits it.
              if (current === owned) current = undefined;
            }
            await stopIfUnclaimed(owned);
          },
        };
        owned.claims.add(claim);
        if (claimOptions.observe) owned.observer = claim;
        sessions.set(token, claim);
        return claim;
      });
      if (!signal) return claimed;
      return new Promise<HelperServiceClaim<S>>((resolve, reject) => {
        let settled = false;
        const cancel = () => {
          if (settled || begun) return;
          settled = true;
          reject(signal.reason);
        };
        if (signal.aborted) cancel();
        else signal.addEventListener("abort", cancel, { once: true });
        claimed.then(
          (claim) => {
            signal.removeEventListener("abort", cancel);
            settled = true;
            resolve(claim);
          },
          (error: unknown) => {
            signal.removeEventListener("abort", cancel);
            if (settled) return;
            settled = true;
            reject(error);
          },
        );
      });
    },
    /** The live claim a token names, or undefined. */
    sessionFor: (token: string) => sessions.get(token),
    /**
     * Opens an agent session on the channel's service, claimed like any other session, so racing
     * opens share one service and its last close ends it. The session's token is its claim's.
     */
    openAgentSession: (
      executable: string,
      owner: string,
      params: Pick<Parameters<S["openSession"]>[0], "capabilityManifestPath" | "environment">,
    ): AgentSession => {
      const abort = new AbortController();
      const sessionId = NodeCrypto.randomBytes(16).toString("base64url");
      let held: HelperServiceClaim<S> | undefined;
      let descriptor: AgentSessionDescriptor | undefined;
      let closing: Promise<void> | undefined;
      const opened = (async (): Promise<AgentSessionDescriptor> => {
        const claim = await manager.claim(executable, owner, { signal: abort.signal });
        held = claim;
        abort.signal.throwIfAborted();
        const session = await unlessAborted(
          claim.service.session.openSession({ sessionId, token: claim.token, ...params }),
          abort.signal,
        );
        descriptor = {
          sessionId,
          socketPath: session.socketPath,
          launch: session.launch,
          token: claim.token,
          servicePid: session.servicePid,
          generation: claim.service.generation,
          executable,
        };
        return descriptor;
      })();
      const close = () =>
        (closing ??= (async () => {
          abort.abort(new Error("The agent session was closed."));
          await opened.catch(() => undefined);
          const claim = held;
          if (!claim) return;
          // Sent even when the open failed or was cancelled: the service reads its channel in
          // order, so this undoes an open that is still on its way.
          await claim.service.session.closeSession(sessionId).catch(() => undefined);
          await claim.release();
        })());
      // An open that fails holds nothing.
      void opened.catch(close);
      return {
        opened,
        stop: async () => {
          if (descriptor === undefined || closing !== undefined || held === undefined) return;
          await held.service.session.stopSession(sessionId);
        },
        close,
      };
    },
  };
  return manager;
}

export type HelperServiceManager = ReturnType<typeof makeHelperServiceManager<HelperSession>>;

/** One manager per channel (bundle id), made on its first claim and kept for the next. */
export const managerPerChannel = <B extends { readonly bundleId: string }>(
  make: (bundle: B) => HelperServiceManager,
) => {
  const managers = new Map<string, HelperServiceManager>();
  return (bundle: B) => {
    const known = managers.get(bundle.bundleId);
    if (known) return known;
    const made = make(bundle);
    managers.set(bundle.bundleId, made);
    return made;
  };
};
