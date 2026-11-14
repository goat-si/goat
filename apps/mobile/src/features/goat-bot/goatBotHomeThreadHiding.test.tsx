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
  BotRemoteWork,
  BotThreadRow,
  EnvironmentId,
  ThreadId,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadLauncher,
  type OrchestrationV2ThreadShell,
} from "@goat/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";
import { PrimaryConnectionTarget } from "@goat/client-runtime/connection";
import {
  v2ShellSnapshot,
  v2ThreadShell,
} from "../../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures";

// One registry holds the real channel atoms, the real thread shells and the real hidden-key set;
// only what a server would answer (session, connection, permission, RPC reads) is a fixture.
type Props = Record<string, unknown> & { children?: ReactNode };
const nativeAlert = vi.hoisted(() => vi.fn());
const fx = vi.hoisted(() => ({
  registry: undefined as unknown as import("effect/reactivity").AtomRegistry.AtomRegistry,
  atoms: {} as Record<string, import("effect/reactivity").Atom.Writable<any>>,
  config: undefined as unknown as (id: string) => import("effect/reactivity").Atom.Writable<any>,
  connection: undefined as unknown as (
    id: string,
  ) => import("effect/reactivity").Atom.Writable<any>,
  openThread: vi.fn(),
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
  const allowed = A.make(true).pipe(A.keepAlive);
  fx.atoms.permission = allowed as never;
  return { createCommandPermissions: () => ({ permissionAtom: () => allowed }) };
});
vi.mock("@goat/client-runtime/state/runtime", async (importOriginal) => {
  const real = await importOriginal<typeof import("@goat/client-runtime/state/runtime")>();
  const { Atom: A, AsyncResult: R } = await import("effect/reactivity");
  const answer = (tag: string) =>
    (fx.atoms[tag] ??= A.make<unknown>(R.initial(true)).pipe(A.keepAlive) as never);
  return {
    ...real,
    createEnvironmentRpcQueryAtomFamily: (_runtime: unknown, options: { tag: string }) => {
      const family = A.family((key: string) => {
        const target = JSON.parse(key) as { environmentId: string; input?: { botId?: string } };
        // Only the main bot on "env" answers a list; any other list read waits.
        if (
          options.tag === "channel.listBotThreads" &&
          (target.environmentId !== "env" || target.input?.botId !== undefined)
        )
          return A.make(R.initial(true));
        return A.make((get) => get(answer(options.tag)));
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
vi.mock("../../state/presentation", () => ({ environmentPresentations: {} }));
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
  Text: (props: Props) => <span>{props.children}</span>,
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
    presentationById: new Map([
      [
        "env",
        {
          serverConfig: {
            environment: {
              capabilities: fx.registry.get(fx.config("env"))?.environment.capabilities,
            },
          },
        },
      ],
    ]),
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
vi.mock("./goatBotHomeMode", () => ({
  pickMobileGoatBotEnvironment: () => ({ environmentId: "env", connected: true, label: "jun-mac" }),
}));
vi.mock("./useMobileGoatBotHomeMode", () => ({
  useMobileGoatBotHomeMode: () => ({ environments: [], botRef: { threadId: "bot" } }),
}));
vi.mock("./useMobileGoatBotMemberModel", () => ({ useMobileGoatBotMemberModelMenu: () => null }));
vi.mock("./GoatBotMarkdown", () => ({ GoatBotMarkdown: () => null }));
vi.mock("../../components/ui/Button", () => ({
  Button: (props: { label: string; onPress: () => void }) => (
    <button onClick={props.onPress}>{props.label}</button>
  ),
}));
import { hiddenGoatBotThreadKeysAtom } from "../threads/goatBotThreadVisibility";
import { MobileBotWork } from "./MobileBotWork";

const env = EnvironmentId.make("env");
const far = EnvironmentId.make("far");
const conversation = ThreadId.make("channel-bot:main");
// Retention reads the clock; setup() pins it here so rows a minute or an hour old stay listed.
const NOW = Date.parse("2026-11-14T03:00:00.000Z");
const at = new Date(NOW - 60_000).toISOString();
const decode = Schema.decodeUnknownSync(BotThreadRow);
const task = (taskId: string, title: string, worker: string, finishedMinutesAgo?: number) => {
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
    worker: { environmentId: env, threadId: worker },
  });
};
const coding = (threadId: string, taskId: string, title: string, workKind: "coding" | "chore") =>
  decode({
    kind: "coding",
    taskId,
    environmentId: env,
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
const setList = (result: unknown) =>
  fx.registry.set(fx.atoms["channel.listBotThreads"] as never, result as never);

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
    threads: [shell("r1", launch("coding", "ssh_thread_launch"))],
  } satisfies OrchestrationV2ShellSnapshot);
  fx.registry.set(fx.config("env"), configOf(env));
  fx.registry.set(fx.connection("env"), connected);
  fx.registry.set(fx.atoms.permission as never, true as never);
  fx.registry.set(fx.config("far"), configOf(far));
  fx.registry.set(
    fx.atoms.preferences as never,
    AsyncResult.success({ showGoatBotThreads: false }) as never,
  );
  fx.atoms["channel.listBots"] ??= Atom.make<unknown>(null).pipe(Atom.keepAlive) as never;
  fx.registry.set(
    fx.atoms["channel.listBots"] as never,
    AsyncResult.success({ bots: [] }) as never,
  );
  fx.atoms["channel.listChildWork"] ??= Atom.make<unknown>(null).pipe(Atom.keepAlive) as never;
  fx.registry.set(
    fx.atoms["channel.listChildWork"] as never,
    AsyncResult.success({ groups: [] }) as never,
  );
  fx.atoms["channel.listBotThreads"] ??= Atom.make<unknown>(null).pipe(Atom.keepAlive) as never;
  setList(AsyncResult.success({ rows, remoteWork: [remote], mainMessageCount: 0 }));
  fx.openThread.mockClear();
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
  // The chore Home does not link stays in Threads; Home lists it among other threads.
  await screen.press("Open Home");
  expect(screen.button("GOAT thread: Tidy logs")).toBeDefined();
});

it("lists Home's work again when its list read fails or a destination disconnects", () => {
  setup();
  fx.registry.set(fx.config("far"), null);
  expect(hiddenWork()).not.toContain(key("far", "r1"));
  expect(hiddenWork()).toContain(key("env", "c1"));
  fx.registry.set(fx.config("far"), configOf(far));
  expect(hiddenWork()).toContain(key("far", "r1"));
  setList(AsyncResult.failure(new Error("offline") as never));
  expect(hiddenWork()).toEqual([]);
});

it("hides nothing from Home while its first list read is pending, offline, or not permitted", () => {
  setup();
  setList(AsyncResult.initial(true));
  expect(hiddenWork()).toEqual([]);
  setList(AsyncResult.success({ rows, remoteWork: [remote], mainMessageCount: 0 }));
  expect(hiddenWork()).toContain(key("env", "c1"));
  // Offline the bot is not eligible, so Home stops governing and the legacy rule decides.
  fx.registry.set(
    fx.connection("env"),
    AsyncResult.success([{ phase: "disconnected" }, Option.none()]),
  );
  expect(hiddenWork()).not.toContain(key("env", "c1"));
  fx.registry.set(fx.connection("env"), connected);
  expect(hiddenWork()).toContain(key("env", "c1"));
  fx.registry.set(fx.atoms.permission as never, false as never);
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
  }
});

it("hides nothing while this device shows GOAT Bot threads", () => {
  setup();
  fx.registry.set(
    fx.atoms.preferences as never,
    AsyncResult.success({ showGoatBotThreads: true }) as never,
  );
  expect(hiddenWork()).toEqual([]);
});
