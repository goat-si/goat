// Two computers as this client sees them, and Threads' hide set over their threads, for the
// Home-governance tests. Test-only; the importing test mocks the environment presentations.
import { PrimaryConnectionTarget } from "@goat/client-runtime/connection";
import type { GoatBotEnsureState } from "@goat/client-runtime/goatBot";
import { createEnvironmentThreadShellAtoms } from "@goat/client-runtime/state/threads";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadShell,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";

import { goatBotHomeEnvironmentIdAtom } from "./goatBotHome";

export const A = EnvironmentId.make("computer-a");
export const B = EnvironmentId.make("computer-b");
export const claim = { environmentId: A, claimedAt: 1, claimId: "claim" };
const at = DateTime.makeUnsafe("2026-11-14T00:00:00.000Z");
const project = ProjectId.make("project");
const codex = ProviderInstanceId.make("codex");

function shell(id: string): OrchestrationV2ThreadShell {
  const threadId = ThreadId.make(id);
  return {
    id: threadId,
    projectId: project,
    title: id,
    providerInstanceId: codex,
    modelSelection: { instanceId: codex, model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    latestRunId: null,
    activeRunId: null,
    status: "idle",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

const snapshot: OrchestrationV2ShellSnapshot = {
  schemaVersion: 1,
  snapshotSequence: 0,
  projects: [],
  threads: [shell("coding"), shell("worker")],
  archivedThreads: [],
};

/** One machine as the connection layer presents it. */
export function machine(
  environmentId: EnvironmentId,
  options: { connected?: boolean; home?: typeof claim | null } = {},
) {
  return {
    environmentId,
    label: environmentId,
    connection: { phase: options.connected === false ? "disconnected" : "connected" },
    serverConfig: {
      environment: {
        label: environmentId,
        capabilities: { channelLedger: true, goatBotHome: true },
      },
      settings: { goatBotHome: options.home === undefined ? claim : options.home },
    },
  };
}

/** Threads' hide set over both computers, governed through the real goatBotHomeEnvironmentIdAtom. */
export function hiddenFromThreadsAtom() {
  const catalogValueAtom = Atom.make({
    isReady: true,
    entries: new Map(
      [A, B].map((id) => [
        id,
        {
          target: new PrimaryConnectionTarget({
            environmentId: id,
            label: id,
            httpBaseUrl: "https://example.test",
            wsBaseUrl: "wss://example.test",
          }),
          profile: Option.none(),
          enabled: true,
        },
      ]),
    ),
  });
  // Each computer's bot Home links a current task's coding thread; its worker is what the legacy
  // rule hides.
  const shells = createEnvironmentThreadShellAtoms({
    catalogValueAtom,
    snapshotAtom: Atom.family((_id: EnvironmentId) => Atom.make(snapshot)),
    goatBotHomeWork: Atom.family((computer: EnvironmentId) =>
      Atom.make({
        rosterKnown: true,
        byBot: [{ botId: "main" as never, eligible: true, list: "ready" as const }],
        links: [
          {
            taskId: "task" as never,
            environmentId: computer,
            threadId: ThreadId.make("coding"),
            kind: "coding" as const,
          },
        ],
      }),
    ),
    goatBotHomeEnvironmentId: goatBotHomeEnvironmentIdAtom,
    goatBotListedWork: ({ environmentIdsAtom }) =>
      Atom.make((get) =>
        get(environmentIdsAtom).map((id) => ({
          environmentId: id,
          threadId: ThreadId.make("worker"),
        })),
      ),
  });
  return shells.goatBotObservationThreadKeysAtom;
}

const key = (computer: EnvironmentId, id: string) => `${computer}:${id}`;
/** Computer A's Home governs: its coding thread hides, B keeps the legacy rule. */
export const GOVERNED = [key(A, "coding"), key(B, "worker")].toSorted();
/** dev's legacy set: each computer's worker only. */
export const LEGACY = [key(A, "worker"), key(B, "worker")].toSorted();
export const confirmed: GoatBotEnsureState = {
  state: "confirmed",
  bot: { environmentId: A, threadId: ThreadId.make("bot") },
};
