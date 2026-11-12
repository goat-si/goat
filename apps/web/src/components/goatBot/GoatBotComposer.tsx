import { goatBotPreviewText } from "@goat/client-runtime/goatBot";
import { ArrowUpIcon, FileIcon, XIcon } from "~/components/solar";
import {
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
  type Ref,
  type ReactNode,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

import { cn } from "~/lib/utils";
import { ComposerAttachAction } from "../chat/ComposerAttachAction";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import {
  releaseGoatBotAttachments,
  releaseUnownedGoatBotAttachments,
  retainGoatBotAttachments,
  stageGoatBotFiles,
  type GoatBotAttachmentSupport,
  type GoatBotDraftAttachment,
} from "./goatBotAttachments";
import { HoldsNavigation } from "~/lib/navigationHolds";

export interface GoatBotComposerHandle {
  addFiles(files: File[]): void;
  /**
   * Puts a drafted message in an empty box for the person to finish and send. A box that holds
   * their own text or files is left as it is; returns whether the draft went in.
   */
  offerDraft(text: string): boolean;
  focus(): void;
  /** The message field, for focus that must land after something else closes. */
  field(): HTMLTextAreaElement | null;
}

// Outside the component: React Compiler cannot lower try/finally without catch.
async function settleAfter<T>(work: Promise<T>, settle: (outcome: T | null) => void) {
  let outcome: T | null = null;
  try {
    outcome = await work;
  } finally {
    settle(outcome);
  }
}

/**
 * GOAT Bot's message box. It clears as soon as a message is handed off, so a double Enter
 * cannot send it twice, and running work never blocks it. It grows with its text up to a cap.
 */
export function GoatBotComposer({
  ref,
  disabled,
  botName,
  placeholder,
  initialText = "",
  attachmentSupport = null,
  modelPicker,
  onSend,
  replyTo = null,
  onClearReply,
}: {
  readonly ref?: Ref<GoatBotComposerHandle>;
  readonly disabled: boolean;
  /** The bot this box messages, as its chat names it. */
  readonly botName: string;
  readonly placeholder: string;
  readonly initialText?: string;
  readonly replyTo?: string | null;
  readonly onClearReply?: () => void;
  readonly attachmentSupport?: GoatBotAttachmentSupport | null;
  readonly modelPicker?: ReactNode;
  /** Returns false when the message was not taken, so the draft stays. */
  readonly onSend: (
    text: string,
    attachments: ReadonlyArray<GoatBotDraftAttachment>,
  ) => boolean | void;
}) {
  const [text, setText] = useState(initialText);
  const [attachments, setDraftAttachments] = useState<ReadonlyArray<GoatBotDraftAttachment>>([]);
  // Files handed to the box and still being prepared (an image is compressed first).
  const [staging, setStaging] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const draftRef = useRef(attachments);
  const lifetime = useRef<AbortController | null>(null);
  const setAttachments = (
    update: (
      current: ReadonlyArray<GoatBotDraftAttachment>,
    ) => ReadonlyArray<GoatBotDraftAttachment>,
  ) =>
    setDraftAttachments((current) => {
      const next = update(current);
      draftRef.current = next;
      return next;
    });
  // oxlint-disable-next-line goat/react-effect-budget -- unsent previews are browser object URLs.
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => {
      controller.abort();
      lifetime.current = null;
      releaseGoatBotAttachments(draftRef.current);
    };
  }, [draftRef]);
  const trimmed = text.trim();
  const drafted = trimmed.length > 0 || attachments.length > 0;
  const canSubmit = !disabled && drafted;
  // Leaving the chat would drop any of these, focused or not.
  const holdsNavigation = drafted || staging > 0 || replyTo !== null;
  const submit = () => {
    if (!canSubmit) return;
    if (onSend(trimmed, attachments) === false) return;
    setText("");
    draftRef.current = [];
    setDraftAttachments([]);
    releaseGoatBotAttachments(attachments);
  };
  const addFiles = async (files: ReadonlyArray<File>) => {
    if (attachmentSupport === null || files.length === 0) return false;
    const signal = lifetime.current?.signal;
    if (!signal) return false;
    setStaging((count) => count + 1);
    await settleAfter(
      stageGoatBotFiles(files, {
        existingCount: draftRef.current.length,
        support: attachmentSupport,
        botName,
      }),
      (outcome) => {
        if (outcome !== null && signal.aborted) releaseUnownedGoatBotAttachments(outcome.staged);
        else if (outcome !== null) {
          if (outcome.staged.length > 0) {
            retainGoatBotAttachments(outcome.staged);
            setAttachments((current) => [...current, ...outcome.staged]);
          }
          if (outcome.error !== null) toastManager.add({ type: "error", title: outcome.error });
        }
        // Set in the same block as the attachment, so no commit lacks both the hold and the file.
        setStaging((count) => count - 1);
      },
    );
    return false;
  };
  useImperativeHandle(ref, () => ({
    addFiles(files) {
      void addFiles(files).then(() => textareaRef.current?.focus());
    },
    offerDraft(next) {
      const empty = text.trim() === "" && attachments.length === 0;
      if (empty) setText(next);
      textareaRef.current?.focus();
      return empty;
    },
    focus() {
      textareaRef.current?.focus();
    },
    field: () => textareaRef.current,
  }));
  const remove = (id: string) => {
    releaseGoatBotAttachments(attachments.filter((attachment) => attachment.id === id));
    setAttachments((current) => current.filter((attachment) => attachment.id !== id));
  };
  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    submit();
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape" && replyTo !== null) {
      event.preventDefault();
      onClearReply?.();
      return;
    }
    // Enter sends; Shift+Enter breaks the line; Enter that confirms IME input does neither.
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  };
  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files);
    if (attachmentSupport === null || files.length === 0) return;
    event.preventDefault();
    void addFiles(files);
  };

  return (
    <form onSubmit={handleSubmit} className="mx-auto w-full max-w-3xl shrink-0 px-4 pb-4">
      {holdsNavigation ? <HoldsNavigation /> : null}
      <div className={cn("goat-composer-field flex flex-col py-1 pr-1", disabled && "opacity-64")}>
        {replyTo !== null ? (
          <div className="mx-2 mt-1 flex min-w-0 items-center gap-1 rounded-md border border-border ps-2 text-xs text-muted-foreground">
            <span className="min-w-0 flex-1 truncate">{goatBotPreviewText(replyTo)}</span>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Clear reply"
              onClick={onClearReply}
            >
              <XIcon />
            </Button>
          </div>
        ) : null}
        {attachments.length > 0 ? (
          <ul aria-label="Attachments" className="flex flex-wrap gap-1.5 pt-1.5 pb-1 pl-2">
            {attachments.map((attachment) => (
              <li
                key={attachment.id}
                className="flex h-9 max-w-48 items-center gap-1.5 rounded-lg border border-border bg-background/60 pr-1 pl-1"
              >
                {attachment.type === "image" ? (
                  <img
                    src={attachment.previewUrl}
                    alt=""
                    className="size-7 shrink-0 rounded-md object-cover"
                  />
                ) : (
                  <FileIcon className="size-4 shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0 truncate text-xs">{attachment.name}</span>
                <button
                  type="button"
                  aria-label={`Remove ${attachment.name}`}
                  onClick={() => remove(attachment.id)}
                  className="flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <XIcon className="size-3" />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="flex flex-wrap items-end gap-2 pl-1">
          <textarea
            ref={textareaRef}
            rows={1}
            data-goat-bot-composer=""
            aria-label={`Message ${botName}`}
            placeholder={replyTo !== null ? "Reply…" : placeholder}
            value={text}
            disabled={disabled}
            onChange={(event) => setText(event.currentTarget.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            className="field-sizing-content order-first max-h-48 min-h-7 w-full resize-none self-center bg-transparent px-2 py-1 sm:order-none sm:w-auto sm:min-w-0 sm:flex-1 font-(family-name:--font-composer,var(--font-sans)) text-(length:--font-size-prompt,var(--text-sm)) text-foreground outline-none placeholder:text-muted-foreground max-sm:pointer-coarse:text-(length:--font-size-prompt-touch)"
          />
          {attachmentSupport !== null && !disabled ? (
            <ComposerAttachAction
              addComposerAttachments={addFiles}
              focusComposer={() => textareaRef.current?.focus()}
            />
          ) : null}
          <div className="min-w-0 flex-1 sm:flex-none">{modelPicker}</div>
          <button
            type="submit"
            aria-label="Send"
            disabled={!canSubmit}
            data-accent={canSubmit ? "true" : "false"}
            className={cn(
              "goat-bot-send flex size-7 shrink-0 items-center justify-center rounded-full",
              !drafted && "invisible",
            )}
          >
            <ArrowUpIcon className="size-4" />
          </button>
        </div>
      </div>
    </form>
  );
}
