import type { DesktopBridge } from "@goat/contracts";
import { classifyFleetThread } from "@goat/client-runtime/state/fleet";
import type { EnvironmentProject, EnvironmentThreadShell } from "@goat/client-runtime/state/models";
import { runAtomCommand } from "@goat/client-runtime/state/runtime";
import { sortPinnedThreadsByOrderKey } from "@goat/client-runtime/state/thread-sort";
import { EnvironmentId, ThreadId } from "@goat/contracts";
import type { AnyRouter } from "@tanstack/react-router";
import type { AtomRegistry } from "effect/reactivity";

import { toastManager } from "./components/ui/toast";
import { watchTrayComputerUse } from "./desktopTrayComputerUse";
import { requestNewThread } from "./newThreadRequests";
import { primaryEnvironmentIdAtom } from "./state/primaryEnvironment";
import { previewSessionsEnvironment } from "./state/previewSessions";
import { environmentProjects } from "./state/projects";
import { serverEnvironment } from "./state/server";
import { liveShellEnvironmentIdsAtom } from "./state/shell";
import { environmentThreadShells } from "./state/threads";

// Read through the bridge so the contracts index, which most tests import, stays untouched.
type DesktopTrayMenu = Parameters<NonNullable<DesktopBridge["setTrayMenu"]>>[0];
type DesktopTrayThread = DesktopTrayMenu["attention"][number];
type DesktopTrayAction = Parameters<Parameters<NonNullable<DesktopBridge["onTrayAction"]>>[0]>[0];

// The tray shows a handful; the cap keeps the IPC payload small however many threads exist.
const SECTION_LIMIT = 20;
// Titles have no length limit; the tray draws about 40 characters of one.
const TEXT_LIMIT = 200;

const bounded = (text: string) => Array.from(text).slice(0, TEXT_LIMIT).join("");

type TrayShell = Pick<
  EnvironmentThreadShell,
  | "environmentId"
  | "id"
  | "projectId"
  | "title"
  | "runtime"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "pendingSubagentRequest"
  | "pendingGuestMessageCount"
  | "pendingBackgroundTasks"
  | "archivedAt"
  | "deletedAt"
  | "sideChatOf"
  | "lineage"
  | "pinnedAt"
  | "pinOrderKey"
  | "createdAt"
  | "updatedAt"
>;

const newestFirst = (left: TrayShell, right: TrayShell) =>
  right.updatedAt.localeCompare(left.updatedAt);

/**
 * Attention and running follow Fleet, plus guest requests as in the sidebar, and only for
 * environments whose shells are live; a cached shell may describe a run that already ended.
 */
export function deriveTrayMenu(
  threads: ReadonlyArray<TrayShell>,
  projects: ReadonlyArray<Pick<EnvironmentProject, "environmentId" | "id" | "title">>,
  liveEnvironmentIds: ReadonlySet<EnvironmentId>,
): DesktopTrayMenu {
  const projectTitles = new Map(
    projects.map((project) => [`${project.environmentId}\u0000${project.id}`, project.title]),
  );
  const row = (thread: TrayShell): DesktopTrayThread => ({
    environmentId: thread.environmentId,
    threadId: thread.id,
    title: bounded(thread.title),
    project:
      bounded(projectTitles.get(`${thread.environmentId}\u0000${thread.projectId}`) ?? "") || null,
  });
  const attention: TrayShell[] = [];
  const running: TrayShell[] = [];
  const pinned: TrayShell[] = [];
  for (const thread of threads) {
    if (
      thread.archivedAt !== null ||
      thread.deletedAt !== null ||
      thread.sideChatOf != null ||
      thread.lineage.relationshipToParent === "subagent"
    ) {
      continue;
    }
    const live = liveEnvironmentIds.has(thread.environmentId);
    const state = live ? classifyFleetThread(thread) : null;
    if (state === "attention" || (live && (thread.pendingGuestMessageCount ?? 0) > 0)) {
      attention.push(thread);
    } else if (state === "running") {
      running.push(thread);
    } else if (thread.pinnedAt !== null) {
      pinned.push(thread);
    }
  }
  return {
    attention: attention.toSorted(newestFirst).slice(0, SECTION_LIMIT).map(row),
    running: running.toSorted(newestFirst).slice(0, SECTION_LIMIT).map(row),
    pinned: sortPinnedThreadsByOrderKey(pinned).slice(0, SECTION_LIMIT).map(row),
  };
}

/** Keeps the desktop tray menu in step with this window's threads, and opens the ones it picks. */
export function startDesktopTray(
  registry: AtomRegistry.AtomRegistry,
  router: AnyRouter,
): () => void {
  const bridge = window.desktopBridge;
  const setTrayMenu = bridge?.setTrayMenu;
  if (bridge === undefined || setTrayMenu === undefined) return () => {};

  let sent: string | null = null;
  let scheduled = false;
  // Several atoms settle in one burst when an environment connects; send once for all of them.
  let publish = () => {};
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => publish());
  };
  const computerUse = watchTrayComputerUse(
    registry,
    {
      primary: primaryEnvironmentIdAtom,
      live: liveShellEnvironmentIdsAtom,
      sessions: (environmentId) =>
        previewSessionsEnvironment.sessions({ environmentId, input: {} }),
      apps: (environmentId) => serverEnvironment.computerUseApps({ environmentId, input: {} }),
    },
    schedule,
  );
  publish = () => {
    scheduled = false;
    const menu = {
      ...deriveTrayMenu(
        registry.get(environmentThreadShells.quietThreadShellsAtom),
        registry.get(environmentProjects.projectsAtom),
        registry.get(liveShellEnvironmentIdsAtom),
      ),
      computerUse: computerUse.current(),
    };
    const key = JSON.stringify(menu);
    if (key === sent) return;
    sent = key;
    void setTrayMenu(menu).catch(() => {
      sent = null;
    });
  };

  // The thread route waits for its environment's shells, so a fresh window can navigate at once.
  const onAction = (action: DesktopTrayAction) => {
    if (action.kind === "stop-computer-use" || action.kind === "stop-all-computer-use") {
      void computerUse.run(action, {
        control: (environmentId, input) =>
          runAtomCommand(registry, previewSessionsEnvironment.control, { environmentId, input }),
        notify: (copy, stopAll) => {
          const id = toastManager.add({
            type: "error",
            ...copy,
            actionProps: {
              children: "Stop all",
              onClick: () => {
                toastManager.close(id);
                void stopAll();
              },
            },
          });
        },
        reveal: () => {
          void window.desktopBridge?.revealWindow?.().catch(() => undefined);
        },
      });
      return;
    }
    if (action.kind === "new-thread") {
      requestNewThread();
      return;
    }
    void router.navigate({
      to: "/$environmentId/$threadId",
      params: {
        environmentId: EnvironmentId.make(action.environmentId),
        threadId: ThreadId.make(action.threadId),
      },
    });
  };

  const unsubscribes = [
    registry.subscribe(environmentThreadShells.quietThreadShellsAtom, schedule),
    registry.subscribe(environmentProjects.projectsAtom, schedule),
    registry.subscribe(liveShellEnvironmentIdsAtom, schedule),
    bridge.onTrayAction?.(onAction) ?? (() => {}),
    computerUse.dispose,
  ];
  schedule();
  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}
