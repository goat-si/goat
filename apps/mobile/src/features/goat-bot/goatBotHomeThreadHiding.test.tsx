import {
  act,
  useImperativeHandle,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type Ref,
} from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import {
  BotProfile,
  BotRemoteWork,
  BotThreadRow,
  EnvironmentId,
  ThreadId,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadLauncher,
  type OrchestrationV2ThreadShell,
} from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";
import { PrimaryConnectionTarget } from "@goat/client-runtime/connection";
import {
  v2ShellSnapshot,
  v2ThreadShell,
} from "../../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures";

// One registry holds the real channel atoms, the app's thread-shell wiring, the hidden-key set,
// MobileBotWork and the roster. Stand-ins: the servers' answers (session, connection, permission,
// RPC reads), the catalog, snapshots and presentations, native components, the Home-mode hook's
// inputs, the row menu, and Home's other parts (face, status card, library, memory, search).
type Props = Record<string, unknown> & { children?: ReactNode };
const nativeAlert = vi.hoisted(() => vi.fn());
const fx = vi.hoisted(() => ({
  registry: undefined as unknown as import("effect/reactivity").AtomRegistry.AtomRegistry,
  atoms: {} as Record<string, import("effect/reactivity").Atom.Writable<any>>,
  config: undefined as unknown as (id: string) => import("effect/reactivity").Atom.Writable<any>,
  connection: undefined as unknown as (
    id: string,
  ) => import("effect/reactivity").Atom.Writable<any>,
  permission: undefined as unknown as (
    tag: string,
  ) => import("effect/reactivity").Atom.Writable<boolean>,
  /** A server's answer to one read, per tag, computer and bot; unanswered reads wait. */
  answer: undefined as unknown as (
    tag: string,
    environmentId: string,
    botId?: string,
  ) => import("effect/reactivity").Atom.Writable<any>,
  openThread: vi.fn(),
  /** Every read the stand-in server was asked for, as tag and target. */
  reads: [] as string[],
}));
vi.mock("../../state/atom-registry", async () => {
  const { AtomRegistry } = await import("effect/reactivity");
  fx.registry = AtomRegistry.make();
  return { appAtomRegistry: fx.registry };
});
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: import("effect/reactivity").Atom.Atom<unknown>) =>
    useSyncExternalStore(
      (notify) => fx.registry.subscribe(atom, notify),
      () => fx.registry.get(atom),
    ),
  useAtomRefresh: (atom: import("effect/reactivity").Atom.Atom<unknown>) => () =>
    fx.registry.refresh(atom),
  useAtomSet: () => () => {},
}));
vi.mock("../../../../../packages/client-runtime/src/state/session.ts", async () => {
  const { Atom: A } = await import("effect/reactivity");
  const family = A.family((_id: string) => A.make<unknown>(null).pipe(A.keepAlive));
  fx.config = family as never;
  return { createEnvironmentSessionAtoms: () => ({ initialConfigValueAtom: family }) };
});
vi.mock("../../../../../packages/client-runtime/src/state/environmentConnections.ts", async () => {
  const { Atom: A, AsyncResult: R } = await import("effect/reactivity");
  const Opt = await import("effect/Option");
  const family = A.family((_id: string) =>
    A.make<unknown>(R.success([{ phase: "connected" }, Opt.some({})] as const)).pipe(A.keepAlive),
  );
  fx.connection = family as never;
  return { environmentConnectionAtoms: () => family };
});
vi.mock("../../../../../packages/client-runtime/src/state/commandPermissions.ts", async () => {
  const { Atom: A } = await import("effect/reactivity");
  // One permission per command, so the bot's own commands can be refused while its list is read.
  const byTag = A.family((_tag: string) => A.make(true).pipe(A.keepAlive));
  fx.permission = byTag as never;
  return {
    createCommandPermissions: (_runtime: unknown, tag: string) => ({
      permissionAtom: () => byTag(tag),
    }),
  };
});
vi.mock("@goat/client-runtime/state/runtime", async (importOriginal) => {
  const real = await importOriginal<typeof import("@goat/client-runtime/state/runtime")>();
  const { Atom: A, AsyncResult: R } = await import("effect/reactivity");
  fx.answer = (tag, environmentId, botId = "main") =>
    (fx.atoms[tag + ":" + environmentId + ":" + botId] ??= A.make<unknown>(R.initial(true)).pipe(
      A.keepAlive,
    ) as never);
  return {
    ...real,
    createEnvironmentRpcQueryAtomFamily: (_runtime: unknown, options: { tag: string }) => {
      const family = A.family((key: string) => {
        const target = JSON.parse(key) as { environmentId: string; input?: { botId?: string } };
        return A.make((get) => {
          fx.reads.push(options.tag + " " + key);
          return get(fx.answer(options.tag, target.environmentId, target.input?.botId));
        });
      });
      return (target: unknown) => family(JSON.stringify(target));
    },
    createEnvironmentRpcSubscriptionAtomFamily: () => () => A.make(null),
    createEnvironmentSubscriptionAtomFamily: () => () => A.make(null),
  };
});
vi.mock("@goat/client-runtime/state/threads", async (importOriginal) => {
  const real = await importOriginal<typeof import("@goat/client-runtime/state/threads")>();
  const { Atom: A } = await import("effect/reactivity");
  fx.atoms.catalog = A.make<unknown>(null).pipe(A.keepAlive) as never;
  const snapshots = A.family((_id: string) => A.make<unknown>(null).pipe(A.keepAlive));
  fx.atoms.snapshots = snapshots as never;
  return {
    ...real,
    // The app's own inputs, except the catalog and snapshots that would come from servers.
    createEnvironmentThreadShellAtoms: (
      input: Parameters<typeof real.createEnvironmentThreadShellAtoms>[0],
    ) =>
      real.createEnvironmentThreadShellAtoms({
        ...input,
        catalogValueAtom: fx.atoms.catalog as never,
        snapshotAtom: snapshots as never,
      }),
  };
});
vi.mock("../connection/runtime", async () => {
  const { Atom: A } = await import("effect/reactivity");
  const Layer = await import("effect/Layer");
  return { connectionAtomRuntime: A.runtime(Layer.empty) };
});
vi.mock("../../connection/runtime", async () => {
  const { Atom: A } = await import("effect/reactivity");
  const Layer = await import("effect/Layer");
  return { connectionAtomRuntime: A.runtime(Layer.empty) };
});
vi.mock("../../connection/catalog", () => ({ environmentCatalog: {} }));
vi.mock("../../state/shell", () => ({ environmentShell: {} }));
vi.mock("../../state/presentation", async () => {
  const { Atom: A } = await import("effect/reactivity");
  const presentationsAtom = A.make<unknown>(new Map()).pipe(A.keepAlive);
  fx.atoms.presentations = presentationsAtom as never;
  return { environmentPresentations: { presentationsAtom } };
});
vi.mock("../../state/preferences", async () => {
  const { Atom: A, AsyncResult: R } = await import("effect/reactivity");
  const preferences = A.make(R.success({ showGoatBotThreads: false })).pipe(A.keepAlive);
  fx.atoms.preferences = preferences as never;
  return { mobilePreferencesAtom: preferences };
});
vi.mock("../../state/server", async () => {
  const { Atom: A, AsyncResult: R } = await import("effect/reactivity");
  const routines = A.make(R.success({ tasks: [] }));
  const command = { label: "command", permissionAtom: () => A.make(true) };
  return {
    serverEnvironment: {
      scheduledTasksLive: () => routines,
      upsertScheduledTask: command,
      setScheduledTaskEnabled: command,
      runScheduledTaskNow: command,
    },
  };
});
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 34, left: 0, right: 0 }),
}));
vi.mock("react-native", () => ({
  StyleSheet: { hairlineWidth: 1 },
  // Android opens a link as the sheet closes; iOS waits for a native dismissal this stand-in lacks.
  Platform: { OS: "android" },
  Switch: () => null,
  View: (props: Props) => (
    <div aria-label={props.accessibilityLabel as string}>{props.children}</div>
  ),
  ScrollView: (props: Props) => <div>{props.children}</div>,
  FlatList: function FlatList(
    props: {
      data: ReadonlyArray<{ key: string }>;
      renderItem: (info: { item: { key: string }; index: number }) => ReactNode;
      ref?: Ref<unknown>;
    } & Record<string, unknown>,
  ) {
    useImperativeHandle(props.ref, () => ({ scrollToIndex: () => {}, scrollToOffset: () => {} }));
    return (
      <div data-testid={props.testID as string}>
        {props.data.map((item, index) => (
          <div key={item.key}>{props.renderItem({ item, index })}</div>
        ))}
      </div>
    );
  },
  Modal: (props: Props & { visible: boolean }) =>
    props.visible ? <div>{props.children}</div> : null,
  Alert: { alert: nativeAlert },
  AccessibilityInfo: { announceForAccessibility: () => {} },
  Text: (props: Props) => <span data-class={props.className as string}>{props.children}</span>,
  TextInput: () => null,
  Pressable: (
    props: Props & { onPress?: () => void; accessibilityLabel?: string; disabled?: boolean },
  ) => (
    <button onClick={props.onPress} aria-label={props.accessibilityLabel} disabled={props.disabled}>
      {props.children}
    </button>
  ),
}));
vi.mock("./MobileBotRowMenu", () => ({
  MobileBotRowMenu: (props: {
    label: string;
    title: string;
    actions: ReadonlyArray<{ id: string; title: string }>;
    onSelect: (id: string) => void;
    row?: ReactNode;
  }) => (
    <>
      {props.row}
      <button
        aria-label={props.label}
        onClick={() =>
          nativeAlert(
            props.title,
            undefined,
            props.actions.map((action) => ({
              text: action.title,
              onPress: () => props.onSelect(action.id),
            })),
          )
        }
      />
    </>
  ),
}));
vi.mock("../../native/StackHeader", () => ({ NativeStackScreenOptions: () => null }));
vi.mock("expo-crypto", () => ({ randomUUID: () => globalThis.crypto.randomUUID() }));
vi.mock("../../state/entities", () => ({
  useThreadShell: () => ({ id: "bot", projectId: "bot-project", modelSelection: null }),
}));
vi.mock("@expo/ui/community/datetime-picker", () => ({ DateTimePicker: () => null }));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    presentationById: new Map(
      ["env", "far"].map((id) => [
        id,
        {
          connection: { phase: "connected" },
          serverConfig: {
            environment: {
              capabilities: fx.registry.get(fx.config(id))?.environment.capabilities,
            },
          },
        },
      ]),
    ),
  }),
}));
vi.mock("../../state/use-thread-detail", () => ({
  useThreadDetail: () => ({ status: "live", data: Option.some({}), error: Option.none() }),
  useThreadVisibleTurnItems: () => [],
}));
vi.mock("../settings/appearance/useScaledTextRole", () => ({ useScaledTextRole: () => ({}) }));
vi.mock("./GoatBotFace", () => ({ GoatBotFaceAvatar: () => null }));
vi.mock("./GoatBotTaskRow", () => ({ GoatBotTaskRow: () => null }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("./MobileBotStatusCard", () => ({ MobileBotStatusCard: () => null }));
vi.mock("./MobileBotComputer", () => ({ MobileBotComputer: () => null }));
vi.mock("./MobileBotLibrary", () => ({ MobileBotLibrary: () => null }));
vi.mock("./MobileBotMemory", () => ({ MobileBotMemory: () => null }));
vi.mock("./MobileBotTaskSearch", () => ({ MobileBotTaskSearch: () => null }));
// Home picks its computer from the same presentations and saved bot as Threads' selection.
vi.mock("./useMobileGoatBotHomeMode", async () => {
  const { useAtomValue } = await import("@effect/atom-react");
  const { AsyncResult: R } = await import("effect/reactivity");
  const { mobileGoatBotEnvironmentInput } = await import("./mobileGoatBotEnvironments");
  return {
    useMobileGoatBotHomeMode: () => {
      const presentations = useAtomValue(fx.atoms.presentations as never) as Map<
        import("@goat/contracts").EnvironmentId,
        any
      >;
      const preferences = useAtomValue(
        fx.atoms.preferences as never,
      ) as import("effect/reactivity").AsyncResult.AsyncResult<
        { goatBotRef?: import("@goat/contracts").ChannelBotRef },
        never
      >;
      return {
        environments: [...presentations].map(([environmentId, presentation]) =>
          mobileGoatBotEnvironmentInput({
            environmentId,
            label: presentation.entry.target.label,
            connection: presentation.connection,
            serverConfig: presentation.serverConfig,
          }),
        ),
        botRef: R.isSuccess(preferences) ? (preferences.value.goatBotRef ?? null) : null,
      };
    },
  };
});
vi.mock("./useMobileGoatBotMemberModel", () => ({ useMobileGoatBotMemberModelMenu: () => null }));
vi.mock("./GoatBotMarkdown", () => ({ GoatBotMarkdown: () => null }));
vi.mock("../../components/ui/Button", () => ({
  Button: (props: { label: string; onPress: () => void }) => (
    <button onClick={props.onPress}>{props.label}</button>
  ),
}));
// The roster's face, strip and chrome are stand-ins; its rows' counts come from the real atoms.
vi.mock("./useMobileGoatBotFace", () => ({
  useMobileGoatBotFace: () => ({ state: "idle" }),
  useMobileGoatBotFaceMotion: () => null,
}));
vi.mock("./MobileNeedsYouStrip", () => ({ MobileNeedsYouStrip: () => null }));
vi.mock("../workspace/WorkspaceTabsContext", () => ({ useWorkspaceTabs: () => null }));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeAppearance: "light" }),
}));
vi.mock("../../components/GoatWordmark", () => ({ GoatWordmark: () => null }));
import { hiddenGoatBotThreadKeysAtom } from "../threads/goatBotThreadVisibility";
import { MobileBotRosterView } from "./MobileBotRosterView";
import { MobileBotWork } from "./MobileBotWork";

