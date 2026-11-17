import type {
  AssistantCitation,
  EnvironmentId,
  KeybindingCommand,
  ModelSelection,
  PreviewAnnotationPayload,
  PreviewTabContextRecord,
  ProviderDriverKind,
  ProviderInteractionMode,
  ResponseContextRecord,
  RuntimeRequestId,
  ServerProvider,
  ThreadContextRecord,
} from "@goat/contracts";
import type { ComposerFileAttachment, ComposerImageAttachment } from "../../composerDraftStore";
import type { AssistantCitationSourceAnchor } from "~/lib/assistantTextSelection";
import type { TerminalContextDraft, TerminalContextSelection } from "../../lib/terminalContext";
import type { ReviewCommentContext } from "../../reviewCommentContext";

export interface ChatComposerHandle {
  focusAtEnd: () => void;
  focusAt: (cursor: number) => void;
  restoreAfterTimelineReachedEnd: () => void;
  collapseForTimelineScrollKey: (key: string) => void;
  addDroppedFiles: (files: File[]) => void;
  addDroppedFolders: (folders: File[]) => void;
  hasPendingAttachments: () => boolean;
  insertTextAtEnd: (
    text: string,
    options?: { ensureLeadingBoundary?: boolean; clipboardData?: DataTransfer },
  ) => boolean;
  pasteTextAtEnd: (text: string, options?: { bypassAutoAttachment?: boolean }) => boolean;
  citeAssistantText: (
    citation: AssistantCitation,
    sourceAnchor: AssistantCitationSourceAnchor,
  ) => boolean;
  /** Shows the reply above the composer and focuses it; false while a question owns it. */
  replyToResponse: (response: ResponseContextRecord) => boolean;
  openModelPicker: () => void;
  stepReasoningEffort: (direction: 1 | -1) => void;
  toggleModelPicker: () => void;
  openControl: (command: KeybindingCommand) => void;
  isModelPickerOpen: () => boolean;
  isCaretAtStart: () => boolean;
  compactContext: () => void;
  readSnapshot: () => {
    value: string;
    cursor: number;
    expandedCursor: number;
    contextIds: string[];
  };
  resetCursorState: (options?: {
    cursor?: number;
    prompt?: string;
    detectTrigger?: boolean;
  }) => void;
  addTerminalContext: (selection: TerminalContextSelection) => void;
  getSendContext: () => {
    answeringPendingUserInput: boolean;
    prompt: string;
    images: ComposerImageAttachment[];
    files: ComposerFileAttachment[];
    terminalContexts: TerminalContextDraft[];
    previewAnnotations: PreviewAnnotationPayload[];
    reviewComments: ReviewCommentContext[];
    threadContexts: ThreadContextRecord[];
    previewTabs: PreviewTabContextRecord[];
    threadContextRoutingEnvironmentId: EnvironmentId;
    selectedPromptEffort: string | null;
    selectedModelOptionsForDispatch: unknown;
    selectedModelSelection: ModelSelection;
    multipleModelSelections: ReadonlyArray<ModelSelection> | null;
    providerAvailable: boolean;
    selectedProvider: ProviderDriverKind;
    selectedModel: string;
    selectedProviderModels: ReadonlyArray<ServerProvider["models"][number]>;
    interactionMode: ProviderInteractionMode;
    interactionModeEnabled: boolean;
    shownPendingApprovalIds: ReadonlyArray<RuntimeRequestId>;
  };
  validateProviderInput: (providerInput: string) => boolean;
  setMultipleModelSelections: (selections: ReadonlyArray<ModelSelection>) => void;
}
