import { Atom } from "effect/reactivity";
import type { ThreadResumeCache } from "./threadResumeCache.ts";

const THREAD_SNAPSHOT_IDLE_TTL_MS = 5 * 60_000;
const THREAD_SNAPSHOT_IDLE_LIMIT = 10;

export function createThreadRetention<K>(limit: number) {
  const inactive = new Map<K, () => void>();
  return {
    activate(key: K, evict: () => void) {
      inactive.delete(key);
      return () => {
        inactive.delete(key);
        inactive.set(key, evict);
        while (inactive.size > limit) {
          const oldest = inactive.entries().next();
          if (oldest.done) break;
          inactive.delete(oldest.value[0]);
          oldest.value[1]();
        }
      };
    },
    forget(key: K) {
      inactive.delete(key);
    },
  };
}

function createRegistryThreadRetention<K>(limit: number) {
  const registries = new WeakMap<object, ReturnType<typeof createThreadRetention<K>>>();
  return (registry: object) => {
    let retention = registries.get(registry);
    if (!retention) {
      retention = createThreadRetention<K>(limit);
      registries.set(registry, retention);
    }
    return retention;
  };
}

export function createThreadResumeRetention() {
  const retentionFor = createRegistryThreadRetention<ThreadResumeCache>(THREAD_SNAPSHOT_IDLE_LIMIT);
  const family = Atom.family((key: string) =>
    Atom.make((get): ThreadResumeCache => {
      const resume: ThreadResumeCache = { snapshot: undefined, owner: undefined };
      get.addFinalizer(() => retentionFor(get.registry).forget(resume));
      return resume;
    }).pipe(
      Atom.setIdleTTL(THREAD_SNAPSHOT_IDLE_TTL_MS),
      Atom.withLabel(`environment-thread-resume:${key}`),
    ),
  );
  return {
    family,
    activate: (registry: object, resume: ThreadResumeCache) =>
      retentionFor(registry).activate(resume, () => {
        resume.snapshot = undefined;
      }),
  };
}