const env = EnvironmentId.make("env");
const far = EnvironmentId.make("far");
const conversation = ThreadId.make("channel-bot:main");
// Retention reads the clock; setup() pins it here so rows a minute or an hour old stay listed.
const NOW = Date.parse("2026-11-14T03:00:00.000Z");
const at = new Date(NOW - 60_000).toISOString();
const decode = Schema.decodeUnknownSync(BotThreadRow);
const task = (
  taskId: string,
  title: string,
  worker: string,
  finishedMinutesAgo?: number,
  source: EnvironmentId = env,
) => {
  const done =
    finishedMinutesAgo === undefined
      ? null
      : new Date(NOW - finishedMinutesAgo * 60_000).toISOString();
  return decode({
    kind: "task",
    task: {
      taskId,
      title,
      status: done === null ? "running" : "completed",
      updatedAt: done ?? at,
      ...(done === null ? {} : { completedAt: done }),
    },
    view: { taskId, pinnedAt: null, doneAt: null, readThrough: null },
    lastActivityAt: done ?? at,
    unread: false,
    mainMessagesSinceQuiet: 0,
    worker: { environmentId: source, threadId: worker },
  });
};
const coding = (
  threadId: string,
  taskId: string,
  title: string,
  workKind: "coding" | "chore",
  source: EnvironmentId = env,
) =>
  decode({
    kind: "coding",
    taskId,
    environmentId: source,
    threadId,
    title,
    state: "bound",
    lastActivityAt: at,
    workKind,
  });
