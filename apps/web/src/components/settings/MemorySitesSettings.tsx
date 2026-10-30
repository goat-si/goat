import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { type EnvironmentId, type SiteNoteListEntry } from "@goat/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useContext, useEffect, useState } from "react";
import { memoryEnvironment } from "../../state/memory";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { validateMemorySettingsSearch } from "./MemorySettings.logic";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const size = (text: string) => new TextEncoder().encode(text).length;

export function MemorySitesSettings({ environmentId, canRead }: { environmentId: EnvironmentId; canRead: boolean }) {
  const registry = useContext(RegistryContext);
  const navigate = useNavigate();
  const canWrite = useAtomValue(memoryEnvironment.siteNotesWrite.permissionAtom(environmentId));
  const [notes, setNotes] = useState<readonly SiteNoteListEntry[]>([]);
  const [reload, setReload] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [origin, setOrigin] = useState("");
  const [text, setText] = useState("");
  // oxlint-disable-next-line goat/react-effect-budget -- Load site notes for the selected connection and after a mutation.
  useEffect(() => {
    if (!canRead) return;
    let active = true;
    void memoryEnvironment.siteNotesList.run(registry, { environmentId, input: {} }).then((result) => {
      if (!active) return;
      if (result._tag === "Success") { setNotes(result.value); setError(null); }
      else setError("Could not load site notes.");
    });
    return () => { active = false; };
  }, [canRead, environmentId, registry, reload]);
  const save = async (noteOrigin: string, noteText: string) => {
    setBusy(true);
    const result = await memoryEnvironment.siteNotesWrite.run(registry, { environmentId, input: { origin: noteOrigin, text: noteText } });
    setBusy(false);
    if (result._tag === "Success") { setError(null); setReload((n) => n + 1); return true; }
    setError("Could not save the site note. Check the origin, size, and contents.");
    return false;
  };
  const change = async (kind: "delete" | "restore", noteOrigin: string) => {
    setBusy(true);
    const command = kind === "delete" ? memoryEnvironment.siteNotesDelete : memoryEnvironment.siteNotesRestoreSeed;
    const result = await command.run(registry, { environmentId, input: { origin: noteOrigin } });
    setBusy(false);
    if (result._tag === "Success") { setError(null); setReload((n) => n + 1); }
    else setError("Could not update the site note.");
  };
  return <SettingsSection title="Site notes" headerAction={<Button size="sm" variant="outline" onClick={() => void navigate({ to: "/settings/memory", search: validateMemorySettingsSearch({ environmentId }) })}>Back to Memory</Button>}>
    {!canRead ? <SettingsRow title="Memory read permission required" /> : <>
      {error ? <SettingsRow title={<span role="alert">{error}</span>} /> : null}
      {notes.map((note) => <SiteNoteRow key={note.origin} note={note} disabled={!canWrite || busy} save={save} change={change} />)}
      <SettingsRow title="Add a site note" description="Enter an HTTP or HTTPS origin and a short note.">
        <div className="space-y-2">
          <Input aria-label="Site origin" value={origin} onChange={(event) => setOrigin(event.target.value)} placeholder="https://example.com" />
          <Textarea aria-label="Site note" value={text} onChange={(event) => setText(event.target.value)} />
          <span>{size(text)} / 1024 bytes</span>{" "}
          <Button size="sm" disabled={!canWrite || busy || !origin || size(text) > 1024} onClick={() => void save(origin, text).then((ok) => { if (ok) { setOrigin(""); setText(""); } })}>Save</Button>
        </div>
      </SettingsRow>
    </>}
  </SettingsSection>;
}

function SiteNoteRow({ note, disabled, save, change }: { note: SiteNoteListEntry; disabled: boolean; save: (origin: string, text: string) => Promise<boolean>; change: (kind: "delete" | "restore", origin: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.text);
  return <SettingsRow title={note.origin} description={note.hidden ? "Default hidden" : `${note.author}${note.seed ? " · default available" : ""}`}>
    {editing ? <div className="space-y-2"><Textarea aria-label={`Note for ${note.origin}`} value={draft} onChange={(event) => setDraft(event.target.value)} /><span>{size(draft)} / 1024 bytes</span>{" "}<Button size="sm" disabled={disabled || size(draft) > 1024} onClick={() => void save(note.origin, draft).then((ok) => { if (ok) setEditing(false); })}>Save</Button>{" "}<Button size="sm" variant="outline" onClick={() => setEditing(false)}>Cancel</Button></div> : <>
      {!note.hidden ? <p>{note.text}</p> : null}
      {!note.hidden ? <><Button size="sm" variant="outline" disabled={disabled} onClick={() => { setDraft(note.text); setEditing(true); }}>Edit</Button>{" "}<Button size="sm" variant="outline" disabled={disabled} onClick={() => void change("delete", note.origin)}>Delete</Button>{" "}</> : null}
      {note.seed && (note.hidden || note.author !== "seed") ? <Button size="sm" variant="outline" disabled={disabled} onClick={() => void change("restore", note.origin)}>Restore default</Button> : null}
    </>}
  </SettingsRow>;
}
