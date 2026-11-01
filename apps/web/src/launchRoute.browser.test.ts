import { createHashHistory } from "@tanstack/react-router";
import { expect, it } from "vite-plus/test";

import { openLaunchRoute } from "./launchRoute";

// Electron's hash history reads the route from the hash and the query from the outer URL.
async function hashWindowAt(path: string) {
  const frame = document.createElement("iframe");
  const loaded = new Promise((resolve) => frame.addEventListener("load", resolve, { once: true }));
  frame.src = path;
  document.body.append(frame);
  await loaded;
  return { window: frame.contentWindow!, [Symbol.dispose]: () => frame.remove() };
}

it("a desktop launch with a query opens Fleet and keeps the query once across reloads", async () => {
  using frame = await hashWindowAt("/launch-route-fixture?from=update");
  const history = createHashHistory({ window: frame.window });
  openLaunchRoute(history, { hostedStatic: false });
  // The router reads the replaced location at once; the address bar follows on flush.
  history.flush();

  expect(frame.window.location.hash).toBe("#/fleet");
  expect(createHashHistory({ window: frame.window }).location.href).toBe("/fleet?from=update");
});
