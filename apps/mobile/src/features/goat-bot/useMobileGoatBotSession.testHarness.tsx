// The session's stand-ins, shared by its test files: one place keeps the mocks every file needs.
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import {
  resolveGoatBotHomeSelection,
  type GoatBotEnvironmentInput,
} from "@goat/client-runtime/goatBot";
import {
  type BotProfile,
  EnvironmentId,
  type ChannelTaskId,
  ProjectId,
  ThreadId,
  type ChannelBotRef,
} from "@goat/contracts";
import * as Option from "effect/Option";
import { vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  environments: [] as ReadonlyArray<GoatBotEnvironmentInput>,
  botRef: null as ChannelBotRef | null,
  loaded: true,
  supportsTaskThreads: false,
  listedTaskIds: [] as ReadonlyArray<string>,
  /** A computer's work list per bot ("env/main", "env/scout"); a missing key is not read yet. */
  lists: {} as Record<string, ReadonlyArray<string>>,
  run: vi.fn(),
  save: vi.fn(),
  items: [] as ReadonlyArray<unknown>,
  itemReads: [] as Array<string | null>,
  openAsks: false,
  workerShell: null as object | null,
  shellReads: [] as Array<string | null>,
  upload: vi.fn(),
  transfer: vi.fn(),
  verify: vi.fn(),
  release: vi.fn(async (_attachments: ReadonlyArray<unknown>) => {}),
  key: vi.fn(() => "request"),
  refresh: vi.fn(),
}));
vi.mock("expo-file-system", () => ({
  File: class {
    constructor(readonly uri: string) {}
    upload(url: string, options: unknown) {
      return harness.transfer(this.uri, url, options);
    }
  },
  Paths: { document: { uri: "file:///documents" } },
  UploadType: { BINARY_CONTENT: 0 },
}));
const preparedConnection = Symbol("prepared connection");
vi.mock("@goat/client-runtime/state/attachments", async (original) => ({
  ...(await original<typeof import("@goat/client-runtime/state/attachments")>()),
  runAttachmentUploadCycle: harness.upload,
  verifyPersistedAttachmentUpload: harness.verify,
}));
vi.mock("../../state/assets", () => ({ assetEnvironment: { createUrl: {} } }));
vi.mock("../../state/attachments", () => ({
  attachmentEnvironment: { createUploadUrl: {}, remove: {} },
}));
vi.mock("../../state/session", () => ({
  readEnvironmentScope: () => true,
  environmentSession: { preparedConnectionValueAtom: () => preparedConnection },
}));
vi.mock("../../state/use-composer-drafts", () => ({
  releaseUnusedComposerAttachmentFiles: harness.release,
}));
const connection = AsyncResult.success({ phase: "connected", generation: 1 });
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: Atom.Atom<unknown>) =>
    atom === permissionAtom
      ? true
      : atom === connectionAtom
        ? connection
        : listAnswer(threadsAtoms.get(atom as Atom.Atom<unknown>)),
  useAtomSet: () => harness.save,
  useAtomRefresh: () => harness.refresh,
}));
vi.mock("@goat/client-runtime/state/runtime", () => ({
  runAtomCommand: harness.run,
  squashAtomCommandFailure: () => new Error("failed"),
}));
vi.mock("../../connection/catalog", () => ({
  environmentCatalog: { stateAtom: () => connectionAtom },
}));
vi.mock("../../state/atom-registry", () => ({
  get appAtomRegistry() {
    return registry;
  },
}));
// One stand-in detail atom for every worker ref, so a test can play the screen that loads it.
vi.mock("../../state/threads", () => ({
  environmentThreadDetails: { threadAtom: () => detailAtom },
}));
vi.mock("../../state/channels", () => ({
  channelEnvironment: {
    ensureBot: { permissionAtom: () => permissionAtom },
    ingest: { permissionAtom: () => permissionAtom },
    listBotThreads: (target: { environmentId: string; input: { botId?: string } }) =>
      threadsAtomFor(`${target.environmentId}/${target.input.botId ?? "main"}`),
  },
}));
vi.mock("../../state/preferences", () => ({ updateMobilePreferencesAtom: {} }));
vi.mock("../../state/use-thread-detail", () => ({
  useThreadVisibleTurnItems: (target: { threadId: string | null }) => {
    harness.itemReads.push(target.threadId);
    return harness.items;
  },
}));
vi.mock("../../state/entities", () => ({
  useThreadShell: (ref: { threadId: string } | null) => {
    harness.shellReads.push(ref?.threadId ?? null);
    return ref?.threadId === "worker-1" && harness.workerShell !== null
      ? { source: harness.workerShell }
      : null;
  },
  useServerConfigs: () =>
    new Map(
      harness.environments.map(({ environmentId }) => [
        environmentId,
        {
          environment: {
            capabilities: {
              goatBotTaskThreads: harness.supportsTaskThreads,
              goatBotOpenAsks: harness.openAsks,
            },
          },
        },
      ]),
    ),
}));
vi.mock("../../state/shell", () => ({
  useEnvironmentShellReadiness: () => ({ status: "loading" }),
}));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => harness.key() }));
vi.mock("./useMobileGoatBotHomeMode", () => ({
  useMobileGoatBotHomeMode: () => ({
    ...harness,
    home: resolveGoatBotHomeSelection(harness.environments, harness.botRef),
  }),
}));
import { useMobileGoatBotSession } from "./useMobileGoatBotSession";

