import { botProfileChanges, type BotProfileValues } from "@goat/client-runtime/state/channels";
import { useRef, useState, type FormEvent, type ReactNode } from "react";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";

export type GoatBotProfileChanges = Partial<BotProfileValues>;

const NAME_MAX = 64;
const AVATAR_MAX = 16;
const PURPOSE_MAX = 4000;

/** Name, avatar and purpose of a GOAT Bot; `onSubmit` resolves to an error to show, or null. */
export function GoatBotProfileDialog(props: {
  readonly mode: "edit" | "create";
  readonly initial: BotProfileValues;
  readonly canSubmit: boolean;
  readonly onSubmit: (changes: GoatBotProfileChanges) => Promise<string | null>;
  readonly onClose: () => void;
  /** More fields after the profile, such as a new bot's model. */
  readonly children?: ReactNode;
}) {
  const [name, setName] = useState(props.initial.name);
  const [avatar, setAvatar] = useState(props.initial.avatar ?? "");
  const [purpose, setPurpose] = useState(props.initial.purpose);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blankName = name.trim() === "";
  // A missing name is pointed out once the person leaves the field or saves, not while they start.
  const [nameChecked, setNameChecked] = useState(false);
  const nameMissing = blankName && nameChecked;
  const nameRef = useRef<HTMLInputElement>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !props.canSubmit) return;
    if (blankName) {
      setNameChecked(true);
      nameRef.current?.focus();
      return;
    }
    const changes = botProfileChanges(props.mode, props.initial, { name, avatar, purpose });
    if (Object.keys(changes).length === 0) return props.onClose();
    setBusy(true);
    setError(null);
    const failure = await props.onSubmit(changes);
    setBusy(false);
    if (failure === null) props.onClose();
    else setError(failure);
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) props.onClose();
      }}
    >
      <DialogPopup showCloseButton={!busy}>
        <form className="contents" onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle>{props.mode === "create" ? "New bot" : "Edit bot"}</DialogTitle>
            <DialogDescription>
              {props.mode === "create"
                ? "The bot gets its own conversation."
                : "Changes reach the bot when it starts its next conversation session."}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <label className="grid gap-1.5 text-sm">
              Name
              <Input
                ref={nameRef}
                value={name}
                maxLength={NAME_MAX}
                disabled={busy}
                aria-invalid={nameMissing}
                onBlur={() => setNameChecked(true)}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label className="grid gap-1.5 text-sm">
              Avatar
              <Input
                value={avatar}
                maxLength={AVATAR_MAX}
                disabled={busy}
                placeholder="An emoji, or empty for the default face"
                onChange={(event) => setAvatar(event.target.value)}
              />
            </label>
            <label className="grid gap-1.5 text-sm">
              Purpose
              <Textarea
                value={purpose}
                maxLength={PURPOSE_MAX}
                disabled={busy}
                placeholder="What should this bot help with?"
                onChange={(event) => setPurpose(event.target.value)}
              />
            </label>
            {props.children}
            {nameMissing ? (
              <p className="text-sm text-muted-foreground">The bot needs a name.</p>
            ) : null}
            {error ? (
              <p role="alert" className="text-sm text-destructive-foreground">
                {error}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={props.onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !props.canSubmit}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
