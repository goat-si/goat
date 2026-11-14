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

// Playwright's mouse outlives each test and each file, so whatever the next test mounts
// under its last position starts hovered. Registered here rather than in render() so tests
// that mount without it are covered too. Before each test, not after: a timed-out test keeps
// running and can move the mouse after its own afterEach.
beforeEach(async () => {
  await commands.resetPointer();
  // Files tree folders persist under this key (src/components/files/fileTreeExpansion.ts), and
  // every file on a worker page shares its storage, so one test's open folders would reach the
  // next tree that mounts, including trees inside ChatView or the right panel.
  localStorage.removeItem("goat.fileTreeExpandedDirectories");
});
