import { createMemoryHistory } from "@tanstack/react-router";
import { describe, expect, it } from "vite-plus/test";

import { isLaunchLanding, LAUNCH_PATH, openLaunchRoute } from "./launchRoute";

function launchAt(entry: string, options = { hostedStatic: false }) {
  const history = createMemoryHistory({ initialEntries: [entry] });
  openLaunchRoute(history, options);
  return history;
}

describe("openLaunchRoute", () => {
  it("opens Fleet when a launch, restart, or update starts at the app root", () => {
    const history = launchAt("/");
    expect(LAUNCH_PATH).toBe("/fleet");
    expect(history.location.pathname).toBe("/fleet");
    // Replaced, so Back does not return to a root that would open the global agent.
    expect(history.length).toBe(1);
  });

  it("keeps the search and hash a root launch carried", () => {
    expect(launchAt("/?from=update#top").location.href).toBe("/fleet?from=update#top");
  });

  it("opens a deep link as asked", () => {
    for (const entry of [
      "/env-1/thread-1",
      "/env-1/thread-1?prompt=hi",
      "/draft/d-1",
      "/new?prompt=hi",
    ]) {
      expect(launchAt(entry).location.href).toBe(entry);
    }
  });

  it("leaves later visits to the root on Home", () => {
    const history = launchAt("/");
    history.push("/");
    expect(history.location.pathname).toBe("/");
  });

  it("keeps the hosted app on its own landing", () => {
    expect(launchAt("/", { hostedStatic: true }).location.pathname).toBe("/");
  });
});

describe("isLaunchLanding", () => {
  it("lets first-run setup open from where a launch lands", () => {
    expect(isLaunchLanding(launchAt("/").location.pathname)).toBe(true);
    expect(isLaunchLanding(launchAt("/", { hostedStatic: true }).location.pathname)).toBe(true);
  });

  it("never takes over a page opened by a direct link", () => {
    expect(isLaunchLanding("/settings/general")).toBe(false);
    expect(isLaunchLanding("/env-1/thread-1")).toBe(false);
  });
});
