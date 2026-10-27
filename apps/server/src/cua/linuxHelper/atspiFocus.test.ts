import { describe, expect, it } from "vite-plus/test";

import { type AtspiCall, type BusReply, BusError } from "./atspiBus.ts";
import { makeSecureFocusProbe, type GdbusRunner } from "./atspiFocus.ts";

const REGISTRY = "org.a11y.atspi.Registry";
const ROOT = "/org/a11y/atspi/accessible/root";
const UNKNOWN_METHOD = "org.freedesktop.DBus.Error.UnknownMethod";
const PLAIN = 1124073472;
const FOCUSED = 1124077568;

/** gdbus finds the accessibility bus; the fakes below answer the calls on it. */
const ADDRESS: GdbusRunner = async () => "('unix:path=/run/user/1000/at-spi/bus',)\n";
const probe = (atspi: AtspiCall) => makeSecureFocusProbe(ADDRESS, atspi);

const refs = (...items: ReadonlyArray<readonly [string, string]>): BusReply => ({
  signature: "a(so)",
  body: [items.map(([bus, path]) => [bus, path])],
});
const u32 = (value: number): BusReply => ({ signature: "u", body: [value] });
const states = (first: number, second = 0): BusReply => ({
  signature: "au",
  body: [[first, second]],
});
const names = (...items: ReadonlyArray<string>): BusReply => ({ signature: "as", body: [items] });
const noCollection = (path: string) =>
  new BusError(
    UNKNOWN_METHOD,
    "No such interface “org.a11y.atspi.Collection” on object at path " + path,
  );
const method = (call: { readonly iface: string; readonly member: string }) =>
  call.iface + "." + call.member;
const UNKNOWN = { known: false, secure: false, windows: 0 };

/** One app on the AT-SPI bus: pid 10, its windows, and what has focus. */
const bus =
  (focusedRole: number | null, windows = 1, role: BusReply = u32(focusedRole ?? 0)): AtspiCall =>
  async (call) => {
    const name = method(call);
    if (name === "org.freedesktop.DBus.GetConnectionUnixProcessID") return u32(10);
    if (name === "org.a11y.atspi.Accessible.GetChildren")
      return call.destination === REGISTRY
        ? refs([":1.7", ROOT])
        : refs(
            ...Array.from(
              { length: windows },
              (_, i) => [":1.7", "/org/a11y/atspi/accessible/" + (i + 1)] as const,
            ),
          );
    if (name === "org.a11y.atspi.Collection.GetMatches")
      return focusedRole === null ? refs() : refs([":1.7", "/org/a11y/atspi/accessible/9"]);
    if (name === "org.a11y.atspi.Accessible.GetRole") return role;
    // What Collection found focused is read again at the end, still focused.
    if (name === "org.a11y.atspi.Accessible.GetState") return states(FOCUSED);
    throw new Error("unexpected " + name);
  };

