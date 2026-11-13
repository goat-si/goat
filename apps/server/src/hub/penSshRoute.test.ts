import { describe, expect, it } from "@effect/vitest";

import {
  isPenRunCommand,
  penExactCommands,
  penExactRoute,
  penHostOption,
  penKnownHostsFile,
  penRunCommand,
  sshSettings,
} from "./penSshRoute.ts";

const NODE = "abcdefghijklmnopqrstuvwxyz";
const NOISE = "N".repeat(42) + "_";
const node = { nodeId: NODE, noisePub: NOISE };
const exact = "'/home/u/.local/bin/pen' pipe --node " + NODE + " --noise " + NOISE + " 22";

const settings = (proxycommand: string, extra: Record<string, string> = {}) =>
  sshSettings(
    Object.entries({
      hostname: "pen-" + NODE,
      port: "22",
      proxycommand,
      userknownhostsfile: "/home/u/.ssh/pen/known_hosts",
      stricthostkeychecking: "true",
      ...extra,
    })
      .map(([key, value]) => key + " " + value)
      .join("\n"),
  );

describe("Pen's exact per-node route", () => {
  it("is accepted only for the node id and Noise key GOAT recorded", () => {
    expect(penExactRoute(settings(exact), node)).toBe(exact);
    const ownHome =
      "env PEN_HOME='/srv/pen state' '/opt/pen/bin/pen' pipe --node " +
      NODE +
      " --noise " +
      NOISE +
      " 22";
    expect(penExactRoute(settings(ownHome), node)).toBe(ownHome);
    expect(penExactRoute(settings(exact), { ...node, noisePub: "M".repeat(43) })).toBeUndefined();
    expect(penExactRoute(settings(exact), { ...node, nodeId: "b".repeat(26) })).toBeUndefined();
  });

  it("refuses the name block an id used as a name gets, and any other command", () => {
    // Pen writes no exact block when another member uses the node id as its name.
    expect(penExactRoute(settings("'/home/u/.local/bin/pen' pipe %n 22"), node)).toBeUndefined();
    for (const command of [
      exact + "; id",
      exact.replace(" 22", " 2222"),
      exact.replace("pipe", "pipe --home /tmp"),
      "env LD_PRELOAD='/tmp/x.so' " + exact,
      exact.replace("'/home/u/.local/bin/pen'", "'pen'"),
    ])
      expect(penExactRoute(settings(command), node), command).toBeUndefined();
    expect(penExactRoute(settings(exact, { proxyjump: "jump" }), node)).toBeUndefined();
  });

  it("names Pen's known_hosts only through the route it was asked about", () => {
    expect(penKnownHostsFile(settings(exact))).toBeUndefined();
    expect(penKnownHostsFile(settings(exact), node)).toBe("/home/u/.ssh/pen/known_hosts");
    expect(
      penKnownHostsFile(settings("'/home/u/.local/bin/pen' pipe %n 22"), node),
    ).toBeUndefined();
    expect(
      penKnownHostsFile(settings(exact, { knownhostscommand: "/bin/echo" }), node),
    ).toBeUndefined();
  });

  it("reads the user from Pen's own block for the alias", () => {
    const config = [
      "# Written by pen ssh-config.",
      "Host pen-box",
      "    User boxes",
      "    ProxyCommand '/p/pen' pipe %n 22",
      "Host pen-" + NODE,
      "    User runner",
      "    ProxyCommand '/p/pen' pipe --node " + NODE + " --noise " + NOISE + " 22",
      "Host pen-zzzzzzzzzzzzzzzzzzzzzzzzzz",
      "    ProxyCommand '/p/pen' pipe --node zzzzzzzzzzzzzzzzzzzzzzzzzz --noise " + NOISE + " 22",
      "Host pen-*",
      "    ProxyCommand '/p/pen' pipe %n 22",
    ].join("\n");
    expect(penHostOption(config, "pen-" + NODE, "User")).toBe("runner");
    expect(penHostOption(config, "pen-zzzzzzzzzzzzzzzzzzzzzzzzzz", "User")).toBeUndefined();
    expect(penHostOption(config, "pen-missing", "User")).toBeUndefined();
  });

  // Pen's fallback is `Host pen-* "!*'*"` (two patterns); a Match line ends a block as well.
  it("never reads an option from the block or Match section after the alias's block", () => {
    const config = [
      "Host pen-zzzzzzzzzzzzzzzzzzzzzzzzzz",
      "    ProxyCommand '/p/pen' pipe --node zzzzzzzzzzzzzzzzzzzzzzzzzz --noise " + NOISE + " 22",
      'Host pen-* "!*\'*"',
      "    User fallback",
      "    ProxyCommand '/p/pen' pipe '%n' 22",
      "Host pen-" + NODE,
      "    ProxyCommand '/p/pen' pipe --node " + NODE + " --noise " + NOISE + " 22",
      "Match host pen-*",
      "    User matched",
    ].join("\n");
    expect(penHostOption(config, "pen-zzzzzzzzzzzzzzzzzzzzzzzzzz", "User")).toBeUndefined();
    expect(penHostOption(config, "pen-" + NODE, "User")).toBeUndefined();
  });
  it("accepts any confirmed binary name in Pen's block", () => {
    const renamed = exact.replace("/home/u/.local/bin/pen", "/opt/bin/pen-v1");
    expect(penExactRoute(settings(renamed), node)).toBe(renamed);
  });

  it("runs the confirmed pen with its home as --home, unquoted, or not at all", () => {
    const pen = { executablePath: "/opt/bin/pen-v1", stateDir: "/home/u/.pen" };
    const run =
      "/opt/bin/pen-v1 pipe --node " + NODE + " --noise " + NOISE + " --home /home/u/.pen 22";
    expect(penRunCommand(node, pen)).toBe(run);
    expect(isPenRunCommand(run, node)).toBe(true);
    expect(isPenRunCommand(run, { ...node, nodeId: "b".repeat(26) })).toBe(false);
    // OpenCodex's explicit route takes no quoting, so a path that needs it has no route.
    expect(penRunCommand(node, { ...pen, stateDir: "/home/u/pen state" })).toBeUndefined();
    expect(penRunCommand(node, { ...pen, executablePath: "/opt/it's/pen" })).toBeUndefined();
    expect(penRunCommand(node, { ...pen, stateDir: "/srv/p%n" })).toBeUndefined();
    // OpenCodex takes : @ , = in later words but not in the program path (explicit-route.ts).
    expect(penRunCommand(node, { ...pen, executablePath: "/opt/me@host/pen" })).toBeUndefined();
    expect(penRunCommand(node, { ...pen, executablePath: "/opt/a:b/pen" })).toBeUndefined();
    expect(penRunCommand(node, { ...pen, stateDir: "/srv/me@host/.pen" })).toBeDefined();
    expect(
      isPenRunCommand(
        "env PEN_HOME='/home/u/.pen' '/opt/bin/pen-v1'" + exact.slice(exact.indexOf(" pipe")),
        node,
      ),
    ).toBe(false);
    expect(isPenRunCommand(run.replace(" --home /home/u/.pen", ""), node)).toBe(false);
  });

  it("names the commands the confirmed Pen writes, as ssh -G prints them", () => {
    const pen = { executablePath: "/opt/it's/pen", stateDir: "/home/u/.pen" };
    const tail = " pipe --node " + NODE + " --noise " + NOISE + " 22";
    expect(penExactCommands(node, pen, "/home/u/.pen")).toEqual([
      "env PEN_HOME='/home/u/.pen' '/opt/it'\\''s/pen'" + tail,
      "'/opt/it'\\''s/pen'" + tail,
    ]);
    // Without PEN_HOME, Pen runs on ~/.pen, so a confirmed Pen elsewhere must name its folder.
    expect(penExactCommands(node, { ...pen, stateDir: "/srv/p%n" }, "/home/u/.pen")).toEqual([
      "env PEN_HOME='/srv/p%%n' '/opt/it'\\''s/pen'" + tail,
    ]);
    expect(penExactCommands({ ...node, nodeId: "pen-box" }, pen, "/home/u/.pen")).toEqual([]);
  });
});
