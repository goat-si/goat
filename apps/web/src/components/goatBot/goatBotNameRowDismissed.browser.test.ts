import { EnvironmentId } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";

import {
  resetBotNameRowDismissalsForTests,
  webBotNameRowDismissals,
} from "./goatBotNameRowDismissed";

// The stored format is shared with every tab and later versions of this browser's GOAT.
const STORAGE_KEY = "goat:bot-name-row-dismissed:v1";
const stored = (): ReadonlyArray<string> => JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
const key = (environmentId: string, botId: string) => JSON.stringify([environmentId, botId]);

/** Every test starts with nothing stored and nothing kept in memory. */
function setup() {
  localStorage.removeItem(STORAGE_KEY);
  resetBotNameRowDismissalsForTests();
}

it("two dismissals in one tick are both stored, and only the newest 200 are kept", () => {
  setup();
  const environmentId = EnvironmentId.make("env-cap");
  for (let index = 0; index < 199; index += 1)
    webBotNameRowDismissals.dismiss(environmentId, `old-${index}`);
  webBotNameRowDismissals.dismiss(environmentId, "first");
  webBotNameRowDismissals.dismiss(environmentId, "second");
  const list = stored();
  expect(list).toHaveLength(200);
  expect(list.slice(-2)).toEqual([key("env-cap", "first"), key("env-cap", "second")]);
  expect(list).not.toContain(key("env-cap", "old-0"));
  expect(webBotNameRowDismissals.dismissed(environmentId, "first")).toBe(true);
  expect(webBotNameRowDismissals.dismissed(environmentId, "second")).toBe(true);
});

it("a dismissal the browser refuses to store still hides the row for this session", () => {
  setup();
  const environmentId = EnvironmentId.make("env-refused");
  using _quota = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
  });
  using _log = vi.spyOn(console, "error").mockImplementation(() => {});
  const listener = vi.fn();
  const stop = webBotNameRowDismissals.subscribe(listener);
  webBotNameRowDismissals.dismiss(environmentId, "refused");
  stop();
  expect(listener).toHaveBeenCalled();
  expect(stored()).toEqual([]);
  expect(webBotNameRowDismissals.dismissed(environmentId, "refused")).toBe(true);
  expect(webBotNameRowDismissals.dismissed(environmentId, "other")).toBe(false);
});

/** Storage refuses every write until disposed. */
function refuseStorage(): Disposable {
  const quota = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
  });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  return {
    [Symbol.dispose]: () => {
      quota.mockRestore();
      log.mockRestore();
    },
  };
}

it("memory keeps only the newest 200 dismissals storage refused", () => {
  setup();
  const environmentId = EnvironmentId.make("env-refused-cap");
  using _refused = refuseStorage();
  for (let index = 0; index <= 200; index += 1)
    webBotNameRowDismissals.dismiss(environmentId, `refused-${index}`);
  expect(webBotNameRowDismissals.dismissed(environmentId, "refused-0")).toBe(false);
  expect(webBotNameRowDismissals.dismissed(environmentId, "refused-1")).toBe(true);
  expect(webBotNameRowDismissals.dismissed(environmentId, "refused-200")).toBe(true);
});

it("a dismissal storage took leaves nothing in memory", () => {
  setup();
  const environmentId = EnvironmentId.make("env-stored");
  webBotNameRowDismissals.dismiss(environmentId, "stored");
  expect(stored()).toEqual([key("env-stored", "stored")]);
  // Another tab clears the list: only storage was holding this dismissal.
  localStorage.removeItem(STORAGE_KEY);
  expect(webBotNameRowDismissals.dismissed(environmentId, "stored")).toBe(false);
});

it("a refused dismissal is stored by the next write that succeeds, and then leaves memory", () => {
  setup();
  const environmentId = EnvironmentId.make("env-late");
  {
    using _refused = refuseStorage();
    webBotNameRowDismissals.dismiss(environmentId, "late");
  }
  webBotNameRowDismissals.dismiss(environmentId, "next");
  expect(stored()).toEqual([key("env-late", "late"), key("env-late", "next")]);
  localStorage.removeItem(STORAGE_KEY);
  expect(webBotNameRowDismissals.dismissed(environmentId, "late")).toBe(false);
});
