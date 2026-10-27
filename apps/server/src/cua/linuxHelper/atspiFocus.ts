// @effect-diagnostics nodeBuiltinImport:off -- The Linux helper is its own Node process; gdbus is its D-Bus client.
import * as NodeChildProcess from "node:child_process";

/**
 * Whether a password field has focus in one process, read from AT-SPI (D6 in epic #1140).
 *
 * Cua Driver 0.37.0 does not report the focused element on Linux, so the helper asks AT-SPI
 * itself: one Collection.GetMatches for the FOCUSED state under each top-level window of the
 * process, then the role of what matched. gdbus ships with GLib wherever AT-SPI runs, so this
 * adds no dependency. An answer the bus cannot give is "unknown", never "not secure"; the
 * helper then fails closed.
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
// AtspiStateType FOCUSED is 12: bit 12 of the first state word.
const FOCUSED_STATES = "[4096, 0]";
// AtspiRole PASSWORD_TEXT.
const ROLE_PASSWORD_TEXT = 40;
// More windows than this and the scan would be slow enough to stall observation; focus is then
// reported unknown, which the helper treats as private.
const MAX_WINDOWS = 64;
// AtspiStateType FOCUSED: bit 12 of the first state word.
const STATE_FOCUSED = 1 << 12;
// GTK4 has no Collection interface, so focus is found by walking (#1607). Each object costs
// three gdbus calls (state, role, children); past this many in one probe, focus is reported
// unknown, which is private. Measured on GTK4: Calculator 98 objects, Text Editor 63, a Nautilus
// window 215-254, two of them 469 (0.9 s to walk); one showing 79 files in a home folder, 975.
const MAX_WALK_NODES = 512;
const UINT32_MAX = 0xffff_ffff;
// gdbus processes running at once. Each call is its own process; on a 16-thread host, 780 calls
// took 1.4 s one at a time and 0.43 s at four or eight at once, and no less with more.
const CONCURRENT_CALLS = 8;

/** The first state word of a `GetState` reply, `([uint32 N, M],)`; null for any other reply. */
function parseStates(output: string): number | null {
  const match = /^\(\[uint32 (\d{1,10}), (?:uint32 )?(\d{1,10})\],\)$/u.exec(output.trim());
  if (!match) return null;
  const [first, second] = [Number(match[1]), Number(match[2])];
  return first <= UINT32_MAX && second <= UINT32_MAX ? first : null;
}

/**
 * A gdbus failure whose reply is UnknownMethod. The runner fails with gdbus's own stderr, in the
 * C locale, whose first line is the reply's error; a message can run on to further lines, so
 * nothing after it counts. The message text is the app's, translated, so whether the object
 * really lacks Collection is asked separately (GetInterfaces).
 */
function unknownMethod(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return (text.split("\n", 1)[0] ?? "").startsWith(
    "Error: GDBus.Error:org.freedesktop.DBus.Error.UnknownMethod: ",
  );
}

