import type { resolveProjectSetupScriptConfiguration } from "@goat/shared/projectScripts";
import type { GoatProjectFileState } from "../../hooks/useGoatProjectFileScripts";
import { Button } from "../ui/button";
import { SettingsRow } from "./settingsLayout";

export function ProjectFileActions({
  file,
  configuration,
  optedOut,
  disabled,
  onDisable,
  onRestore,
}: {
  file: GoatProjectFileState;
  configuration: ReturnType<typeof resolveProjectSetupScriptConfiguration>;
  optedOut: boolean;
  disabled: boolean;
  onDisable: () => void;
  onRestore: () => void;
}) {
  if (optedOut)
    return (
      <SettingsRow
        title="Repository actions are disabled for this project."
        description="Repository setup and inherited actions will not run for this project."
        control={
          <Button size="xs" variant="outline" disabled={disabled} onClick={onRestore}>
            Use inherited actions
          </Button>
        }
      />
    );
  if (file.status === "loading") return <SettingsRow title="Loading repository actions…" />;
  if (file.status === "missing")
    return <SettingsRow title="No goat.json or t3.json found in this checkout." />;
  if (file.status === "invalid")
    return (
      <SettingsRow
        title={`${file.relativePath} is invalid`}
        description="Repository actions are ignored. Check the JSON syntax and icon values."
        className="text-warning"
      />
    );
  if (configuration.source !== "project-file")
    return <SettingsRow title={`No worktree setup action in ${file.relativePath}.`} />;
  return (
    <>
      <SettingsRow
        title="Repository actions"
        description={
          <>Read-only setup from this checkout. Edit {file.relativePath} to change it.</>
        }
        control={
          <Button size="xs" variant="outline" disabled={disabled} onClick={onDisable}>
            Disable repository actions for this project
          </Button>
        }
      />
      {configuration.scripts.map((script) => (
        <SettingsRow
          key={script.id}
          title={
            <span className="flex flex-wrap items-center gap-2">
              <span>{script.name}</span>
              <span className="text-xs font-normal text-muted-foreground">
                from {file.relativePath}
              </span>
            </span>
          }
          description={
            <span className="block space-y-1">
              <code className="block whitespace-pre-wrap break-words font-mono">
                {script.command}
              </code>
              <span className="flex flex-wrap gap-2 text-xs">
                <span>runOnWorktreeCreate</span>
                <span>async: {String(script.async !== false)}</span>
                {script.runAsCheck ? <span>check</span> : null}
                {script.runOnSettle ? <span>on settle</span> : null}
              </span>
            </span>
          }
        />
      ))}
    </>
  );
}
