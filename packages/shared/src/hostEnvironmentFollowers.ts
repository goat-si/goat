import { SHELL_DISCOVERY_PENDING_ENV } from "./cliPath.ts";

const FOLLOWED = ["PATH", SHELL_DISCOVERY_PENDING_ENV] as const;
type Followed = Partial<Record<(typeof FOLLOWED)[number], string | undefined>>;

interface Follower {
  readonly copy: WeakRef<NodeJS.ProcessEnv>;
  /** The host values this copy was made from, then the ones it was last given. */
  readonly seen: Followed;
}

/** One set of remembered copies. The server uses the shared one below; tests make their own. */
export function makeHostEnvironmentFollowers() {
  // Weak on both sides: a copy nobody holds is collected, and its entry leaves with it.
  const followers = new Set<Follower>();
  const known = new WeakSet<NodeJS.ProcessEnv>();
  const collected = new FinalizationRegistry<Follower>((follower) => followers.delete(follower));

  const follow = (copy: NodeJS.ProcessEnv, source: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
    if (source[SHELL_DISCOVERY_PENDING_ENV] !== "1" || known.has(copy)) return copy;
    const follower: Follower = {
      copy: new WeakRef(copy),
      seen: Object.fromEntries(FOLLOWED.map((name) => [name, source[name]])),
    };
    followers.add(follower);
    known.add(copy);
    collected.register(copy, follower);
    return copy;
  };

  const sync = (before: Followed, host: NodeJS.ProcessEnv): number => {
    let changed = 0;
    for (const follower of followers) {
      const copy = follower.copy.deref();
      if (copy === undefined) {
        followers.delete(follower);
        continue;
      }
      let touched = false;
      for (const name of FOLLOWED) {
        const next = host[name];
        if (follower.seen[name] !== before[name] || copy[name] !== before[name]) continue;
        follower.seen[name] = next;
        if (next === before[name]) continue;
        if (next === undefined) delete copy[name];
        else copy[name] = next;
        touched = true;
      }
      if (touched) changed++;
    }
    return changed;
  };

  return { follow, sync };
}

const shared = makeHostEnvironmentFollowers();

/**
 * Remembers a plain copy a provider made of the host environment, so the PATH a login shell
 * reports later can reach it. Only a copy made while discovery is pending is kept: the desktop
 * changes the server's PATH at no other time. Returns the copy unchanged.
 */
export const followHostEnvironment = shared.follow;

/**
 * Gives every remembered copy the host's new PATH and pending flag, where the copy still holds
 * the host value it was made from. A copy that set its own value, or had it changed, is left
 * alone, and no other variable is touched. Returns how many copies changed.
 */
export const syncHostEnvironmentFollowers = shared.sync;
