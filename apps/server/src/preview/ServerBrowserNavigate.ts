import type { Page } from "playwright-core";
import type { PreviewAutomationNavigateInput } from "@goat/contracts";
import { normalizePreviewUrl } from "@goat/shared/preview";
import type { ActionChannel } from "./actionChannel.ts";
import type { SessionControl } from "./SessionControl.ts";
import * as ServerBrowserPage from "./ServerBrowserPage.ts";

export const guardedNavigate = async (
  tab: { readonly page: Page; readonly control: Pick<SessionControl, "track"> },
  url: string,
  readiness: "load" | "domContentLoaded" | "none",
  timeout: number,
  channel: ActionChannel,
) => {
  const navigation = channel.call(() =>
    tab.page.goto(url, {
      timeout,
      waitUntil:
        readiness === "domContentLoaded"
          ? "domcontentloaded"
          : readiness === "none"
            ? "commit"
            : "load",
    }),
  );
  if (readiness === "none") {
    tab.control.track(navigation);
    return;
  }
  await navigation.catch((cause: unknown) => {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (message.includes("Download is starting")) {
      throw new ServerBrowserPage.ServerBrowserOperationError(
        "PreviewAutomationExecutionError",
        `${url} is a file this browser cannot show, so it was downloaded instead. goat_call {path:"preview.status"} lists it under downloads.`,
      );
    }
    if (/ERR_[A-Z_]+/.test(message)) {
      throw new ServerBrowserPage.ServerBrowserOperationError(
        "PreviewAutomationExecutionError",
        `Navigation to ${url} failed: ${ServerBrowserPage.parseNetError(message).description}`,
      );
    }
    throw ServerBrowserPage.toOperationError(cause, timeout);
  });
};

export const resolveNavigationUrl = (input: PreviewAutomationNavigateInput) => {
  if (input.url !== undefined) return normalizePreviewUrl(input.url);
  const target = input.target;
  if (!target) throw new Error("A navigation target is required.");
  if (target.kind === "url") return normalizePreviewUrl(target.url);
  const path = target.path ?? "";
  return `${target.protocol ?? "http"}://localhost:${target.port}${path.startsWith("/") || path === "" ? path : `/${path}`}`;
};
