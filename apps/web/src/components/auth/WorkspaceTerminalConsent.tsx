import type { AuthMcpWorkspaceTerminalScope } from "@goat/contracts";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

export type WorkspaceTerminalScope = AuthMcpWorkspaceTerminalScope;

export function WorkspaceTerminalConsent({
  scopes,
  readOnly,
  disabled,
  onChange,
}: {
  readonly scopes: readonly WorkspaceTerminalScope[];
  readonly readOnly: boolean;
  readonly disabled: boolean;
  readonly onChange: (scopes: readonly WorkspaceTerminalScope[]) => void;
}) {
  return (
    <div className="space-y-3">
      <p className="text-sm font-medium">Workspace and terminal access (optional)</p>
      {(["filesystem", "terminal"] as const).map((kind) => {
        const read = kind === "filesystem" ? "filesystem:read" : "terminal:read";
        const write = kind === "filesystem" ? "filesystem:write" : "terminal:operate";
        const label = kind === "filesystem" ? "Workspace files" : "Terminal";
        const value =
          !readOnly && scopes.includes(write) ? "write" : scopes.includes(read) ? "read" : "off";
        return (
          <div key={kind} className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm">{label}</span>
            <Select
              value={value}
              disabled={disabled}
              onValueChange={(next) => {
                if (next !== "off" && next !== "read" && next !== "write") return;
                if (next === "write" && readOnly) return;
                const remaining = scopes.filter((scope) => scope !== read && scope !== write);
                onChange(
                  next === "off"
                    ? remaining
                    : next === "read"
                      ? [...remaining, read]
                      : [...remaining, read, write],
                );
              }}
            >
              <SelectTrigger size="sm" aria-label={`${label} access`}>
                <SelectValue>
                  {value === "off"
                    ? "Off"
                    : value === "read"
                      ? "Read"
                      : kind === "filesystem"
                        ? "Read and write"
                        : "Operate"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem value="off">Off</SelectItem>
                <SelectItem value="read">Read</SelectItem>
                <SelectItem value="write" disabled={readOnly}>
                  {kind === "filesystem" ? "Read and write" : "Operate (includes Read)"}
                </SelectItem>
              </SelectPopup>
            </Select>
          </div>
        );
      })}
      <p className="text-xs text-muted-foreground">
        Nothing is selected by default. Project policy also applies. Operate permits shell execution
        with the server's OS file and network authority; the starting workspace directory is not a
        sandbox.
      </p>
      <p className="text-xs text-muted-foreground">
        Approval creates a separate session with no terminal binding. Bind it to an existing thread
        in Settings → Connections → Authorized clients. To reduce an older session's access, revoke
        it explicitly there; changing this consent does not revoke it.
      </p>
    </div>
  );
}
