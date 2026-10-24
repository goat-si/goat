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
});
