import { useAtomValue } from "@effect/atom-react";
import { createAuthEnvironmentAtoms } from "@goat/client-runtime/state/auth";
import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  type AuthClientSession,
  type EnvironmentId,
  type ThreadId,
} from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { useState } from "react";
import { TextInput, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { environmentShell } from "../../state/shell";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { SettingsSection } from "./components/SettingsSection";

function bindingErrorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Terminal binding could not be saved.";
}

const authEnvironment = createAuthEnvironmentAtoms(connectionAtomRuntime);

export function AgentTerminalClientBindingsSection({
  environmentId,
  connected,
}: {
  readonly environmentId: EnvironmentId;
  readonly connected: boolean;
}) {
  const canRead = useEnvironmentScope(environmentId, AuthAccessReadScope);
  const clients = useEnvironmentQuery(
    connected && canRead ? authEnvironment.accessChanges({ environmentId, input: null }) : null,
  );
  const [selected, setSelected] = useState<string | null>(null);
  const sessions =
    clients.data?.type === "snapshot"
      ? clients.data.payload.clientSessions.filter(
          ({ subject, client: metadata }) =>
            subject === "mcp-client" && metadata.deviceType === "bot",
        )
      : [];
  return (
    <SettingsSection title="Authorized agent terminals">
      {!connected || !canRead ? (
        <Text className="px-4 py-3 text-sm text-foreground-muted">
          Connect with access:read to view authorized MCP sessions.
        </Text>
      ) : clients.error ? (
        <View className="gap-2 px-4 py-3">
          <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
            {clients.error}
          </Text>
          <Button label="Retry" onPress={clients.refresh} />
        </View>
      ) : clients.data === null ? (
        <Text className="px-4 py-3 text-sm text-foreground-muted">
          Loading authorized sessions…
        </Text>
      ) : sessions.length === 0 ? (
        <Text className="px-4 py-3 text-sm text-foreground-muted">
          No authorized MCP bot sessions.
        </Text>
      ) : (
        sessions.map(({ client: metadata, ...session }) => (
          <View key={session.sessionId}>
            <SettingsActionRow
              label={metadata.label ?? session.sessionId}
              description={`Session ${session.sessionId}`}
              onPress={() =>
                setSelected((current) => (current === session.sessionId ? null : session.sessionId))
              }
            />
            {selected === session.sessionId ? (
              <ClientBinding
                key={`${environmentId}:${session.sessionId}`}
                environmentId={environmentId}
                session={{ ...session, client: metadata }}
                connected={connected}
              />
            ) : null}
          </View>
        ))
      )}
    </SettingsSection>
  );
}

function ClientBinding({
  environmentId,
  session,
  connected,
}: {
  readonly environmentId: EnvironmentId;
  readonly session: AuthClientSession;
  readonly connected: boolean;
}) {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const shell = useAtomValue(environmentShell.stateValueAtom(environmentId));
  const binding = config?.settings.agentTerminalClientBindings[session.sessionId];
  const allowed = useAtomValue(
    serverEnvironment.updateSettings.permissionAtom(environmentId, {
      patch: {},
      agentTerminalBinding: { sessionId: session.sessionId, threadId: null },
    }),
  );
  const canManageAccess = useEnvironmentScope(environmentId, AuthAccessWriteScope);
  const persist = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const threads =
    Option.getOrNull(shell.snapshot)?.threads.filter(
      (thread) => thread.archivedAt === null && thread.deletedAt === null,
    ) ?? [];
  const disabled = !connected || !allowed || !canManageAccess || pending || config === null;
  const save = async (threadId: ThreadId | null) => {
    if (disabled) return;
    setPending(true);
    setError(null);
    try {
      const result = await persist({
        environmentId,
        input: { patch: {}, agentTerminalBinding: { sessionId: session.sessionId, threadId } },
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
    <View className="gap-3 px-4 py-3">
      <Text className="text-sm text-foreground-muted">
        Granted scopes: {session.scopes.join(", ")}
      </Text>
      <Text className="text-sm text-foreground">
        Terminal thread:{" "}
        {binding
          ? (threads.find((thread) => thread.id === binding.threadId)?.title ??
            "Bound thread unavailable")
          : "Unbound"}
      </Text>
      <ThreadPicker
        threads={threads}
        disabled={disabled || shell.status !== "live"}
        onSelect={(threadId) => void save(threadId)}
      />
      {pending ? <Text className="text-sm text-foreground-muted">Saving binding…</Text> : null}
      {binding ? (
        <Button label="Unbind" disabled={disabled} onPress={() => void save(null)} />
      ) : null}
      {shell.status !== "live" ? (
        <Text className="text-sm text-foreground-muted">Connect to load existing threads.</Text>
      ) : threads.length === 0 ? (
        <Text className="text-sm text-foreground-muted">No nonarchived threads are available.</Text>
      ) : null}
      {!allowed || !canManageAccess ? (
        <Text className="text-sm text-foreground-muted">
          Changing a binding requires settings:write and access:write.
        </Text>
      ) : null}
      <Text className="text-sm text-foreground-muted">
        Binding applies only to this session in this environment. Unbinding blocks new terminal
        calls but leaves running terminals for you to close. New consent creates a separate session
        with no binding. To reduce an older session's access, explicitly revoke it in web or desktop
        Settings → Connections → Authorized clients.
      </Text>
      {error ? (
        <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

function ThreadPicker({
  threads,
  disabled,
  onSelect,
}: {
  readonly threads: readonly { readonly id: ThreadId; readonly title: string }[];
  readonly disabled: boolean;
  readonly onSelect: (threadId: ThreadId) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const pageSize = 20;
  if (!open)
    return (
      <SettingsActionRow
        label="Choose existing thread"
        disabled={disabled}
        onPress={() => {
          setQuery("");
          setPage(0);
          setOpen(true);
        }}
      />
    );
  const search = query.trim().toLowerCase();
  const matches = threads.filter((thread) =>
    `${thread.title} ${thread.id}`.toLowerCase().includes(search),
  );
  const currentPage = Math.min(page, Math.max(0, Math.ceil(matches.length / pageSize) - 1));
  return (
    <View className="gap-2">
      <TextInput
        accessibilityLabel="Search terminal threads"
        placeholder="Search threads"
        value={query}
        onChangeText={(next) => {
          setQuery(next);
          setPage(0);
        }}
        className="rounded-lg border border-border p-3 text-foreground"
      />
      <Text className="text-sm text-foreground-muted">
        {matches.length === 0
          ? "No matching threads"
          : `Page ${currentPage + 1} of ${Math.ceil(matches.length / pageSize)}`}
      </Text>
      {matches.slice(currentPage * pageSize, (currentPage + 1) * pageSize).map((thread) => (
        <SettingsActionRow
          key={thread.id}
          label={thread.title}
          description={thread.id}
          disabled={disabled}
          onPress={() => {
            setOpen(false);
            onSelect(thread.id);
          }}
        />
      ))}
      <SettingsActionRow
        label="Previous threads"
        disabled={currentPage === 0}
        onPress={() => setPage(currentPage - 1)}
      />
      <SettingsActionRow
        label="Next threads"
        disabled={(currentPage + 1) * pageSize >= matches.length}
        onPress={() => setPage(currentPage + 1)}
      />
      <SettingsActionRow label="Close thread chooser" onPress={() => setOpen(false)} />
    </View>
  );
}
