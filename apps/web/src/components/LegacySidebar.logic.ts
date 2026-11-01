import type {
  ConnectionCatalogEntry,
  EnvironmentConnectionPhase,
  EnvironmentPresentation,
} from "@goat/client-runtime/connection";
import type { EnvironmentId } from "@goat/contracts";
import { isSideChatThread } from "@goat/contracts";
import { scopedProjectKey, scopeProjectRef } from "@goat/client-runtime/environment";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import { isDesktopLocalConnectionTarget, isWslConnectionTarget } from "../connection/desktopLocal";
import type { SidebarProjectSnapshot } from "../sidebarProjectGrouping";
import type { SidebarThreadSummary } from "../types";

interface ProjectEnvironmentMetadata {
  readonly label: string;
  readonly desktopLocal: boolean;
  readonly wsl: boolean;
}

/** Project identity must not change with transport progress or provider/config refreshes. */
export function createProjectsViewEnvironmentAtoms(input: {
  catalogAtom: Atom.Atom<{
    readonly entries: ReadonlyMap<EnvironmentId, Pick<ConnectionCatalogEntry, "target">>;
  }>;
  presentationsAtom: Atom.Atom<
    ReadonlyMap<EnvironmentId, Pick<EnvironmentPresentation, "connection">>
  >;
}) {
  const metadataAtom = Atom.make((get) => {
    const next = new Map<EnvironmentId, ProjectEnvironmentMetadata>();
    for (const [environmentId, entry] of get(input.catalogAtom).entries) {
      next.set(environmentId, {
        label: entry.target.label,
        desktopLocal: isDesktopLocalConnectionTarget(entry.target),
        wsl: isWslConnectionTarget(entry.target),
      });
    }
    const previous = Option.getOrNull(
      get.self<ReadonlyMap<EnvironmentId, ProjectEnvironmentMetadata>>(),
    );
    return previous !== null &&
      previous.size === next.size &&
      [...next].every(([id, value]) => {
        const old = previous.get(id);
        return (
          old?.label === value.label &&
          old.desktopLocal === value.desktopLocal &&
          old.wsl === value.wsl
        );
      })
      ? previous
      : next;
  });
  const connectionPhasesAtom = Atom.make((get) => {
    const next = new Map<EnvironmentId, EnvironmentConnectionPhase>();
    for (const [id, environment] of get(input.presentationsAtom)) {
      next.set(id, environment.connection.phase);
    }
    const previous = Option.getOrNull(
      get.self<ReadonlyMap<EnvironmentId, EnvironmentConnectionPhase>>(),
    );
    return previous !== null &&
      previous.size === next.size &&
      [...next].every(([id, phase]) => previous.get(id) === phase)
      ? previous
      : next;
  });
  return { metadataAtom, connectionPhasesAtom };
}

/**
 * The project group each registered project belongs to, by scoped project key. Member refs
 * include duplicate registrations of one folder, which share their winner's display row.
 */
export function projectsViewProjectKeyByScopedRef(
  projects: ReadonlyArray<Pick<SidebarProjectSnapshot, "projectKey" | "memberProjectRefs">>,
): ReadonlyMap<string, string> {
  return new Map(
    projects.flatMap((project) =>
      project.memberProjectRefs.map(
        (ref) =>
          [
            scopedProjectKey(scopeProjectRef(ref.environmentId, ref.projectId)),
            project.projectKey,
          ] as const,
      ),
    ),
  );
}

/** Forks are standalone chats; subagents belong to their parent's Agents surface. */
export function isProjectsViewPinnedThread(
  thread: Pick<
    SidebarThreadSummary,
    "pinnedAt" | "archivedAt" | "deletedAt" | "lineage" | "sideChatOf"
  >,
) {
  return (
    thread.pinnedAt != null &&
    thread.archivedAt === null &&
    thread.deletedAt === null &&
    thread.lineage.relationshipToParent !== "subagent" &&
    !isSideChatThread(thread)
  );
}

/**
 * Rows under a project: live, unpinned, and never a subagent in any state. An open
 * subagent shows beneath its owner row instead. An archived owner stays when it
 * still carries a child's request or the open subagent.
 */
export function isProjectsViewListedThread(
  thread: Pick<
    SidebarThreadSummary,
    "pinnedAt" | "archivedAt" | "deletedAt" | "lineage" | "sideChatOf"
  >,
  retainArchived = false,
) {
  if (thread.lineage.relationshipToParent === "subagent" || isSideChatThread(thread)) return false;
  if (thread.archivedAt !== null) return retainArchived && thread.deletedAt === null;
  return !isProjectsViewPinnedThread(thread);
}

/**
 * A project's collapsed preview. When the open subagent's owner row falls past the
 * limit, it is kept (in list order) so the open subagent stays visible beneath it.
 */
export function resolveProjectsViewPreview<T>(
  threads: readonly T[],
  previewCount: number,
  ownerKey: string | null,
  keyOf: (thread: T) => string,
): T[] {
  const preview = threads.slice(0, previewCount);
  if (ownerKey === null) return preview;
  const ownerIndex = threads.findIndex((thread) => keyOf(thread) === ownerKey);
  const owner = threads[ownerIndex];
  return owner === undefined || ownerIndex < previewCount ? preview : [...preview, owner];
}

/** Keyboard jumps, traversal and range selection share the displayed order, with pins once. */
export function resolveProjectsViewThreadOrder(
  pinnedKeys: readonly string[],
  projectKeys: readonly string[],
) {
  return [...new Set([...pinnedKeys, ...projectKeys])];
}

/** A grouped remote project reports the least healthy member connection. */
export function resolveProjectConnectionStatus(phases: readonly EnvironmentConnectionPhase[]) {
  if (
    phases.length === 0 ||
    phases.some((phase) => ["available", "offline", "error", "unsupported"].includes(phase))
  )
    return "disconnected";
  if (phases.some((phase) => phase !== "connected")) return "connecting";
  return "connected";
}

/** Local rows receive a stable null prop through remote connection churn. */
export function resolveProjectsViewProjectConnectionStatus(
  project: {
    readonly memberProjects: ReadonlyArray<
      Pick<SidebarProjectSnapshot["memberProjects"][number], "environmentId">
    >;
  },
  primaryEnvironmentId: EnvironmentId | null,
  phaseByEnvironmentId: ReadonlyMap<EnvironmentId, EnvironmentConnectionPhase>,
) {
  const remoteMembers = project.memberProjects.filter(
    (member) => member.environmentId !== primaryEnvironmentId,
  );
  return remoteMembers.length === 0
    ? null
    : resolveProjectConnectionStatus(
        remoteMembers.map((member) => phaseByEnvironmentId.get(member.environmentId) ?? "offline"),
      );
}
