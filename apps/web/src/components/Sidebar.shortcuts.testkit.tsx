import { createMemoryHistory } from "@tanstack/react-router";
import { scopeThreadRef } from "@goat/client-runtime/environment";
import { DEFAULT_CLIENT_SETTINGS } from "@goat/contracts/settings";
import { expect, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  installFakeEnvironment,
  threadWithHistory,
} from "../../test/fakeEnvironment";
import { render } from "../../test/render";

/** Mounts the app on the first of two threads; callers own the vi.mock setup for the socket. */
export async function mountTwoThreads(serverBrowser: boolean) {
  await using stack = new AsyncDisposableStack();
  const [first, second] = [threadWithHistory("thread-a", 1), threadWithHistory("thread-b", 1)];
  stack.use(installFakeEnvironment([first, second], { capabilities: { serverBrowser } }));
  stack.use(vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64"));
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  await page.viewport(1400, 900);
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${first.id}`] }),
  );
  await router.load();
  stack.use(
    await render(<AppRoot router={router} />, {
      // AppRoot brings its own router.
      router: false,
    }),
  );
  await expect.element(page.getByText(`Thread ${second.id}`).first()).toBeVisible();
  return {
    stack: stack.move(),
    router,
    firstRef: scopeThreadRef(ENVIRONMENT_ID, first.id),
    firstPath: `/${ENVIRONMENT_ID}/${first.id}`,
    secondPath: `/${ENVIRONMENT_ID}/${second.id}`,
  };
}

export const press = () => userEvent.keyboard("{Control>}{Shift>}]{/Shift}{/Control}");
