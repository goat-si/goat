import { ArrowUpIcon } from "~/components/solar";
import { type FormEvent, type KeyboardEvent, useState } from "react";

import { cn } from "~/lib/utils";

/**
 * GOAT Bot's message box. It clears as soon as a message is handed off, so a
 * double Enter cannot send the same message twice. Work in progress never
 * blocks it: the bot takes new messages while workers run. The box starts one
 * line tall and grows with its text up to a cap, with the send button inside
 * it, so nothing shifts or resizes by hand.
 */
export function GoatBotComposer({
  disabled,
  placeholder,
  initialText = "",
  onSend,
}: {
  readonly disabled: boolean;
  readonly placeholder: string;
  readonly initialText?: string;
  readonly onSend: (text: string) => void;
}) {
  const [text, setText] = useState(initialText);
  const trimmed = text.trim();
  const submit = () => {
    if (disabled || trimmed.length === 0) return;
    onSend(trimmed);
    setText("");
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

  return (
    <form onSubmit={handleSubmit} className="mx-auto w-full max-w-3xl shrink-0 px-4 pb-4">
      <div
        className={cn(
          "goat-composer-field flex items-end gap-2 py-1 pr-1 pl-3.5",
          disabled && "opacity-64",
        )}
      >
        <textarea
          rows={1}
          aria-label="Message GOAT Bot"
          placeholder={placeholder}
          value={text}
          disabled={disabled}
          onChange={(event) => setText(event.currentTarget.value)}
          onKeyDown={handleKeyDown}
          className="field-sizing-content max-h-48 min-h-7 flex-1 resize-none self-center bg-transparent py-1 font-(family-name:--font-composer,var(--font-sans)) text-(length:--font-size-prompt,var(--text-sm)) text-foreground outline-none placeholder:text-muted-foreground max-sm:pointer-coarse:text-(length:--font-size-prompt-touch)"
        />
        <button
          type="submit"
          aria-label="Send"
          disabled={disabled || trimmed.length === 0}
          className={cn(
            "goat-bubble-out-fill flex size-7 shrink-0 items-center justify-center rounded-full text-goat-bubble-out-foreground",
            trimmed.length === 0 && "invisible",
          )}
        >
          <ArrowUpIcon className="size-4" />
        </button>
      </div>
    </form>
  );
}
