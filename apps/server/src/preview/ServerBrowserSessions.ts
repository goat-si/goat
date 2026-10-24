/**
 * What the preview session list reads from one server browser tab.
 *
 * @module ServerBrowserSessions
 */
import type { ThreadId } from "@goat/contracts";
import type { Page } from "playwright-core";

import type { SessionControl } from "./SessionControl.ts";

export interface ServerBrowserSessionView {
  readonly threadId: ThreadId;
  readonly tabId: string;
  readonly url: string;
  readonly title: string;
  /** The agent session that opened it, or null for a person's tab. */
  readonly agentId: string | null;
  readonly humanControls: boolean;
  readonly private: boolean;
  readonly agentStopped: boolean;
}

export const browserSessionView = async (tab: {
  readonly threadId: ThreadId;
  readonly tabId: string;
  readonly page: Page;
  readonly control: SessionControl;
}): Promise<ServerBrowserSessionView> => ({
  threadId: tab.threadId,
  tabId: tab.tabId,
  url: tab.page.url(),
  title: await tab.page.title().catch(() => ""),
  agentId: tab.control.agentId,
  humanControls: tab.control.controller !== null,
  private: tab.control.isPrivate,
  agentStopped: tab.control.isAgentStopped,
});
