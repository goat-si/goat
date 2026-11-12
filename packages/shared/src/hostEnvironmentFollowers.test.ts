import { describe, expect, it } from "vite-plus/test";

import { makeHostEnvironmentFollowers } from "./hostEnvironmentFollowers.ts";

const PENDING = "GOAT_DESKTOP_SHELL_DISCOVERY_PENDING";
const pendingHost = (PATH: string): NodeJS.ProcessEnv => ({
  PATH,
  [PENDING]: "1",
  HOME: "/home/ada",
  JAVA_HOME: "/old/java",
});
/** Its own set of copies, and what the snapshot receiver does: change the host, then sync. */
const followers = () => {
  const { follow, sync } = makeHostEnvironmentFollowers();
  const hostLearns = (host: NodeJS.ProcessEnv, PATH: string, discovered: boolean) => {
    const before = { PATH: host.PATH, [PENDING]: host[PENDING] };
    host.PATH = PATH;
    host.JAVA_HOME = "/new/java";
    if (discovered) delete host[PENDING];
    return sync(before, host);
  };
  return { follow, sync, hostLearns };
};

describe("host environment followers", () => {
  it("gives a copy the host's new PATH and pending flag, and changes nothing else in it", () => {
    const { follow, hostLearns } = followers();
    const host = pendingHost("/usr/bin");
    const copy = follow({ ...host, OWN: "1" }, host);
    delete copy.HOME;

    expect(hostLearns(host, "/home/ada/.volta/bin:/usr/bin", false)).toBe(1);
    expect(copy).toEqual({
      PATH: "/home/ada/.volta/bin:/usr/bin",
      [PENDING]: "1",
      JAVA_HOME: "/old/java",
      OWN: "1",
    });

    hostLearns(host, "/home/ada/.volta/bin:/usr/bin", true);
    expect(copy).toEqual({
      PATH: "/home/ada/.volta/bin:/usr/bin",
      JAVA_HOME: "/old/java",
      OWN: "1",
    });
  });

  it("leaves a copy that set its own PATH alone, and a copy made from that one", () => {
    const { follow, hostLearns } = followers();
    const host = pendingHost("/usr/bin");
    const own = follow({ ...host, PATH: "/instance/bin" }, host);
    const derived = follow({ ...own, MORE: "1" }, own);

    hostLearns(host, "/recovered/bin", true);
    expect(own.PATH).toBe("/instance/bin");
    expect(derived.PATH).toBe("/instance/bin");
    expect(PENDING in own).toBe(false);
    expect(PENDING in derived).toBe(false);
  });

  it("stops following a copy whose PATH something else changed", () => {
    const { follow, hostLearns } = followers();
    const host = pendingHost("/usr/bin");
    const copy = follow({ ...host }, host);
    copy.PATH = "/prepended:/usr/bin";

    hostLearns(host, "/recovered/bin", false);
    hostLearns(host, "/recovered-again/bin", false);
    expect(copy.PATH).toBe("/prepended:/usr/bin");
  });

  it("follows through a chain of copies, each one once", () => {
    const { follow, hostLearns } = followers();
    const host = pendingHost("/usr/bin");
    const first = follow({ ...host }, host);
    const second = follow({ ...first, EXTRA: "1" }, first);
    expect(follow(second, first)).toBe(second);

    expect(hostLearns(host, "/recovered/bin", false)).toBe(2);
    expect([first.PATH, second.PATH]).toEqual(["/recovered/bin", "/recovered/bin"]);
    expect(hostLearns(host, "/recovered-again/bin", true)).toBe(2);
    expect([first.PATH, second.PATH]).toEqual(["/recovered-again/bin", "/recovered-again/bin"]);
  });

  it("does not follow a copy made once discovery has ended, the only time PATH changes", () => {
    const { follow, sync } = followers();
    const host: NodeJS.ProcessEnv = { PATH: "/final/bin" };
    const copy = follow({ ...host }, host);

    const before = { PATH: host.PATH, [PENDING]: host[PENDING] };
    host.PATH = "/unexpected/bin";
    expect(sync(before, host)).toBe(0);
    expect(copy.PATH).toBe("/final/bin");
  });

  it("keeps copies plain objects", () => {
    const { follow, hostLearns } = followers();
    const host = pendingHost("/usr/bin");
    const copy = follow({ ...host }, host);
    hostLearns(host, "/recovered/bin", true);

    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(copy, "PATH")).toEqual({
      value: "/recovered/bin",
      writable: true,
      enumerable: true,
      configurable: true,
    });
    expect(structuredClone(copy)).toEqual(copy);
  });
});
