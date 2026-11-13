import { describe, expect, it } from "vitest";
import { penExactAliasDecision, penExactRoute, penKnownHostsFile } from "./penRoute.ts";

const node = "a".repeat(26);
const alias = `pen-${node}`;
const noise = "A".repeat(43);
const file = "/tmp/pen/known_hosts";
const settings = () =>
  new Map(
    Object.entries({
      hostname: alias,
      port: "22",
      proxycommand: `'/bin/pen' pipe --node ${node} --noise ${noise} 22`,
      proxyjump: "none",
      stricthostkeychecking: "true",
      controlmaster: "false",
      controlpath: "none",
      userknownhostsfile: file,
    }),
  );
const facts = () => ({
  alias,
  configHosts: [alias],
  settings: settings(),
  penKnownHosts: file,
  globalKey: false,
  recorded: `${alias} ssh-ed25519 AAA`,
});

describe("exact Pen route", () => {
  it("accepts Pen's Unix command and binds a revision", () => {
    const f = facts();
    expect(penExactRoute(f.settings)).toEqual({
      nodeId: node,
      noisePub: noise,
      knownHostsFile: file,
    });
    expect(penExactAliasDecision(f)).toMatchObject({
      nodeId: node,
      noisePub: noise,
      revision: expect.stringMatching(/^pen:[a-f0-9]{64}$/u),
    });
    f.settings.set(
      "proxycommand",
      `env PEN_HOME='/a b' '/a/it'\\''s/pen' pipe --node ${node} --noise ${noise} 22`,
    );
    expect(penExactRoute(f.settings)).toBeDefined();
  });
  it.each([
    ["proxycommand", "'/bin/pen' pipe %n 22"],
    ["proxycommand", `"C:\\pen.exe" pipe --node ${node} --noise ${noise} 22`],
    ["proxycommand", `'/bin/pen' pipe --node ${node} --noise bad;id 22`],
    ["controlmaster", "true"],
    ["controlpath", "/tmp/socket"],
    ["proxyjump", "jump"],
    ["knownhostscommand", "command"],
    ["userknownhostsfile", `${file} /tmp/other`],
  ])("refuses unsafe %s = %s", (key, value) => {
    const f = facts();
    f.settings.set(key, value);
    expect(penExactAliasDecision(f)).toBe("not-pen-route");
  });
  it("applies refusal order and distinguishes each reason", () => {
    const f = facts();
    expect(penExactAliasDecision({ ...f, configHosts: [] })).toBe("not-in-pen-config");
    f.settings.set("proxycommand", `'/bin/pen' pipe --node ${"b".repeat(26)} --noise ${noise} 22`);
    expect(penExactAliasDecision(f)).toBe("node-mismatch");
    f.settings.set("proxycommand", settings().get("proxycommand")!);
    expect(penExactAliasDecision({ ...f, penKnownHosts: "/other" })).toBe("known-hosts-not-pen");
    expect(penExactAliasDecision({ ...f, globalKey: true })).toBe("global-known-hosts");
    expect(penExactAliasDecision({ ...f, recorded: "" })).toBe("no-recorded-key");
    expect(penExactAliasDecision({ ...f, recorded: "@revoked host key" })).toBe("marker-lines");
  });
  it("retains the name route", () => {
    const s = settings();
    s.set("proxycommand", "'/bin/pen' pipe %n 22");
    expect(penKnownHostsFile(s)).toBe(file);
  });
});
