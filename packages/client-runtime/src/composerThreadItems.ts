import type { EnvironmentId, HubNode, ScopedThreadRef, ThreadId } from "@goat/contracts";
import { foldSearchQuery, rankSearchItems, scoreThreadSearch } from "@goat/shared/paletteSearch";

import type { EnvironmentThreadShell } from "./state/models.ts";
import { threadSearchSubject, type ThreadSearchShell } from "./state/threadSearch.ts";

const COMPOSER_THREAD_RESULT_LIMIT = 5;

export class ComposerThreadHosts extends Map<EnvironmentId, string> {
  private readonly aliases = new Map<string, EnvironmentId>();
  allow(id: EnvironmentId, host: string) {
    this.aliases.set(host, id);
  }
  allows(id: EnvironmentId, host: string) {
    return this.aliases.get(host) === id;
  }
}

export function composerThreadHosts(input: {
  readonly nodes: ReadonlyArray<HubNode>;
  readonly mounted: ReadonlySet<EnvironmentId>;
  readonly sshHosts: ReadonlyMap<EnvironmentId, string>;
}): ComposerThreadHosts {
  const names = new Map<string, Set<EnvironmentId | null>>();
  const remember = (name: string, id: EnvironmentId | null) => {
    const ids = names.get(name) ?? new Set<EnvironmentId | null>();
    ids.add(id);
    names.set(name, ids);
  };
  for (const [id, host] of input.sshHosts) remember(host, id);
  for (const node of input.nodes)
    for (const route of node.routes) {
      if (route.target.kind === "linked") remember(route.target.name, node.environmentId);
      if (route.target.kind === "ssh") remember(route.target.alias, node.environmentId);
    }
  const safe = (name: string, id: EnvironmentId) => {
    const ids = names.get(name);
    return ids?.size === 1 && ids.has(id);
  };
  const result = new ComposerThreadHosts();
  for (const [id, host] of input.sshHosts) {
    const node = input.nodes.find((candidate) => candidate.environmentId === id);
    if (input.mounted.has(id) && node?.status !== "offline" && safe(host, id)) {
      result.allow(id, host);
      result.set(id, host);
    }
  }
  for (const node of input.nodes) {
    const id = node.environmentId;
    if (id === null || !input.mounted.has(id) || node.status === "offline") continue;
    for (const route of node.routes) {
      if (route.status !== "online") continue;
      const host =
        route.target.kind === "linked"
          ? route.target.name
          : route.target.kind === "ssh"
            ? route.target.alias
            : null;
      if (host === null || !safe(host, id)) continue;
      result.allow(id, host);
      if (route.target.kind === "linked" && !result.has(id)) result.set(id, host);
    }
  }
  return result;
}

export type ComposerThreadCandidate = ThreadSearchShell &
  Pick<EnvironmentThreadShell, "archivedAt" | "lineage">;

export interface ComposerThreadItem {
  readonly id: string;
  readonly type: "thread";
  readonly thread: ScopedThreadRef;
  readonly label: string;
  readonly description: string;
}

/**
 * Threads to reference from the composer, matched and ranked like the command palette, without
 * subagent threads. Foreign candidates require an SSH route settled by the caller for this agent.
 */
export function matchComposerThreadItems(input: {
  shells: ReadonlyArray<ComposerThreadCandidate>;
  environmentId: EnvironmentId;
  excludeThreadId: ThreadId | null;
  query: string;
  /** Recency is measured against this time. */
  now: number;
  sshHostsByEnvironment?: ReadonlyMap<EnvironmentId, string>;
}): ComposerThreadItem[] {
  const query = foldSearchQuery(input.query);
  if (query.length === 0) return [];
  const candidates = input.shells.filter(
    (shell) =>
      (shell.environmentId === input.environmentId ||
        input.sshHostsByEnvironment?.has(shell.environmentId)) &&
      !(shell.environmentId === input.environmentId && shell.id === input.excludeThreadId) &&
      shell.archivedAt === null &&
      shell.lineage.relationshipToParent !== "subagent",
  );
  return rankSearchItems(candidates, (shell, options) =>
    scoreThreadSearch(query, threadSearchSubject(shell, null), input.now, {
      ...options,
      picks: false,
    }),
  )
    .slice(0, COMPOSER_THREAD_RESULT_LIMIT)
    .map(({ item: shell }) => ({
      id: `thread:${shell.environmentId}:${shell.id}`,
      type: "thread",
      thread: { environmentId: shell.environmentId, threadId: shell.id },
      label: shell.title,
      description:
        shell.environmentId === input.environmentId
          ? "Thread"
          : `Thread · ${input.sshHostsByEnvironment?.get(shell.environmentId)}`,
    }));
}
