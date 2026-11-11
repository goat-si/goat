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
import { toastManager } from "../ui/toast";
import {
  releaseGoatBotAttachments,
  releaseUnownedGoatBotAttachments,
  retainGoatBotAttachments,
  stageGoatBotFiles,
  type GoatBotAttachmentSupport,
  type GoatBotDraftAttachment,
} from "./goatBotAttachments";

export interface GoatBotComposerHandle {
  addFiles(files: File[]): void;
  /** Puts a drafted message in the box, keeping staged files; the person still sends it. */
  replaceText(text: string): void;
  focus(): void;
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
}: {
  readonly ref?: Ref<GoatBotComposerHandle>;
  readonly disabled: boolean;
  /** The bot this box messages, as its chat names it. */
  readonly botName: string;
  readonly placeholder: string;
  readonly initialText?: string;
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
  const canSubmit = !disabled && (trimmed.length > 0 || attachments.length > 0);
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
    const { staged, error } = await stageGoatBotFiles(files, {
      existingCount: draftRef.current.length,
      support: attachmentSupport,
      botName,
    });
    if (signal.aborted) {
      releaseUnownedGoatBotAttachments(staged);
      return false;
    }
    if (staged.length > 0) {
      retainGoatBotAttachments(staged);
      setAttachments((current) => [...current, ...staged]);
    }
    if (error !== null) toastManager.add({ type: "error", title: error });
    return false;
  };
  useImperativeHandle(ref, () => ({
    addFiles(files) {
      void addFiles(files).then(() => textareaRef.current?.focus());
    },
    replaceText(next) {
      setText(next);
      textareaRef.current?.focus();
    },
    focus() {
      textareaRef.current?.focus();
    },
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
      <div className={cn("goat-composer-field flex flex-col py-1 pr-1", disabled && "opacity-64")}>
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
            placeholder={placeholder}
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
            className={cn(
              "flex size-7 shrink-0 items-center justify-center rounded-full bg-goat-person-message text-goat-person-message-foreground",
              trimmed.length === 0 && attachments.length === 0 && "invisible",
            )}
          >
            <ArrowUpIcon className="size-4" />
          </button>
        </div>
      </div>
    </form>
  );
}
