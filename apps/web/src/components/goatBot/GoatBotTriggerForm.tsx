import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@goat/client-runtime/environment";
import {
  parseWebhookFilterDrafts,
  webhookFilterDrafts,
} from "@goat/client-runtime/scheduled-task-webhook";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@goat/client-runtime/state/runtime";
import {
  AuthSettingsWriteScope,
  type EnvironmentId,
  type ScheduledTaskWebhookFilter,
  type ThreadId,
} from "@goat/contracts";
import { useId, useState } from "react";
import { HoldsNavigation } from "~/lib/navigationHolds";
import { useProjects, useThreadShell } from "~/state/entities";
import { serverEnvironment } from "~/state/server";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { WebhookFiltersField } from "../settings/ScheduledTaskWebhookFiltersField";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";

const presets = [
  {
    id: "pr-opened",
    title: "Pull request opened",
    prompt: "Review the pull request at {{body.pull_request.html_url}} and report your findings.",
    filters: [
      { path: "headers.x-github-event", op: "equals", value: "pull_request" },
      { path: "body.action", op: "equals", value: "opened" },
    ],
  },
  {
    id: "check-failed",
    title: "Check failed",
    prompt: "Investigate the failing check {{body.check_run.name}} on {{body.check_run.html_url}}.",
    filters: [
      { path: "headers.x-github-event", op: "equals", value: "check_run" },
      { path: "body.check_run.conclusion", op: "equals", value: "failure" },
    ],
  },
  {
    id: "any-webhook",
    title: "Any webhook",
    prompt: "Triage this event and start work if needed. Event data: {{body}}",
    filters: [],
  },
] as const satisfies ReadonlyArray<{
  id: string;
  title: string;
  prompt: string;
  filters: ReadonlyArray<ScheduledTaskWebhookFilter>;
}>;

export function GoatBotTriggerOffer(props: { environmentId: EnvironmentId; threadId: ThreadId }) {
  const [open, setOpen] = useState(false);
  const mayOperate = useAtomValue(
    serverEnvironment.upsertScheduledTask.permissionAtom(props.environmentId),
  );
  const mayConfigure = useEnvironmentScope(props.environmentId, AuthSettingsWriteScope);
  if (!mayOperate || !mayConfigure) return null;
  return (
    <div className="border-b border-border/50 px-3 py-2">
      {open ? (
        <TriggerForm {...props} onClose={() => setOpen(false)} />
      ) : (
        <Button size="xs" variant="outline" onClick={() => setOpen(true)}>
          New trigger
        </Button>
      )}
    </div>
  );
}

function TriggerForm(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  onClose: () => void;
}) {
  const formId = useId();
  const bot = useThreadShell(scopeThreadRef(props.environmentId, props.threadId));
  const projects = useProjects().filter(
    (project) =>
      project.environmentId === props.environmentId &&
      project.archivedAt == null &&
      project.id !== bot?.projectId,
  );
  const [preset, setPreset] = useState<(typeof presets)[number]>(presets[0]);
  const [projectId, setProjectId] = useState("");
  const [prompt, setPrompt] = useState<string>(preset.prompt);
  const [filters, setFilters] = useState(() => webhookFilterDrafts(preset.filters));
  const [secret, setSecret] = useState("");
  const [allowChecksWithoutPullRequest, setAllowChecksWithoutPullRequest] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const project = projects.find((candidate) => candidate.id === projectId) ?? projects[0];
  const upsert = useAtomCommand(serverEnvironment.upsertScheduledTask, {
    label: "GOAT Bot work trigger",
    reportFailure: false,
  });

  const save = async () => {
    if (saving || bot == null || project === undefined || !prompt.trim()) return;
    const parsed = parseWebhookFilterDrafts(filters);
    if ("error" in parsed) {
      setError(parsed.error);
      return;
    }
    setSaving(true);
    setError(null);
    const result = await upsert({
      environmentId: props.environmentId,
      input: {
        title: preset.title,
        prompt: prompt.trim(),
        enabled: secret.trim() !== "",
        routineMode: "work",
        schedule: {
          type: "webhook",
          signature: {
            header: preset.id === "any-webhook" ? "x-goat-signature" : "x-hub-signature-256",
            encoding: "hex",
            prefix: "sha256=",
            required: true,
            ...(secret.trim() === "" ? {} : { secret: secret.trim() }),
          },
          filters: parsed.filters,
          allowChecksWithoutPullRequest,
        },
        projectId: project.id,
        threadId: props.threadId,
        workspaceStrategy: { type: "root" },
        modelSelection: bot.modelSelection,
        runtimeMode: "approval-required",
        interactionMode: "default",
        creationSource: "web",
      },
    });
    setSaving(false);
    if (result._tag === "Success") {
      props.onClose();
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <form
      aria-label="New trigger"
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <HoldsNavigation />
      <div className="grid gap-1">
        <Label htmlFor={formId + "-event"}>Event</Label>
        <select
          className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
          id={formId + "-event"}
          value={preset.id}
          onChange={(event) => {
            const next = presets.find((item) => item.id === event.target.value);
            if (next === undefined) return;
            setPreset(next);
            setPrompt(next.prompt);
            setFilters(webhookFilterDrafts(next.filters));
            setAllowChecksWithoutPullRequest(false);
          }}
        >
          {presets.map((item) => (
            <option key={item.id} value={item.id}>
              {item.title}
            </option>
          ))}
        </select>
      </div>
      <div className="grid gap-1">
        <Label htmlFor={formId + "-project"}>Project</Label>
        <select
          className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
          id={formId + "-project"}
          value={project?.id ?? ""}
          disabled={projects.length === 0}
          onChange={(event) => setProjectId(event.target.value)}
        >
          {projects.length === 0 ? (
            <option value="">Add a project to create a trigger</option>
          ) : null}
          {projects.map((item) => (
            <option key={item.id} value={item.id}>
              {item.title}
            </option>
          ))}
        </select>
      </div>
      <div className="grid gap-1">
        <Label htmlFor={formId + "-prompt"}>Instructions</Label>
        <Textarea
          id={formId + "-prompt"}
          value={prompt}
          required
          onChange={(event) => setPrompt(event.target.value)}
        />
      </div>
      <div className="grid gap-1">
        <Label htmlFor={formId + "-secret"}>Signing secret</Label>
        <Input
          id={formId + "-secret"}
          type="password"
          autoComplete="new-password"
          value={secret}
          onChange={(event) => setSecret(event.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          Sign requests with HMAC-SHA256. Leave the secret blank to save paused.
        </p>
      </div>
      <p className="text-xs text-muted-foreground">Webhook URL appears after saving.</p>
      <details className="space-y-2">
        <summary className="cursor-pointer text-sm">Event filters</summary>
        <WebhookFiltersField filters={filters} onChange={setFilters} />
      </details>
      {preset.id !== "pr-opened" ? (
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={allowChecksWithoutPullRequest}
            onChange={(event) => setAllowChecksWithoutPullRequest(event.target.checked)}
          />
          Allow checks without a pull request
        </label>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={props.onClose} disabled={saving}>
          Cancel
        </Button>
        <Button
          type="submit"
          size="sm"
          disabled={saving || bot == null || project === undefined || !prompt.trim()}
        >
          Save trigger
        </Button>
      </div>
    </form>
  );
}
