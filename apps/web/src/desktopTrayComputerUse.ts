import type {
  ComputerUseApp,
  DesktopBridge,
  EnvironmentId,
  PreviewSession,
  PreviewSessionControlInput,
  PreviewSessionControlResult,
} from "@goat/contracts";
import type { AtomCommandResult } from "@goat/client-runtime/state/runtime";
import * as Option from "effect/Option";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";

type DesktopTrayMenu = Parameters<NonNullable<DesktopBridge["setTrayMenu"]>>[0];
type DesktopTrayComputerUse = NonNullable<DesktopTrayMenu["computerUse"]>;
type DesktopTrayAction = Parameters<Parameters<NonNullable<DesktopBridge["onTrayAction"]>>[0]>[0];

export type TrayComputerUseAction = Extract<
  DesktopTrayAction,
  { readonly kind: "stop-computer-use" } | { readonly kind: "stop-all-computer-use" }
>;

const APP_TARGET_LIMIT = 12;
const COUNT_LIMIT = 1000;
const ICON_LIMIT = 65_536;
const NAME_LIMIT = 200;
const PNG_ICON = /^data:image\/png;base64,/;

const GRANT_STILL_HELD = {
  title: "The agent stopped, but its apps are still reserved",
  description: "Its computer use approval could not be ended. Stop all releases them.",
} as const;

const STOP_ALL_INCOMPLETE = {
  title: "Some agents could not be stopped",
  description: "An approval for computer use is still active. Try Stop all again.",
} as const;

export type TrayControl = (
  environmentId: EnvironmentId,
  input: PreviewSessionControlInput,
) => Promise<AtomCommandResult<PreviewSessionControlResult, unknown>>;

export interface TrayEffects {
  readonly control: TrayControl;
  readonly notify: (copy: { readonly title: string; readonly description: string }) => void;
  /** Brings a hidden window forward so a notice can be seen. */
  readonly reveal: () => void;
}

const clampCount = (count: number) => Math.min(count, COUNT_LIMIT);

const clampName = (name: string) => Array.from(name).slice(0, NAME_LIMIT).join("");

const iconOf = (icon: string | undefined): string | null =>
  icon !== undefined && icon.length <= ICON_LIMIT && PNG_ICON.test(icon) ? icon : null;

const byName = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

/** Acting, paused, or waiting. An ended session offers only stop-all, so it is not live. */
const isLiveDesktop = (session: PreviewSession) =>
  session.kind === "desktop" &&
  session.threadId !== undefined &&
  session.capabilities.controls.includes("stop");

/**
 * Absent scope is the whole screen, including a pause whose scope was never stored.
 * An empty list is not, and ids match case-insensitively, as grants do.
 */
function trayComputerUseHolders(
  sessions: ReadonlyArray<PreviewSession>,
  appId: string | null,
): ReadonlyArray<PreviewSession> {
  const wanted = appId === null ? null : appId.toLowerCase();
  const holders: PreviewSession[] = [];
  for (const session of sessions) {
    if (!isLiveDesktop(session)) continue;
    const scope = session.lease?.scope;
    if (wanted === null) {
      if (scope === undefined) holders.push(session);
      continue;
    }
    if (scope?.some((id) => id.toLowerCase() === wanted)) holders.push(session);
  }
  return holders;
}

export function deriveTrayComputerUse(input: {
  readonly environmentId: EnvironmentId | null;
  readonly liveEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly sessions: ReadonlyArray<PreviewSession>;
  readonly apps: ReadonlyArray<ComputerUseApp>;
}): DesktopTrayComputerUse | null {
  if (input.environmentId === null || !input.liveEnvironmentIds.has(input.environmentId)) {
    return null;
  }
  const catalog = new Map<string, ComputerUseApp>();
  for (const app of input.apps) {
    const key = app.id.toLowerCase();
    if (!catalog.has(key)) catalog.set(key, app);
  }
  const groups = new Map<string, { readonly appId: string; count: number }>();
  let threadCount = 0;
  let screenCount = 0;
  for (const session of input.sessions) {
    if (!isLiveDesktop(session)) continue;
    threadCount += 1;
    const scope = session.lease?.scope;
    if (scope === undefined) {
      screenCount += 1;
      continue;
    }
    const seen = new Set<string>();
    for (const id of scope) {
      const key = id.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const group = groups.get(key);
      if (group === undefined) groups.set(key, { appId: id, count: 1 });
      else group.count += 1;
    }
  }
  if (threadCount === 0) return null;
  const appTargets = [...groups.values()]
    .map((group) => {
      const app = catalog.get(group.appId.toLowerCase());
      return {
        appId: group.appId,
        name: clampName(app?.name ?? group.appId),
        icon: iconOf(app?.icon),
        threadCount: clampCount(group.count),
      };
    })
    .sort((left, right) => byName(left.name, right.name))
    .slice(0, APP_TARGET_LIMIT);
  const screenTarget =
    screenCount > 0
      ? [
          {
            appId: null,
            name: "Screen",
            icon: null,
            threadCount: clampCount(screenCount),
          },
        ]
      : [];
  const targets = [...appTargets, ...screenTarget];
  return {
    threadCount: clampCount(threadCount),
    appCount: clampCount(groups.size),
    targets,
  };
}

