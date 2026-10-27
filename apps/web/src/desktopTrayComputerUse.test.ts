import {
  EnvironmentId,
  ThreadId,
  type ComputerUseApp,
  type PreviewSession,
  type PreviewSessionControl,
} from "@goat/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  deriveTrayComputerUse,
  runTrayComputerUseAction,
  watchTrayComputerUse,
  type TrayControl,
} from "./desktopTrayComputerUse";

const env = EnvironmentId.make("env");
const live = new Set([env]);

const CATALOG: ReadonlyArray<ComputerUseApp> = [
  { id: "com.apple.calculator", name: "Calculator" },
  { id: "com.kakao.KakaoTalk", name: "KakaoTalk" },
];

const PNG_PREFIX = "data:image/png;base64,";

function session(
  id: string,
  scope: readonly string[] | "screen",
  options: {
    readonly kind?: PreviewSession["kind"];
    readonly controls?: ReadonlyArray<PreviewSessionControl>;
    readonly status?: PreviewSession["status"];
    readonly threadId?: string | null;
  } = {},
): PreviewSession {
  const kind = options.kind ?? "desktop";
  const threadId = options.threadId === null ? undefined : ThreadId.make(options.threadId ?? id);
  const controls = options.controls ?? ["takeover", "stop", "stopAll"];
  return {
    id,
    kind,
    environmentId: env,
    host: "local",
    platform: "mac",
    ...(threadId === undefined ? {} : { threadId }),
    target:
      kind === "browser"
        ? { kind: "browser", tabId: id, url: "https://example.test", title: id }
        : { kind: "desktop", title: id },
    owner: "agent",
    status: options.status ?? "acting",
    lease: {
      threadId: threadId ?? ThreadId.make(id),
      expiresAt: "2026-10-28T00:00:00.000Z",
      ...(scope === "screen" ? {} : { scope: [...scope] }),
    },
    capabilities: {
      controls: [...controls],
      frames: false,
      privateMode: false,
      humanInput: false,
    },
  };
}

function caseFive(): ReadonlyArray<PreviewSession> {
  return [
    session("t1", ["com.apple.calculator", "com.kakao.KakaoTalk"]),
    session("t2", ["com.kakao.kakaotalk"]),
    session("t3", "screen"),
  ];
}

function derive(
  sessions: ReadonlyArray<PreviewSession>,
  options: {
    readonly environmentId?: EnvironmentId | null;
    readonly liveEnvironmentIds?: ReadonlySet<EnvironmentId>;
    readonly apps?: ReadonlyArray<ComputerUseApp>;
  } = {},
) {
  return deriveTrayComputerUse({
    environmentId: "environmentId" in options ? (options.environmentId ?? null) : env,
    liveEnvironmentIds: options.liveEnvironmentIds ?? live,
    sessions,
    apps: options.apps ?? CATALOG,
  });
}

const stopped: TrayControl = async () => AsyncResult.success({ applied: true });
const missing: TrayControl = async () =>
  AsyncResult.success({ applied: false, reason: "not_found" });
const denied: TrayControl = async () =>
  AsyncResult.success({ applied: false, reason: "not_allowed" });

async function run(
  action:
    | { readonly kind: "stop-computer-use"; readonly appId: string | null }
    | { readonly kind: "stop-all-computer-use" },
  options: {
    readonly environmentId?: EnvironmentId | null;
    readonly sessions?: ReadonlyArray<PreviewSession>;
    readonly control?: TrayControl;
  } = {},
) {
  const control = vi.fn(options.control ?? stopped);
  const notify = vi.fn();
  const reveal = vi.fn();
  await runTrayComputerUseAction(action, {
    environmentId: "environmentId" in options ? (options.environmentId ?? null) : env,
    sessions: options.sessions ?? caseFive(),
    control,
    notify,
    reveal,
  });
  return { control, notify, reveal };
}