const remote = Schema.decodeUnknownSync(BotRemoteWork)({
  childWorkId: "rc1",
  taskId: "t1",
  callerThreadId: conversation,
  host: "studio",
  state: "bound",
  lastActivityAt: at,
  environmentId: far,
  threadId: "r1",
  workKind: "coding",
});
const rows = [
  task("t1", "Ship the release", "w1"),
  coding("c1", "t1", "Patch web", "coding"),
  // A chore whose task left the current list: Home has no link for it.
  coding("k1", "t-gone", "Tidy logs", "chore"),
  ...[1, 2, 3, 4, 5, 6].map((n) => task("f" + n, "Finished " + n, "fw" + n, n * 10)),
];
// The second computer's own bot: a current task with its worker and a coding thread.
const farRows = [
  task("tb1", "Check the far build", "bw1", undefined, far),
  coding("bc1", "tb1", "Patch far", "coding", far),
];
const capabilities = {
  goatBotTaskThreads: true,
  goatBotTaskThreadsPaged: true,
  goatBotTaskLookupSearch: true,
  goatBotChildWork: true,
};
const configOf = (id: EnvironmentId, extra: object = {}) => ({
  environment: { environmentId: id, capabilities: { ...capabilities, ...extra } },
});
// The launch records each thread carries on its own machine.
const shell = (
  id: string,
  launchedBy?: OrchestrationV2ThreadLauncher,
): OrchestrationV2ThreadShell => ({
  ...v2ThreadShell,
  id: ThreadId.make(id),
  ...(launchedBy ? { launchedBy } : {}),
});
const launch = (
  workKind?: "coding" | "chore",
  via: OrchestrationV2ThreadLauncher["via"] = "thread_launch",
): OrchestrationV2ThreadLauncher => ({
  kind: "launch",
  environmentId: env,
  environmentLabel: null,
  threadId: conversation,
  threadTitle: null,
  via,
  ...(workKind === undefined ? {} : { workKind }),
});