export async function runTrayComputerUseAction(
  action: TrayComputerUseAction,
  input: {
    readonly environmentId: EnvironmentId | null;
    readonly sessions: ReadonlyArray<PreviewSession>;
  } & TrayEffects,
): Promise<void> {
  const environmentId = input.environmentId;
  if (environmentId === null) return;
  if (action.kind === "stop-all-computer-use") {
    const result = await input.control(environmentId, { control: "stopAll" });
    if (result._tag === "Success" && !result.value.applied) {
      input.notify(STOP_ALL_INCOMPLETE);
      input.reveal();
    }
    return;
  }
  const holders = trayComputerUseHolders(input.sessions, action.appId);
  if (holders.length === 0) return;
  let denied = false;
  for (const holder of holders) {
    const result = await input.control(environmentId, {
      sessionId: holder.id,
      control: "stop",
    });
    if (result._tag === "Success" && result.value.reason === "not_allowed") denied = true;
  }
  if (denied) {
    input.notify(GRANT_STILL_HELD);
    input.reveal();
  }
}

export interface TrayComputerUseAtoms<
  Sessions extends { readonly sessions: ReadonlyArray<PreviewSession> },
  Apps extends { readonly apps: ReadonlyArray<ComputerUseApp> },
  SessionsE,
  AppsE,
> {
  readonly primary: Atom.Atom<EnvironmentId | null>;
  readonly live: Atom.Atom<ReadonlySet<EnvironmentId>>;
  readonly sessions: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<AsyncResult.AsyncResult<Sessions, SessionsE>>;
  readonly apps: (environmentId: EnvironmentId) => Atom.Atom<AsyncResult.AsyncResult<Apps, AppsE>>;
}

export function watchTrayComputerUse<
  Sessions extends { readonly sessions: ReadonlyArray<PreviewSession> },
  Apps extends { readonly apps: ReadonlyArray<ComputerUseApp> },
  SessionsE,
  AppsE,
>(
  registry: AtomRegistry.AtomRegistry,
  atoms: TrayComputerUseAtoms<Sessions, Apps, SessionsE, AppsE>,
  onChange: () => void,
): {
  current(): DesktopTrayComputerUse | null;
  run(action: TrayComputerUseAction, effects: TrayEffects): Promise<void>;
  dispose(): void;
} {
  let sessionsUnsubscribe: (() => void) | undefined;
  let appsUnsubscribe: (() => void) | undefined;
  let sessionsFor: EnvironmentId | null = null;
  let appsFor: EnvironmentId | null = null;

  const readSessions = (environmentId: EnvironmentId): ReadonlyArray<PreviewSession> =>
    Option.getOrNull(AsyncResult.value(registry.get(atoms.sessions(environmentId))))?.sessions ??
    [];

  const readApps = (environmentId: EnvironmentId): ReadonlyArray<ComputerUseApp> =>
    Option.getOrNull(AsyncResult.value(registry.get(atoms.apps(environmentId))))?.apps ?? [];

  const syncApps = () => {
    const environmentId = registry.get(atoms.primary);
    const needsApps = environmentId !== null && readSessions(environmentId).some(isLiveDesktop);
    if (!needsApps) {
      appsUnsubscribe?.();
      appsUnsubscribe = undefined;
      appsFor = null;
      return;
    }
    if (appsFor === environmentId && appsUnsubscribe !== undefined) return;
    appsUnsubscribe?.();
    appsFor = environmentId;
    appsUnsubscribe = registry.subscribe(atoms.apps(environmentId), () => {
      onChange();
    });
  };

  const syncSessions = () => {
    const environmentId = registry.get(atoms.primary);
    if (sessionsFor !== environmentId) {
      sessionsUnsubscribe?.();
      sessionsUnsubscribe = undefined;
      sessionsFor = environmentId;
      if (environmentId !== null) {
        sessionsUnsubscribe = registry.subscribe(atoms.sessions(environmentId), () => {
          syncApps();
          onChange();
        });
      }
    }
    syncApps();
  };

  const unsubscribePrimary = registry.subscribe(atoms.primary, () => {
    syncSessions();
    onChange();
  });
  const unsubscribeLive = registry.subscribe(atoms.live, () => {
    onChange();
  });
  syncSessions();

  return {
    current() {
      const environmentId = registry.get(atoms.primary);
      const liveEnvironmentIds = registry.get(atoms.live);
      if (environmentId === null || !liveEnvironmentIds.has(environmentId)) return null;
      const sessions = readSessions(environmentId);
      if (!sessions.some(isLiveDesktop)) return null;
      return deriveTrayComputerUse({
        environmentId,
        liveEnvironmentIds,
        sessions,
        apps: readApps(environmentId),
      });
    },
    run(action, effects) {
      const environmentId = registry.get(atoms.primary);
      return runTrayComputerUseAction(action, {
        environmentId,
        sessions: environmentId === null ? [] : readSessions(environmentId),
        ...effects,
      });
    },
    dispose() {
      unsubscribePrimary();
      unsubscribeLive();
      sessionsUnsubscribe?.();
      appsUnsubscribe?.();
      sessionsUnsubscribe = undefined;
      appsUnsubscribe = undefined;
    },
  };
}