/** The interfaces in a `GetInterfaces` reply, `(['org.a11y.atspi.Accessible', ...],)`. */
function parseInterfaces(output: string): ReadonlyArray<string> | null {
  const reply = output.trim();
  if (reply === "(@as [],)") return [];
  const match = /^\(\[('[A-Za-z0-9_.]+'(?:, '[A-Za-z0-9_.]+')*)\],\)$/u.exec(reply);
  return match ? [...(match[1] ?? "").matchAll(/'([^']+)'/gu)].map(([, name]) => name ?? "") : null;
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

// One (bus name, object path) element of an `a(so)` as gdbus prints it.
const REFERENCE = "\\('([^'\\\\]+)', (?:objectpath )?'(/[^'\\\\]*)'\\)";
// A whole non-empty `(a(so))` reply: the first element carries the type, the rest do not.
const REFERENCE_LIST = new RegExp(
  "^\\(\\[\\('[^'\\\\]+', objectpath '/[^'\\\\]*'\\)(?:, " + REFERENCE + ")*\\],\\)$",
  "u",
);

/**
 * The (bus name, object path) references in a GetChildren or GetMatches reply, an `(a(so))`.
 * gdbus names the `objectpath` type only on an array's first element, so the rest have none
 * (#1606). Any other reply is not an answer: it throws, and the probe reports focus unknown,
 * which is private, instead of reading a malformed reply as "nothing focused".
 */
function parseReferences(
  output: string,
): ReadonlyArray<{ readonly bus: string; readonly path: string }> {
  const reply = output.trim();
  if (/^\(@a\(so\) \[\],\)$/u.test(reply)) return [];
  if (!REFERENCE_LIST.test(reply))
    throw new Error("AT-SPI gave a reply that is not a list of objects.");
  return [...reply.matchAll(new RegExp(REFERENCE, "gu"))].map(([, bus, path]) => ({
    bus: bus ?? "",
    path: path ?? "",
  }));
}

/** The number in a `(uint32 N,)` reply: a process id or a role. GLib never prints more than 32 bits. */
function parseUint32(output: string): number | null {
  const match = /^\(uint32 (\d+),\)$/u.exec(output.trim());
  const value = match ? Number(match[1]) : Number.NaN;
  return value <= 0xffff_ffff ? value : null;
}

/** run, with at most limit calls in flight; the rest wait their turn. */
function limited(run: GdbusRunner, limit: number): GdbusRunner {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async (args) => {
    if (active < limit) active++;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await run(args);
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

/**
 * Reads every item at once, then judges the answers in item order, as a loop that reads one at a
 * time would: true at the first decisive answer, unless a failure comes before it, which throws.
 */
async function anyInOrder<T, R>(
  items: ReadonlyArray<T>,
  read: (item: T) => Promise<R>,
  decisive: (answer: R) => boolean,
): Promise<boolean> {
  for (const answer of await Promise.allSettled(items.map(read))) {
    if (answer.status === "rejected") throw answer.reason;
    if (decisive(answer.value)) return true;
  }
  return false;
}

export function makeSecureFocusProbe(run: GdbusRunner) {
  const runLimited = limited(run, CONCURRENT_CALLS);
  let address: Promise<string> | null = null;
  const busByPid = new Map<number, string>();

  const a11yAddress = () => (address ??= a11yBusAddress(runLimited));
  const call = async (dest: string, path: string, method: string, ...args: string[]) =>
    runLimited([
      "call",
      "--address",
      await a11yAddress(),
      "--dest",
      dest,
      "--object-path",
      path,
      "--method",
      method,
      ...args,
    ]);

  const busFor = async (pid: number) => {
    const known = busByPid.get(pid);
    if (known) return known;
    const apps = parseReferences(
      await call(REGISTRY, ROOT, "org.a11y.atspi.Accessible.GetChildren"),
    );
    let found: string | null = null;
    await anyInOrder(
      apps,
      async ({ bus }) => {
        const owner = parseUint32(
          await call(
            "org.freedesktop.DBus",
            "/org/freedesktop/DBus",
            "org.freedesktop.DBus.GetConnectionUnixProcessID",
            bus,
          ),
        );
        if (owner !== null) busByPid.set(owner, bus);
        return { bus, owner };
      },
      ({ bus, owner }) => {
        if (owner === pid) found = bus;
        return owner === pid;
      },
    );
    return found;
  };

  return async (pid: number): Promise<SecureFocus> => {
    try {
      const bus = await busFor(pid);
      if (bus === null) return { known: false, secure: false, windows: 0 };
      const windows = parseReferences(
        await call(bus, ROOT, "org.a11y.atspi.Accessible.GetChildren"),
      );
      if (windows.length > MAX_WINDOWS)
        return { known: false, secure: false, windows: windows.length };
      let walkBudget = MAX_WALK_NODES;
      type Ref = { readonly bus: string; readonly path: string };
      const readStates = async (node: Ref) => {
        const states = parseStates(
          await call(node.bus, node.path, "org.a11y.atspi.Accessible.GetState"),
        );
        if (states === null) throw new Error("AT-SPI gave no state set.");
        return states;
      };
      // Read again once every window has been read: password fields the walks saw, and
      // everything found focused, by a walk or by Collection.
      const passwords: Ref[] = [];
      const seenFocus: Ref[] = [];
      // Every object of the window, for a toolkit without Collection: its state and role, read a
      // level of the tree at a time. A hidden container can still hold focus, so none is skipped;
      // an unreadable answer or an exhausted budget throws, so focus is unknown.
      const walkFocused = async (window: Ref) => {
        const focused: Ref[] = [];
        for (let level = [window]; level.length > 0;) {
          walkBudget -= level.length;
          if (walkBudget < 0) throw new Error("Too many accessible objects to find focus.");
          const read = await Promise.all(
            level.map(async (node) => {
              const [states, role, children] = await Promise.all([
                readStates(node),
                call(node.bus, node.path, "org.a11y.atspi.Accessible.GetRole").then(parseUint32),
                call(node.bus, node.path, "org.a11y.atspi.Accessible.GetChildren").then(
                  parseReferences,
                ),
              ]);
              if (role === null) throw new Error("AT-SPI gave no role.");
              return { node, states, role, children };
            }),
          );
          for (const { node, states, role } of read) {
            if (role === ROLE_PASSWORD_TEXT) passwords.push(node);
            if ((states & STATE_FOCUSED) !== 0) focused.push(node);
          }
          level = read.flatMap(({ children }) => children);
        }
        seenFocus.push(...focused);
        return focused;
      };
      const focusedByCollection = async (window: Ref) =>
        parseReferences(
          await call(
            bus,
            window.path,
            "org.a11y.atspi.Collection.GetMatches",
            // states ALL, attributes/roles/interfaces ALL of none, no inversion; canonical order.
            "(" + FOCUSED_STATES + ", 1, @a{ss} {}, 1, @ai [], 1, @as [], 1, false)",
            "1",
            "4",
            "true",
          ),
        );
      const anyPassword = (refs: ReadonlyArray<Ref>) =>
        anyInOrder(
          refs,
          async (ref) => {
            const role = parseUint32(
              await call(ref.bus, ref.path, "org.a11y.atspi.Accessible.GetRole"),
            );
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
          const interfaces = parseInterfaces(
            await call(bus, window.path, "org.a11y.atspi.Accessible.GetInterfaces"),
          );
          if (interfaces === null || interfaces.includes("org.a11y.atspi.Collection")) throw error;
          matches = await walkFocused(window);
        }
        if (await anyPassword(matches))
          return { known: true, secure: true, windows: windows.length };
      }
      // The windows are read one after another, and a walk one object at a time, so focus can
      // move under the probe, within a window or between windows. Everything is asked again:
      // a password field focused through the whole probe is focused now, wherever it is; what
      // was found focused must still be, and the app must still show the same windows, read
      // last. Otherwise focus is unknown. A password field created and focused after its parent
      // was walked is the one change this does not see (#1607).
      if (await anyInOrder(passwords, focusedNow, (focused) => focused))
        return { known: true, secure: true, windows: windows.length };
      if (
        await anyInOrder(
          collectionWindows,
          async (window) => anyPassword(await focusedByCollection(window)),
          (password) => password,
        )
      )
        return { known: true, secure: true, windows: windows.length };
      if (await anyInOrder(seenFocus, focusedNow, (focused) => !focused))
        throw new Error("Focus moved while the app was read.");
      const now = parseReferences(await call(bus, ROOT, "org.a11y.atspi.Accessible.GetChildren"));
      const same = (refs: ReadonlyArray<Ref>) => refs.map((ref) => ref.bus + ref.path).join("\n");
      if (same(now) !== same(windows))
        throw new Error("The app's windows changed while they were read.");
      return { known: true, secure: false, windows: windows.length };
    } catch {
      // A restarted app gets a new bus name; look it up again next time.
      busByPid.delete(pid);
      address = null;
      return { known: false, secure: false, windows: 0 };
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