const key = (environmentId: string, threadId: string) => environmentId + ":" + threadId;
const workKeys = [
  key("env", "w1"),
  key("env", "c1"),
  key("env", "k1"),
  key("far", "r1"),
  ...[1, 2, 3, 4, 5, 6].map((n) => key("env", "fw" + n)),
];
const hiddenWork = () => {
  const hidden = fx.registry.get(hiddenGoatBotThreadKeysAtom);
  return workKeys.filter((item) => hidden.has(item));
};
const hiddenSet = () => [...fx.registry.get(hiddenGoatBotThreadKeysAtom)].sort();
const setList = (result: unknown, environmentId = "env", botId = "main") =>
  fx.registry.set(fx.answer("channel.listBotThreads", environmentId, botId), result as never);
const listed = (list: ReadonlyArray<BotThreadRow>, remoteWork: ReadonlyArray<BotRemoteWork> = []) =>
  AsyncResult.success({ rows: list, remoteWork, mainMessageCount: 0 });
// Home opens the bot on this computer; a saved bot names it, otherwise the first connected one.
const saveBot = (environmentId: string | null) =>
  fx.registry.set(
    fx.atoms.preferences as never,
    AsyncResult.success({
      showGoatBotThreads: false,
      ...(environmentId === null
        ? {}
        : {
            goatBotRef: {
              environmentId,
              projectId: "bot-project",
              threadId: "channel-bot:main",
            },
          }),
    }) as never,
  );

