import type { GoatBotRow } from "@goat/client-runtime/goatBot";
import { Link } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";

import { APP_DISPLAY_NAME } from "~/branding";
import { isElectron } from "~/env";
import { ChevronRightIcon } from "~/components/solar";
import { GOAT_BOT_PATH, type GlobalAgentLegacyRoute } from "~/globalAgentRoute";

import { Button } from "../ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { GoatBotAvatar } from "./GoatBotAvatar";
import { GoatBotComposer } from "./GoatBotComposer";
import { GoatBotModeButton } from "./GoatBotModeButton";
import { GoatBotModelPicker } from "./GoatBotModelPicker";
import { GoatBotTimeline } from "./GoatBotTimeline";
import {
  canSendToGoatBot,
  type GoatBotAvailability,
  type GoatBotRemoval,
} from "@goat/client-runtime/goatBot";

const GOAT_BOT_TITLE = "GOAT Bot";
const EXAMPLES = [
  "Fix the flaky test in my project",
  "Review the latest changes",
  "How is the work going?",
] as const;

export interface GoatBotChatViewProps {
  readonly homeMove?:
    | { readonly label: string; readonly busy: boolean; readonly onMove: () => void }
    | undefined;
  readonly homeMoveError?: string | null | undefined;
  readonly availability: GoatBotAvailability;
  readonly canOperate: boolean;
  readonly rows: ReadonlyArray<GoatBotRow>;
  /** When GOAT Bot started reading a message it is still answering. */
  readonly replyingSince?: string | null | undefined;
  readonly onSend: (text: string) => void;
  readonly onRetryInput: (clientKey: string) => void;
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
  /** Only offer navigation when this connection confirmed a different bot chat. */
  readonly canOpenCurrentBot?: boolean | undefined;
}

