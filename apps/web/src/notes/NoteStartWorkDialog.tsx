import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ModelSelection } from "@goat/contracts";
import { useState, useSyncExternalStore } from "react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "../components/ui/dialog";
import { randomUUID } from "../lib/utils";
import { useStableCallback } from "../hooks/useStableCallback";
import { useEnvironmentQuery } from "../state/query";
import { notesQueries, notesRpc } from "../rpc/notes/atoms";
import { NoteChoice } from "./NoteControls";
import { NoteWorkSession } from "./noteWork";
import { NoteModelPicker } from "./NoteModelPicker";
import { useNoteCommand } from "./useNoteCommand";

export function NoteStartWorkDialog(props: {
  environmentId: EnvironmentId;
  path: string;
  onClose: () => void;
}) {
  const canStart = useAtomValue(notesRpc.startWork.permissionAtom(props.environmentId));
  const startCommand = useNoteCommand(notesRpc.startWork);
  const [node, setNode] = useState("hub");
  const [project, setProject] = useState("");
  const [workspace, setWorkspace] = useState("root");
  const [baseRef, setBaseRef] = useState("HEAD");
  const [branch, setBranch] = useState("");
  const [modelSelection, setModelSelection] = useState<ModelSelection | undefined>();
  const startCurrent = useStableCallback((input: Parameters<typeof startCommand>[0]["input"]) =>
    startCommand({ environmentId: props.environmentId, input }),
  );
  const [session] = useState(() => new NoteWorkSession(randomUUID(), startCurrent));
  const launch = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const { busy, ambiguous, input: attempt } = launch;
  const targetsQuery = useEnvironmentQuery(
    notesQueries.workTargets({ environmentId: props.environmentId, input: {} }),
  );
  const projectsQuery = useEnvironmentQuery(
    node === "hub"
      ? null
      : notesQueries.workTargetProjects({
          environmentId: props.environmentId,
          input: { host: node.slice(5) },
        }),
  );
  const targets = targetsQuery.data;
  const projects = projectsQuery.data;
  const error = launch.error ?? targetsQuery.error ?? projectsQuery.error;
  const options =
    node === "hub"
      ? (targets?.hub.projects ?? []).map((item) => ({ value: item.projectId, label: item.title }))
      : (projects?.projects ?? []).map((item) => ({ value: item.path, label: item.title }));
  const selectedProject = project || options[0]?.value || "";
  async function start() {
    if (busy || ambiguous || !canStart || !selectedProject) return;
    const hubProject = targets?.hub.projects.find((item) => item.projectId === selectedProject);
    const result = await session.launch({
      path: props.path,
      target:
        node === "hub" && hubProject
          ? { type: "hub", projectId: hubProject.projectId }
          : { type: "host", host: node.slice(5), projectPath: selectedProject },
      workspace:
        workspace === "root"
          ? { type: "root" }
          : {
              type: "worktree",
              baseRef: baseRef.trim(),
              ...(branch.trim() ? { branch: branch.trim() } : {}),
            },
      ...(modelSelection ? { modelSelection } : {}),
    });
    if (result?.ok) props.onClose();
  }
  function startAgain() {
    session.startAgain(randomUUID());
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) props.onClose();
      }}
    >
      <DialogPopup showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>Start work from this note</DialogTitle>
          <DialogDescription>
            The thread receives this note and reports its result back here.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <NoteChoice
            label="Node"
            value={node}
            disabled={busy || attempt !== null}
            options={[
              { value: "hub", label: "This hub" },
              ...(targets?.hosts ?? []).map((host) => ({
                value: `host:${host.host}`,
                label: host.label,
              })),
            ]}
            onChange={(value) => {
              setNode(value);
              setProject("");
            }}
          />
          <NoteChoice
            label="Project"
            value={selectedProject}
            disabled={busy || attempt !== null || options.length === 0}
            options={options}
            onChange={setProject}
          />
          {targets && options.length === 0 && (
            <p className="text-sm text-muted-foreground">No projects available on this node.</p>
          )}
          <NoteModelPicker
            environmentId={props.environmentId}
            value={modelSelection}
            onChange={setModelSelection}
            disabled={busy || attempt !== null}
          />
          <NoteChoice
            label="Workspace"
            value={workspace}
            disabled={busy || attempt !== null}
            options={[
              { value: "root", label: "Project folder" },
              { value: "worktree", label: "New worktree" },
            ]}
            onChange={setWorkspace}
          />
          {workspace === "worktree" && (
            <>
              <label className="grid gap-1.5 text-sm">
                Base ref
                <Input
                  value={baseRef}
                  disabled={busy || attempt !== null}
                  onChange={(event) => setBaseRef(event.target.value)}
                />
              </label>
              <label className="grid gap-1.5 text-sm">
                Branch (optional)
                <Input
                  value={branch}
                  disabled={busy || attempt !== null}
                  onChange={(event) => setBranch(event.target.value)}
                />
              </label>
            </>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive-foreground">
              {error}
            </p>
          )}
          {ambiguous && (
            <p role="alert" className="text-sm">
              The launch outcome is unknown. Check the host’s threads before using Start again.
              Retrying will not launch another thread automatically.
            </p>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={props.onClose}>
            Cancel
          </Button>
          {error && !attempt && (
            <Button
              variant="outline"
              onClick={() => {
                targetsQuery.refresh();
                projectsQuery.refresh();
              }}
            >
              Reload targets
            </Button>
          )}
          {attempt && !busy && (
            <Button variant="outline" onClick={startAgain}>
              Start again
            </Button>
          )}
          <Button
            disabled={
              busy ||
              !canStart ||
              ambiguous ||
              !selectedProject ||
              (workspace === "worktree" && !baseRef.trim())
            }
            onClick={() => void start()}
          >
            {busy ? "Starting…" : attempt ? "Retry same attempt" : "Start work"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
