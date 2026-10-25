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

/** `('unix:path=...',)` from org.a11y.Bus.GetAddress. */
function parseAddress(output: string): string | null {
  return /^\('(.+)',\)\s*$/u.exec(output.trim())?.[1] ?? null;
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

/** The number in a `(uint32 N,)` reply: a process id or a role. */
function parseUint32(output: string): number | null {
  const match = /^\(uint32 (\d+),\)$/u.exec(output.trim());
  return match ? Number(match[1]) : null;
}

export function makeSecureFocusProbe(run: GdbusRunner) {
  let address: string | null = null;
  const busByPid = new Map<number, string>();

  const a11yAddress = async () => {
    address ??= parseAddress(
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
  };
  const call = async (dest: string, path: string, method: string, ...args: string[]) =>
    run([
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
    for (const { bus } of apps) {
      const owner = parseUint32(
        await call(
          "org.freedesktop.DBus",
          "/org/freedesktop/DBus",
          "org.freedesktop.DBus.GetConnectionUnixProcessID",
          bus,
        ),
      );
      if (owner !== null) busByPid.set(owner, bus);
      if (owner === pid) return bus;
    }
    return null;
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
      for (const window of windows) {
        const matches = parseReferences(
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
        for (const match of matches) {
          const role = parseUint32(
            await call(match.bus, match.path, "org.a11y.atspi.Accessible.GetRole"),
          );
          if (role === null) throw new Error("AT-SPI gave no role for the focused object.");
          if (role === ROLE_PASSWORD_TEXT)
            return { known: true, secure: true, windows: windows.length };
        }
      }
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
        { env: { ...environment }, timeout: 1_000, maxBuffer: 256 * 1024 },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      );
    });
