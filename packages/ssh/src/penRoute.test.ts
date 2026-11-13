import { describe, expect, it } from "vite-plus/test";
import {
  penExactAliasDecision,
  penExactAliasRoute,
  penGlobalFiles,
  penKnownHostsFile,
} from "./penRoute.ts";

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
    expect(penExactAliasRoute(f.settings)).toEqual({
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
    expect(penExactAliasRoute(f.settings)).toBeDefined();
  });
  it.each([
    ["proxycommand", "'/bin/pen' pipe %n 22"],
    ["proxycommand", `"C:\\pen.exe" pipe --node ${node} --noise ${noise} 22`],
    ["proxycommand", `'/bin/pen' pipe --node ${node} --noise bad;id 22`],
    ["controlmaster", "true"],
    ["controlpath", "/tmp/socket"],
    ["proxyjump", "jump"],
    ["nohostauthenticationforproxycommand", "yes"],
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

describe("Windows exact Pen route", () => {
  const winFacts = () => {
    const f = facts();
    f.settings.set(
      "proxycommand",
      `"C:\\Program Files\\pen.exe" pipe --node ${node} --noise ${noise} 22`,
    );
    f.settings.set("userknownhostsfile", "C:/Users/jun/.ssh/pen/known_hosts");
    return {
      ...f,
      penKnownHosts: "C:\\Users\\jun\\.ssh\\pen\\known_hosts",
      platform: "win32" as const,
    };
  };
  it("accepts Windows commands and compares path separators", () => {
    const f = winFacts();
    expect(penExactAliasDecision(f)).toMatchObject({ nodeId: node, noisePub: noise });
    f.settings.set(
      "proxycommand",
      `"C:\\pen.exe" pipe --home "C:\\pen\\\\" --node ${node} --noise ${noise} 22`,
    );
    expect(penExactAliasDecision(f)).toMatchObject({ nodeId: node });
    expect(penExactAliasDecision({ ...f, platform: "darwin" })).toBe("not-pen-route");
  });
  it.each([
    ["relative program", `"pen.exe" pipe --node ${node} --noise ${noise} 22`],
    ["another program", `"C:\\tools\\other.exe" pipe --node ${node} --noise ${noise} 22`],
    ["quote in program", `"C:\\a\\"b\\pen.exe" pipe --node ${node} --noise ${noise} 22`],
    ["relative home", `"C:\\pen.exe" pipe --home "pen" --node ${node} --noise ${noise} 22`],
    ["extra argument", `"C:\\pen.exe" pipe --extra --node ${node} --noise ${noise} 22`],
    ["trailing text", `"C:\\pen.exe" pipe --node ${node} --noise ${noise} 22 extra`],
    ["unterminated", `"C:\\pen.exe pipe --node ${node} --noise ${noise} 22`],
    ["posix", `'/bin/pen' pipe --node ${node} --noise ${noise} 22`],
  ])("refuses %s", (_name, command) => {
    const f = winFacts();
    f.settings.set("proxycommand", command);
    expect(penExactAliasDecision(f)).toBe("not-pen-route");
  });
  it.each([
    ["proxyjump", "jump"],
    ["controlmaster", "auto"],
    ["controlpath", "C:/socket"],
    ["nohostauthenticationforproxycommand", "yes"],
  ])("refuses %s", (key, value) => {
    const f = winFacts();
    f.settings.set(key, value);
    expect(penExactAliasDecision(f)).toBe("not-pen-route");
  });
  it("refuses a mismatched node or ambiguous known hosts", () => {
    const f = winFacts();
    f.settings.set(
      "proxycommand",
      `"C:\\pen.exe" pipe --node ${"b".repeat(26)} --noise ${noise} 22`,
    );
    expect(penExactAliasDecision(f)).toBe("node-mismatch");
    f.settings.set("proxycommand", `"C:\\pen.exe" pipe --node ${node} --noise ${noise} 22`);
    f.settings.set("userknownhostsfile", "C:/Users/with space/.ssh/pen/known_hosts");
    expect(penExactAliasDecision(f)).toBe("known-hosts-not-pen");
    f.settings.set("userknownhostsfile", "C:/other/known_hosts");
    expect(penExactAliasDecision(f)).toBe("known-hosts-not-pen");
  });
});

describe("Windows global known hosts", () => {
  it("accepts only the unambiguous default list or none", () => {
    const files = ["C:\\ProgramData\\ssh/ssh_known_hosts", "C:\\ProgramData\\ssh/ssh_known_hosts2"];
    const options = { platform: "win32" as const, programData: "C:\\ProgramData" };
    expect(penGlobalFiles(new Map(), options)).toEqual([]);
    expect(penGlobalFiles(new Map([["globalknownhostsfile", files.join(" ")]]), options)).toEqual(
      files,
    );
    expect(
      penGlobalFiles(
        new Map([
          [
            "globalknownhostsfile",
            "__PROGRAMDATA__\\ssh/ssh_known_hosts __PROGRAMDATA__\\ssh/ssh_known_hosts2",
          ],
        ]),
        options,
      ),
    ).toEqual(files);
    expect(
      penGlobalFiles(new Map([["globalknownhostsfile", "C:/custom"]]), options),
    ).toBeUndefined();
    expect(
      penGlobalFiles(new Map([["globalknownhostsfile", files.join(" ")]]), {
        ...options,
        programData: "C:\\Program Data",
      }),
    ).toBeUndefined();
    expect(
      penGlobalFiles(new Map([["globalknownhostsfile", files.join(" ")]]), { platform: "win32" }),
    ).toBeUndefined();
  });
});
