import { ArrowUpIcon } from "lucide-react";
import { type FormEvent, type KeyboardEvent, useState } from "react";

import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";

/**
 * GOAT Bot's message box. It clears as soon as a message is handed off, so a
 * double Enter cannot send the same message twice. Work in progress never
 * blocks it: the bot takes new messages while workers run.
 */
export function GoatBotComposer({
  disabled,
  placeholder,
  onSend,
}: {
  readonly disabled: boolean;
  readonly placeholder: string;
  readonly onSend: (text: string) => void;
}) {
  const [text, setText] = useState("");
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
    <form
      onSubmit={handleSubmit}
      className="mx-auto flex w-full max-w-3xl items-end gap-2 px-4 pb-4"
    >
      <Textarea
        size="sm"
        aria-label="Message GOAT Bot"
        placeholder={placeholder}
        value={text}
        disabled={disabled}
        onChange={(event) => setText(event.currentTarget.value)}
        onKeyDown={handleKeyDown}
      />
      <Button
        type="submit"
        size="icon"
        aria-label="Send"
        disabled={disabled || trimmed.length === 0}
      >
        <ArrowUpIcon />
      </Button>
    </form>
  );
}
