import { beforeEach } from "vite-plus/test";
import { commands } from "vite-plus/test/browser";
import { installMockFactoryFailureReport } from "./reportMockFactoryFailure";

declare module "vite-plus/test/browser" {
  interface BrowserCommands {
    /** Defined in vite.config.ts. Moves Playwright's mouse off the page. */
    resetPointer: () => Promise<void>;
  }
}

installMockFactoryFailureReport();

// Test files in one browser session share the origin's storage, and persisted stores such as the
// composer drafts hydrate from it when the test file imports them. Setup files run before that
// import in each file's fresh frame, so every file starts from what it seeds itself.
localStorage.clear();
sessionStorage.clear();

// Playwright's mouse outlives each test and each file, so whatever the next test mounts
// under its last position starts hovered. Registered here rather than in render() so tests
// that mount without it are covered too. Before each test, not after: a timed-out test keeps
// running and can move the mouse after its own afterEach.
beforeEach(async () => {
  await commands.resetPointer();
});
