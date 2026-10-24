import { describe, expect, it } from "vite-plus/test";

import { makeSecureFocusProbe, type GdbusRunner } from "./atspiFocus.ts";

/** gdbus answers for one app on the AT-SPI bus: pid 10 with one window whose focus has a role. */
const bus =
  (focusedRole: number | null): GdbusRunner =>
  async (args) => {
    const method = args[args.indexOf("--method") + 1];
    if (method === "org.a11y.Bus.GetAddress") return "('unix:path=/run/user/1000/at-spi/bus',)\n";
    if (method === "org.freedesktop.DBus.GetConnectionUnixProcessID") return "(uint32 10,)\n";
    if (method === "org.a11y.atspi.Accessible.GetChildren")
      return args.includes("org.a11y.atspi.Registry")
        ? "([(':1.7', objectpath '/org/a11y/atspi/accessible/root')],)\n"
        : "([(':1.7', objectpath '/org/a11y/atspi/accessible/1')],)\n";
    if (method === "org.a11y.atspi.Collection.GetMatches")
      return focusedRole === null
        ? "(@a(so) [],)\n"
        : "([(':1.7', objectpath '/org/a11y/atspi/accessible/9')],)\n";
    if (method === "org.a11y.atspi.Accessible.GetRole") return "(uint32 " + focusedRole + ",)\n";
    throw new Error("unexpected " + method);
  };

describe("makeSecureFocusProbe", () => {
  it("reads a focused AT-SPI password field as secure and other focus as not", async () => {
    expect(await makeSecureFocusProbe(bus(40))(10)).toEqual({ known: true, secure: true });
    expect(await makeSecureFocusProbe(bus(61))(10)).toEqual({ known: true, secure: false });
    expect(await makeSecureFocusProbe(bus(null))(10)).toEqual({ known: true, secure: false });
  });

  it("reports focus as unknown, never as not secure, when the process or the bus does not answer", async () => {
    expect(await makeSecureFocusProbe(bus(40))(11)).toEqual({ known: false, secure: false });
    const broken: GdbusRunner = async () => {
      throw new Error("gdbus: timed out");
    };
    expect(await makeSecureFocusProbe(broken)(10)).toEqual({ known: false, secure: false });
  });
});
