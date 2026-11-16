import { beforeEach, vi } from "vite-plus/test";
import { commands } from "vite-plus/test/browser";

import { initializeI18n } from "../src/i18n/initializeI18n";
import { installMockFactoryFailureReport } from "./reportMockFactoryFailure";

declare module "vite-plus/test/browser" {
  interface BrowserCommands {
    /** Defined in vite.config.ts. Moves Playwright's mouse off the page. */
    resetPointer: () => Promise<void>;
  }
}

installMockFactoryFailureReport();

// Faces, the main row and Needs you read this gate; a test that is about it unmocks it.
vi.mock("../src/components/goatBot/useGoatBotComputerReadable", () => ({
  useGoatBotComputerReadable: () => true,
}));

// Test files in one browser session share the origin's storage, and persisted stores such as the
// composer drafts hydrate from it when the test file imports them. Setup files run before that
// import in each file's fresh frame, so every file starts from what it seeds itself.
localStorage.clear();
sessionStorage.clear();
// The connection runtime caches shells, threads and server config in IndexedDB under the
// environment id every app-render test shares, and loads them at boot.
await Promise.all(
  (await indexedDB.databases()).map(({ name }) =>
    name === undefined
      ? undefined
      : new Promise<void>((resolve) => {
          const request = indexedDB.deleteDatabase(name);
          request.onsuccess = request.onerror = request.onblocked = () => resolve();
        }),
  ),
);

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

// The app initializes GT at startup; components using its hooks need the same here.
initializeI18n(() => {});