const connected = AsyncResult.success([{ phase: "connected" }, Option.some({})] as const);
function setup() {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  const target = (id: EnvironmentId) =>
    new PrimaryConnectionTarget({
      environmentId: id,
      label: id,
      httpBaseUrl: "https://example.test",
      wsBaseUrl: "wss://example.test",
    });
  fx.registry.set(
    fx.atoms.catalog as never,
    {
      isReady: true,
      entries: new Map(
        [env, far].map((id) => [id, { target: target(id), profile: Option.none(), enabled: true }]),
      ),
    } as never,
  );
  const snapshots = fx.atoms.snapshots as unknown as (id: string) => Atom.Writable<unknown>;
  fx.registry.set(snapshots("env"), {
    ...v2ShellSnapshot,
    threads: [
      shell("w1", launch()),
      shell("c1", launch("coding")),
      shell("k1", launch("chore")),
      ...[1, 2, 3, 4, 5, 6].map((n) => shell("fw" + n)),
    ],
  } satisfies OrchestrationV2ShellSnapshot);
  fx.registry.set(snapshots("far"), {
    ...v2ShellSnapshot,
    threads: [
      shell("r1", launch("coding", "ssh_thread_launch")),
      shell("bw1", { ...launch(), environmentId: far }),
      shell("bc1", { ...launch("coding"), environmentId: far }),
    ],
  } satisfies OrchestrationV2ShellSnapshot);
  // Both computers run a bot; by label, "A-mac" is the one Home opens unless a bot is saved.
  fx.registry.set(
    fx.atoms.presentations as never,
    new Map(
      [
        [env, "A-mac"],
        [far, "B-mac"],
      ].map(([id, label]) => [
        id,
        {
          entry: { target: target(id as EnvironmentId), profile: Option.none(), enabled: true },
          connection: { phase: "connected" },
          serverConfig: {
            environment: { label, capabilities: { ...capabilities, channelLedger: true } },
          },
        },
      ]),
    ) as never,
  );
  fx.registry.set(fx.config("env"), configOf(env));
  fx.registry.set(fx.connection("env"), connected);
  for (const tag of ["channel.listBotThreads", "channel.ensureBot", "channel.ingest"])
    fx.registry.set(fx.permission(tag), true);
  fx.registry.set(fx.config("far"), configOf(far));
  saveBot(null);
  fx.registry.set(fx.answer("channel.listBots", "env"), AsyncResult.success({ bots: [] }) as never);
  fx.registry.set(
    fx.answer("channel.listChildWork", "env"),
    AsyncResult.success({ groups: [] }) as never,
  );
  setList(listed(rows, [remote]));
  // The second computer's list waits unless a test answers it.
  setList(AsyncResult.initial(true), "far");
  fx.openThread.mockClear();
  fx.reads.length = 0;
}

function Home() {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open Home</button>
      <MobileBotWork
        visible
        seen
        open={open}
        onOpenChange={setOpen}
        onOpenTask={() => {}}
        onOpenThread={fx.openThread}
        onDraft={() => true}
        workRevision={null}
      />
    </>
  );
}
async function renderHome() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(<Home />));
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find(
      (item) =>
        item.textContent === label ||
        item.getAttribute("aria-label") === label ||
        item.getAttribute("aria-label")?.startsWith(label + ", ") === true,
    );
  const press = async (label: string) => {
    const target = button(label);
    expect(target, label).toBeDefined();
    await act(async () => target?.click());
  };
  return {
    container,
    button,
    press,
    /** Opens a link under a task's Show work; opening it closes Home, so Home opens first. */
    openLink: async (title: string, label: string, reveal = false) => {
      await press("Open Home");
      if (reveal) await press("Show more");
      await press("Actions for " + title);
      const choices = nativeAlert.mock.calls.at(-1)?.[2] as Array<{
        text: string;
        onPress?: () => void;
      }>;
      await act(async () => choices.find((choice) => choice.text === "Show work")?.onPress?.());
      await press(label);
    },
    [Symbol.asyncDispose]: async () => act(async () => root.unmount()),
  };
}

