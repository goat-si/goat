import type { EnvironmentId as EnvironmentIdType } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom } from "effect/reactivity";
import type { SupervisorConnectionState } from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type * as RpcSession from "../rpc/session.ts";
import { followStreamInEnvironment } from "./environmentStreams.ts";

type EnvironmentConnection = readonly [
  SupervisorConnectionState,
  Option.Option<RpcSession.RpcSession>,
];

const connectionAtomsByRuntime = new WeakMap<
  object,
  (
    environmentId: EnvironmentIdType,
  ) => Atom.Atom<AsyncResult.AsyncResult<EnvironmentConnection | null>>
>();

// Queries and reconnect listeners must observe the same connection update.
export function environmentConnectionAtoms<R, ER>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, ER>,
) {
  const existing = connectionAtomsByRuntime.get(runtime);
  if (existing !== undefined) return existing;
  const family = Atom.family((environmentId: EnvironmentIdType) =>
    runtime.atom(
      followStreamInEnvironment(
        environmentId,
        Stream.unwrap(
          EnvironmentSupervisor.EnvironmentSupervisor.pipe(
            Effect.map((supervisor) =>
              SubscriptionRef.changes(supervisor.state).pipe(
                Stream.zipLatest(SubscriptionRef.changes(supervisor.session)),
              ),
            ),
          ),
        ),
      ),
      { initialValue: null },
    ),
  ) as (
    environmentId: EnvironmentIdType,
  ) => Atom.Atom<AsyncResult.AsyncResult<EnvironmentConnection | null>>;
  connectionAtomsByRuntime.set(runtime, family);
  return family;
}

const sessionGenerationAtomsByRuntime = new WeakMap<
  object,
  (environmentId: EnvironmentIdType) => Atom.Atom<number>
>();

// Session identity survives generation counters restarting when a supervisor is replaced.
export function environmentSessionGenerationAtom<R, ER>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, ER>,
  environmentId: EnvironmentIdType,
): Atom.Atom<number> {
  let family = sessionGenerationAtomsByRuntime.get(runtime);
  if (family === undefined) {
    const connectionAtom = environmentConnectionAtoms(runtime);
    const sessionsSeen = Atom.family((id: EnvironmentIdType) =>
      Atom.make(
        (get): { readonly session: RpcSession.RpcSession | null; readonly count: number } => {
          const previous = Option.getOrElse(
            get.self<{ readonly session: RpcSession.RpcSession | null; readonly count: number }>(),
            () => ({ session: null, count: 0 }),
          );
          const connection = Option.getOrNull(AsyncResult.value(get(connectionAtom(id))));
          if (connection === null || connection[0].phase !== "connected") return previous;
          const session = Option.getOrNull(connection[1]);
          return session === null || session === previous.session
            ? previous
            : { session, count: previous.count + 1 };
        },
      ),
    );
    family = Atom.family((id: EnvironmentIdType) =>
      Atom.make((get) => get(sessionsSeen(id)).count).pipe(
        Atom.withLabel(`environment-session-generation:${id}`),
      ),
    );
    sessionGenerationAtomsByRuntime.set(runtime, family);
  }
  return family(environmentId);
}