const permissionAtom = Atom.make(true);
const connectionAtom = Atom.make(connection);
const detailAtom = Atom.make<unknown>(null);
const threadsAtoms = new Map<Atom.Atom<unknown>, string>();
const threadsByScope = new Map<string, Atom.Atom<unknown>>();
function threadsAtomFor(scope: string) {
  let atom = threadsByScope.get(scope);
  if (!atom) {
    atom = Atom.make<unknown>(AsyncResult.initial());
    threadsByScope.set(scope, atom);
    threadsAtoms.set(atom, scope);
  }
  return atom;
}
const rowsOf = (ids: ReadonlyArray<string>) =>
  AsyncResult.success({ rows: ids.map((taskId) => ({ kind: "task", task: { taskId } })) });
/** A scope's own list when a test sets one; otherwise listedTaskIds, unread while empty. */
function listAnswer(scope: string | undefined) {
  if (scope === undefined) return AsyncResult.initial();
  const own = harness.lists[scope];
  if (own !== undefined) return rowsOf(own);
  return harness.listedTaskIds.length > 0 ? rowsOf(harness.listedTaskIds) : AsyncResult.initial();
}
const registry = Object.assign(AtomRegistry.make(), {
  get: (atom: unknown) =>
    atom === preparedConnection ? Option.some({ httpBaseUrl: "https://example.test" }) : connection,
});
let root: Root | null = null;
/** The session as the last render returned it, and the task and member the next render asks for. */
export const view = {
  session: undefined as unknown as ReturnType<typeof useMobileGoatBotSession>,
  taskId: undefined as ChannelTaskId | null | undefined,
  member: null as BotProfile | null,
};
function Consumer() {
  const value = useMobileGoatBotSession(true, view.taskId, view.member);
  // oxlint-disable-next-line goat/react-effect-budget -- Hands the committed session to the test.
  useLayoutEffect(() => {
    view.session = value;
  }, [value]);
  return null;
}
export async function render() {
  const mounted = (root ??= createRoot(document.createElement("div")));
  await act(async () => {
    mounted.render(<Consumer />);
  });
}
export function environment(id: string, connected = true): GoatBotEnvironmentInput {
  return {
    environmentId: EnvironmentId.make(id),
    label: id,
    connected,
    primary: false,
    supportsChannelLedger: true,
  };
}
export function bot(environmentId: EnvironmentId): ChannelBotRef {
  return { environmentId, projectId: ProjectId.make("project"), threadId: ThreadId.make("bot") };
}
/** Every test starts here: no computers, no bot, nothing listed. */
export function setupSession() {
  view.taskId = undefined;
  view.member = null;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  harness.environments = [];
  harness.botRef = null;
  harness.loaded = true;
  harness.supportsTaskThreads = harness.openAsks = false;
  harness.listedTaskIds = [];
  harness.lists = {};
  harness.save.mockReset();
  harness.release.mockReset().mockResolvedValue(undefined);
  harness.key.mockReset().mockReturnValue("request");
  harness.run.mockReset().mockImplementation(async (_registry, _command, { environmentId }) => ({
    _tag: "Success",
    value: bot(environmentId),
  }));
}
export async function unmountSession() {
  await act(async () => root?.unmount());
  root = null;
}
export { harness, registry, detailAtom };
