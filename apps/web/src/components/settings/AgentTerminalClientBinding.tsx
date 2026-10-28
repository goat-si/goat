import { useAtomValue } from "@effect/atom-react";
import { AuthAccessWriteScope, type EnvironmentId, type ThreadId } from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { useId, useState } from "react";

import { usePrimaryEnvironmentId } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { environmentShell } from "../../state/shell";
import { useAtomCommand } from "../../state/use-atom-command";
import type { ServerClientSessionRecord } from "../../environments/primary";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

function bindingErrorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Terminal binding could not be saved.";
}

export function AgentTerminalClientBinding({
  clientSession,
}: {
  readonly clientSession: ServerClientSessionRecord;
}) {
  const environmentId = usePrimaryEnvironmentId();
  const [open, setOpen] = useState(false);
  const controlId = useId();
  // oxlint-disable-next-line goat/no-rpc-permission-bypass -- AuthClientSession.client is display metadata, not an RPC client.
  const { client: metadata } = clientSession;
  if (
    environmentId === null ||
    clientSession.subject !== "mcp-client" ||
    metadata.deviceType !== "bot"
  )
    return null;
  return (
    <div className="mt-2">
      <Button
        size="xs"
        variant="outline"
        aria-expanded={open}
        aria-controls={controlId}
        onClick={() => setOpen((previous) => !previous)}
      >
        Terminal binding
      </Button>
      {open ? (
        <div id={controlId}>
          <BindingControl
            key={`${environmentId}:${clientSession.sessionId}`}
            environmentId={environmentId}
            clientSession={clientSession}
          />
        </div>
      ) : null}
    </div>
  );
}

function BindingControl({
  environmentId,
  clientSession,
}: {
  readonly environmentId: EnvironmentId;
  readonly clientSession: ServerClientSessionRecord;
}) {
  // oxlint-disable-next-line goat/no-rpc-permission-bypass -- AuthClientSession.client is display metadata, not an RPC client.
  const { client: metadata } = clientSession;
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const shell = useAtomValue(environmentShell.stateValueAtom(environmentId));
  const binding = config?.settings.agentTerminalClientBindings[clientSession.sessionId];
  const input = {
    patch: {},
    agentTerminalBinding: { sessionId: clientSession.sessionId, threadId: null },
  };
  const allowed = useAtomValue(
    serverEnvironment.updateSettings.permissionAtom(environmentId, input),
  );
  const canManageAccess = useEnvironmentScope(environmentId, AuthAccessWriteScope);
  const persist = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const threads =
    Option.getOrNull(shell.snapshot)?.threads.filter(
      (thread) => thread.archivedAt === null && thread.deletedAt === null,
    ) ?? [];
  const matches = threads.filter((thread) =>
    `${thread.title} ${thread.id}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const pageSize = 20;
  const currentPage = Math.min(page, Math.max(0, Math.ceil(matches.length / pageSize) - 1));
  const disabled = !allowed || !canManageAccess || pending || config === null;
  const save = async (threadId: ThreadId | null) => {
    if (disabled) return;
    setPending(true);
    setError(null);
    try {
      const result = await persist({
        environmentId,
        input: {
          patch: {},
          agentTerminalBinding: { sessionId: clientSession.sessionId, threadId },
        },
      });
      if (result._tag === "Failure") {
        const cause = Cause.squash(result.cause);
        setError(bindingErrorMessage(cause));
      }
    } catch (cause) {
      setError(bindingErrorMessage(cause));
    }
    setPending(false);
  };
  return (
    <div className="mt-3 space-y-2">
      <Input
        aria-label="Search terminal threads"
        placeholder="Search existing threads"
        value={query}
        disabled={pending}
        onChange={(event) => {
          setQuery(event.currentTarget.value);
          setPage(0);
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium">Terminal thread</span>
        <Select
          value={binding?.threadId ?? null}
          disabled={disabled || shell.status !== "live"}
          onValueChange={(value) => {
            const thread = threads.find((candidate) => candidate.id === value);
            if (thread) void save(thread.id);
          }}
        >
          <SelectTrigger
            size="sm"
            aria-label={`Terminal thread for ${metadata.label ?? clientSession.sessionId}`}
          >
            <SelectValue>
              {pending
                ? "Saving…"
                : binding
                  ? (threads.find((thread) => thread.id === binding.threadId)?.title ??
                    "Bound thread unavailable")
                  : "Unbound"}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="start" alignItemWithTrigger={false}>
            {matches.slice(currentPage * pageSize, (currentPage + 1) * pageSize).map((thread) => (
              <SelectItem key={thread.id} value={thread.id}>
                {thread.title} · {thread.id}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        {binding ? (
          <Button size="xs" variant="outline" disabled={disabled} onClick={() => void save(null)}>
            Unbind
          </Button>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="xs"
          variant="ghost"
          disabled={currentPage === 0}
          onClick={() => setPage(currentPage - 1)}
        >
          Previous threads
        </Button>
        <span className="text-xs text-muted-foreground">
          {matches.length === 0
            ? "No matching threads"
            : `Page ${currentPage + 1} of ${Math.ceil(matches.length / pageSize)}`}
        </span>
        <Button
          size="xs"
          variant="ghost"
          disabled={(currentPage + 1) * pageSize >= matches.length}
          onClick={() => setPage(currentPage + 1)}
        >
          Next threads
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {shell.status !== "live"
          ? "Connect to load existing threads. "
          : threads.length === 0
            ? "No nonarchived threads are available. "
            : ""}
        Binding applies only to this session in this environment. Unbinding blocks new terminal
        calls but leaves running terminals for you to close. A new consent session has no binding;
        revoke the old session explicitly to reduce its access.
      </p>
      {!allowed || !canManageAccess ? (
        <p className="text-xs text-muted-foreground">
          Changing a binding requires settings:write and access:write.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
