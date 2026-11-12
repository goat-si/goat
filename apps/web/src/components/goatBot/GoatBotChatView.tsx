import type { GoatBotRow } from "@goat/client-runtime/goatBot";
import {
  type ChannelBotArtifact,
  ChannelQuestionId,
  ChannelTaskId,
  type EnvironmentId,
} from "@goat/contracts";
import { Link } from "@tanstack/react-router";
import { useContext, useRef, useState, type ReactNode } from "react";

import { useMediaQuery } from "~/hooks/useMediaQuery";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "~/rightPanelLayout";
import { cn } from "~/lib/utils";
import { Sheet, SheetPopup, SheetTitle } from "../ui/sheet";
import { GoatBotFileViewer } from "./GoatBotFileViewer";
import { GoatBotOpenFileContext } from "./GoatBotReplyFiles";
import { GoatBotWorkPanel } from "./GoatBotWorkPanel";
import { useGoatBotRoutineLanding } from "./useGoatBotRoutineLanding";

import { APP_DISPLAY_NAME } from "~/branding";
import { isElectron } from "~/env";
import { GOAT_BOT_PATH, type GlobalAgentLegacyRoute } from "~/globalAgentRoute";
import { useStableCallback } from "~/hooks/useStableCallback";

import { WorkspaceFileDropOverlay } from "../chat/TimelineOverlays";
import { makeWorkspaceFileDropHandlers } from "../chat/workspaceFileDrop";
import { Button } from "../ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { toastManager } from "../ui/toast";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { GoatBotAvatar, GoatBotMainAvatar, GoatBotSessionAvatar } from "./GoatBotAvatar";
import {
  useGoatBotAccentStyle,
  useGoatBotAvatar,
  useGoatBotMainName,
  useGoatBotMember,
  useGoatBotName,
} from "./goatBotMemberContext";
import { useGoatBotMemberWaitingCount } from "./useGoatBotMemberStatus";
import { scopeThreadRef } from "@goat/client-runtime/environment";
import type { GoatBotAttachmentSupport, GoatBotDraftAttachment } from "./goatBotAttachments";
import { GoatBotComposer, type GoatBotComposerHandle } from "./GoatBotComposer";
import { GoatBotMemberModelPicker } from "./GoatBotMemberModelPicker";
import { GoatBotModelPicker } from "./GoatBotModelPicker";
import { GoatBotNameRow } from "./GoatBotNameRow";
import { GoatBotActivityContext, GoatBotTimeline } from "./GoatBotTimeline";
import { GoatBotActivityStatus } from "./GoatBotActivityStatus";
import { GoatBotStepsReader } from "./GoatBotStepsProvider";
import { useGoatBotReading } from "./useGoatBotFace";
import {
  buildGoatBotQuote,
  canSendToGoatBot,
  goatBotOpenQuestionPlaceholder,
  goatBotNotesRefreshKey,
  type GoatBotAvailability,
  type GoatBotRemoval,
} from "@goat/client-runtime/goatBot";
const EXAMPLES = [
  "Fix the flaky test in my project",
  "Review the latest changes",
  "How is the work going?",
] as const;

