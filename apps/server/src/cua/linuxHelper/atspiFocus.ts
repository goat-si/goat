// @effect-diagnostics nodeBuiltinImport:off -- The Linux helper is its own Node process; gdbus finds the accessibility bus.
// @effect-diagnostics globalTimers:off -- A probe's deadline, in plain promises like the rest of the helper.
import * as NodeChildProcess from "node:child_process";

import {
  type AtspiCall,
  type BusReply,
  type DbusValue,
  BusError,
  makeAtspiBus,
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

/** One probe: its reads all come from one connection, and none starts once it has ended. */
interface ProbeRun {
  ended: boolean;
  connection: number | undefined;
}

/**
 * read over items, WORKERS at a time and in item order, stopping at the first failure or once the
 * probe has ended; an item never read has no answer.
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
    while (!failed && !probe.ended && next < items.length) {
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
  // Which app owns which bus name, as learned on connection ownersOn; a new connection may
  // give the same unique name to another process, so it starts empty.
  const busByPid = new Map<number, string>();
  let ownersOn: number | undefined;
  const a11yAddress = () => (address ??= a11yBusAddress(run));
  const send = atspi ?? makeAtspiBus({ address: a11yAddress, uid: process.getuid?.() ?? 0 });

  const probeFocus = async (probe: ProbeRun, pid: number): Promise<SecureFocus> => {
    const call = async (
      destination: string,
      path: string,
      iface: string,
      member: string,
      signature?: string,
      body?: ReadonlyArray<DbusValue>,
    ) => {
      if (probe.ended) throw new Error("The probe has ended.");
      const reply = await send({
        destination,
        path,
        iface,
        member,
        ...(signature === undefined ? {} : { signature }),
        ...(body === undefined ? {} : { body }),
      });
      const connection = reply.connection ?? 0;
      if (ownersOn !== connection) {
        busByPid.clear();
        ownersOn = connection;
      }
      probe.connection ??= connection;
      if (probe.connection !== connection)
        throw new Error("The accessibility bus connection changed during the probe.");
      return reply;
    };

    const busFor = async () => {
      const known = busByPid.get(pid);
      if (known) {
        probe.connection = ownersOn;
        return known;
      }
      const apps = references(await call(REGISTRY, ROOT, ACCESSIBLE, "GetChildren"));
      let found: string | null = null;
      await anyInOrder(
        probe,
        apps,
        async ({ bus }) => {
          const owner = uint32(
            await call(
              "org.freedesktop.DBus",
              "/org/freedesktop/DBus",
              "org.freedesktop.DBus",
              "GetConnectionUnixProcessID",
              "s",
              [bus],
            ),
          );
          if (owner !== null && ownersOn === probe.connection) busByPid.set(owner, bus);
          return { bus, owner };
        },
        ({ bus, owner }) => {
          if (owner === pid) found = bus;
          return owner === pid;
        },
      );
      return found;
    };

    const bus = await busFor();
    if (bus === null) return { known: false, secure: false, windows: 0 };
    const windows = references(await call(bus, ROOT, ACCESSIBLE, "GetChildren"));
    if (windows.length > MAX_WINDOWS)
      return { known: false, secure: false, windows: windows.length };
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
    // an unreadable answer or an exhausted budget throws, so focus is unknown, and ends the probe.
    const walkFocused = async (window: Ref) => {
      const focused: Ref[] = [];
      for (let level: ReadonlyArray<Ref> = [window]; level.length > 0;) {
        walkBudget -= level.length;
        if (walkBudget < 0) throw new Error("Too many accessible objects to find focus.");
        const answers = await readEach(probe, level, async (node) => {
          try {
            const states = await readStates(node);
            const role = uint32(await call(node.bus, node.path, ACCESSIBLE, "GetRole"));
            if (role === null) throw new Error("AT-SPI gave no role.");
            const children = references(await call(node.bus, node.path, ACCESSIBLE, "GetChildren"));
            return { node, states, role, children };
          } catch (error) {
            probe.ended = true;
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
          if (next.length + children.length > walkBudget)
            throw new Error("Too many accessible objects to find focus.");
          for (const child of children) next.push(child);
        }
        level = next;
      }
      seenFocus.push(...focused);
      return focused;
    };
    const focusedByCollection = async (window: Ref) =>
      references(
        await call(
          bus,
          window.path,
          "org.a11y.atspi.Collection",
          "GetMatches",
          // states ALL, attributes/roles/interfaces ALL of none, no inversion; canonical order.
          "(aiia{ss}iaiiasib)uib",
          [[FOCUSED_STATES, 1, [], 1, [], 1, [], 1, false], 1, 4, true],
        ),
      );
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

  return async (pid: number): Promise<SecureFocus> => {
    const probe: ProbeRun = { ended: false, connection: undefined };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("The probe ran past its deadline.")),
        options.deadlineMs ?? PROBE_DEADLINE_MS,
      );
    });
    try {
      return await Promise.race([probeFocus(probe, pid), deadline]);
    } catch {
      // A restarted app gets a new bus name; look it up again next time.
      busByPid.delete(pid);
      address = null;
      return { known: false, secure: false, windows: 0 };
    } finally {
      probe.ended = true;
      clearTimeout(timer);
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
