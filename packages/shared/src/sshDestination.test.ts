import { describe, expect, it } from "vite-plus/test";

import { parseSshDestination } from "./sshDestination.ts";

const ok = (input: Parameters<typeof parseSshDestination>[0]) => {
  const result = parseSshDestination(input);
  if (!result.ok) throw new Error(result.message);
  return result.destination;
};

describe("parseSshDestination", () => {
  it("reads aliases, user@host, host:port and bracketed IPv6", () => {
    expect(ok({ host: "devbox" })).toEqual({ user: null, hostname: "devbox", port: null });
    expect(ok({ host: " jun@macmini " })).toEqual({ user: "jun", hostname: "macmini", port: null });
    expect(ok({ host: "jun@box.ts.net:2222" })).toEqual({
      user: "jun",
      hostname: "box.ts.net",
      port: 2222,
    });
    expect(ok({ host: "[fd7a::1]:22" })).toEqual({ user: null, hostname: "fd7a::1", port: 22 });
    expect(ok({ host: "fd7a::1" }).hostname).toBe("fd7a::1");
  });

  it("lets separate fields win over inline ones", () => {
    expect(ok({ host: "jun@box:2222", user: "root", port: "22" })).toEqual({
      user: "root",
      hostname: "box",
      port: 22,
    });
    expect(ok({ host: "box", port: 2200 }).port).toBe(2200);
  });

  it("rejects ports and names ssh would misread", () => {
    for (const input of [
      { host: "box:22x" },
      { host: "box:0" },
      { host: "box:65536" },
      { host: "box", port: "1e3" },
      { host: "box", port: "22 " + "x" },
      { host: "[fd7a::1]:" },
      { host: "-oProxyCommand=evil" },
      { host: "jun@" },
      { host: "@box" },
      { host: "two words" },
      { host: "box", user: "-x" },
    ])
      expect(parseSshDestination(input).ok).toBe(false);
  });
});