it("hides exactly the threads Home's current list opens, and each one opens from Home", async () => {
  setup();
  // Home closed: Threads already leaves out the current list's worker, coding and remote work.
  // No bot conversation is loaded here, so the whole hide set is work.
  const hidden = [...fx.registry.get(hiddenGoatBotThreadKeysAtom)].sort();
  expect(hidden).toEqual(workKeys.filter((item) => item !== key("env", "k1")).sort());
  await using screen = await renderHome();
  await screen.openLink("Ship the release", "Work thread: Ship the release");
  await screen.openLink("Ship the release", "GOAT thread: Patch web");
  await screen.openLink("Ship the release", "Open work thread on studio");
  for (const n of [1, 2, 3, 4, 5])
    await screen.openLink("Finished " + n, "Work thread: Finished " + n);
  // The sixth finished task sits behind Show more until it is revealed.
  await screen.press("Open Home");
  expect(screen.button("Actions for Finished 6")).toBeUndefined();
  await screen.openLink("Finished 6", "Work thread: Finished 6", true);
  // Every hidden key, and nothing else, opened from Home.
  const opened = fx.openThread.mock.calls.map(([thread]) => key(thread.environmentId, thread.id));
  expect(opened.sort()).toEqual(hidden);
  // Show work's child reads and a peek of a task left the hidden set as it was.
  expect(
    fx.reads.some((read) => read.startsWith("channel.listChildWork") && read.includes('"t1"')),
  ).toBe(true);
  await screen.press("Open Home");
  await screen.press("Ship the release");
  expect(screen.button("Back to home. Ship the release")).toBeDefined();
  expect(hiddenSet()).toEqual(hidden);
  // The chore Home does not link stays in Threads; Home lists it among other threads.
  await screen.press("Open Home");
  expect(screen.button("GOAT thread: Tidy logs")).toBeDefined();
});

it("lists Home's work again when its list read fails or a destination disconnects, while Home keeps its rows", async () => {
  setup();
  fx.registry.set(fx.config("far"), null);
  expect(hiddenWork()).not.toContain(key("far", "r1"));
  expect(hiddenWork()).toContain(key("env", "c1"));
  fx.registry.set(fx.config("far"), configOf(far));
  expect(hiddenWork()).toContain(key("far", "r1"));
  // A refresh that fails keeps the earlier answer beside the error, as the app's reads do.
  setList(
    AsyncResult.failure(Cause.fail("offline"), {
      previousSuccess: Option.some(listed(rows, [remote])),
    }),
  );
  expect(hiddenWork()).toEqual([]);
  await using screen = await renderHome();
  expect(screen.button("Actions for Ship the release")).toBeDefined();
});

it("hides nothing from Home while its first list read is pending, offline, or not permitted", () => {
  setup();
  setList(AsyncResult.initial(true));
  expect(hiddenWork()).toEqual([]);
  setList(listed(rows, [remote]));
  expect(hiddenWork()).toContain(key("env", "c1"));
  // Offline the bot is not eligible, so Home stops governing and the legacy rule decides.
  fx.registry.set(
    fx.connection("env"),
    AsyncResult.success([{ phase: "disconnected" }, Option.none()]),
  );
  expect(hiddenWork()).not.toContain(key("env", "c1"));
  fx.registry.set(fx.connection("env"), connected);
  expect(hiddenWork()).toContain(key("env", "c1"));
  fx.registry.set(fx.permission("channel.listBotThreads"), false);
  expect(hiddenWork()).not.toContain(key("env", "c1"));
});

it("returns Threads to the legacy rule when either visibility capability is withdrawn", () => {
  for (const missing of ["goatBotTaskThreadsPaged", "goatBotTaskLookupSearch"]) {
    setup();
    fx.registry.set(fx.config("env"), configOf(env, { [missing]: false }));
    // Legacy hides task workers and chores, and lists coding launches.
    expect(hiddenWork(), missing).toEqual([
      key("env", "w1"),
      key("env", "k1"),
      ...[1, 2, 3, 4, 5, 6].map((n) => key("env", "fw" + n)),
    ]);
    // Returned, Home's rule decides again.
    fx.registry.set(fx.config("env"), configOf(env));
    expect(hiddenWork(), missing).toEqual(workKeys.filter((item) => item !== key("env", "k1")));
  }
});

