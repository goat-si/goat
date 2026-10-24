import { assert, describe, it } from "@effect/vitest";

import { approvedApps, learnApps, type ListedApp, scopeVerdict } from "./ComputerUseScope.ts";

const KAKAO = { pid: 6972, bundle_id: "com.kakao.KakaoTalkMac", name: "KakaoTalk" };

const verdict = (listed: Map<number, ListedApp>) =>
  scopeVerdict({
    name: "click",
    args: { pid: KAKAO.pid, window_id: 57000, x: 51, y: 104 },
    apps: approvedApps([KAKAO.bundle_id]),
    appOf: (pid) => listed.get(pid),
    bundleIds: true,
  });

describe("learnApps", () => {
  it("lists a pid again after a reply names its app without the bundle id a grant names", () => {
    const listed = new Map<number, ListedApp>();
    learnApps({ apps: [KAKAO] }, listed, true);
    assert.deepEqual(verdict(listed), { _tag: "allow" });
    // get_window_state answers with the app's name and pid but no bundle id.
    learnApps({ app_name: "KakaoTalk", pid: KAKAO.pid, window_id: 57000 }, listed, false);
    assert.deepEqual(verdict(listed), { _tag: "resolve", pid: KAKAO.pid });
    // The listing the proxy asks for then judges the call by bundle id again.
    learnApps({ apps: [KAKAO] }, listed, true);
    assert.deepEqual(verdict(listed), { _tag: "allow" });
  });

  it("does not let a same-named app that reused the pid inherit the approved bundle id", () => {
    const listed = new Map<number, ListedApp>();
    learnApps({ apps: [KAKAO] }, listed, true);
    learnApps({ app_name: "KakaoTalk", pid: KAKAO.pid }, listed, false);
    learnApps({ apps: [{ ...KAKAO, bundle_id: "com.example.KakaoTalk" }] }, listed, true);
    assert.deepEqual(verdict(listed), {
      _tag: "refuse",
      reason: "app_not_approved",
      app: "com.example.KakaoTalk",
    });
  });
});

describe("scopeVerdict", () => {
  it("approves an app by the id list_apps reports, so its display name is no second grant to it", () => {
    const byName = (listed: Map<number, ListedApp>) =>
      scopeVerdict({
        name: "click",
        args: { pid: KAKAO.pid, window_id: 57000, x: 51, y: 104 },
        apps: approvedApps([KAKAO.name]),
        appOf: (pid) => listed.get(pid),
        bundleIds: true,
      });
    const listed = new Map<number, ListedApp>();
    // list_windows on macOS names the app without its bundle id; that is no identity.
    learnApps(
      { windows: [{ pid: KAKAO.pid, app_name: KAKAO.name, window_id: 57000 }] },
      listed,
      false,
    );
    assert.deepEqual(byName(listed), { _tag: "resolve", pid: KAKAO.pid });
    learnApps({ apps: [KAKAO] }, listed, true);
    assert.deepEqual(byName(listed), {
      _tag: "refuse",
      reason: "app_not_approved",
      app: KAKAO.bundle_id,
    });
    // A later name-only answer cannot replace the listed identity with the display name.
    learnApps(
      { windows: [{ pid: KAKAO.pid, app_name: KAKAO.name, window_id: 57000 }] },
      listed,
      false,
    );
    assert.notDeepEqual(byName(listed), { _tag: "allow" });
  });

  it("keeps apps the driver lists by name alone, as on Linux and Windows", () => {
    const listed = new Map<number, ListedApp>();
    learnApps({ apps: [{ pid: 12, name: "gedit" }] }, listed, true);
    learnApps({ pid: 12, app_name: "gedit", window_id: 3 }, listed, false);
    assert.deepEqual(
      scopeVerdict({
        name: "click",
        args: { pid: 12, window_id: 3, x: 1, y: 1 },
        apps: approvedApps(["gedit"]),
        appOf: (pid) => listed.get(pid),
        bundleIds: false,
      }),
      { _tag: "allow" },
    );
  });

  it("takes a listed app's bundle id over the windows its entry nests", () => {
    const listed = new Map<number, ListedApp>();
    learnApps(
      {
        apps: [{ ...KAKAO, windows: [{ pid: KAKAO.pid, app_name: KAKAO.name, window_id: 57000 }] }],
      },
      listed,
      true,
    );
    assert.deepEqual(listed.get(KAKAO.pid), { id: KAKAO.bundle_id, name: KAKAO.name });
    assert.deepEqual(verdict(listed), { _tag: "allow" });
  });

  it("takes a listed app's id over the name-only processes list Windows and Linux send beside it", () => {
    const listed = new Map<number, ListedApp>();
    learnApps(
      {
        structuredContent: {
          apps: [{ pid: 42, bundle_id: "org.example.Editor", name: "Editor" }],
          processes: [{ pid: 42, name: "Editor" }],
        },
      },
      listed,
      true,
    );
    assert.deepEqual(listed.get(42), { id: "org.example.Editor", name: "Editor" });
  });

  it("launches an app under a list only by an approved bundle id on macOS, and never elsewhere", () => {
    const launch = (args: object, bundleIds: boolean, apps: ReadonlyArray<string>) =>
      scopeVerdict({
        name: "launch_app",
        args,
        apps: approvedApps(apps),
        appOf: () => undefined,
        bundleIds,
      });
    // A grant naming Safari by name must not open the Safari another grant holds by bundle id.
    assert.deepInclude(
      launch({ name: "Safari", urls: ["https://example.com"] }, true, ["Safari"]),
      {
        _tag: "refuse",
        launch: "bundle_id",
      },
    );
    assert.deepInclude(
      launch({ bundle_id: "com.apple.Safari", name: "Safari" }, true, ["com.apple.Safari"]),
      { _tag: "refuse", launch: "bundle_id" },
    );
    assert.deepEqual(launch({ bundle_id: "com.apple.Safari" }, true, ["com.apple.Safari"]), {
      _tag: "allow",
    });
    // Linux runs launch_path (or opens urls) whatever bundle_id says, and Windows prefers a path
    // or AUMID over it, so no argument there proves which app opens.
    for (const args of [
      { bundle_id: "org.gnome.gedit", launch_path: "firefox" },
      { name: "gedit" },
      { bundle_id: "org.gnome.gedit", urls: ["https://example.com"] },
    ])
      assert.deepInclude(launch(args, false, ["org.gnome.gedit", "gedit"]), {
        _tag: "refuse",
        launch: "unverifiable",
      });
  });
});