describe("deriveTrayComputerUse", () => {
  it("ignores stopped sessions, sessions that cannot be stopped, and browser sessions", () => {
    expect(
      derive([
        session("stopped", ["com.apple.calculator"], {
          status: "stopped",
          controls: ["stopAll"],
        }),
        session("needs-permission", ["com.kakao.KakaoTalk"], {
          status: "permission-needed",
          controls: [],
        }),
        session("browser", "screen", { kind: "browser", controls: ["stop", "stopAll"] }),
      ]),
    ).toBeNull();
  });

  it("returns null when the primary environment is missing or its shell is not live", () => {
    expect(derive(caseFive(), { environmentId: null })).toBeNull();
    expect(derive(caseFive(), { liveEnvironmentIds: new Set() })).toBeNull();
    expect(
      derive(caseFive(), { liveEnvironmentIds: new Set([EnvironmentId.make("other")]) }),
    ).toBeNull();
  });

  it("counts an empty app list as a thread and shows no target", () => {
    expect(derive([session("t", [])])).toEqual({
      threadCount: 1,
      appCount: 0,
      targets: [],
    });
  });

  it("groups app ids case-insensitively and appends the whole screen", () => {
    expect(derive(caseFive())).toEqual({
      threadCount: 3,
      appCount: 2,
      targets: [
        {
          appId: "com.apple.calculator",
          name: "Calculator",
          icon: null,
          threadCount: 1,
        },
        {
          appId: "com.kakao.KakaoTalk",
          name: "KakaoTalk",
          icon: null,
          threadCount: 2,
        },
        { appId: null, name: "Screen", icon: null, threadCount: 1 },
      ],
    });
  });

  it("uses the scope id as the name when the catalog has no match", () => {
    expect(derive([session("t", ["com.unknown.App"])], { apps: [] })).toEqual({
      threadCount: 1,
      appCount: 1,
      targets: [{ appId: "com.unknown.App", name: "com.unknown.App", icon: null, threadCount: 1 }],
    });
  });

  it("keeps a png icon of 65,536 characters and drops a longer or non-png icon", () => {
    const kept = PNG_PREFIX + "A".repeat(65_536 - PNG_PREFIX.length);
    const over = PNG_PREFIX + "B".repeat(65_537 - PNG_PREFIX.length);
    expect(kept).toHaveLength(65_536);
    expect(over).toHaveLength(65_537);
    expect(
      derive([session("t", ["com.big.App", "com.kept.App", "com.plain.App"])], {
        apps: [
          { id: "com.big.App", name: "Big", icon: over },
          { id: "com.kept.App", name: "Kept", icon: kept },
          { id: "com.plain.App", name: "Plain", icon: "https://example.test/icon.png" },
        ],
      })?.targets.map((target) => ({ name: target.name, icon: target.icon })),
    ).toEqual([
      { name: "Big", icon: null },
      { name: "Kept", icon: kept },
      { name: "Plain", icon: null },
    ]);
  });

  it("lists the first twelve apps by name and then the screen when thirteen apps are held", () => {
    const apps = Array.from({ length: 13 }, (_, index) => {
      const n = String(13 - index).padStart(2, "0");
      return { id: `id-${n}`, name: `App ${n}` };
    });
    const derived = derive(
      [
        session(
          "apps",
          apps.map((app) => app.id),
        ),
        session("screen", "screen"),
      ],
      { apps },
    );
    expect(derived?.appCount).toBe(13);
    expect(derived?.targets).toHaveLength(13);
    expect(derived?.targets.slice(0, 12).map((target) => target.name)).toEqual(
      Array.from({ length: 12 }, (_, index) => `App ${String(index + 1).padStart(2, "0")}`),
    );
    expect(derived?.targets.some((target) => target.name === "App 13")).toBe(false);
    expect(derived?.targets[12]).toMatchObject({ appId: null, threadCount: 1 });
  });

  it("clamps a section and a target at 1000 threads", () => {
    const sessions = Array.from({ length: 1_200 }, (_, index) =>
      session(`h${index}`, ["com.apple.calculator"]),
    );
    expect(derive(sessions)).toEqual({
      threadCount: 1000,
      appCount: 1,
      targets: [
        {
          appId: "com.apple.calculator",
          name: "Calculator",
          icon: null,
          threadCount: 1000,
        },
      ],
    });
  });
});

