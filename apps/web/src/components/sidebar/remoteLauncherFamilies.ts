import { scopeThreadRef, scopedThreadKey } from "@goat/client-runtime/environment";
import {
  enabledEnvironmentIds,
  type EnvironmentCatalogState,
} from "@goat/client-runtime/state/connections";
import type { EnvironmentThreadShell } from "@goat/client-runtime/state/models";
import { threadFamilyRead } from "@goat/client-runtime/state/threads";
import type { EnvironmentId, OrchestrationV2ThreadFamily, ThreadId } from "@goat/contracts";
import { foldsUnderLauncher } from "@goat/shared/threadLaunchState";
import { Atom, type AsyncResult, type AtomRegistry } from "effect/reactivity";

type LaunchedThread = Pick<
  EnvironmentThreadShell,
  "environmentId" | "id" | "lineage" | "archivedAt" | "deletedAt" | "pinnedAt"
> & {
  readonly source: Pick<EnvironmentThreadShell["source"], "launchedBy">;
};
interface LauncherRef {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly key: string;
}
interface Projection {
  readonly candidates: ReadonlyArray<LauncherRef>;
  readonly present: ReadonlySet<string>;
  readonly generations: ReadonlyMap<EnvironmentId, number>;
  readonly signature: string;
}
const keyOf = (environmentId: EnvironmentId, threadId: ThreadId) =>
  scopedThreadKey(scopeThreadRef(environmentId, threadId));

export function createRemoteLauncherFamilies(deps: {
  readonly threadsAtom: Atom.Atom<ReadonlyArray<LaunchedThread>>;
  readonly catalogAtom: Atom.Atom<EnvironmentCatalogState>;
  /** Zero until this connection has a current authoritative shell. */
  readonly readyGenerationAtom: (id: EnvironmentId) => Atom.Atom<number>;
  readonly familyAtom: (
    environmentId: EnvironmentId,
    threadId: ThreadId,
  ) => Atom.Atom<AsyncResult.AsyncResult<OrchestrationV2ThreadFamily, unknown>>;
  readonly mount: (
    registry: AtomRegistry.AtomRegistry,
    environmentId: EnvironmentId,
    threadId: ThreadId,
  ) => () => void;
}) {
  const projectionAtom = Atom.make((get): Projection => {
    const generations = new Map<EnvironmentId, number>();
    for (const id of enabledEnvironmentIds(get(deps.catalogAtom))) {
      const generation = get(deps.readyGenerationAtom(id));
      if (generation !== 0) generations.set(id, generation);
    }
    const threads = get(deps.threadsAtom);
    const refs = new Map<string, LauncherRef>();
    for (const thread of threads) {
      const launcher = thread.source.launchedBy;
      if (
        launcher === undefined ||
        !foldsUnderLauncher({ ...thread, launchedBy: launcher }) ||
        thread.archivedAt !== null ||
        thread.deletedAt !== null ||
        launcher.environmentId == null ||
        launcher.environmentId === thread.environmentId ||
        !generations.has(launcher.environmentId)
      )
        continue;
      const key = keyOf(launcher.environmentId, launcher.threadId);
      refs.set(key, { environmentId: launcher.environmentId, threadId: launcher.threadId, key });
    }
    const candidates = [...refs.values()].toSorted((a, b) => a.key.localeCompare(b.key));
    const present = new Set<string>();
    for (const thread of threads) {
      const key = keyOf(thread.environmentId, thread.id);
      if (refs.has(key)) present.add(key);
    }
    const signature = JSON.stringify([
      candidates.map((ref) => [ref.key, generations.get(ref.environmentId), present.has(ref.key)]),
    ]);
    const previous = get.self<Projection>();
    return previous._tag === "Some" && previous.value.signature === signature
      ? previous.value
      : { candidates, present, generations, signature };
  }).pipe(Atom.withLabel("web-remote-launcher-family-demand"));

  interface Mounted {
    readonly ref: LauncherRef;
    readonly generation: number;
    readonly release: () => void;
    readonly unsubscribe: () => void;
  }
  const owners = new WeakMap<AtomRegistry.AtomRegistry, { count: number; dispose: () => void }>();
  const start = (registry: AtomRegistry.AtomRegistry) => {
    const mounted = new Map<string, Mounted>();
    let syncing = false;
    let dirty = false;
    let stopped = false;
    const drop = (key: string) => {
      const entry = mounted.get(key);
      if (entry === undefined) return;
      mounted.delete(key);
      entry.unsubscribe();
      entry.release();
    };
    const sync = () => {
      if (stopped) return;
      if (syncing) {
        dirty = true;
        return;
      }
      syncing = true;
      try {
        do {
          dirty = false;
          // Presence schedules reads; only the remote child's demand keeps or releases a mount.
          const input = registry.get(projectionAtom);
          const wanted = new Set(input.candidates.map((ref) => ref.key));
          for (const [key, entry] of mounted) {
            if (
              !wanted.has(key) ||
              input.generations.get(entry.ref.environmentId) !== entry.generation
            )
              drop(key);
          }
          const busy = new Set<EnvironmentId>();
          for (const entry of mounted.values()) {
            if (
              threadFamilyRead(
                registry.get(deps.familyAtom(entry.ref.environmentId, entry.ref.threadId)),
              ) === "pending"
            )
              busy.add(entry.ref.environmentId);
          }
          for (const ref of input.candidates) {
            if (busy.has(ref.environmentId) || mounted.has(ref.key) || input.present.has(ref.key))
              continue;
            const release = deps.mount(registry, ref.environmentId, ref.threadId);
            const unsubscribe = registry.subscribe(
              deps.familyAtom(ref.environmentId, ref.threadId),
              sync,
            );
            mounted.set(ref.key, {
              ref,
              generation: input.generations.get(ref.environmentId) ?? 0,
              release,
              unsubscribe,
            });
            // Landed family rows can satisfy later candidates; always use the newest projection.
            dirty = true;
            break;
          }
        } while (dirty);
      } finally {
        syncing = false;
      }
    };
    const unsubscribe = registry.subscribe(projectionAtom, sync);
    sync();
    return () => {
      stopped = true;
      unsubscribe();
      for (const key of mounted.keys()) drop(key);
    };
  };
  return {
    projectionAtom,
    retain: (registry: AtomRegistry.AtomRegistry) => {
      let owner = owners.get(registry);
      if (owner === undefined) {
        owner = { count: 0, dispose: start(registry) };
        owners.set(registry, owner);
      }
      const held = owner;
      held.count++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        held.count--;
        if (held.count !== 0) return;
        // StrictMode re-retains in the same turn; keep its attempts and family mounts intact.
        queueMicrotask(() => {
          if (held.count !== 0 || owners.get(registry) !== held) return;
          owners.delete(registry);
          held.dispose();
        });
      };
    },
  };
}
