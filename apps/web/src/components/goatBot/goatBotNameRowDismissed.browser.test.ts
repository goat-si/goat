import { EnvironmentId } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";

import { webBotNameRowDismissals } from "./goatBotNameRowDismissed";

// The stored format is shared with every tab and later versions of this browser's GOAT.
const STORAGE_KEY = "goat:bot-name-row-dismissed:v1";
const stored = (): ReadonlyArray<string> => JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
const key = (environmentId: string, botId: string) => JSON.stringify([environmentId, botId]);

it("two dismissals in one tick are both stored, and only the newest 200 are kept", () => {
  localStorage.removeItem(STORAGE_KEY);
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
  localStorage.removeItem(STORAGE_KEY);
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
