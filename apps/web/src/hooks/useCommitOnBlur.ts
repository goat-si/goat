import { type ChangeEvent, type KeyboardEvent, useState } from "react";

/**
 * Buffer text input locally so keystrokes don't cause a settings-wide
 * re-render (and optionally a server RPC round-trip) on every character.
 * Edited drafts commit on blur and, for single-line inputs, on Enter.
 *
 * The draft resynchronizes from the upstream `value` only when the input
 * is not focused, so an external push (e.g. an optimistic settings
 * update from the user's own commit, or a reset to defaults) doesn't
 * clobber an in-progress edit.
 *
 * Returns a bag of props that should be spread onto an `<Input>`:
 *
 *   const bag = useCommitOnBlur(instance.displayName ?? "", (next) => {...});
 *   <Input {...bag} placeholder="e.g. Work" />
 */
export function useCommitOnBlur(
  value: string,
  onCommit: (next: string) => void,
  {
    multiline = false,
    commitUnchanged = false,
  }: {
    multiline?: boolean;
    /** Mixed fields can explicitly clear all targets even when their placeholder value is empty. */
    commitUnchanged?: boolean;
  } = {},
) {
  const [draft, setDraft] = useState<{ value: string; edited: boolean } | null>(null);

  return {
    value: draft?.value ?? value,
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setDraft({ value: event.target.value, edited: true });
    },
    onFocus: () => {
      setDraft({ value, edited: false });
    },
    onBlur: () => {
      const next = draft?.value ?? value;
      setDraft(null);
      if (draft?.edited && (commitUnchanged || next !== value)) {
        onCommit(next);
      }
    },
    onKeyDown: (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (!multiline && event.key === "Enter") {
        event.preventDefault();
        (event.target as HTMLInputElement | HTMLTextAreaElement).blur();
      }
    },
  };
}
