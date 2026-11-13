import { describe, expect, it } from "@effect/vitest";

import { penExactRoute, penHostUser, penKnownHostsFile, sshSettings } from "./penSshRoute.ts";

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
      exact.replace("/pen'", "/open'"),
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
    expect(penHostUser(config, "pen-" + NODE)).toBe("runner");
    expect(penHostUser(config, "pen-zzzzzzzzzzzzzzzzzzzzzzzzzz")).toBeUndefined();
    expect(penHostUser(config, "pen-missing")).toBeUndefined();
  });
});
