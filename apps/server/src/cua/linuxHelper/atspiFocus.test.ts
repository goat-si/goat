import { describe, expect, it } from "vite-plus/test";

import { makeSecureFocusProbe, type GdbusRunner } from "./atspiFocus.ts";

/** gdbus answers for one app on the AT-SPI bus: pid 10, its windows, and what has focus. */
const bus =
  (focusedRole: number | null, windows = 1): GdbusRunner =>
  async (args) => {
    const method = args[args.indexOf("--method") + 1];
    if (method === "org.a11y.Bus.GetAddress") return "('unix:path=/run/user/1000/at-spi/bus',)\n";
    if (method === "org.freedesktop.DBus.GetConnectionUnixProcessID") return "(uint32 10,)\n";
    if (method === "org.a11y.atspi.Accessible.GetChildren")
      return args.includes("org.a11y.atspi.Registry")
        ? "([(':1.7', objectpath '/org/a11y/atspi/accessible/root')],)\n"
        : "([" +
            Array.from(
              { length: windows },
              (_, i) => "(':1.7', objectpath '/org/a11y/atspi/accessible/" + (i + 1) + "')",
            ).join(", ") +
            "],)\n";
    if (method === "org.a11y.atspi.Collection.GetMatches")
      return focusedRole === null
        ? "(@a(so) [],)\n"
        : "([(':1.7', objectpath '/org/a11y/atspi/accessible/9')],)\n";
    if (method === "org.a11y.atspi.Accessible.GetRole") return "(uint32 " + focusedRole + ",)\n";
    // What Collection found focused is read again at the end, still focused.
    if (method === "org.a11y.atspi.Accessible.GetState") return "([uint32 1124077568, 0],)\n";
    throw new Error("unexpected " + method);
  };