describe("makeSecureFocusProbe", () => {
  it("reads a focused AT-SPI password field as secure and other focus as not", async () => {
    expect(await probe(bus(40))(10)).toEqual({ known: true, secure: true, windows: 1 });
    expect(await probe(bus(61))(10)).toEqual({ known: true, secure: false, windows: 1 });
    expect(await probe(bus(null))(10)).toEqual({ known: true, secure: false, windows: 1 });
  });

  it("reports focus as unknown when there are more windows than it scans", async () => {
    expect(await probe(bus(null, 65))(10)).toEqual({ known: false, secure: false, windows: 65 });
  });

  it("reads a role that is not a uint32 as unknown, never as a role that is not a password field (#1621 r7)", async () => {
    expect(await probe(bus(40, 1, { signature: "t", body: [4_294_967_296] }))(10)).toEqual(UNKNOWN);
  });

  it("reports focus as unknown, never as not secure, when the process or the bus does not answer", async () => {
    expect(await probe(bus(40))(11)).toEqual(UNKNOWN);
    const silent: AtspiCall = async (call) => {
      throw new Error("The accessibility bus did not answer " + call.member + ".");
    };
    expect(await probe(silent)(10)).toEqual(UNKNOWN);
    const noAddress: GdbusRunner = async () => {
      throw new Error("gdbus: timed out");
    };
    expect(await makeSecureFocusProbe(noAddress)(10)).toEqual(UNKNOWN);
  });

  it("finds every app and match in a reply, the password field among them (#1606)", async () => {
    // The password field is in the third app's second window, second match.
    const pids: Record<string, number> = { ":1.0": 1, ":1.2": 2, ":1.3": 30 };
    const gnome: AtspiCall = async (call) => {
      const name = method(call);
      if (name === "org.freedesktop.DBus.GetConnectionUnixProcessID")
        return u32(pids[String(call.body?.[0])] ?? 0);
      if (name === "org.a11y.atspi.Accessible.GetChildren")
        return call.destination === REGISTRY
          ? refs([":1.0", ROOT], [":1.2", ROOT], [":1.3", ROOT])
          : refs([":1.3", "/app/window/1"], [":1.3", "/app/window/2"]);
      if (name === "org.a11y.atspi.Collection.GetMatches")
        return call.path === "/app/window/2"
          ? refs([":1.3", "/app/label/4"], [":1.3", "/app/entry/5"])
          : refs();
      if (name === "org.a11y.atspi.Accessible.GetRole")
        return u32(call.path === "/app/entry/5" ? 40 : 29);
      throw new Error("unexpected " + name);
    };
    expect(await probe(gnome)(30)).toEqual({ known: true, secure: true, windows: 2 });
  });

  it("reads a reply that is not a list of objects as unknown, never as nothing focused", async () => {
    // A string reply that merely holds a quoted pair, then a window list that is not one.
    const odd: AtspiCall = async (call) => {
      const name = method(call);
      if (name === "org.freedesktop.DBus.GetConnectionUnixProcessID") return u32(30);
      if (name === "org.a11y.atspi.Accessible.GetChildren")
        return call.destination === REGISTRY
          ? { signature: "s", body: ["(':1.30', '/root_1')"] }
          : { signature: "b", body: [false] };
      throw new Error("unexpected " + name);
    };
    expect(await probe(odd)(30)).toEqual(UNKNOWN);
    // A real list, but the focused object's role cannot be read.
    expect(await probe(bus(40, 1, { signature: "b", body: [false] }))(10)).toEqual(UNKNOWN);
  });

  it("finds a focused password field in a toolkit without Collection, such as GTK4 (#1607)", async () => {
    // GTK4: window → box → (label, password entry with focus); a hidden page is never entered.
    const stateOf: Record<string, number> = {
      "/w": PLAIN,
      "/box": PLAIN,
      "/label": PLAIN,
      "/entry": FOCUSED,
      "/hidden": 0,
    };
    const children: Record<string, ReadonlyArray<readonly [string, string]>> = {
      "/w": [
        [":1.9", "/box"],
        [":1.9", "/hidden"],
      ],
      "/box": [
        [":1.9", "/label"],
        [":1.9", "/entry"],
      ],
    };
    const gtk4 =
      (focusedRole: number, extraChildren = 0): AtspiCall =>
      async (call) => {
        const name = method(call);
        if (name === "org.freedesktop.DBus.GetConnectionUnixProcessID") return u32(10);
        if (name === "org.a11y.atspi.Accessible.GetChildren") {
          if (call.path === ROOT)
            return call.destination === REGISTRY ? refs([":1.9", ROOT]) : refs([":1.9", "/w"]);
          if (call.path === "/w" && extraChildren > 0)
            return refs(
              ...Array.from({ length: extraChildren }, (_, i) => [":1.9", "/n" + i] as const),
            );
          return refs(...(children[call.path] ?? []));
        }
        if (name === "org.a11y.atspi.Collection.GetMatches") throw noCollection(call.path);
        if (name === "org.a11y.atspi.Accessible.GetInterfaces")
          return names("org.a11y.atspi.Accessible", "org.a11y.atspi.Component");
        if (name === "org.a11y.atspi.Accessible.GetState")
          return states(stateOf[call.path] ?? PLAIN);
        if (name === "org.a11y.atspi.Accessible.GetRole")
          return u32(call.path === "/entry" ? focusedRole : 29);
        throw new Error("unexpected " + name);
      };
    expect(await probe(gtk4(40))(10)).toEqual({ known: true, secure: true, windows: 1 });
    expect(await probe(gtk4(61))(10)).toEqual({ known: true, secure: false, windows: 1 });
    // A tree too large to walk in time stays unknown, which is private.
    expect(await probe(gtk4(40, 8200))(10)).toEqual(UNKNOWN);
  });

  it("checks every focused object in a walked window, hidden containers included, and fails closed on any other error (#1607)", async () => {
    // window → (label: focused, ordinary) and (page: hidden → entry: focused password)
    const tree =
      (collectionError: Error, interfaces = names("org.a11y.atspi.Accessible")): AtspiCall =>
      async (call) => {
        const name = method(call);
        if (name === "org.freedesktop.DBus.GetConnectionUnixProcessID") return u32(10);
        if (name === "org.a11y.atspi.Accessible.GetChildren") {
          if (call.path === ROOT)
            return call.destination === REGISTRY ? refs([":1.9", ROOT]) : refs([":1.9", "/w"]);
          if (call.path === "/w") return refs([":1.9", "/label"], [":1.9", "/page"]);
          if (call.path === "/page") return refs([":1.9", "/entry"]);
          return refs();
        }
        if (name === "org.a11y.atspi.Collection.GetMatches") throw collectionError;
        if (name === "org.a11y.atspi.Accessible.GetInterfaces") return interfaces;
        if (name === "org.a11y.atspi.Accessible.GetState")
          return states(
            call.path === "/label"
              ? FOCUSED
              : call.path === "/page"
                ? 0
                : call.path === "/entry"
                  ? 4096
                  : PLAIN,
          );
        if (name === "org.a11y.atspi.Accessible.GetRole")
          return u32(call.path === "/entry" ? 40 : 29);
        throw new Error("unexpected " + name);
      };
    const secure = { known: true, secure: true, windows: 1 };
    expect(await probe(tree(noCollection("/w")))(10)).toEqual(secure);
    // The message is the app's, translated; only the error name and its interfaces count.
    const translated = new BusError(
      UNKNOWN_METHOD,
      "경로 /w의 객체에 “org.a11y.atspi.Collection” 인터페이스가 없습니다",
    );
    expect(await probe(tree(translated))(10)).toEqual(secure);
    // Any other failure, or an object that says it has Collection after all: focus stays unknown.
    for (const [error, interfaces] of [
      [new Error("The accessibility bus did not answer GetMatches."), undefined],
      [noCollection("/w"), names("org.a11y.atspi.Accessible", "org.a11y.atspi.Collection")],
      [noCollection("/w"), { signature: "s", body: ["not a list"] }],
    ] as const)
      expect(await probe(tree(error, interfaces))(10)).toEqual(UNKNOWN);
  });

  it("judges focus that moved during the probe by what holds at its end, and reads other error names or malformed states as unknown (#1607)", async () => {
    // window → label, entry. `state` answers each GetState in turn, per path.
    const walked = (
      state: (path: string, read: number) => BusReply,
      collectionError: Error = noCollection("/w"),
      windowLists: ReadonlyArray<BusReply> = [refs([":1.9", "/w"])],
    ): AtspiCall => {
      const reads = new Map<string, number>();
      let lists = 0;
      return async (call) => {
        const name = method(call);
        if (name === "org.freedesktop.DBus.GetConnectionUnixProcessID") return u32(10);
        if (name === "org.a11y.atspi.Accessible.GetChildren") {
          if (call.path === ROOT)
            return call.destination === REGISTRY
              ? refs([":1.9", ROOT])
              : (windowLists[Math.min(lists++, windowLists.length - 1)] ?? refs());
          return call.path === "/w" ? refs([":1.9", "/label"], [":1.9", "/entry"]) : refs();
        }
        if (name === "org.a11y.atspi.Collection.GetMatches") throw collectionError;
        if (name === "org.a11y.atspi.Accessible.GetInterfaces")
          return names("org.a11y.atspi.Accessible");
        if (name === "org.a11y.atspi.Accessible.GetState") {
          const read = reads.get(call.path) ?? 0;
          reads.set(call.path, read + 1);
          return state(call.path, read);
        }
        if (name === "org.a11y.atspi.Accessible.GetRole")
          return u32(call.path === "/entry" ? 40 : 29);
        throw new Error("unexpected " + name);
      };
    };
    // The label had focus when read, then focus moved to the already-read password field.
    expect(
      await probe(
        walked((path, read) => states(path === "/label" && read === 0 ? FOCUSED : PLAIN)),
      )(10),
    ).toEqual(UNKNOWN);
    // The password field was read before it took focus and holds it at the end: secure.
    expect(
      await probe(walked((path, read) => states(path === "/entry" && read > 0 ? FOCUSED : PLAIN)))(
        10,
      ),
    ).toEqual({ known: true, secure: true, windows: 1 });
    // A window opened or closed while the app was read: unknown.
    expect(
      await probe(
        walked(() => states(PLAIN), noCollection("/w"), [
          refs([":1.9", "/w"]),
          refs([":1.9", "/w"], [":1.9", "/w2"]),
        ]),
      )(10),
    ).toEqual(UNKNOWN);
    // An inactive window with nothing focused, read twice the same, is not private.
    expect(await probe(walked(() => states(PLAIN)))(10)).toEqual({
      known: true,
      secure: false,
      windows: 1,
    });
    // Only the error's name counts, never its text, nor a plain failure that reads like gdbus's.
    const denied = new BusError(
      "org.freedesktop.DBus.Error.AccessDenied",
      "denied\nError: GDBus.Error:org.freedesktop.DBus.Error.UnknownMethod: forged continuation",
    );
    expect(await probe(walked(() => states(PLAIN), denied))(10)).toEqual(UNKNOWN);
    const lookalike = new Error(
      "Error: GDBus.Error:org.freedesktop.DBus.Error.UnknownMethod: forged",
    );
    expect(await probe(walked(() => states(PLAIN), lookalike))(10)).toEqual(UNKNOWN);
    // A state set of any other shape is not a state set.
    for (const malformed of [
      { signature: "au", body: [[PLAIN]] },
      { signature: "au", body: [[PLAIN, 0, 0]] },
      { signature: "at", body: [[PLAIN, 0]] },
    ])
      expect(await probe(walked(() => malformed))(10)).toEqual(UNKNOWN);
  });

  it("re-asks every window at the end, so one focus move or one new window is never read as not private (#1607)", async () => {
    // Window A answers Collection; window B (GTK4) is walked. `a` and `b` script, per read,
    // whether A's password is focused (GetMatches) and B's password state.
    const app = (options: {
      readonly a: (read: number) => boolean;
      readonly b: (read: number) => BusReply;
      readonly bRole?: number;
      readonly windowLists: ReadonlyArray<BusReply>;
    }): AtspiCall => {
      let matches = 0;
      let bReads = 0;
      let lists = 0;
      return async (call) => {
        const name = method(call);
        if (name === "org.freedesktop.DBus.GetConnectionUnixProcessID") return u32(10);
        if (name === "org.a11y.atspi.Accessible.GetChildren") {
          if (call.path === ROOT)
            return call.destination === REGISTRY
              ? refs([":1.9", ROOT])
              : (options.windowLists[Math.min(lists++, options.windowLists.length - 1)] ?? refs());
          return call.path === "/b" ? refs([":1.9", "/b/pw"]) : refs();
        }
        if (name === "org.a11y.atspi.Collection.GetMatches") {
          if (call.path !== "/a") throw noCollection(call.path);
          return options.a(matches++) ? refs([":1.9", "/a/pw"]) : refs();
        }
        if (name === "org.a11y.atspi.Accessible.GetInterfaces")
          return names("org.a11y.atspi.Accessible");
        if (name === "org.a11y.atspi.Accessible.GetState")
          return call.path === "/b/pw" ? options.b(bReads++) : states(PLAIN);
        if (name === "org.a11y.atspi.Accessible.GetRole")
          return u32(
            call.path === "/a/pw" ? 40 : call.path === "/b/pw" ? (options.bRole ?? 40) : 29,
          );
        throw new Error("unexpected " + name);
      };
    };
    const BOTH = refs([":1.9", "/a"], [":1.9", "/b"]);
    // A is read with nothing focused; focus then moves once from B's password to A's; B is read.
    expect(
      await probe(app({ a: (read) => read > 0, b: () => states(PLAIN), windowLists: [BOTH] }))(10),
    ).toEqual({ known: true, secure: true, windows: 2 });
    // No password field anywhere, and a window opens while the app is read: unknown.
    expect(
      await probe(
        app({
          a: () => false,
          b: () => states(PLAIN),
          bRole: 29,
          windowLists: [BOTH, refs([":1.9", "/a"], [":1.9", "/b"], [":1.9", "/c"])],
        }),
      )(10),
    ).toEqual(UNKNOWN);
    // Nothing focused, nothing changed: not private.
    expect(
      await probe(app({ a: () => false, b: () => states(PLAIN), windowLists: [BOTH] }))(10),
    ).toEqual({ known: true, secure: false, windows: 2 });
  });

  it("re-reads what Collection found focused, so focus leaving it for a password field is never not private (#1607)", async () => {
    // Two Collection windows: B's ordinary field has focus at first; after A's final query,
    // focus moves once to A's password field.
    let bQueries = 0;
    let moved = false;
    const atspi: AtspiCall = async (call) => {
      const name = method(call);
      if (name === "org.freedesktop.DBus.GetConnectionUnixProcessID") return u32(10);
      if (name === "org.a11y.atspi.Accessible.GetChildren")
        return call.destination === REGISTRY
          ? refs([":1.9", ROOT])
          : refs([":1.9", "/a"], [":1.9", "/b"]);
      if (name === "org.a11y.atspi.Collection.GetMatches") {
        if (call.path === "/a") {
          // A's second query is the final one; focus moves right after it.
          if (bQueries > 0) moved = true;
          return refs();
        }
        bQueries++;
        return moved ? refs() : refs([":1.9", "/b/field"]);
      }
      if (name === "org.a11y.atspi.Accessible.GetState") return states(PLAIN);
      if (name === "org.a11y.atspi.Accessible.GetRole") return u32(61);
      throw new Error("unexpected " + name);
    };
    expect(await probe(atspi)(10)).toEqual(UNKNOWN);
  });

  it("walks a window without Collection several calls at a time, never more than its cap", async () => {
    // GTK4 Nautilus showed 254 objects, three calls each; one after another they took 1.9 s.
    let inFlight = 0;
    let most = 0;
    const leaves = Array.from({ length: 40 }, (_, i) => [":1.9", "/n" + i] as const);
    const atspi: AtspiCall = async (call) => {
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise<void>((resolve) => setImmediate(resolve));
      inFlight--;
      const name = method(call);
      if (name === "org.freedesktop.DBus.GetConnectionUnixProcessID") return u32(10);
      if (name === "org.a11y.atspi.Accessible.GetChildren") {
        if (call.path === ROOT)
          return call.destination === REGISTRY ? refs([":1.9", ROOT]) : refs([":1.9", "/w"]);
        return call.path === "/w" ? refs(...leaves) : refs();
      }
      if (name === "org.a11y.atspi.Collection.GetMatches") throw noCollection(call.path);
      if (name === "org.a11y.atspi.Accessible.GetInterfaces")
        return names("org.a11y.atspi.Accessible");
      if (name === "org.a11y.atspi.Accessible.GetState")
        return states(call.path === "/n7" ? FOCUSED : PLAIN);
      if (name === "org.a11y.atspi.Accessible.GetRole") return u32(61);
      throw new Error("unexpected " + name);
    };
    expect(await probe(atspi)(10)).toEqual({ known: true, secure: false, windows: 1 });
    expect(most).toBeGreaterThan(1);
    expect(most).toBeLessThanOrEqual(8);
  });
});
