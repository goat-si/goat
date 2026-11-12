import { PrimaryConnectionTarget } from "@goat/client-runtime/connection";
import { createEnvironmentThreadShellAtoms } from "@goat/client-runtime/state/threads";
import { createEnvironmentSnapshotAtom, EMPTY_SHELL_STATE } from "@goat/client-runtime/state/shell";
import {
  v2ShellSnapshot,
  v2ThreadShell,
} from "../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures";
import { EnvironmentId, ThreadId } from "@goat/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

vi.mock("expo-file-system", () => ({
  Directory: class {
    create() {}
  },
  File: class {
    create() {}
  },
  Paths: { document: { uri: "file:///documents" } },
}));
vi.mock("../lib/uuid", () => ({ uuidv4: () => "uuid", randomHex: () => "0000" }));
vi.mock("./assets", () => ({ assetEnvironment: {} }));
vi.mock("./attachments", () => ({ attachmentEnvironment: {} }));
vi.mock("./session", () => ({ environmentSession: {} }));
vi.mock("@goat/client-runtime/state/runtime", () => ({
  createEnvironmentRpcCommand: () => Symbol("rpc-command"),
  executeAtomQuery: () => {
    throw new Error("unexpected query");
  },
  runAtomCommand: () => {
    throw new Error("unexpected command");
  },
}));
vi.mock("../lib/attachmentUpload", () => ({ releasePendingAttachmentUploads: async () => {} }));
vi.mock("../features/sharing/incoming-share-storage", () => ({
  loadIncomingShareDrafts: async () => [],
}));

import {
  getComposerDraftSnapshot,
  subscribeComposerDraftModelReconciliation,
  updateComposerDraftSettings,
} from "./use-composer-drafts";

it("keeps the latest model pick for a send while an older save is pending", () => {
  const environmentId = EnvironmentId.make("pending-model-env");
  const threadId = ThreadId.make("pending-model-thread");
  const tasks: Array<() => void> = [];
  const registry = AtomRegistry.make({
    scheduleTask: (task) => {
      tasks.push(task);
      return () => {};
    },
  });
  const flush = () => {
    for (let task = tasks.shift(); task; task = tasks.shift()) task();
  };
  const shell = { ...v2ThreadShell, id: threadId };
  const shellState = Atom.make({
    ...EMPTY_SHELL_STATE,
    status: "live" as const,
    snapshot: Option.some({ ...v2ShellSnapshot, threads: [shell] }),
  });
  const shellResult = Atom.map(shellState, AsyncResult.success);
  const snapshot = createEnvironmentSnapshotAtom(() => shellResult)(environmentId);
  const catalog = Atom.make({
    isReady: true,
    entries: new Map([
      [
        environmentId,
        {
          target: new PrimaryConnectionTarget({
            environmentId,
            label: "test",
            httpBaseUrl: "https://example.test",
            wsBaseUrl: "wss://example.test",
          }),
          profile: Option.none(),
          enabled: true,
        },
      ],
    ]),
  });
  const shells = createEnvironmentThreadShellAtoms({
    catalogValueAtom: catalog,
    snapshotAtom: () => snapshot,
  });
  const pending = Atom.make<ReadonlySet<ThreadId>>(new Set<ThreadId>([threadId])).pipe(
    Atom.keepAlive,
  );
  const unsubscribe = subscribeComposerDraftModelReconciliation({
    registry,
    threadShellAtom: shells.threadShellAtom,
    threadRefsAtom: shells.threadRefsAtom,
    shellStateAtom: () => shellResult,
    pendingThreadIdsAtom: () => pending,
  });
  try {
    flush();
    const key = `${environmentId}:${threadId}`;
    updateComposerDraftSettings(key, { modelSelection: shell.modelSelection });
    flush();
    expect(getComposerDraftSnapshot(key).modelSelection).toEqual(shell.modelSelection);
  } finally {
    unsubscribe();
    registry.dispose();
  }
});
