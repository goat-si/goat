import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, SiteNoteListEntry } from "@goat/contracts";
import { useContext, useEffect, useState } from "react";
import { memoryEnvironment } from "../../state/memory";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const NOTE_LIMIT_BYTES = 1024;
const size = (text: string) => new TextEncoder().encode(text).length;

type Setters = {
  readonly setNotes: (notes: ReadonlyArray<SiteNoteListEntry>) => void;
  readonly setError: (error: string | null) => void;
};

const loadNotes = (
  registry: Parameters<typeof memoryEnvironment.siteNotesList.run>[0],
  environmentId: EnvironmentId,
  { setNotes, setError }: Setters,
  isCurrent: () => boolean = () => true,
) =>
  memoryEnvironment.siteNotesList.run(registry, { environmentId, input: {} }).then((result) => {
    if (!isCurrent()) return;
    if (result._tag === "Success") {
      setNotes(result.value);
      setError(null);
    } else setError("Could not load site notes.");
  });

/** Site notes agents receive the first time a thread opens each site. */
export function MemorySitesSettings({ environmentId }: { environmentId: EnvironmentId }) {
  const registry = useContext(RegistryContext);
  const canRead = useAtomValue(memoryEnvironment.siteNotesList.permissionAtom(environmentId));
  const canWrite = useAtomValue(memoryEnvironment.siteNotesWrite.permissionAtom(environmentId));
  const [notes, setNotes] = useState<ReadonlyArray<SiteNoteListEntry>>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [origin, setOrigin] = useState("");
  const [text, setText] = useState("");
  // oxlint-disable-next-line goat/react-effect-budget -- Loads the selected connection's site notes from the server.
  useEffect(() => {
    if (!canRead) return;
    let active = true;
    void loadNotes(registry, environmentId, { setNotes, setError }, () => active);
    return () => {
      active = false;
    };
  }, [canRead, environmentId, registry]);
  if (!canRead) return null;
  const reload = () => loadNotes(registry, environmentId, { setNotes, setError });
  const save = async (noteOrigin: string, noteText: string) => {
    setBusy(true);
    const result = await memoryEnvironment.siteNotesWrite.run(registry, {
      environmentId,
      input: { origin: noteOrigin, text: noteText },
    });
    setBusy(false);
    if (result._tag !== "Success") {
      setError("Could not save the site note. Check the site address, its size and its contents.");
      return false;
    }
    await reload();
    return true;
  };
  const change = async (kind: "delete" | "restore", noteOrigin: string) => {
    setBusy(true);
    const command =
      kind === "delete"
        ? memoryEnvironment.siteNotesDelete
        : memoryEnvironment.siteNotesRestoreSeed;
    const result = await command.run(registry, { environmentId, input: { origin: noteOrigin } });
    setBusy(false);
    if (result._tag !== "Success") {
      setError("Could not update the site note.");
      return;
    }
    await reload();
  };
  return (
    <SettingsSection title="Site notes">
      {error ? <SettingsRow title={<span role="alert">{error}</span>} /> : null}
      {notes.map((note) => (
        <SiteNoteRow
          key={note.origin}
          note={note}
          disabled={!canWrite || busy}
          save={save}
          change={change}
        />
      ))}
      <SettingsRow
        title="Add a site note"
        description="Agents receive a site's note the first time a conversation opens that site."
      >
        <div className="space-y-2">
          <Input
            aria-label="Site address"
            value={origin}
            onChange={(event) => setOrigin(event.target.value)}
            placeholder="https://example.com"
          />
          <Textarea
            aria-label="Site note"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <span>
            {size(text)} / {NOTE_LIMIT_BYTES} bytes
          </span>{" "}
          <Button
            size="sm"
            disabled={!canWrite || busy || !origin || size(text) > NOTE_LIMIT_BYTES}
            onClick={() =>
              void save(origin, text).then((ok) => {
                if (!ok) return;
                setOrigin("");
                setText("");
              })
            }
          >
            Save
          </Button>
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}

function SiteNoteRow({
  note,
  disabled,
  save,
  change,
}: {
  readonly note: SiteNoteListEntry;
  readonly disabled: boolean;
  readonly save: (origin: string, text: string) => Promise<boolean>;
  readonly change: (kind: "delete" | "restore", origin: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.text);
  const description = note.hidden
    ? "Default hidden"
    : `${note.author}${note.seed ? " · default available" : ""}`;
  if (editing)
    return (
      <SettingsRow title={note.origin} description={description}>
        <div className="space-y-2">
          <Textarea
            aria-label={`Note for ${note.origin}`}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <span>
            {size(draft)} / {NOTE_LIMIT_BYTES} bytes
          </span>{" "}
          <Button
            size="sm"
            disabled={disabled || size(draft) > NOTE_LIMIT_BYTES}
            onClick={() =>
              void save(note.origin, draft).then((ok) => {
                if (ok) setEditing(false);
              })
            }
          >
            Save
          </Button>{" "}
          <Button size="sm" variant="outline" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </div>
      </SettingsRow>
    );
  return (
    <SettingsRow title={note.origin} description={description}>
      {note.hidden ? null : (
        <>
          <p>{note.text}</p>
          <Button
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => {
              setDraft(note.text);
              setEditing(true);
            }}
          >
            Edit
          </Button>{" "}
          <Button
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => void change("delete", note.origin)}
          >
            Delete
          </Button>{" "}
        </>
      )}
      {note.seed && (note.hidden || note.author !== "seed") ? (
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => void change("restore", note.origin)}
        >
          Restore default
        </Button>
      ) : null}
    </SettingsRow>
  );
}
