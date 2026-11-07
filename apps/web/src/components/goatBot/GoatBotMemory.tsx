import {
  botNotesFailure,
  changeNoteDraft,
  forgetNoteDraft,
  GOAT_BOT_NOTES_COPY,
  GOAT_BOT_NOTES_SHARED_COPY,
  noteDateLabel,
} from "@goat/client-runtime/goatBot";
import type { ChannelBotNote, EnvironmentId } from "@goat/contracts";
import { useEffect, useId, useState } from "react";
import { channelEnvironment } from "~/state/channels";
import { useServerConfigs } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { useGoatBotMember } from "./goatBotMemberContext";

/** GOAT Bot's notes, read only; changing or forgetting one is a message the person sends. */
export function GoatBotMemory({
  environmentId,
  onDraft,
  refreshKey = null,
}: {
  environmentId: EnvironmentId;
  /** Puts a message in the chat's composer; absent while the chat cannot send. */
  onDraft?: ((text: string) => void) | undefined;
  /** Changes when the bot answers or a task moves on, which may have changed the notes. */
  refreshKey?: string | null | undefined;
}) {
  const member = useGoatBotMember();
  const supported =
    useServerConfigs().get(environmentId)?.environment.capabilities.goatBotNotes === true;
  const notes = useEnvironmentQuery(
    supported ? channelEnvironment.listBotNotes({ environmentId, input: {} }) : null,
  );
  const refresh = notes.refresh;
  // Null while there is nothing to read; otherwise the latest answer or task change.
  const trigger = supported ? (refreshKey ?? "") : null;
  // oxlint-disable-next-line goat/react-effect-budget -- The notes file lives on the server: read it again when the tab opens and after each answer, since a task may have changed it.
  useEffect(() => {
    if (trigger !== null) refresh();
  }, [trigger, refresh]);
  const failure = notes.failure === null ? null : botNotesFailure(notes.failure);
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">{GOAT_BOT_NOTES_COPY}</p>
      {member !== null && (
        <p className="text-xs text-muted-foreground">{GOAT_BOT_NOTES_SHARED_COPY}</p>
      )}
      {!supported ? (
        <p>Notes need a newer GOAT server.</p>
      ) : failure !== null ? (
        <div className="space-y-2">
          <p>{failure.message}</p>
          {failure.retry && (
            <Button size="xs" variant="outline" onClick={refresh}>
              Try again
            </Button>
          )}
        </div>
      ) : notes.data === null ? (
        <p className="text-muted-foreground">Loading notes…</p>
      ) : notes.data.notes.length === 0 ? (
        <p>No notes yet. Ask GOAT Bot to remember a standing rule.</p>
      ) : (
        <>
          {notes.data.truncated && (
            <p className="text-xs text-muted-foreground">Showing the newest notes only.</p>
          )}
          <ul className="space-y-3">
            {notes.data.notes.map((note) => (
              <NoteRow key={note.index} note={note} onDraft={onDraft} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function NoteRow({
  note,
  onDraft,
}: {
  note: ChannelBotNote;
  onDraft: ((text: string) => void) | undefined;
}) {
  const [wording, setWording] = useState<string | null>(null);
  const textId = useId();
  const draft = wording === null ? null : changeNoteDraft(note, wording);
  return (
    <li className="space-y-1 border-b border-border pb-3" aria-describedby={textId}>
      <p className="text-xs text-muted-foreground">{noteDateLabel(note.date)}</p>
      <p id={textId} className="whitespace-pre-wrap">
        {note.text}
      </p>
      {wording === null ? (
        <div className="flex gap-1">
          <Button
            size="xs"
            variant="ghost"
            disabled={onDraft === undefined}
            onClick={() => setWording(note.text)}
          >
            Ask to change
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={onDraft === undefined}
            onClick={() => onDraft?.(forgetNoteDraft(note))}
          >
            Ask to forget
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          <Textarea
            size="sm"
            aria-label="New wording"
            value={wording}
            onChange={(event) => setWording(event.currentTarget.value)}
          />
          <div className="flex gap-1">
            <Button
              size="xs"
              disabled={draft === null || onDraft === undefined}
              onClick={() => {
                if (draft === null) return;
                onDraft?.(draft);
                setWording(null);
              }}
            >
              Fill message
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setWording(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}