export interface GoatBotChatViewProps {
  readonly unreadSince?: string | null | undefined;
  /** The bot's server supports task threads, so task chips render as task-thread pills. */
  readonly supportsTaskThreads?: boolean | undefined;
  /** The bot's server runs failed or stopped work again when a person asks. */
  readonly supportsTaskRetry?: boolean | undefined;
  readonly homeMove?:
    | { readonly label: string; readonly busy: boolean; readonly onMove: () => void }
    | undefined;
  readonly homeMoveError?: string | null | undefined;
  readonly availability: GoatBotAvailability;
  readonly canOperate: boolean;
  readonly rows: ReadonlyArray<GoatBotRow>;
  /** A task's own conversation, for reading it in the bot's panel. */
  readonly rowsForTask?: ((taskId: ChannelTaskId) => ReadonlyArray<GoatBotRow>) | undefined;
  /** When GOAT Bot started reading a message it is still answering. */
  readonly replyingSince?: string | null | undefined;
  readonly onSend: (
    text: string,
    attachments?: ReadonlyArray<GoatBotDraftAttachment>,
  ) => boolean | void;
  /** Sends an answer to the task whose question offered it. */
  readonly onSendToTask?:
    | ((
        taskId: ChannelTaskId,
        text: string,
        attachments?: ReadonlyArray<never>,
        questionId?: ChannelQuestionId,
      ) => boolean | void)
    | undefined;
  /** What GOAT Bot's server takes with a message; null when it takes no files. */
  readonly attachmentSupport?: GoatBotAttachmentSupport | null | undefined;
  readonly onRetryInput: (clientKey: string) => void;
  readonly onDiscardInput?: (clientKey: string) => void;
  /** Asks the server for its bot again, after a failure or a busy global agent. */
  readonly onRetryAvailability?: (() => void) | undefined;
  /** The old global agent, which keeps its coding view and history. */
  readonly legacyAgentRoute: GlobalAgentLegacyRoute | null;
  /** The bot thread was archived or deleted, here or on another device. */
  readonly removal?: GoatBotRemoval | undefined;
  /** Checks the archive again after that check failed. */
  readonly onCheckAgain?: (() => void) | undefined;
  /** Brings an archived bot chat back. */
  readonly onUnarchive?: (() => void) | undefined;
  /** Brings a deleted member bot back, with its conversation. */
  readonly onRestore?: (() => void) | undefined;
  /** Only offer navigation when this connection confirmed a different bot chat. */
  readonly canOpenCurrentBot?: boolean | undefined;
  /** The environment whose bot history is shown, which can differ from a new home during a move. */
  readonly environmentId?: EnvironmentId | null | undefined;
}

