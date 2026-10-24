import { assert, describe, it } from "@effect/vitest";

import { approvedApps, learnApps, type ListedApp, scopeVerdict } from "./ComputerUseScope.ts";

const KAKAO = { pid: 6972, bundle_id: "com.kakao.KakaoTalkMac", name: "KakaoTalk" };

const verdict = (listed: Map<number, ListedApp>) =>
  scopeVerdict({
    name: "click",
    args: { pid: KAKAO.pid, window_id: 57000, x: 51, y: 104 },
    apps: approvedApps([KAKAO.bundle_id]),
    appOf: (pid) => listed.get(pid),
  });

describe("learnApps", () => {
  it("lists a pid again after a reply names its app without the bundle id a grant names", () => {
    const listed = new Map<number, ListedApp>();
    learnApps({ apps: [KAKAO] }, listed);
    assert.deepEqual(verdict(listed), { _tag: "allow" });
    // get_window_state answers with the app's name and pid but no bundle id.
    learnApps({ app_name: "KakaoTalk", pid: KAKAO.pid, window_id: 57000 }, listed);
    assert.deepEqual(verdict(listed), { _tag: "resolve", pid: KAKAO.pid });
    // The listing the proxy asks for then judges the call by bundle id again.
    learnApps({ apps: [KAKAO] }, listed);
    assert.deepEqual(verdict(listed), { _tag: "allow" });
  });

  it("does not let a same-named app that reused the pid inherit the approved bundle id", () => {
    const listed = new Map<number, ListedApp>();
    learnApps({ apps: [KAKAO] }, listed);
    learnApps({ app_name: "KakaoTalk", pid: KAKAO.pid }, listed);
    learnApps({ apps: [{ ...KAKAO, bundle_id: "com.example.KakaoTalk" }] }, listed);
    assert.deepEqual(verdict(listed), {
      _tag: "refuse",
      reason: "app_not_approved",
      app: "com.example.KakaoTalk",
    });
  });

  // Linux list_apps nests each running app's windows, which name the process, not the desktop id.
  const CALCULATOR = {
    pid: 3827077,
    bundle_id: "org.gnome.Calculator",
    name: "Calculator",
    windows: [{ app_name: "gnome-calculator", pid: 3827077, window_id: 8388612 }],
  };
  const readCalculator = (listed: Map<number, ListedApp>) =>
    scopeVerdict({
      name: "get_window_state",
      args: { pid: CALCULATOR.pid, window_id: 8388612 },
      apps: approvedApps([CALCULATOR.bundle_id]),
      appOf: (pid) => listed.get(pid),
    });

  it("keeps an approved Linux app's desktop id when list_apps nests its windows", () => {
    const listed = new Map<number, ListedApp>();
    learnApps({ apps: [CALCULATOR] }, listed);
    assert.deepEqual(readCalculator(listed), { _tag: "allow" });
  });

  it("lists the apps again before refusing a pid known only by its window's app name", () => {
    const listed = new Map<number, ListedApp>();
    learnApps({ windows: CALCULATOR.windows }, listed);
    assert.deepEqual(readCalculator(listed), { _tag: "resolve", pid: CALCULATOR.pid });
    learnApps({ apps: [CALCULATOR] }, listed);
    assert.deepEqual(readCalculator(listed), { _tag: "allow" });
  });

  it("still judges a process without a desktop id by its window's app name", () => {
    const listed = new Map<number, ListedApp>();
    const fixture = {
      pid: 3731239,
      bundle_id: null,
      name: "python3",
      windows: [{ app_name: "goat-cu-fixture.py", pid: 3731239, window_id: 4194307 }],
    };
    learnApps({ apps: [fixture] }, listed);
    assert.deepEqual(
      scopeVerdict({
        name: "get_window_state",
        args: { pid: fixture.pid, window_id: 4194307 },
        apps: approvedApps(["goat-cu-fixture.py"]),
        appOf: (pid) => listed.get(pid),
      }),
      { _tag: "allow" },
    );
  });
});
