import { useGT } from "gt-react";
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
  const gt = useGT();
  if (optedOut)
    return (
      <SettingsRow
        title={gt("Repository actions are disabled for this project.")}
        description={gt("Repository setup and inherited actions will not run for this project.")}
        control={
          <Button size="xs" variant="outline" disabled={disabled} onClick={onRestore}>
            {gt("Use inherited actions")}
          </Button>
        }
      />
    );
  if (file.status === "loading") return <SettingsRow title={gt("Loading repository actions…")} />;
  if (file.status === "missing")
    return <SettingsRow title={gt("No goat.json or t3.json found in this checkout.")} />;
  if (file.status === "invalid")
    return (
      <SettingsRow
        title={gt("{file} is invalid", { file: file.relativePath })}
        description={gt("Repository actions are ignored. Check the JSON syntax and icon values.")}
        className="text-warning"
      />
    );
  if (configuration.source !== "project-file")
    return (
      <SettingsRow title={gt("No worktree setup action in {file}.", { file: file.relativePath })} />
    );
  return (
    <>
      <SettingsRow
        title={gt("Repository actions")}
        description={gt("Read-only setup from this checkout. Edit {file} to change it.", {
          file: file.relativePath,
        })}
        control={
          <Button size="xs" variant="outline" disabled={disabled} onClick={onDisable}>
            {gt("Disable repository actions for this project")}
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
                {gt("from {file}", { file: file.relativePath })}
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
                {script.runAsCheck ? <span>{gt("check")}</span> : null}
                {script.runOnSettle ? <span>{gt("on settle")}</span> : null}
              </span>
            </span>
          }
        />
      ))}
    </>
  );
}