describe("makeSecureFocusProbe", () => {
  it("reads a focused AT-SPI password field as secure and other focus as not", async () => {
    expect(await makeSecureFocusProbe(bus(40))(10)).toEqual({
      known: true,
      secure: true,
      windows: 1,
    });
    expect(await makeSecureFocusProbe(bus(61))(10)).toEqual({
      known: true,
      secure: false,
      windows: 1,
    });
    expect(await makeSecureFocusProbe(bus(null))(10)).toEqual({
      known: true,
      secure: false,
      windows: 1,
    });
  });

  it("reports focus as unknown when there are more windows than it scans", async () => {
    expect(await makeSecureFocusProbe(bus(null, 65))(10)).toEqual({
      known: false,
      secure: false,
      windows: 65,
    });
  });

  it("reports focus as unknown, never as not secure, when the process or the bus does not answer", async () => {
    expect(await makeSecureFocusProbe(bus(40))(11)).toEqual({
      known: false,
      secure: false,
      windows: 0,
    });
    const broken: GdbusRunner = async () => {
      throw new Error("gdbus: timed out");
    };
    expect(await makeSecureFocusProbe(broken)(10)).toEqual({
      known: false,
      secure: false,
      windows: 0,
    });
  });

  it("finds every app and match in a gdbus reply, which names the object path type only once (#1606)", async () => {
    // As gdbus prints them in a GNOME 46 session: only the first array element carries
    // `objectpath`. The password field is in the third app's second window, second match.
    const pids: Record<string, string> = { ":1.0": "1", ":1.2": "2", ":1.3": "30" };
    const gnome: GdbusRunner = async (args) => {
      const method = args[args.indexOf("--method") + 1];
      const dest = args[args.indexOf("--dest") + 1] ?? "";
      const path = args[args.indexOf("--object-path") + 1] ?? "";
      if (method === "org.a11y.Bus.GetAddress") return "('unix:path=/run/user/1000/at-spi/bus',)\n";
      if (method === "org.freedesktop.DBus.GetConnectionUnixProcessID")
        return "(uint32 " + pids[args.at(-1) ?? ""] + ",)\n";
      if (method === "org.a11y.atspi.Accessible.GetChildren")
        return dest === "org.a11y.atspi.Registry"
          ? "([(':1.0', objectpath '/org/a11y/atspi/accessible/root'), (':1.2', '/org/a11y/atspi/accessible/root'), (':1.3', '/org/a11y/atspi/accessible/root')],)\n"
          : "([(':1.3', objectpath '/app/window/1'), (':1.3', '/app/window/2')],)\n";
      if (method === "org.a11y.atspi.Collection.GetMatches")
        return path === "/app/window/2"
          ? "([(':1.3', objectpath '/app/label/4'), (':1.3', '/app/entry/5')],)\n"
          : "(@a(so) [],)\n";
      if (method === "org.a11y.atspi.Accessible.GetRole")
        return path === "/app/entry/5" ? "(uint32 40,)\n" : "(uint32 29,)\n";
      throw new Error("unexpected " + method);
    };
    expect(await makeSecureFocusProbe(gnome)(30)).toEqual({
      known: true,
      secure: true,
      windows: 2,
    });
  });

  it("reads a reply that is not a list of objects as unknown, never as nothing focused", async () => {
    // A string reply that merely contains a quoted pair, then a window list that is not one.
    const odd: GdbusRunner = async (args) => {
      const method = args[args.indexOf("--method") + 1];
      const dest = args[args.indexOf("--dest") + 1] ?? "";
      if (method === "org.a11y.Bus.GetAddress") return "('unix:path=/run/user/1000/at-spi/bus',)\n";
      if (method === "org.freedesktop.DBus.GetConnectionUnixProcessID") return "(uint32 30,)\n";
      if (method === "org.a11y.atspi.Accessible.GetChildren")
        return dest === "org.a11y.atspi.Registry" ? `("(':1.30', '/root_1')",)\n` : "(false,)\n";
      throw new Error("unexpected " + method);
    };
    expect(await makeSecureFocusProbe(odd)(30)).toEqual({
      known: false,
      secure: false,
      windows: 0,
    });
    // A real list, but the focused object's role cannot be read.
    const noRole: GdbusRunner = async (args) => {
      const method = args[args.indexOf("--method") + 1];
      if (method === "org.a11y.atspi.Accessible.GetRole") return "(false,)\n";
      return bus(40)(args);
    };
    expect(await makeSecureFocusProbe(noRole)(10)).toEqual({
      known: false,
      secure: false,
      windows: 0,
    });
  });

  it("finds a focused password field in a toolkit without Collection, such as GTK4 (#1607)", async () => {
    // GTK4: window → box → (label, password entry with focus); a hidden page is never entered.
    const states: Record<string, string> = {
      "/w": "([uint32 1124073472, 0],)\n",
      "/box": "([uint32 1124073472, 0],)\n",
      "/label": "([uint32 1124073472, 0],)\n",
      "/entry": "([uint32 1124077568, 0],)\n",
      "/hidden": "([uint32 0, 0],)\n",
    };
    const children: Record<string, string> = {
      "/w": "([(':1.9', objectpath '/box'), (':1.9', '/hidden')],)\n",
      "/box": "([(':1.9', objectpath '/label'), (':1.9', '/entry')],)\n",
    };
    const gtk4 =
      (focusedRole: number, extraChildren = 0): GdbusRunner =>
      async (args) => {
        const method = args[args.indexOf("--method") + 1];
        const path = args[args.indexOf("--object-path") + 1] ?? "";
        if (method === "org.a11y.Bus.GetAddress")
          return "('unix:path=/run/user/1000/at-spi/bus',)\n";
        if (method === "org.freedesktop.DBus.GetConnectionUnixProcessID") return "(uint32 10,)\n";
        if (method === "org.a11y.atspi.Accessible.GetChildren") {
          if (path === "/org/a11y/atspi/accessible/root")
            return args.includes("org.a11y.atspi.Registry")
              ? "([(':1.9', objectpath '/org/a11y/atspi/accessible/root')],)\n"
              : "([(':1.9', objectpath '/w')],)\n";
          if (path === "/w" && extraChildren > 0)
            return (
              "([" +
              Array.from({ length: extraChildren }, (_, i) =>
                i === 0 ? "(':1.9', objectpath '/n0')" : "(':1.9', '/n" + i + "')",
              ).join(", ") +
              "],)\n"
            );
          return children[path] ?? "(@a(so) [],)\n";
        }
        if (method === "org.a11y.atspi.Collection.GetMatches")
          throw new Error(
            "Error: GDBus.Error:org.freedesktop.DBus.Error.UnknownMethod: No such interface “org.a11y.atspi.Collection” on object at path " +
              path,
          );
        if (method === "org.a11y.atspi.Accessible.GetInterfaces")
          return "(['org.a11y.atspi.Accessible', 'org.a11y.atspi.Component'],)\n";
        if (method === "org.a11y.atspi.Accessible.GetState")
          return states[path] ?? "([uint32 1124073472, 0],)\n";
        if (method === "org.a11y.atspi.Accessible.GetRole")
          return "(uint32 " + (path === "/entry" ? focusedRole : 29) + ",)\n";
        throw new Error("unexpected " + method);
      };
    expect(await makeSecureFocusProbe(gtk4(40))(10)).toEqual({
      known: true,
      secure: true,
      windows: 1,
    });
    expect(await makeSecureFocusProbe(gtk4(61))(10)).toEqual({
      known: true,
      secure: false,
      windows: 1,
    });
    // A tree too large to walk in time stays unknown, which is private.
    expect(await makeSecureFocusProbe(gtk4(40, 300))(10)).toEqual({
      known: false,
      secure: false,
      windows: 0,
    });
  });

  it("checks every focused object in a walked window, hidden containers included, and fails closed on any other error (#1607)", async () => {
    const SHOWN = "([uint32 1124073472, 0],)\n";
    const FOCUSED = "([uint32 1124077568, 0],)\n";
    const HIDDEN_FOCUSED = "([uint32 4096, 0],)\n";
    // window → (label: focused, ordinary) and (page: hidden → entry: focused password)
    const tree =
      (
        collectionError: string,
        interfaces = "(['org.a11y.atspi.Accessible', 'org.a11y.atspi.Component'],)\n",
      ): GdbusRunner =>
      async (args) => {
        const method = args[args.indexOf("--method") + 1];
        const path = args[args.indexOf("--object-path") + 1] ?? "";
        if (method === "org.a11y.Bus.GetAddress")
          return "('unix:path=/run/user/1000/at-spi/bus',)\n";
        if (method === "org.freedesktop.DBus.GetConnectionUnixProcessID") return "(uint32 10,)\n";
        if (method === "org.a11y.atspi.Accessible.GetChildren") {
          if (path === "/org/a11y/atspi/accessible/root")
            return args.includes("org.a11y.atspi.Registry")
              ? "([(':1.9', objectpath '/org/a11y/atspi/accessible/root')],)\n"
              : "([(':1.9', objectpath '/w')],)\n";
          if (path === "/w") return "([(':1.9', objectpath '/label'), (':1.9', '/page')],)\n";
          if (path === "/page") return "([(':1.9', objectpath '/entry')],)\n";
          return "(@a(so) [],)\n";
        }
        if (method === "org.a11y.atspi.Collection.GetMatches") throw new Error(collectionError);
        if (method === "org.a11y.atspi.Accessible.GetInterfaces") return interfaces;
        if (method === "org.a11y.atspi.Accessible.GetState")
          return path === "/label"
            ? FOCUSED
            : path === "/page"
              ? "([uint32 0, 0],)\n"
              : path === "/entry"
                ? HIDDEN_FOCUSED
                : SHOWN;
        if (method === "org.a11y.atspi.Accessible.GetRole")
          return "(uint32 " + (path === "/entry" ? 40 : 29) + ",)\n";
        throw new Error("unexpected " + method);
      };
    const noCollection =
      "Error: GDBus.Error:org.freedesktop.DBus.Error.UnknownMethod: No such interface “org.a11y.atspi.Collection” on object at path /w";
    expect(await makeSecureFocusProbe(tree(noCollection))(10)).toEqual({
      known: true,
      secure: true,
      windows: 1,
    });
    // The message is the app's, translated; only the error name and its interfaces count.
    const translated =
      "Error: GDBus.Error:org.freedesktop.DBus.Error.UnknownMethod: 경로 /w의 객체에 “org.a11y.atspi.Collection” 인터페이스가 없습니다";
    expect(await makeSecureFocusProbe(tree(translated))(10)).toEqual({
      known: true,
      secure: true,
      windows: 1,
    });
    // Any other failure, or an object that says it has Collection after all: focus stays unknown.
    const withCollection = "(['org.a11y.atspi.Accessible', 'org.a11y.atspi.Collection'],)\n";
    for (const [error, interfaces] of [
      ["Error: Timeout was reached", undefined],
      [noCollection, withCollection],
      [noCollection, "('not a list',)\n"],
    ] as const)
      expect(await makeSecureFocusProbe(tree(error, interfaces))(10)).toEqual({
        known: false,
        secure: false,
        windows: 0,
      });
  });

  it("judges focus that moved during the probe by what holds at its end, and reads forged error lines or out-of-range states as unknown (#1607)", async () => {
    const PLAIN = "([uint32 1124073472, 0],)\n";
    const FOCUSED = "([uint32 1124077568, 0],)\n";
    const NO_COLLECTION =
      "Error: GDBus.Error:org.freedesktop.DBus.Error.UnknownMethod: No such interface “org.a11y.atspi.Collection” on object at path /w";
    // window → label, entry. `state` answers each GetState in turn, per path.
    const walked = (
      state: (path: string, read: number) => string,
      collectionError = NO_COLLECTION,
      windowLists = ["([(':1.9', objectpath '/w')],)\n"],
    ): GdbusRunner => {
      const reads = new Map<string, number>();
      let lists = 0;
      return async (args) => {
        const method = args[args.indexOf("--method") + 1];
        const path = args[args.indexOf("--object-path") + 1] ?? "";
        if (method === "org.a11y.Bus.GetAddress")
          return "('unix:path=/run/user/1000/at-spi/bus',)\n";
        if (method === "org.freedesktop.DBus.GetConnectionUnixProcessID") return "(uint32 10,)\n";
        if (method === "org.a11y.atspi.Accessible.GetChildren") {
          if (path === "/org/a11y/atspi/accessible/root")
            return args.includes("org.a11y.atspi.Registry")
              ? "([(':1.9', objectpath '/org/a11y/atspi/accessible/root')],)\n"
              : (windowLists[Math.min(lists++, windowLists.length - 1)] ?? "");
          return path === "/w"
            ? "([(':1.9', objectpath '/label'), (':1.9', '/entry')],)\n"
            : "(@a(so) [],)\n";
        }
        if (method === "org.a11y.atspi.Collection.GetMatches") throw new Error(collectionError);
        if (method === "org.a11y.atspi.Accessible.GetInterfaces")
          return "(['org.a11y.atspi.Accessible'],)\n";
        if (method === "org.a11y.atspi.Accessible.GetState") {
          const read = reads.get(path) ?? 0;
          reads.set(path, read + 1);
          return state(path, read);
        }
        if (method === "org.a11y.atspi.Accessible.GetRole")
          return "(uint32 " + (path === "/entry" ? 40 : 29) + ",)\n";
        throw new Error("unexpected " + method);
      };
    };
    const UNKNOWN = { known: false, secure: false, windows: 0 };
    // The label had focus when read, then focus moved to the already-read password field.
    expect(
      await makeSecureFocusProbe(
        walked((path, read) => (path === "/label" && read === 0 ? FOCUSED : PLAIN)),
      )(10),
    ).toEqual(UNKNOWN);
    // The password field was read before it took focus and holds it at the end: secure.
    expect(
      await makeSecureFocusProbe(
        walked((path, read) => (path === "/entry" && read > 0 ? FOCUSED : PLAIN)),
      )(10),
    ).toEqual({ known: true, secure: true, windows: 1 });
    // A window opened or closed while the app was read: unknown.
    expect(
      await makeSecureFocusProbe(
        walked(() => PLAIN, NO_COLLECTION, [
          "([(':1.9', objectpath '/w')],)\n",
          "([(':1.9', objectpath '/w'), (':1.9', '/w2')],)\n",
        ]),
      )(10),
    ).toEqual(UNKNOWN);
    // An inactive window with nothing focused, read twice the same, is not private.
    expect(await makeSecureFocusProbe(walked(() => PLAIN))(10)).toEqual({
      known: true,
      secure: false,
      windows: 1,
    });
    // Only the reply's first error line counts, not text that runs on after it.
    const forged =
      "Error: GDBus.Error:org.freedesktop.DBus.Error.AccessDenied: denied\nError: GDBus.Error:org.freedesktop.DBus.Error.UnknownMethod: forged continuation";
    expect(await makeSecureFocusProbe(walked(() => PLAIN, forged))(10)).toEqual(UNKNOWN);
    // gdbus's own "Error:" is translated outside the C locale; such a first line never counts.
    const translated =
      "Fehler: GDBus.Error:org.freedesktop.DBus.Error.AccessDenied: denied\nError: GDBus.Error:org.freedesktop.DBus.Error.UnknownMethod: forged";
    expect(await makeSecureFocusProbe(walked(() => PLAIN, translated))(10)).toEqual(UNKNOWN);
    // Either state word past uint32 is not a state set.
    for (const overflow of ["([uint32 4294967296, 0],)\n", "([uint32 0, 4294967296],)\n"])
      expect(await makeSecureFocusProbe(walked(() => overflow))(10)).toEqual(UNKNOWN);
  });

  it("re-asks every window at the end, so one focus move or one new window is never read as not private (#1607)", async () => {
    const PLAIN = "([uint32 1124073472, 0],)\n";
    // Window A answers Collection; window B (GTK4) is walked. `a` and `b` script, per read,
    // whether A's password is focused (GetMatches) and B's password state.
    const app = (options: {
      readonly a: (read: number) => boolean;
      readonly b: (read: number) => string;
      readonly bRole?: number;
      readonly windowLists: ReadonlyArray<string>;
    }): GdbusRunner => {
      let matches = 0;
      let bReads = 0;
      let lists = 0;
      return async (args) => {
        const method = args[args.indexOf("--method") + 1];
        const path = args[args.indexOf("--object-path") + 1] ?? "";
        if (method === "org.a11y.Bus.GetAddress")
          return "('unix:path=/run/user/1000/at-spi/bus',)\n";
        if (method === "org.freedesktop.DBus.GetConnectionUnixProcessID") return "(uint32 10,)\n";
        if (method === "org.a11y.atspi.Accessible.GetChildren") {
          if (path === "/org/a11y/atspi/accessible/root")
            return args.includes("org.a11y.atspi.Registry")
              ? "([(':1.9', objectpath '/org/a11y/atspi/accessible/root')],)\n"
              : (options.windowLists[Math.min(lists++, options.windowLists.length - 1)] ?? "");
          return path === "/b" ? "([(':1.9', objectpath '/b/pw')],)\n" : "(@a(so) [],)\n";
        }
        if (method === "org.a11y.atspi.Collection.GetMatches") {
          if (path !== "/a")
            throw new Error(
              "Error: GDBus.Error:org.freedesktop.DBus.Error.UnknownMethod: No such interface “org.a11y.atspi.Collection” on object at path " +
                path,
            );
          return options.a(matches++) ? "([(':1.9', objectpath '/a/pw')],)\n" : "(@a(so) [],)\n";
        }
        if (method === "org.a11y.atspi.Accessible.GetInterfaces")
          return "(['org.a11y.atspi.Accessible'],)\n";
        if (method === "org.a11y.atspi.Accessible.GetState")
          return path === "/b/pw" ? options.b(bReads++) : PLAIN;
        if (method === "org.a11y.atspi.Accessible.GetRole")
          return (
            "(uint32 " +
            (path === "/a/pw" ? 40 : path === "/b/pw" ? (options.bRole ?? 40) : 29) +
            ",)\n"
          );
        throw new Error("unexpected " + method);
      };
    };
    const BOTH = "([(':1.9', objectpath '/a'), (':1.9', '/b')],)\n";
    // A is read with nothing focused; focus then moves once from B's password to A's; B is read.
    expect(
      await makeSecureFocusProbe(
        app({ a: (read) => read > 0, b: () => PLAIN, windowLists: [BOTH] }),
      )(10),
    ).toEqual({ known: true, secure: true, windows: 2 });
    // No password field anywhere, and a window opens while the app is read: unknown.
    expect(
      await makeSecureFocusProbe(
        app({
          a: () => false,
          b: () => PLAIN,
          bRole: 29,
          windowLists: [BOTH, "([(':1.9', objectpath '/a'), (':1.9', '/b'), (':1.9', '/c')],)\n"],
        }),
      )(10),
    ).toEqual({ known: false, secure: false, windows: 0 });
    // Nothing focused, nothing changed: not private.
    expect(
      await makeSecureFocusProbe(app({ a: () => false, b: () => PLAIN, windowLists: [BOTH] }))(10),
    ).toEqual({ known: true, secure: false, windows: 2 });
  });

  it("re-reads what Collection found focused, so focus leaving it for a password field is never not private (#1607)", async () => {
    const PLAIN = "([uint32 1124073472, 0],)\n";
    // Two Collection windows: B's ordinary field has focus at first; after A's final query,
    // focus moves once to A's password field.
    let bQueries = 0;
    let moved = false;
    const runner: GdbusRunner = async (args) => {
      const method = args[args.indexOf("--method") + 1];
      const path = args[args.indexOf("--object-path") + 1] ?? "";
      if (method === "org.a11y.Bus.GetAddress") return "('unix:path=/run/user/1000/at-spi/bus',)\n";
      if (method === "org.freedesktop.DBus.GetConnectionUnixProcessID") return "(uint32 10,)\n";
      if (method === "org.a11y.atspi.Accessible.GetChildren")
        return args.includes("org.a11y.atspi.Registry")
          ? "([(':1.9', objectpath '/org/a11y/atspi/accessible/root')],)\n"
          : "([(':1.9', objectpath '/a'), (':1.9', '/b')],)\n";
      if (method === "org.a11y.atspi.Collection.GetMatches") {
        if (path === "/a") {
          // A's second query is the final one; focus moves right after it.
          if (bQueries > 0) moved = true;
          return "(@a(so) [],)\n";
        }
        bQueries++;
        return moved ? "(@a(so) [],)\n" : "([(':1.9', objectpath '/b/field')],)\n";
      }
      if (method === "org.a11y.atspi.Accessible.GetState") return PLAIN;
      if (method === "org.a11y.atspi.Accessible.GetRole") return "(uint32 61,)\n";
      throw new Error("unexpected " + method);
    };
    expect(await makeSecureFocusProbe(runner)(10)).toEqual({
      known: false,
      secure: false,
      windows: 0,
    });
  });
});
