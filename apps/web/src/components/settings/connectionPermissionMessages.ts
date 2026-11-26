import { msg, useMessages } from "gt-react";

// Permission descriptions are shared with native clients; mark their web messages for extraction.
const messages = new Set<string>([
  msg("View environment"),
  msg("Read threads, status, checkpoints, and configuration."),
  msg("Operate tasks"),
  msg("Start, update, and stop tasks."),
  msg("Change environment settings"),
  msg("Edit environment preferences and keybindings."),
  msg("Manage providers"),
  msg("Configure, install, sign in to, and update providers and usage sources."),
  msg("Maintain environment"),
  msg("Update the server and control environment processes."),
  msg("Control previews"),
  msg("Open browser previews and host browser automation."),
  msg("View diagnostics and usage"),
  msg("Read process diagnostics, resource history, and usage totals."),
  msg("View terminals"),
  msg("Read existing terminal output and status."),
  msg("Use terminals"),
  msg("Create terminals and send input to running shells."),
  msg("Change source control"),
  msg("Commit, push, manage branches and repositories, and change pull requests."),
  msg("Read files"),
  msg("Browse host files, search workspaces, and inspect local changes."),
  msg("Write files"),
  msg("Edit workspace files and save plans to disk."),
  msg("View access"),
  msg("Inspect pairing links and authorized clients."),
  msg("Manage access"),
  msg("Issue and revoke credentials for other clients."),
  msg("View relay"),
  msg("Inspect managed relay connectivity."),
  msg("Manage relay"),
  msg("Change managed tunnel connectivity."),
  msg("Open hub devices"),
  msg(
    "Open threads on the machines this hub lists, within what the hub allows on each. Only the hub's owner can grant this.",
  ),
  msg("Connect to this environment to view this session’s permissions."),
  msg("This environment did not accept your session. Reconnect to try again."),
  msg("Could not verify your permissions. Retrying automatically."),
  msg("Checking permissions…"),
]);

export function useConnectionPermissionMessages() {
  const localize = useMessages();
  return (source: string) => (messages.has(source) ? localize(source) : source);
}
