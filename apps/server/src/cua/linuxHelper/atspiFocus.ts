// @effect-diagnostics nodeBuiltinImport:off -- The Linux helper is its own Node process; gdbus finds the accessibility bus.
// @effect-diagnostics globalTimers:off -- A probe's deadline, in plain promises like the rest of the helper.
import * as NodeChildProcess from "node:child_process";

import {
  type AtspiCall,
  type BusReply,
  BusError,
  DAEMON,
  makeAtspiBus,
  untilAborted,
} from "./atspiBus.ts";

/**
 * Whether a password field has focus in one process, read from AT-SPI (D6 in epic #1140).
 *
 * Cua Driver 0.37.0 does not report the focused element on Linux, so the helper asks AT-SPI
 * itself: one Collection.GetMatches for the FOCUSED state under each top-level window of the
 * process, then the role of what matched. gdbus, which ships with GLib wherever AT-SPI runs, finds
 * the accessibility bus; the reads go over one connection to it (atspiBus.ts). An answer the bus
 * cannot give is "unknown", never "not secure"; the helper then fails closed.
 */

export interface SecureFocus {
  /** False when AT-SPI could not say what has focus. */
  readonly known: boolean;
  readonly secure: boolean;
  /** Top-level windows the process shows to AT-SPI: a real tree read, for readiness. */
  readonly windows: number;
}

/** Runs gdbus with these arguments and returns its stdout, or throws. */
export type GdbusRunner = (args: ReadonlyArray<string>) => Promise<string>;

const REGISTRY = "org.a11y.atspi.Registry";
const ROOT = "/org/a11y/atspi/accessible/root";
const ACCESSIBLE = "org.a11y.atspi.Accessible";
const UNKNOWN_METHOD = "org.freedesktop.DBus.Error.UnknownMethod";
// AtspiStateType FOCUSED is 12: bit 12 of the first state word.
const FOCUSED_STATES = [4096, 0];
// AtspiRole PASSWORD_TEXT.
const ROLE_PASSWORD_TEXT = 40;
// Focused objects Collection is asked for per window; more than this is focus unknown.
const MAX_FOCUS_MATCHES = 4;
// More windows than this and the scan would be slow enough to stall observation; focus is then
// reported unknown, which the helper treats as private.
const MAX_WINDOWS = 64;
// AtspiStateType FOCUSED: bit 12 of the first state word.
const STATE_FOCUSED = 1 << 12;
// GTK4 has no Collection interface, so focus is found by walking (#1607). Each object costs
// three calls (state, role, children); past this many in one probe, focus is reported unknown,
// which is private. Measured on GTK4: Calculator 98 objects, a Nautilus window 215-254, one on a
// home folder 975, one on /usr/bin (2,119 files) about 6,500; three of those took 0.38 s.
const MAX_WALK_NODES = 8192;
// Reads one probe has in flight at once, so a walk does not queue hundreds on the app.
const WORKERS = 8;
// A probe still reading after this answers unknown, which is private.
const PROBE_DEADLINE_MS = 2_000;

type Ref = { readonly bus: string; readonly path: string };

/** The (bus name, object path) list of a GetChildren or GetMatches reply; any other reply throws. */
function references(reply: BusReply): ReadonlyArray<Ref> {
  const [list] = reply.body;
  if (reply.signature !== "a(so)" || !Array.isArray(list))
    throw new Error("AT-SPI gave a reply that is not a list of objects.");
  return list.map((item) => {
    const [bus, path] = Array.isArray(item) ? item : [];
    if (typeof bus !== "string" || typeof path !== "string")
      throw new Error("AT-SPI gave a reply that is not a list of objects.");
    return { bus, path };
  });
}

/** The number in a `u` reply, a process id or a role; null for any other reply. */
function uint32(reply: BusReply): number | null {
  const [value] = reply.body;
  return reply.signature === "u" && typeof value === "number" ? value : null;
}

/** The first word of a GetState reply, an `au` of two words; null for any other reply. */
function firstStateWord(reply: BusReply): number | null {
  const [words] = reply.body;
  if (reply.signature !== "au" || !Array.isArray(words) || words.length !== 2) return null;
  return typeof words[0] === "number" ? words[0] : null;
}

/** The interfaces in a GetInterfaces reply, an `as`; null for any other reply. */
function interfaceNames(reply: BusReply): ReadonlyArray<string> | null {
  const [names] = reply.body;
  if (reply.signature !== "as" || !Array.isArray(names)) return null;
  return names.every((name) => typeof name === "string") ? names.map(String) : null;
}