describe("runTrayComputerUseAction", () => {
  it("stops every holder of an app, matching ids case-insensitively, in session order", async () => {
    const { control } = await run({
      kind: "stop-computer-use",
      appId: "com.kakao.KakaoTalk",
    });
    expect(control.mock.calls.map((call) => call[1])).toEqual([
      { sessionId: "t1", control: "stop" },
      { sessionId: "t2", control: "stop" },
    ]);
    expect(control.mock.calls.every((call) => call[0] === env)).toBe(true);
  });

  it("stops sessions with no scope and leaves an empty scope alone", async () => {
    const { control } = await run(
      { kind: "stop-computer-use", appId: null },
      { sessions: [session("t3", "screen"), session("t4", [])] },
    );
    expect(control.mock.calls.map((call) => call[1])).toEqual([
      { sessionId: "t3", control: "stop" },
    ]);
  });

  it("stops every current holder, past the number of menu rows", async () => {
    const sessions = Array.from({ length: 25 }, (_, index) => session(`h${index}`, ["App"]));
    const { control } = await run({ kind: "stop-computer-use", appId: "App" }, { sessions });
    expect(control).toHaveBeenCalledTimes(25);
    expect(control.mock.calls.map((call) => call[1]?.sessionId)).toEqual(
      sessions.map((holder) => holder.id),
    );
  });

  it("does nothing when no live session holds the app", async () => {
    const { control, notify, reveal } = await run({
      kind: "stop-computer-use",
      appId: "com.missing.App",
    });
    expect(control).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(reveal).not.toHaveBeenCalled();
  });

  it("stays quiet when a holder has already ended", async () => {
    const { control, notify, reveal } = await run(
      { kind: "stop-computer-use", appId: "com.apple.calculator" },
      { control: missing },
    );
    expect(control).toHaveBeenCalledWith(env, { sessionId: "t1", control: "stop" });
    expect(notify).not.toHaveBeenCalled();
    expect(reveal).not.toHaveBeenCalled();
  });

  it("reports one denial when a grant could not be ended, after stopping the rest", async () => {
    const control = vi
      .fn<TrayControl>()
      .mockImplementationOnce(denied)
      .mockImplementationOnce(stopped);
    const { notify, reveal } = await run(
      { kind: "stop-computer-use", appId: "com.kakao.KakaoTalk" },
      { control },
    );
    expect(control).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({
      title: "The agent stopped, but its apps are still reserved",
      description: "Its computer use approval could not be ended. Stop all releases them.",
    });
    expect(reveal).toHaveBeenCalledTimes(1);
  });

  it("reports stop all only when the server did not apply it", async () => {
    const applied = await run({ kind: "stop-all-computer-use" }, { sessions: [] });
    expect(applied.control).toHaveBeenCalledTimes(1);
    expect(applied.control).toHaveBeenCalledWith(env, { control: "stopAll" });
    expect(applied.notify).not.toHaveBeenCalled();
    expect(applied.reveal).not.toHaveBeenCalled();

    const failed = await run({ kind: "stop-all-computer-use" }, { sessions: [], control: denied });
    expect(failed.control).toHaveBeenCalledTimes(1);
    expect(failed.control).toHaveBeenCalledWith(env, { control: "stopAll" });
    expect(failed.notify).toHaveBeenCalledTimes(1);
    expect(failed.notify).toHaveBeenCalledWith({
      title: "Some agents could not be stopped",
      description: "An approval for computer use is still active. Try Stop all again.",
    });
    expect(failed.reveal).toHaveBeenCalledTimes(1);
  });

  it("does not call control when the primary environment is missing", async () => {
    const stop = await run(
      { kind: "stop-computer-use", appId: "com.kakao.KakaoTalk" },
      { environmentId: null },
    );
    const stopAll = await run({ kind: "stop-all-computer-use" }, { environmentId: null });
    expect(stop.control).not.toHaveBeenCalled();
    expect(stopAll.control).not.toHaveBeenCalled();
  });
});

describe("watchTrayComputerUse", () => {
  it("reads the current primary snapshot and hears later session changes", async () => {
    const primary = Atom.make<EnvironmentId | null>(env);
    const liveIds = Atom.make<ReadonlySet<EnvironmentId>>(live);
    const sessions = Atom.make<
      AsyncResult.AsyncResult<{ readonly sessions: ReadonlyArray<PreviewSession> }, unknown>
    >(AsyncResult.success({ sessions: caseFive() }));
    const apps = Atom.make<
      AsyncResult.AsyncResult<{ readonly apps: ReadonlyArray<ComputerUseApp> }, unknown>
    >(AsyncResult.success({ apps: CATALOG }));
    const registry = AtomRegistry.make();
    const onChange = vi.fn();
    const watched = watchTrayComputerUse(
      registry,
      {
        primary,
        live: liveIds,
        sessions: () => sessions,
        apps: () => apps,
      },
      onChange,
    );
    try {
      expect(watched.current()?.targets).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ appId: "com.kakao.KakaoTalk", name: "KakaoTalk" }),
        ]),
      );
      const control = vi.fn(stopped);
      await watched.run(
        { kind: "stop-computer-use", appId: "com.kakao.KakaoTalk" },
        { control, notify: () => {}, reveal: () => {} },
      );
      expect(control).toHaveBeenCalledWith(env, { sessionId: "t1", control: "stop" });
      expect(control).toHaveBeenCalledWith(env, { sessionId: "t2", control: "stop" });
      const before = onChange.mock.calls.length;
      registry.set(sessions, AsyncResult.success({ sessions: [] }));
      expect(onChange.mock.calls.length).toBeGreaterThan(before);
    } finally {
      watched.dispose();
      registry.dispose();
    }
  });
});
