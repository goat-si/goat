import type {
  PreviewAppearancePreference,
  PreviewAutomationActionEvent,
  PreviewAutomationConsoleEntry,
  PreviewAutomationNetworkEntry,
  PreviewViewportSetting,
  ThreadId,
} from "@goat/contracts";
import type { CDPSession, Dialog, FileChooser, Frame, Page } from "playwright-core";

import type { ServerBrowserViewerOutput } from "./ServerBrowser.ts";
import type { ServerBrowserDiagnostics } from "./ServerBrowserDiagnostics.ts";
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

export interface EncoderWindow {
  __goatRecorder: {
    cursor(x: number, y: number, click: boolean): void;
    frame(data: string, width: number): Promise<boolean>;
    stop(): Promise<{ mimeType: string | null; count: number; bytes: number }>;
    chunk(index: number): Promise<string>;
  };
}

export interface Recording {
  readonly encoder: Page;
  readonly session: CDPSession;
  readonly startedAt: string;
  readonly framesInFlight: Set<Promise<void>>;
}

export interface ServerTab {
  readonly threadId: ThreadId;
  readonly tabId: string;
  readonly page: Page;
  readonly cdp: CDPSession;
  readonly frameSessions: Map<Frame, CDPSession>;
  readonly createdAt: number;
  usedAt: number;
  readonly viewers: Set<ViewerState>;
  readonly consoleEntries: Array<PreviewAutomationConsoleEntry>;
  readonly networkEntries: Array<PreviewAutomationNetworkEntry>;
  readonly diagnostics: ServerBrowserDiagnostics;
  readonly actionTimeline: Array<PreviewAutomationActionEvent>;
  readonly control: SessionControl;
  agentOperating: boolean;
  fileChooserIntercepted: boolean;
  readonly onFileChooser: (chooser: FileChooser) => void;
  readonly isolatedContext: boolean;
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
  loading: boolean;
  closing: boolean;
  recording: Recording | null;
  initialNavigation: Promise<void> | null;
  navigationGeneration: number;
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
