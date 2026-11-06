import { parseThreadKey, threadKey } from "@goat/client-runtime/state/entities";
import { createThreadVisitTracker } from "@goat/client-runtime/state/thread-visits";
import { threadWokeAt } from "@goat/client-runtime/state/thread-settled";
import { Atom } from "effect/reactivity";
import { environmentThreadShells, threadEnvironment } from "../../state/threads";

// A scheduled wake can happen without a newer server update, so the tracker
// is told when one takes effect. The shell's updatedAt ticks while a run
// streams; the tracker follows it outside React.
const wakeAwareVisitShell = Atom.family((key: string) => {
  const ref = parseThreadKey(key);
  return Atom.make((get) => {
    const shell = get(environmentThreadShells.threadShellAtom(ref));
    if (shell === null) return null;
    const nowMs = Date.now();
    const wokeAt = threadWokeAt(shell, { now: new Date(nowMs).toISOString() });
    const wakeAtMs = shell.snoozedUntil == null ? NaN : Date.parse(shell.snoozedUntil);
    if (wokeAt === null && wakeAtMs > nowMs) {
      const timer = setTimeout(
        () => get.refreshSelf(),
        Math.min(wakeAtMs - nowMs + 50, 2_147_483_647),
      );
      get.addFinalizer(() => clearTimeout(timer));
    }
    return { ...shell, wokeAt };
  }).pipe(Atom.withLabel(`mobile-thread-visit-shell:${key}`));
});
export const threadVisitTracker = createThreadVisitTracker({
  threadShellAtom: (ref) => wakeAwareVisitShell(threadKey(ref)),
  visit: threadEnvironment.visit,
});
