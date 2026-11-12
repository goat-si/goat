import {
  botNotesFailure,
  changeNoteDraft,
  forgetNoteDraft,
  GOAT_BOT_NOTES_COPY,
  GOAT_BOT_NOTES_SHARED_COPY,
  GOAT_BOT_NOTES_TRUNCATED_COPY,
  type GoatBotNoteHeldBack,
  goatBotNoteHeldBackCopy,
  goatBotNotesHeldBack,
  goatBotNoteSourceLabel,
  goatBotNotesView,
  noteDateLabel,
} from "@goat/client-runtime/goatBot";
import type { ChannelBotNote, EnvironmentId } from "@goat/contracts";
import { useEffect, useId, useState } from "react";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { channelEnvironment } from "~/state/channels";
import { useNowMinute } from "~/hooks/useNowMinute";
import { useServerConfigs } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { useGoatBotMember, useGoatBotName } from "./goatBotMemberContext";
import { GoatBotPanelEmpty } from "./GoatBotPanelEmpty";
import { HoldsNavigation } from "~/lib/navigationHolds";

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
  const botName = useGoatBotName();
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
  const failure = notes.failure === null ? null : botNotesFailure(notes.failure, botName);
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
      ) : (
        <NoteList
          revision={notes.data.revision}
          notes={notes.data.notes}
          truncated={notes.data.truncated}
          onDraft={onDraft}
        />
      )}
    </div>
  );
}

function NoteList({
  revision,
  notes,
  truncated,
  onDraft,
}: {
  revision: string | null;
  notes: ReadonlyArray<ChannelBotNote>;
  truncated: boolean;
  onDraft: ((text: string) => void) | undefined;
}) {
  const botName = useGoatBotName();
  const view = goatBotNotesView({ notes, truncated });
  const heldBack = goatBotNotesHeldBack({ notes, truncated });
  const [showReplaced, setShowReplaced] = useState(false);
  const replacedId = useId();
  // The minute tick is UTC without an offset, and Date.parse reads that form as local time.
  const now = Date.parse(`${useNowMinute()}:00Z`);
  return (
    <>
      {truncated && (
        <p className="text-xs text-muted-foreground">{GOAT_BOT_NOTES_TRUNCATED_COPY}</p>
      )}
      {view.empty === "none" ? (
        <GoatBotPanelEmpty
          title="No notes yet"
          next={`Ask ${botName} to remember a standing rule.`}
        />
      ) : view.empty === "none_in_window" ? (
        <p>No complete note fits in the newest 64 KB of memory.md.</p>
      ) : view.empty === "no_current" ? (
        <p>No current notes.</p>
      ) : (
        <ul className="space-y-3">
          {view.current.map((note) => (
            // An index is a line's place in this read only, so a new read starts every row over.
            <NoteRow
              key={`${revision}:${note.index}`}
              note={note}
              heldBack={heldBack.get(note.index)}
              source={goatBotNoteSourceLabel(note.source, { now })}
              onDraft={onDraft}
            />
          ))}
        </ul>
      )}
      {view.replaced.length > 0 && (
        <>
          <Button
            size="xs"
            variant="ghost"
            aria-expanded={showReplaced}
            aria-controls={replacedId}
            onClick={() => setShowReplaced((value) => !value)}
          >
            {showReplaced ? "Hide replaced notes" : `Show replaced notes (${view.replaced.length})`}
          </Button>
          {showReplaced && (
            <ul id={replacedId} className="space-y-3 text-muted-foreground">
              {view.replaced.map((note) => {
                const replacing = view.replacingText(note);
                const source = goatBotNoteSourceLabel(note.source, { now });
                return (
                  <li
                    key={`${revision}:${note.index}`}
                    className="space-y-1 border-b border-border pb-3"
                  >
                    <p className="text-xs">{noteDateLabel(note)}</p>
                    {source !== null && <p className="text-xs">{source}</p>}
                    <p className="whitespace-pre-wrap">{note.text}</p>
                    <p className="text-xs">
                      {replacing === null
                        ? "Replaced by a later note"
                        : `Replaced by: “${replacing}”`}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </>
  );
}

function NoteRow({
  note,
  heldBack,
  source,
  onDraft,
}: {
  note: ChannelBotNote;
  /** Why a request naming this note by its words could reach another note, if it could. */
  heldBack: GoatBotNoteHeldBack | undefined;
  source: string | null;
  onDraft: ((text: string) => void) | undefined;
}) {
  const [wording, setWording] = useState<string | null>(null);
  const [forgetting, setForgetting] = useState(false);
  const textId = useId();
  const draft = wording === null ? null : changeNoteDraft(note, wording);
  return (
    <li className="space-y-1 border-b border-border pb-3" aria-describedby={textId}>
      <p className="text-xs text-muted-foreground">{noteDateLabel(note)}</p>
      {source !== null && <p className="text-xs text-muted-foreground">{source}</p>}
      <p id={textId} className="whitespace-pre-wrap">
        {note.text}
      </p>
      {note.replaces !== undefined && (
        <p className="text-xs text-muted-foreground">Replaces: “{note.replaces}”</p>
      )}
      {wording === null && forgetting && heldBack !== undefined ? (
        <HeldBackNotice
          reason={heldBack}
          text={note.text}
          copy={note.text}
          copyTarget="note"
          onDiscard={() => setForgetting(false)}
        />
      ) : wording === null ? (
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
            onClick={() =>
              heldBack === undefined ? onDraft?.(forgetNoteDraft(note)) : setForgetting(true)
            }
          >
            Ask to forget
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          <HoldsNavigation />
          <Textarea
            size="sm"
            aria-label="New wording"
            value={wording}
            onChange={(event) => setWording(event.currentTarget.value)}
          />
          {heldBack !== undefined ? (
            <HeldBackNotice
              reason={heldBack}
              text={note.text}
              copy={wording}
              copyTarget="new wording"
              onDiscard={() => setWording(null)}
            />
          ) : (
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
          )}
        </div>
      )}
    </li>
  );
}

/** In place of a request the server could take for another note: copy the words to ask by hand. */
function HeldBackNotice({
  reason,
  text,
  copy,
  copyTarget,
  onDiscard,
}: {
  reason: GoatBotNoteHeldBack;
  text: string;
  copy: string;
  copyTarget: string;
  onDiscard: () => void;
}) {
  const botName = useGoatBotName();
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: copyTarget });
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">
        {goatBotNoteHeldBackCopy(reason, text, botName)}
      </p>
      <div className="flex gap-1">
        <Button size="xs" variant="ghost" onClick={() => copyToClipboard(copy)}>
          {isCopied ? "Copied" : `Copy ${copyTarget}`}
        </Button>
        <Button size="xs" variant="ghost" onClick={onDiscard}>
          Discard
        </Button>
      </div>
    </div>
  );
}
