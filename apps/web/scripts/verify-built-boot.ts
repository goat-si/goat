// @effect-diagnostics nodeBuiltinImport:off - CI boots the production chunk graph without a server.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { chromium } from "playwright";

const origin = "http://goat-boot.test";

export async function verifyBuiltBoot(
  distDir = NodeURL.fileURLToPath(new URL("../dist/", import.meta.url)),
) {
  const root = NodePath.resolve(distDir);
  const index = NodePath.join(root, "index.html");
  if (!NodeFS.existsSync(index))
    throw new Error(`No web build at ${root}. Build the web app first.`);

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      const file = NodePath.resolve(root, `.${decodeURIComponent(url.pathname)}`);
      if (
        file.startsWith(`${root}${NodePath.sep}`) &&
        NodeFS.statSync(file, { throwIfNoEntry: false })?.isFile()
      ) {
        return route.fulfill({ path: file });
      }
      if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/.well-known/")) {
        return route.fulfill({ status: 503 });
      }
      return route.request().isNavigationRequest()
        ? route.fulfill({ path: index })
        : route.fulfill({ status: 404 });
    });

    await page.goto(`${origin}/`);
    // React replaces the splash; the boot error UI keeps it and adds the reload control.
    const settled = await page.waitForSelector("#root > :not(#boot-shell), #boot-error-reload", {
      timeout: 60_000,
    });
    if (await settled.evaluate((node) => node.id === "boot-error-reload")) {
      throw new Error(`The built web client failed to boot:\n${errors.join("\n")}`);
    }
    console.log("The built web client booted and mounted React.");
  } finally {
    await browser.close();
  }
}

if (import.meta.main) {
  await verifyBuiltBoot();
}