/** GOAT Bot as a messenger: bubbles and work cards, never tool calls. */
export function GoatBotChatView({
  availability,
  homeMove,
  homeMoveError,
  canOperate,
  rows,
  replyingSince = null,
  onSend,
  onRetryInput,
  onRetryAvailability,
  legacyAgentRoute,
  removal = null,
  canOpenCurrentBot = false,
  onUnarchive,
  onCheckAgain,
}: GoatBotChatViewProps) {
  const removed = removal !== null;
  const ready = availability.kind === "ready" && !removed;
  const canSend = !removed && canSendToGoatBot(availability, canOperate);
  const [seed, setSeed] = useState<{ text: string; nonce: number } | null>(null);
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
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <WorkspacePageHeader electron={isElectron} className="surface-glass relative">
        {/* Equal sides center the title until the controls, which never shrink, need its space. */}
        <div aria-hidden className="flex-1 basis-0" />
        <div className="flex max-w-[60%] min-w-0 items-center gap-2">
          <GoatBotAvatar size="md" />
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="goat-name-capsule truncate text-foreground">
              {GOAT_BOT_TITLE} <ChevronRightIcon aria-hidden className="size-3" />
            </h1>
            {headerStatus ? (
              <p className="truncate text-2xs text-muted-foreground">{headerStatus}</p>
            ) : null}
          </div>
        </div>
        <div className="flex min-w-max flex-1 basis-0 items-center justify-end gap-1">
          <GoatBotModelPicker />
          <GoatBotModeButton to="thread" />
        </div>
      </WorkspacePageHeader>
      {availability.kind === "offline" ||
      availability.kind === "home_offline" ||
      availability.kind === "connecting" ? (
        <div
          role="status"
          className="border-b border-border px-4 py-2 text-sm text-muted-foreground"
        >
          {availability.kind === "home_offline"
            ? offlineHomeCopy(availability)
            : availability.kind === "offline"
              ? "GOAT Bot's computer is offline. You can send messages again once it reconnects."
              : "Connecting to GOAT Bot…"}
          {/* With no history the notice below carries the same action. */}
          {availability.kind === "home_offline" && homeMove && rows.length > 0 ? (
            <div className="mt-2">
              <Button
                size="sm"
                variant="outline"
                disabled={homeMove.busy}
                onClick={homeMove.onMove}
              >
                Move GOAT Bot to {homeMove.label}
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
      {rows.length > 0 ? (
        // History stays readable while the bot is unavailable; only sending stops.
        <GoatBotTimeline
          rows={rows}
          replyingSince={removed ? null : replyingSince}
          onRetry={onRetryInput}
          onPick={canSend ? onSend : undefined}
        />
      ) : removal !== null ? (
        <GoatBotRemovedNotice
          removal={removal}
          availability={availability}
          onRetryAvailability={onRetryAvailability}
          canOpenCurrentBot={canOpenCurrentBot}
          onUnarchive={onUnarchive}
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
              ? (text) => setSeed((previous) => ({ text, nonce: (previous?.nonce ?? 0) + 1 }))
              : undefined
          }
        />
      )}
      {ready && !canOperate ? (
        <p className="mx-auto w-full max-w-3xl px-4 pb-2 text-xs text-muted-foreground">
          You can read this chat but can't send messages.
        </p>
      ) : null}
      <GoatBotComposer
        key={seed?.nonce ?? 0}
        initialText={seed?.text ?? ""}
        disabled={!canSend}
        placeholder={canSend ? "Message GOAT Bot" : "GOAT Bot isn't available"}
        onSend={onSend}
      />
    </div>
  );
}

function GoatBotRemovedNotice({
  removal,
  availability,
  onRetryAvailability,
  canOpenCurrentBot,
  onUnarchive,
  onCheckAgain,
}: {
  readonly removal: Exclude<GoatBotRemoval, null>;
  readonly availability: GoatBotAvailability;
  readonly onRetryAvailability: (() => void) | undefined;
  readonly canOpenCurrentBot: boolean;
  readonly onUnarchive: (() => void) | undefined;
  readonly onCheckAgain: (() => void) | undefined;
}) {
  if (removal === "unchecked") {
    return (
      <Empty className="min-h-0 flex-1">
        <EmptyHeader className="max-w-md">
          <GoatBotAvatar size="lg" className="mx-auto mb-4" />
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
    ? "GOAT Bot keeps going in its current chat."
    : removal === "archived"
      ? "Unarchive it to keep chatting with GOAT Bot here."
      : replacementFailed
        ? "Couldn't start a new GOAT Bot chat."
        : availability.kind === "connecting"
          ? "GOAT Bot is starting a new chat."
          : "Reconnect to start a new GOAT Bot chat.";
  return (
    <Empty className="min-h-0 flex-1">
      <EmptyHeader className="max-w-md">
        <GoatBotAvatar size="lg" className="mx-auto mb-4" />
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
  const { title, description, retryLabel } = noticeCopy(availability);
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
        Move GOAT Bot to {homeMove.label}
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
        <GoatBotAvatar size="lg" className="mx-auto mb-4" />
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {availability.kind === "ready" && onSelectExample ? (
        <EmptyContent>
          <div className="flex flex-col items-start gap-2 text-left">
            {EXAMPLES.map((example) => (
              <button
                key={example}
                type="button"
                className="rounded-full border border-border bg-transparent px-3 py-1.5 text-sm hover:bg-goat-bubble-in"
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

function noticeCopy(availability: GoatBotAvailability): {
  title: string;
  description: string;
  retryLabel: string | null;
} {
  switch (availability.kind) {
    case "ready":
      return {
        title: "GOAT Bot",
        description: "Text it like a person. It answers here and does the work in its own threads.",
        retryLabel: null,
      };
    case "connecting":
      return {
        title: "Connecting to GOAT Bot…",
        description: "This takes a moment.",
        retryLabel: null,
      };
    case "home_offline":
      return {
        title: "Waiting for GOAT Bot's computer",
        description: offlineHomeCopy(availability),
        retryLabel: null,
      };
    case "offline":
      return {
        title: "GOAT Bot's computer is offline",
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
        title: "Couldn't reach GOAT Bot",
        description: availability.message,
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

function offlineHomeCopy(availability: Extract<GoatBotAvailability, { kind: "home_offline" }>) {
  return availability.known
    ? `GOAT Bot runs on ${availability.label}, which isn't connected.`
    : `GOAT Bot's home (${availability.label}) isn't a computer this app knows.`;
}