/**
 * An UnknownMethod error reply, by the name in its header. The message text is the app's,
 * translated, so whether the object really lacks Collection is asked separately (GetInterfaces).
 */
function unknownMethod(error: unknown): boolean {
  return error instanceof BusError && error.errorName === UNKNOWN_METHOD;
}

/** `('unix:path=...',)` from org.a11y.Bus.GetAddress. */
function parseAddress(output: string): string | null {
  return /^\('(.+)',\)\s*$/u.exec(output.trim())?.[1] ?? null;
}

/** The accessibility bus address, asked of org.a11y.Bus on the session bus. */
export async function a11yBusAddress(run: GdbusRunner): Promise<string> {
  const address = parseAddress(
    await run([
      "call",
      "--session",
      "--dest",
      "org.a11y.Bus",
      "--object-path",
      "/org/a11y/bus",
      "--method",
      "org.a11y.Bus.GetAddress",
    ]),
  );
  if (address === null) throw new Error("AT-SPI gave no bus address.");
  return address;
}

/** One probe: it shares one cap on calls in flight, and nothing it starts outlives its signal. */
interface ProbeRun {
  readonly signal: AbortSignal;
  readonly stop: () => void;
  /** The connection its reads came from; a read from another one ends the probe. */
  connection: number | undefined;
  inFlight: number;
  readonly waiting: Array<() => void>;
}

/** A turn at one of the probe's call slots, or a rejection once the probe is stopped. */
async function slot(probe: ProbeRun): Promise<() => void> {
  if (probe.inFlight >= WORKERS)
    await untilAborted(new Promise<void>((resolve) => probe.waiting.push(resolve)), probe.signal);
  else probe.inFlight++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = probe.waiting.shift();
    if (next) next();
    else probe.inFlight--;
  };
}

/**
 * read over items, WORKERS at a time and in item order, stopping at the first failure or once the
 * probe has stopped; an item never read has no answer.
 */
async function readEach<T, R>(
  probe: ProbeRun,
  items: ReadonlyArray<T>,
  read: (item: T) => Promise<R>,
): Promise<ReadonlyArray<PromiseSettledResult<R> | undefined>> {
  const answers: Array<PromiseSettledResult<R> | undefined> = [];
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && !probe.signal.aborted && next < items.length) {
      const index = next++;
      const item = items[index];
      if (item === undefined) return;
      try {
        answers[index] = { status: "fulfilled", value: await read(item) };
      } catch (reason) {
        answers[index] = { status: "rejected", reason };
        failed = true;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(WORKERS, items.length) }, worker));
  return answers;
}

/**
 * Judges the answers in item order, as a loop that reads one at a time would: true at the first
 * decisive answer, unless a failure or an unread item comes before it, which throws.
 */
async function anyInOrder<T, R>(
  probe: ProbeRun,
  items: ReadonlyArray<T>,
  read: (item: T) => Promise<R>,
  decisive: (answer: R) => boolean,
): Promise<boolean> {
  const answers = await readEach(probe, items, read);
  for (let index = 0; index < items.length; index++) {
    const answer = answers[index];
    if (answer === undefined) throw new Error("The probe ended before everything was read.");
    if (answer.status === "rejected") throw answer.reason;
    if (decisive(answer.value)) return true;
  }
  return false;
}

/**
 * The probe. `run` finds the accessibility bus; `atspi` makes the calls on it, by default over one
 * connection of this process.
 */