const envLinks = workKeys.filter((item) => item !== key("env", "k1"));
const envLegacy = [
  key("env", "w1"),
  key("env", "k1"),
  ...[1, 2, 3, 4, 5, 6].map((n) => key("env", "fw" + n)),
];
const farLinks = [key("far", "bw1"), key("far", "bc1")];
const sorted = (keys: ReadonlyArray<string>) => [...keys].sort();

it("keeps another computer's bot work on dev's rule while Home opens this one", () => {
  setup();
  setList(listed(farRows), "far");
  // B-mac governs its own Home, but this device's Home is A-mac's: B-mac's coding thread stays in
  // Threads and its worker stays hidden, as on dev.
  expect(hiddenSet()).toEqual(sorted([...envLinks, key("far", "bw1")]));
});

it("moves Home's rule to the computer Home opens, and each thread it hides opens from that Home", async () => {
  setup();
  setList(listed(farRows), "far");
  saveBot("far");
  // A-mac returns to dev's rule (its coding launch and remote coding are listed again).
  expect(hiddenSet()).toEqual(sorted([...envLegacy, ...farLinks]));
  await using screen = await renderHome();
  await screen.openLink("Check the far build", "Work thread: Check the far build");
  await screen.openLink("Check the far build", "GOAT thread: Patch far");
  const opened = fx.openThread.mock.calls.map(([thread]) => key(thread.environmentId, thread.id));
  expect(sorted(opened)).toEqual(sorted(farLinks));
});

it("governs no computer until preferences have loaded, then hides what the loaded Home opens", async () => {
  setup();
  // Before preferences load the Bots switch does nothing, so Threads keeps dev's rule.
  for (const pending of [
    AsyncResult.initial(true),
    AsyncResult.failure(Cause.fail("storage unavailable")),
  ]) {
    fx.registry.set(fx.atoms.preferences as never, pending as never);
    expect(hiddenSet()).toEqual(sorted(envLegacy));
  }
  saveBot(null);
  expect(hiddenSet()).toEqual(sorted(envLinks));
  await using screen = await renderHome();
  await screen.openLink("Ship the release", "GOAT thread: Patch web");
  expect(fx.openThread).toHaveBeenLastCalledWith({ environmentId: "env", id: "c1" });
});

// Mobile's Home opens from the chat whether or not the bot can take messages (GoatBotScreen.naming.test.tsx
// covers the chat for a failed setup, an unresolved claim and refused permission). This pins the other
// half: Home's rule reads nothing of the bot's readiness, so the two must change together.
it("hides a current task's thread and opens it from Home while the bot cannot take messages", async () => {
  setup();
  // Without the bot's own commands the chat says this connection cannot message it.
  fx.registry.set(fx.permission("channel.ensureBot"), false);
  fx.registry.set(fx.permission("channel.ingest"), false);
  expect(hiddenSet()).toEqual(sorted(envLinks));
  await using screen = await renderHome();
  await screen.openLink("Ship the release", "GOAT thread: Patch web");
  expect(fx.openThread).toHaveBeenLastCalledWith({ environmentId: "env", id: "c1" });
});

// The server advertises the newer flags without task lists, so Home's sheet would show no list.
function advertise(extra: object) {
  fx.registry.set(fx.config("env"), configOf(env, extra));
  const presentations = new Map(
    fx.registry.get(fx.atoms.presentations as never) as Map<string, { serverConfig: object }>,
  );
  const current = presentations.get("env");
  if (current)
    presentations.set("env", {
      ...current,
      serverConfig: {
        environment: {
          label: "A-mac",
          capabilities: { ...capabilities, channelLedger: true, ...extra },
        },
      },
    });
  fx.registry.set(fx.atoms.presentations as never, presentations as never);
}

it("governs the selected computer only where Home can show its task list", async () => {
  setup();
  advertise({ goatBotTaskThreads: false });
  // Dev's rule on a server without task lists hides none of the bot's work.
  expect(hiddenSet()).toEqual([]);
  advertise({});
  expect(hiddenSet()).toEqual(sorted(envLinks));
  await using screen = await renderHome();
  await screen.openLink("Ship the release", "GOAT thread: Patch web");
  expect(fx.openThread).toHaveBeenLastCalledWith({ environmentId: "env", id: "c1" });
});

it("governs no computer while no bot computer is selected", () => {
  setup();
  setList(listed(farRows), "far");
  // The saved bot's computer is gone from this device.
  saveBot("gone");
  expect(hiddenSet()).toEqual(sorted([...envLegacy, key("far", "bw1")]));
});