/** GOAT Bot as a messenger: bubbles and work cards, never tool calls. */
export function GoatBotChatView({
  unreadSince,
  supportsTaskThreads = false,
  supportsTaskRetry = false,
  availability,
  homeMove,
  homeMoveError,
  canOperate,
  rows,
  replyingSince = null,
  onSend,
  onSendToTask,
  attachmentSupport = null,
  onRetryInput,
  rowsForTask,
  onDiscardInput,
  onRetryAvailability,
  legacyAgentRoute,
  removal = null,
  canOpenCurrentBot = false,
  environmentId = null,
  onUnarchive,
  onRestore,
  onCheckAgain,
}: GoatBotChatViewProps) {
  const [panelOpen, setPanelOpen] = useState(false);
  const member = useGoatBotMember();
  const accentStyle = useGoatBotAccentStyle();
  const memberWaiting = useGoatBotMemberWaitingCount(member);
  const title = useGoatBotName();
  const mainName = useGoatBotMainName();
  const avatar = useGoatBotAvatar();
  const narrow = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  const bot = availability.kind === "ready" ? availability.bot : null;
  const routineLanding = useGoatBotRoutineLanding(bot, panelOpen, () => setPanelOpen(true));
  const removed = removal !== null;
  const ready = availability.kind === "ready" && !removed;
  const canSend = !removed && canSendToGoatBot(availability, canOperate);
  const acceptsFiles = canSend && attachmentSupport !== null;
  const composerRef = useRef<GoatBotComposerHandle>(null);
  const homeRef = useRef<HTMLButtonElement>(null);
  // Why the narrow sheet last closed: a draft action leaves focus in the message box and a file
  // takes focus itself; plain dismissal returns focus to the chip that opened the sheet.
  const sheetClosedFor = useRef<"draft" | "file" | null>(null);
  const sheetFinalFocus = () => {
    const reason = sheetClosedFor.current;
    sheetClosedFor.current = null;
    if (reason === "file") return false;
    const field = reason === "draft" ? composerRef.current?.field() : null;
    if (!field) return homeRef.current ?? true;
    field.setSelectionRange(field.value.length, field.value.length);
    return field;
  };
  const botIdentity = `${environmentId ?? ""}:${member?.sessionThreadId ?? bot?.threadId ?? ""}`;
  const [replyState, setReplyState] = useState<{ botIdentity: string; text: string } | null>(null);
  if (replyState !== null && replyState.botIdentity !== botIdentity) setReplyState(null);
  const replyTo = replyState?.botIdentity === botIdentity ? replyState.text : null;
  const onDraft = canSend
    ? (text: string) => {
        if (narrow) {
          sheetClosedFor.current = "draft";
          setPanelOpen(false);
        }
        if (composerRef.current?.offerDraft(text) === false) {
          toastManager.add({
            type: "info",
            title: "Your message box already has a message. Send or clear it, then try again.",
          });
        }
      }
    : undefined;
  const notesRefreshKey = goatBotNotesRefreshKey(rows);
  // A Library file open in place of the conversation, for the bot it was opened from.
  const [viewing, setViewing] = useState<{
    readonly environmentId: EnvironmentId;
    readonly threadId: string;
    readonly file: ChannelBotArtifact;
  } | null>(null);
  const fileOpener = useRef<HTMLElement | null>(null);
  const openFile = bot
    ? (file: ChannelBotArtifact) => {
        fileOpener.current =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;
        if (narrow) {
          sheetClosedFor.current = "file";
          setPanelOpen(false);
        }
        setViewing({ environmentId: bot.environmentId, threadId: bot.threadId, file });
      }
    : () => {};
  const closeFile = () => {
    setViewing(null);
    const opener = fileOpener.current;
    fileOpener.current = null;
    // Focus returns to the Library row; on a narrow screen its sheet is gone, so to the composer.
    if (opener?.isConnected) opener.focus();
    else composerRef.current?.focus();
  };
  // Another bot, or this one moved to another server, closes the file for good; a bot that is
  // only briefly unavailable keeps it.
  if (
    viewing !== null &&
    bot !== null &&
    (viewing.environmentId !== bot.environmentId || viewing.threadId !== bot.threadId)
  ) {
    setViewing(null);
  }
  const shownFile =
    viewing !== null &&
    viewing.environmentId === bot?.environmentId &&
    viewing.threadId === bot.threadId
      ? viewing
      : null;
  const [dragActive, setDragActive] = useState(false);
  // One value per bot server, so the reply file cards under every message skip re-rendering.
  const openFileStable = useStableCallback(openFile);
  const botEnvironmentId = bot?.environmentId ?? null;
  const fileOpening =
    botEnvironmentId === null ? null : { environmentId: botEnvironmentId, open: openFileStable };
  if (!acceptsFiles && dragActive) setDragActive(false);
  const addDroppedFiles = useStableCallback((files: File[]) =>
    composerRef.current?.addFiles(files),
  );
  const dropHandlers = makeWorkspaceFileDropHandlers({
    setDragActive,
    addFiles: addDroppedFiles,
    addFolders: () =>
      toastManager.add({
        type: "error",
        title: `Folders can't be attached to ${title}. Drop the files instead.`,
      }),
  });
  const [seed, setSeed] = useState<{ text: string; nonce: number } | null>(null);
  const working = useContext(GoatBotActivityContext);
  const reading = useGoatBotReading(replyingSince);
  const headerStatus =
    removal === "archived"
      ? "Archived"
      : removal === "deleted"
        ? "Deleted"
        : removal === "unchecked"
          ? "Couldn't check this chat"
          : availability.kind === "ready"
            ? null
            : statusLine(availability);
  return (
    <div className="flex min-h-0 min-w-0 flex-1" style={accentStyle}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
        <WorkspacePageHeader electron={isElectron} className="surface-glass relative">
          <div aria-hidden className="flex-1 basis-0" />
          <div className="flex max-w-[60%] min-w-0 items-center gap-2">
            <h1 className="flex min-w-0">
              <button
                type="button"
                ref={homeRef}
                aria-label={`${title} home`}
                aria-expanded={panelOpen}
                disabled={!bot}
                onClick={() => setPanelOpen((open) => !open)}
                className="goat-name-capsule max-w-full min-w-0 text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              >
                <span className="goat-name-avatar flex shrink-0">
                  {member ? (
                    <GoatBotSessionAvatar
                      size="sm"
                      chatOpen
                      emoji={avatar}
                      waitingCount={memberWaiting}
                      threadRef={scopeThreadRef(member.environmentId, member.sessionThreadId)}
                      activity={reading ? { state: "reading" } : removed ? null : working}
                    />
                  ) : (
                    <GoatBotMainAvatar
                      size="sm"
                      chatOpen
                      emoji={avatar}
                      activity={reading ? { state: "reading" } : removed ? null : working}
                    />
                  )}
                </span>
                <span className="min-w-0 truncate">{title}</span>
              </button>
            </h1>
            {headerStatus ? (
              <p className="truncate text-2xs text-muted-foreground">{headerStatus}</p>
            ) : null}
          </div>
          <div aria-hidden className="flex-1 basis-0" />
        </WorkspacePageHeader>
        {availability.kind === "offline" ||
        availability.kind === "home_offline" ||
        availability.kind === "connecting" ? (
          <div
            role="status"
            className="border-b border-border px-4 py-2 text-sm text-muted-foreground"
          >
            {availability.kind === "home_offline"
              ? offlineHomeCopy(availability, mainName)
              : availability.kind === "offline"
                ? `${mainName}'s computer is offline. You can send messages again once it reconnects.`
                : `Connecting to ${mainName}…`}
            {/* With no history the notice below carries the same action. */}
            {availability.kind === "home_offline" && homeMove && rows.length > 0 ? (
              <div className="mt-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={homeMove.busy}
                  onClick={homeMove.onMove}
                >
                  Move {mainName} to {homeMove.label}
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
        {homeMoveError ? (
          <p role="alert" className="px-4 py-2 text-sm text-muted-foreground">
            {homeMoveError}
          </p>
        ) : null}
        {rows.length > 0 &&
        availability.kind !== "ready" &&
        availability.kind !== "offline" &&
        availability.kind !== "home_offline" &&
        availability.kind !== "connecting" ? (
          <div role="status">
            <GoatBotNotice
              availability={availability}
              onRetryAvailability={onRetryAvailability}
              legacyAgentRoute={legacyAgentRoute}
            />
          </div>
        ) : null}
        <div
          className="relative flex min-h-0 flex-1 flex-col"
          {...(acceptsFiles ? dropHandlers : {})}
        >
          {dragActive ? <WorkspaceFileDropOverlay /> : null}
          {shownFile !== null ? (
            <GoatBotFileViewer
              key={`${shownFile.file.relativePath}:${shownFile.file.modifiedAt}`}
              environmentId={shownFile.environmentId}
              file={shownFile.file}
              onClose={closeFile}
            />
          ) : null}
          {/* The conversation stays mounted under an open file, so closing it keeps its place. */}
          <div className={cn("flex min-h-0 flex-1 flex-col", shownFile !== null && "hidden")}>
            {/* Mounted before the first message, so the chat's first status is heard. */}
            <GoatBotActivityStatus
              key={botIdentity}
              replyingSince={removed ? null : replyingSince}
            />
            {/* An open file covers the conversation, so its activity lines stop reading. */}
            <GoatBotStepsReader rows={rows} paused={shownFile !== null}>
              <GoatBotOpenFileContext value={fileOpening}>
                {rows.length > 0 ? (
                  // History stays readable while the bot is unavailable; only sending stops.
                  <GoatBotTimeline
                    rows={rows}
                    unreadSince={unreadSince}
                    onReply={
                      canSend
                        ? (text) => {
                            setReplyState({ botIdentity, text });
                            composerRef.current?.focus();
                          }
                        : undefined
                    }
                    environmentId={environmentId}
                    onOpenRoutine={routineLanding.openRoutine}
                    taskThreads={supportsTaskThreads}
                    retryEnvironmentId={supportsTaskRetry ? environmentId : null}
                    replyingSince={removed ? null : replyingSince}
                    onRetry={onRetryInput}
                    onDiscard={onDiscardInput}
                    onPick={
                      canSend
                        ? (answer, taskId, questionId) =>
                            taskId !== undefined && onSendToTask !== undefined
                              ? onSendToTask(
                                  ChannelTaskId.make(taskId),
                                  answer,
                                  [],
                                  questionId === undefined
                                    ? undefined
                                    : ChannelQuestionId.make(questionId),
                                )
                              : onSend(answer)
                        : undefined
                    }
                  />
                ) : removal !== null ? (
                  <GoatBotRemovedNotice
                    removal={removal}
                    availability={availability}
                    onRetryAvailability={onRetryAvailability}
                    canOpenCurrentBot={canOpenCurrentBot}
                    onUnarchive={onUnarchive}
                    onRestore={member ? onRestore : undefined}
                    memberName={member?.name ?? null}
                    onCheckAgain={onCheckAgain}
                  />
                ) : (
                  <GoatBotNotice
                    availability={availability}
                    homeMove={homeMove}
                    onRetryAvailability={onRetryAvailability}
                    legacyAgentRoute={legacyAgentRoute}
                    onSelectExample={
                      canSend
                        ? (text) =>
                            setSeed((previous) => ({ text, nonce: (previous?.nonce ?? 0) + 1 }))
                        : undefined
                    }
                  />
                )}
              </GoatBotOpenFileContext>
            </GoatBotStepsReader>
          </div>
          <GoatBotNameRow composer={composerRef} />
          {ready && !canOperate ? (
            <p className="mx-auto w-full max-w-3xl px-4 pb-2 text-xs text-muted-foreground">
              You can read this chat but can't send messages.
            </p>
          ) : null}
          <GoatBotComposer
            ref={composerRef}
            key={seed?.nonce ?? 0}
            initialText={seed?.text ?? ""}
            disabled={!canSend}
            botName={title}
            placeholder={
              canSend
                ? (goatBotOpenQuestionPlaceholder(rows) ?? `Message ${title}`)
                : `${title} isn't available`
            }
            attachmentSupport={attachmentSupport}
            modelPicker={
              member ? <GoatBotMemberModelPicker member={member} /> : <GoatBotModelPicker />
            }
            replyTo={replyTo}
            onClearReply={() => setReplyState(null)}
            onSend={(text, attachments) => {
              const result = onSend(
                replyTo === null ? text : buildGoatBotQuote(replyTo, text),
                attachments,
              );
              if (result !== false) setReplyState(null);
              return result;
            }}
          />
        </div>
      </div>
      {bot && panelOpen && !narrow && (
        <aside aria-label={`${title} work`} className="flex w-88 shrink-0 border-l border-border">
          <GoatBotWorkPanel
            environmentId={bot.environmentId}
            threadId={bot.threadId}
            onDraft={onDraft}
            notesRefreshKey={notesRefreshKey}
            peekRows={rowsForTask}
            onRetryInput={onRetryInput}
            openFile={shownFile?.file.relativePath ?? null}
            onOpenFile={openFile}
            routineLanding={routineLanding.landing}
          />
        </aside>
      )}
      {bot && narrow && (
        <Sheet open={panelOpen} onOpenChange={setPanelOpen}>
          {/* A phone-width window gives the home the whole screen; wider, the chat stays beside it. */}
          <SheetPopup
            finalFocus={sheetFinalFocus}
            showCloseButton={false}
            className="max-sm:w-full max-sm:max-w-none"
          >
            <SheetTitle className="sr-only">{title} work</SheetTitle>
            <GoatBotWorkPanel
              environmentId={bot.environmentId}
              threadId={bot.threadId}
              onDraft={onDraft}
              notesRefreshKey={notesRefreshKey}
              onShowChat={() => setPanelOpen(false)}
              peekRows={rowsForTask}
              onRetryInput={onRetryInput}
              openFile={shownFile?.file.relativePath ?? null}
              onOpenFile={openFile}
              routineLanding={routineLanding.landing}
            />
          </SheetPopup>
        </Sheet>
      )}
    </div>
  );
}

function GoatBotRemovedNotice({
  removal,
  availability,
  onRetryAvailability,
  canOpenCurrentBot,
  onUnarchive,
  onRestore,
  memberName,
  onCheckAgain,
}: {
  readonly removal: Exclude<GoatBotRemoval, null>;
  readonly availability: GoatBotAvailability;
  readonly onRetryAvailability: (() => void) | undefined;
  readonly canOpenCurrentBot: boolean;
  readonly onUnarchive: (() => void) | undefined;
  readonly onRestore: (() => void) | undefined;
  readonly memberName: string | null;
  readonly onCheckAgain: (() => void) | undefined;
}) {
  const avatar = useGoatBotAvatar();
  const botName = useGoatBotName();
  if (memberName !== null) {
    return (
      <Empty className="min-h-0 flex-1">
        <EmptyHeader className="max-w-md">
          <GoatBotAvatar size="lg" emoji={avatar} className="mx-auto mb-4" />
          <EmptyTitle>{memberName} was deleted</EmptyTitle>
          <EmptyDescription>
            Its conversation is archived. Restore it to keep chatting here.
          </EmptyDescription>
        </EmptyHeader>
        {onRestore !== undefined ? (
          <EmptyContent>
            <div className="flex justify-center">
              <Button size="sm" variant="outline" onClick={onRestore}>
                Restore
              </Button>
            </div>
          </EmptyContent>
        ) : null}
      </Empty>
    );
  }
  if (removal === "unchecked") {
    return (
      <Empty className="min-h-0 flex-1">
        <EmptyHeader className="max-w-md">
          <GoatBotAvatar size="lg" emoji={avatar} className="mx-auto mb-4" />
          <EmptyTitle>Couldn't check this chat</EmptyTitle>
          <EmptyDescription>
            It may have been archived or deleted. Check again to find out.
          </EmptyDescription>
        </EmptyHeader>
        {onCheckAgain !== undefined ? (
          <EmptyContent>
            <div className="flex justify-center">
              <Button size="sm" variant="outline" onClick={onCheckAgain}>
                Check again
              </Button>
            </div>
          </EmptyContent>
        ) : null}
      </Empty>
    );
  }
  const replacementFailed =
    removal === "deleted" &&
    !canOpenCurrentBot &&
    (availability.kind === "error" ||
      availability.kind === "legacy_active" ||
      availability.kind === "ready");
  const description = canOpenCurrentBot
    ? `${botName} keeps going in its current chat.`
    : removal === "archived"
      ? `Unarchive it to keep chatting with ${botName} here.`
      : replacementFailed
        ? `Couldn't start a new ${botName} chat.`
        : availability.kind === "connecting"
          ? `${botName} is starting a new chat.`
          : `Reconnect to start a new ${botName} chat.`;
  return (
    <Empty className="min-h-0 flex-1">
      <EmptyHeader className="max-w-md">
        <GoatBotAvatar size="lg" emoji={avatar} className="mx-auto mb-4" />
        <EmptyTitle>
          {removal === "archived" ? "This chat is archived" : "This chat was deleted"}
        </EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {canOpenCurrentBot ||
      onUnarchive !== undefined ||
      (replacementFailed && onRetryAvailability) ? (
        <EmptyContent>
          <div className="flex justify-center">
            {canOpenCurrentBot ? (
              <Button size="sm" variant="outline" render={<Link to={GOAT_BOT_PATH} />}>
                Open GOAT Bot
              </Button>
            ) : onUnarchive !== undefined ? (
              <Button size="sm" variant="outline" onClick={onUnarchive}>
                Unarchive
              </Button>
            ) : (
              <Button size="sm" variant="outline" onClick={onRetryAvailability}>
                Try again
              </Button>
            )}
          </div>
        </EmptyContent>
      ) : null}
    </Empty>
  );
}

function statusLine(availability: GoatBotAvailability): string {
  switch (availability.kind) {
    case "ready":
      return "Answers here, works in its own threads";
    case "connecting":
      return "Connecting…";
    case "offline":
    case "home_offline":
      return "Offline";
    case "legacy_active":
      return "Waiting for the global agent";
    case "error":
      return "Couldn't connect";
    case "unsupported":
      return "Not available on this server";
  }
}

function GoatBotNotice({
  availability,
  homeMove,
  onRetryAvailability,
  legacyAgentRoute,
  onSelectExample,
}: {
  readonly availability: GoatBotAvailability;
  readonly onRetryAvailability: (() => void) | undefined;
  readonly legacyAgentRoute: GlobalAgentLegacyRoute | null;
  readonly homeMove?: GoatBotChatViewProps["homeMove"];
  readonly onSelectExample?: ((text: string) => void) | undefined;
}) {
  const member = useGoatBotMember();
  const avatar = useGoatBotAvatar();
  const openName = useGoatBotName();
  const mainName = useGoatBotMainName();
  const copy = noticeCopy(availability, mainName, openName);
  // A member introduces itself by its own name and purpose.
  const { title, description, retryLabel } =
    member !== null && availability.kind === "ready"
      ? {
          ...copy,
          title: member.name,
          description: member.purpose || "It answers here and does the work in its own threads.",
        }
      : copy;
  const actions: ReactNode[] = [];
  if (availability.kind === "home_offline" && homeMove)
    actions.push(
      <Button
        key="move"
        size="sm"
        variant="outline"
        disabled={homeMove.busy}
        onClick={homeMove.onMove}
      >
        Move {mainName} to {homeMove.label}
      </Button>,
    );
  if (retryLabel !== null && onRetryAvailability !== undefined) {
    actions.push(
      <Button key="retry" size="sm" variant="outline" onClick={onRetryAvailability}>
        {retryLabel}
      </Button>,
    );
  }
  if (legacyAgentRoute !== null && availability.kind !== "ready") {
    actions.push(
      <Button
        key="legacy"
        size="sm"
        variant="outline"
        render={
          legacyAgentRoute.kind === "thread" ? (
            <Link
              to="/$environmentId/$threadId"
              params={{
                environmentId: legacyAgentRoute.environmentId,
                threadId: legacyAgentRoute.threadId,
              }}
            />
          ) : (
            <Link to="/draft/$draftId" params={{ draftId: legacyAgentRoute.draftId }} />
          )
        }
      >
        Open global agent
      </Button>,
    );
  }
  return (
    <Empty size="compact" className="min-h-0 flex-1">
      <EmptyHeader className="max-w-md">
        <GoatBotAvatar size="lg" emoji={avatar} className="mx-auto mb-4" />
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {/* The examples are coding requests for the main bot; a member's purpose says what it does. */}
      {availability.kind === "ready" && onSelectExample && member === null ? (
        <EmptyContent>
          <div className="flex flex-col items-center gap-2">
            {EXAMPLES.map((example) => (
              <button
                key={example}
                type="button"
                className="rounded-full border border-border bg-transparent px-3 py-1.5 text-sm hover:bg-accent"
                onClick={() => onSelectExample(example)}
              >
                {example}
              </button>
            ))}
          </div>
        </EmptyContent>
      ) : null}
      {actions.length > 0 ? (
        <EmptyContent>
          <div className="flex flex-wrap justify-center gap-2">{actions}</div>
        </EmptyContent>
      ) : null}
    </Empty>
  );
}

function noticeCopy(
  availability: GoatBotAvailability,
  mainName: string,
  openName: string,
): {
  title: string;
  description: string;
  retryLabel: string | null;
} {
  switch (availability.kind) {
    case "ready":
      return {
        title: mainName,
        description: "Text it like a person. It answers here and does the work in its own threads.",
        retryLabel: null,
      };
    case "connecting":
      return {
        title: `Connecting to ${mainName}…`,
        description: "This takes a moment.",
        retryLabel: null,
      };
    case "home_offline":
      return {
        title: `Waiting for ${mainName}'s computer`,
        description: offlineHomeCopy(availability, mainName),
        retryLabel: null,
      };
    case "offline":
      return {
        title: `${mainName}'s computer is offline`,
        description: "You can send messages again once it reconnects.",
        retryLabel: null,
      };
    case "legacy_active":
      return {
        title: "Your global agent is still working",
        description:
          "This becomes GOAT Bot when it finishes. Its history stays in the global agent.",
        retryLabel: "Check again",
      };
    case "error":
      return {
        title: `Couldn't reach ${openName}`,
        description: availability.message ?? `Couldn't reach ${openName}`,
        retryLabel: "Try again",
      };
    case "unsupported":
      return {
        title: "GOAT Bot isn't available here yet",
        description: `This server doesn't support GOAT Bot. Update ${APP_DISPLAY_NAME} on the server to chat with it.`,
        retryLabel: null,
      };
  }
}

function offlineHomeCopy(
  availability: Extract<GoatBotAvailability, { kind: "home_offline" }>,
  mainName: string,
) {
  return availability.known
    ? `${mainName} runs on ${availability.label}, which isn't connected.`
    : `${mainName}'s home (${availability.label}) isn't a computer this app knows.`;
}