export function makeSecureFocusProbe(
  run: GdbusRunner,
  atspi?: AtspiCall,
  options: { readonly deadlineMs?: number } = {},
) {
  let address: Promise<string> | null = null;
  // Which app owns which unique name, as learned on connection ownersOn; a new connection may
  // give the same unique name to another process, so it starts empty.
  const busByPid = new Map<number, string>();
  let ownersOn: number | undefined;
  const a11yAddress = () => (address ??= a11yBusAddress(run));
  const send = atspi ?? makeAtspiBus({ address: a11yAddress });

  const probeFocus = async (probe: ProbeRun, pid: number): Promise<SecureFocus> => {
    const call = async (
      destination: string,
      path: string,
      iface: string,
      member: string,
      signature?: string,
      body?: ReadonlyArray<unknown>,
    ) => {
      const release = await slot(probe);
      try {
        if (probe.signal.aborted) throw new Error("The probe has ended.");
        const reply = await untilAborted(
          send(
            {
              destination,
              path,
              iface,
              member,
              ...(signature === undefined ? {} : { signature }),
              ...(body === undefined ? {} : { body }),
            },
            probe.signal,
          ),
          probe.signal,
        );
        const connection = reply.connection ?? 0;
        if (ownersOn !== connection) {
          busByPid.clear();
          ownersOn = connection;
        }
        probe.connection ??= connection;
        if (probe.connection !== connection)
          throw new Error("The accessibility bus connection changed during the probe.");
        return reply;
      } finally {
        release();
      }
    };

    // Every name is resolved once, to the unique name of its owner, and only that name is
    // called: a well-known name can change owner between two calls.
    const busFor = async () => {
      const known = busByPid.get(pid);
      if (known) {
        probe.connection = ownersOn;
        return known;
      }
      const owner = await call(DAEMON, "/org/freedesktop/DBus", DAEMON, "GetNameOwner", "s", [
        REGISTRY,
      ]);
      const [registry] = owner.body;
      if (owner.signature !== "s" || typeof registry !== "string" || !registry.startsWith(":"))
        throw new Error("The bus daemon gave no owner for the AT-SPI registry.");
      const apps = references(await call(registry, ROOT, ACCESSIBLE, "GetChildren")).filter(
        ({ bus }) => bus.startsWith(":"),
      );
      let found: string | null = null;
      await anyInOrder(
        probe,
        apps,
        async ({ bus }) => {
          const reply = await call(
            DAEMON,
            "/org/freedesktop/DBus",
            DAEMON,
            "GetConnectionUnixProcessID",
            "s",
            [bus],
          );
          const appPid = uint32(reply);
          if (appPid !== null && ownersOn === probe.connection) busByPid.set(appPid, bus);
          return { bus, appPid };
        },
        ({ bus, appPid }) => {
          if (appPid === pid) found = bus;
          return appPid === pid;
        },
      );
      return found;
    };

    const bus = await busFor();
    if (bus === null) return { known: false, secure: false, windows: 0 };
    const windows = references(await call(bus, ROOT, ACCESSIBLE, "GetChildren"));
    if (windows.length > MAX_WINDOWS)
      return { known: false, secure: false, windows: windows.length };
    // Objects a walk may still find; each GetChildren answer spends its count at once.
    let walkBudget = MAX_WALK_NODES;
    const readStates = async (node: Ref) => {
      const states = firstStateWord(await call(node.bus, node.path, ACCESSIBLE, "GetState"));
      if (states === null) throw new Error("AT-SPI gave no state set.");
      return states;
    };
    // Read again once every window has been read: password fields the walks saw, and
    // everything found focused, by a walk or by Collection.
    const passwords: Ref[] = [];
    const seenFocus: Ref[] = [];
    // Every object of the window, for a toolkit without Collection: its state and role, read a
    // level of the tree at a time. A hidden container can still hold focus, so none is skipped;
    // an unreadable answer or an exhausted budget ends the probe, so focus is unknown.
    const walkFocused = async (window: Ref) => {
      const focused: Ref[] = [];
      walkBudget -= 1;
      if (walkBudget < 0) throw new Error("Too many accessible objects to find focus.");
      for (let level: ReadonlyArray<Ref> = [window]; level.length > 0;) {
        const answers = await readEach(probe, level, async (node) => {
          try {
            const states = await readStates(node);
            const role = uint32(await call(node.bus, node.path, ACCESSIBLE, "GetRole"));
            if (role === null) throw new Error("AT-SPI gave no role.");
            const children = references(await call(node.bus, node.path, ACCESSIBLE, "GetChildren"));
            walkBudget -= children.length;
            if (walkBudget < 0) throw new Error("Too many accessible objects to find focus.");
            return { node, states, role, children };
          } catch (error) {
            probe.stop();
            throw error;
          }
        });
        const next: Ref[] = [];
        for (let index = 0; index < level.length; index++) {
          const answer = answers[index];
          if (answer === undefined) throw new Error("The probe ended before the window was read.");
          if (answer.status === "rejected") throw answer.reason;
          const { node, states, role, children } = answer.value;
          if (role === ROLE_PASSWORD_TEXT) passwords.push(node);
          if ((states & STATE_FOCUSED) !== 0) focused.push(node);
          for (const child of children) next.push(child);
        }
        level = next;
      }
      seenFocus.push(...focused);
      return focused;
    };
    const focusedByCollection = async (window: Ref) => {
      const matches = references(
        await call(
          bus,
          window.path,
          "org.a11y.atspi.Collection",
          "GetMatches",
          // states ALL, attributes/roles/interfaces ALL of none, no inversion; canonical order.
          "(aiia{ss}iaiiasib)uib",
          [[FOCUSED_STATES, 1, {}, 1, [], 1, [], 1, false], 1, MAX_FOCUS_MATCHES + 1, true],
        ),
      );
      // One more than are read: a full answer may have left a focused password field unread.
      if (matches.length > MAX_FOCUS_MATCHES)
        throw new Error("More objects say they are focused than the probe reads.");
      return matches;
    };
    const anyPassword = (refs: ReadonlyArray<Ref>) =>
      anyInOrder(
        probe,
        refs,
        async (ref) => {
          const role = uint32(await call(ref.bus, ref.path, ACCESSIBLE, "GetRole"));
          if (role === null) throw new Error("AT-SPI gave no role for the focused object.");
          return role;
        },
        (role) => role === ROLE_PASSWORD_TEXT,
      );
    const focusedNow = async (node: Ref) => ((await readStates(node)) & STATE_FOCUSED) !== 0;
    const collectionWindows: Ref[] = [];
    for (const window of windows) {
      let matches: ReadonlyArray<Ref>;
      try {
        matches = await focusedByCollection(window);
        collectionWindows.push(window);
        seenFocus.push(...matches);
      } catch (error) {
        if (!unknownMethod(error)) throw error;
        const interfaces = interfaceNames(
          await call(bus, window.path, ACCESSIBLE, "GetInterfaces"),
        );
        if (interfaces === null || interfaces.includes("org.a11y.atspi.Collection")) throw error;
        matches = await walkFocused(window);
      }
      if (await anyPassword(matches)) return { known: true, secure: true, windows: windows.length };
    }
    // The windows are read one after another, and a walk a level at a time, so focus can
    // move under the probe, within a window or between windows. Everything is asked again:
    // a password field focused through the whole probe is focused now, wherever it is; what
    // was found focused must still be, and the app must still show the same windows, read
    // last. Otherwise focus is unknown. A password field created and focused after its parent
    // was walked is the one change this does not see (#1607).
    if (await anyInOrder(probe, passwords, focusedNow, (focused) => focused))
      return { known: true, secure: true, windows: windows.length };
    if (
      await anyInOrder(
        probe,
        collectionWindows,
        async (window) => anyPassword(await focusedByCollection(window)),
        (password) => password,
      )
    )
      return { known: true, secure: true, windows: windows.length };
    if (await anyInOrder(probe, seenFocus, focusedNow, (focused) => !focused))
      throw new Error("Focus moved while the app was read.");
    const now = references(await call(bus, ROOT, ACCESSIBLE, "GetChildren"));
    const same = (refs: ReadonlyArray<Ref>) => refs.map((ref) => ref.bus + ref.path).join("\n");
    if (same(now) !== same(windows))
      throw new Error("The app's windows changed while they were read.");
    return { known: true, secure: false, windows: windows.length };
  };

  // Returns once everything the probe started has stopped: past the deadline nothing it began
  // is still sent or awaited.
  return async (pid: number): Promise<SecureFocus> => {
    const controller = new AbortController();
    const probe: ProbeRun = {
      signal: controller.signal,
      stop: () => controller.abort(),
      connection: undefined,
      inFlight: 0,
      waiting: [],
    };
    const deadline = setTimeout(() => controller.abort(), options.deadlineMs ?? PROBE_DEADLINE_MS);
    const body = probeFocus(probe, pid);
    try {
      return await untilAborted(body, controller.signal);
    } catch {
      // A restarted app gets a new bus name; look it up again next time.
      busByPid.delete(pid);
      address = null;
      return { known: false, secure: false, windows: 0 };
    } finally {
      clearTimeout(deadline);
      controller.abort();
      await body.catch(() => undefined);
    }
  };
}

export const gdbusRunner =
  (environment: Readonly<Record<string, string>>): GdbusRunner =>
  (args) =>
    new Promise((resolve, reject) => {
      NodeChildProcess.execFile(
        "gdbus",
        [...args],
        // GLib translates gdbus's own "Error:" line; the C locale keeps it the one this reads.
        {
          env: { ...environment, LC_ALL: "C", LANGUAGE: "" },
          timeout: 1_000,
          maxBuffer: 256 * 1024,
        },
        (error, stdout, stderr) =>
          error ? reject(new Error(stderr.trim() || error.message)) : resolve(stdout),
      );
    });
