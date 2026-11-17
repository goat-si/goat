import type {
  PreviewAppearancePreference,
  PreviewAutomationActionEvent,
  PreviewAutomationConsoleEntry,
  PreviewAutomationNetworkEntry,
  PreviewTabSession,
  PreviewViewportSetting,
  ThreadId,
} from "@goat/contracts";
import type { CDPSession, Dialog, FileChooser, Frame, Page } from "playwright-core";

import type * as AgentTabState from "./agentTabState.ts";
import type { makeRecordingFrames } from "./RecordingFrames.ts";
import type { ServerBrowserDiagnostics } from "./ServerBrowserDiagnostics.ts";
import type { ServerBrowserViewerOutput } from "./ServerBrowserViewerOutput.ts";
import type { SessionControl } from "./SessionControl.ts";

export interface ViewerState {
  readonly id: string;
  readonly canOperate: boolean;
  readonly pressedKeys: Map<string, { key: string; code: string }>;
  readonly pressedButtons: Map<"left" | "middle" | "right", { x: number; y: number }>;
  readonly push: (output: ServerBrowserViewerOutput) => void;
  readonly pause: () => Promise<void>;
  readonly resume: () => Promise<void>;
  scrolledAt: number;

  requestedSize: { width: number; height: number; order: number } | null;
}

export interface Recording {
  readonly encoder: Page;
  readonly session: CDPSession;
  readonly startedAt: string;
  readonly frames: ReturnType<typeof makeRecordingFrames>;
}

export interface ServerTab {
  readonly threadId: ThreadId;
  readonly tabId: string;
  readonly page: Page;
  readonly cdp: CDPSession;
  readonly frameSessions: Map<Frame, CDPSession>;
  copyReads: Promise<void>;
  copyKeyedUntil: number;
  pendingCopyReads: number;
  readonly createdAt: number;
  usedAt: number;
  readonly viewers: Set<ViewerState>;
  viewerAttached: PromiseWithResolvers<void> | null;
  readonly consoleEntries: Array<PreviewAutomationConsoleEntry>;
  readonly networkEntries: Array<PreviewAutomationNetworkEntry>;
  readonly diagnostics: ServerBrowserDiagnostics;
  readonly actionTimeline: Array<PreviewAutomationActionEvent>;
  readonly control: SessionControl;
  agentOperating: boolean;
  /** Whose input last reached this tab, and so whose popups it opens. */
  readonly popups: AgentTabState.PopupAttribution;
  fileChooserIntercepted: boolean;
  readonly onFileChooser: (chooser: FileChooser) => void;

  readonly isolatedContext: boolean;
  /** The sign-in mode and store the tab was opened with; it never changes. */
  readonly session: PreviewTabSession;

  readonly desktop: { readonly close: () => Promise<void> } | null;
  readonly profileId: string | undefined;
  readonly openerTabId: string | undefined;

  readonly downloads: Array<ServerDownload>;
  fileChooser: {
    readonly id: string;
    readonly chooser: FileChooser;
    readonly accept: string;
    readonly offeredTo: string | null;
  } | null;
  dialog: Dialog | null;
  setting: PreviewViewportSetting;
  colorScheme: PreviewAppearancePreference;
  zoomFactor: number;
  /** Last usable CSS size measured on the desktop. */
  desktopViewport: { readonly width: number; readonly height: number } | null;
  desktopViewportRead: Promise<ServerTab["desktopViewport"]>;
  /** A read queued behind `desktopViewportRead`, shared by every caller that waits for it. */
  desktopViewportNext: Promise<ServerTab["desktopViewport"]> | null;
  /** A page resize or load since the last read started; status measures again. */
  desktopViewportStale: boolean;
  /** Counts page resizes, loads and dialog closes, so a caller can tell one landed during a read. */
  desktopViewportChanges: number;
  /** Settles at the desktop page's next main-frame resize. */
  desktopResize: PromiseWithResolvers<void>;
  loading: boolean;
  loadError: import("@goat/contracts").PreviewAutomationLoadError | undefined;
  closing: boolean;
  recording: Recording | null;
  initialNavigation: Promise<void> | null;
  initialNavigationSent: boolean;
  navigationGeneration: number;
  /** The navigation Stop cancelled; its aborted request is the stop, not a download. */
  stoppedGeneration: number | null;
  /** The first load's URL until its request event arrives, which can come after Stop. */
  pendingInitialRequestUrl: string | null;
  /** Moves on every main-frame navigation, same-document routes and reloads included. */
  documentGeneration: number;

  abortedNavigation: {
    readonly url: string;
    readonly generation: number;
    readonly timer: ReturnType<typeof setTimeout>;
  } | null;

  recordingStart: Promise<Recording> | null;
  captureLock: Promise<void>;
  capturing: number;
}

export interface ServerDownload {
  readonly id: string;
  readonly fileName: string;
  readonly path: string;
  readonly sizeBytes: number;
  readonly url: string;
  readonly completedAt: string;
}
