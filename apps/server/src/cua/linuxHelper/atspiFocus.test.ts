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
            "Command failed: gdbus call ... --method org.a11y.atspi.Collection.GetMatches\nError: GDBus.Error:org.freedesktop.DBus.Error.UnknownMethod: No such interface “org.a11y.atspi.Collection” on object at path " +
              path,
          );
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
});