it("hides nothing while this device shows GOAT Bot threads", () => {
  setup();
  fx.registry.set(
    fx.atoms.preferences as never,
    AsyncResult.success({ showGoatBotThreads: true }) as never,
  );
  expect(hiddenWork()).toEqual([]);
});

const scout = Schema.decodeUnknownSync(BotProfile)({
  botId: "scout",
  role: "member",
  name: "Scout",
  avatar: null,
  purpose: "",
  defaultModelSelection: null,
  defaultProjectId: null,
  environmentId: "env",
  sessionThreadId: "scout-thread",
  createdAt: at,
  updatedAt: at,
});
// A member on a server that counts waits by visit, with its own list and status reads.
function setupScout(input: { unread: ReadonlyArray<boolean>; waiting: number }) {
  setup();
  fx.registry.set(
    fx.config("env"),
    configOf(env, {
      goatBotMembers: true,
      goatBotProfiles: true,
      goatBotStatus: true,
      goatBotWaitingRead: true,
      threadVisitedTracking: true,
    }),
  );
  fx.registry.set(
    fx.answer("channel.listBots", "env"),
    AsyncResult.success({ bots: [{ botId: "scout", role: "member", state: "active" }] }) as never,
  );
  setScout(input);
}
function setScout(input: { unread: ReadonlyArray<boolean>; waiting: number }) {
  answerScoutList(input.unread);
  answerScoutStatus(input.waiting);
}
// The server's answer to Scout's task list: one task per entry, unread or read.
function answerScoutList(unread: ReadonlyArray<boolean>) {
  setList(
    listed(
      unread.map((value, n) => ({ ...task("s" + n, "Scout task " + n, "sw" + n), unread: value })),
    ),
    "env",
    "scout",
  );
}
// The server's answer to Scout's status read: how many of its tasks wait on the person.
function answerScoutStatus(waitingCount: number) {
  fx.registry.set(
    fx.answer("channel.getBotStatus", "env", "scout"),
    AsyncResult.success({ waitingCount }) as never,
  );
}
async function renderRoster() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <MobileBotRosterView
        bots={[
          { kind: "main", profile: null },
          { kind: "member", profile: scout },
        ]}
        slackEnabled={false}
        mainEnvironmentId={env}
        onOpenBot={() => {}}
      />,
    ),
  );
  const row = () =>
    [...container.querySelectorAll("button")].find((item) =>
      item.getAttribute("aria-label")?.split(", ").includes("Scout"),
    );
  const marked = (className: string) =>
    [...(row()?.querySelectorAll("span") ?? [])]
      .filter((item) => item.getAttribute("data-class") === className)
      .map((item) => item.textContent);
  return {
    label: () => row()?.getAttribute("aria-label") ?? "",
    // The unread mark and the waiting badge, told apart by how each is drawn.
    unread: () =>
      marked("rounded-full bg-subtle-strong px-1.5 text-xs font-semibold text-foreground"),
    waiting: () => marked("text-xs font-semibold text-foreground"),
    rerender: () => act(async () => {}),
    [Symbol.asyncDispose]: async () => act(async () => root.unmount()),
  };
}

it("a governed member row counts the unread tasks of its bot's real current list, beside its waiting count", async () => {
  setupScout({ unread: [true, false, true], waiting: 1 });
  await using roster = await renderRoster();
  expect(roster.unread()).toEqual(["2"]);
  expect(roster.waiting()).toEqual(["1"]);
  expect(roster.label()).toContain("2 unread tasks; recent work only; older work may be missing");
});

// Simulated server answers: the list after a Mark read, the status after a visit.
it("a member row's unread and waiting counts each follow only their own read", async () => {
  setupScout({ unread: [true], waiting: 2 });
  await using roster = await renderRoster();
  expect([roster.unread(), roster.waiting()]).toEqual([["1"], ["2"]]);
  // The list answers the task read, as after Mark read; the status read is unchanged.
  await act(async () => answerScoutList([false]));
  expect([roster.unread(), roster.waiting()]).toEqual([[], ["2"]]);
  expect(roster.label()).not.toContain("unread task");
  // A new unread task arrives in the list; the status read is still unchanged.
  await act(async () => answerScoutList([false, true]));
  expect([roster.unread(), roster.waiting()]).toEqual([["1"], ["2"]]);
  // The status answers no waiting task, as after a visit; the list is unchanged.
  await act(async () => answerScoutStatus(0));
  expect([roster.unread(), roster.waiting()]).toEqual([["1"], []]);
});
