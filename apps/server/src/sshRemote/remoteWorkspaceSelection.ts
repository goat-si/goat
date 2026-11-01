import { isWindowsAbsolutePath, isWindowsShellOs, windowsHostPathKey } from "@goat/shared/path";
import { goatCallText } from "@goat/contracts/agentSurface/callText";

import type { SshBrowseResult } from "./SshRemoteDispatch.ts";

const normalizeRemotePath = (value: string) =>
  value.length > 1 ? value.replace(/\/+$/u, "") : value;

export interface RemoteProject {
  readonly id: string;
  readonly workspaceRoot: string;
}

/**
 * Why a remote folder is too broad to be a thread's workspace, or null. The
 * filesystem root, the home directory, a folder above home, and other top-level
 * folders would give an agent a whole account or machine, and the folder
 * becomes a project on the remote. Case is folded, which can only over-reject.
 */
export function broadWorkspaceRoot(
  folder: Pick<SshBrowseResult, "path" | "realPath" | "home">,
): string | null {
  // A Windows drive letter is part of the root, not a folder below it.
  const segments = (value: string) =>
    value
      .split(/[\\/]+/)
      .filter((part) => part.length > 0 && !/^[A-Za-z]:$/.test(part))
      .map((part) => part.toLowerCase());
  const home = folder.home === null ? [] : segments(folder.home);
  for (const candidate of [folder.path, folder.realPath]) {
    const parts = segments(candidate);
    if (parts.length === 0) return "the filesystem root";
    if (
      home.length > 0 &&
      parts.length <= home.length &&
      parts.every((part, i) => part === home[i])
    ) {
      return parts.length === home.length
        ? "the home directory"
        : "a folder that contains the home directory";
    }
    if (parts.length === 1) return "a top-level folder";
  }
  return null;
}

/**
 * What launch knows about a folder on a linked host, which it cannot browse, or why the
 * folder is unusable. Launch then requires an existing project there, so a person on that
 * host chose the workspace; the path only needs to match project roots exactly.
 */
export function linkedHostFolder(alias: string, cwd: string): SshBrowseResult | string {
  const trimmed = cwd.trim();
  const windows = /^[A-Za-z]:[\\/]/u.test(trimmed);
  if (/^(?:\/\/|\\\\)/u.test(trimmed))
    return `${alias} is a linked host; network share paths are not supported there. Pass the local absolute path of one of its projects.`;
  if (!windows && !trimmed.startsWith("/"))
    return `${alias} is a linked host, so cwd must be an absolute path there, not ${trimmed}. ${goatCallText("project.list")} with host "${alias}" shows its project folders.`;
  // Resolve . and .. so the path compares with the host's stored project roots.
  const [root, ...rest] = trimmed.split(/[\\/]+/u);
  const parts: Array<string> = [];
  for (const part of rest) {
    if (part === "..") parts.pop();
    else if (part !== "" && part !== ".") parts.push(part);
  }
  const separator = windows ? "\\" : "/";
  const path = `${root}${separator}${parts.join(separator)}`;
  return {
    host: alias,
    os: null,
    home: null,
    path,
    realPath: path,
    gitRoot: null,
    branch: null,
    worktrees: [],
    entries: [],
    truncated: false,
  };
}

/**
 * Finds the project registered at the browsed folder, by either form of its path. A Windows
 * host compares either shell form, any slash, and any case, as NTFS does by default.
 * A linked host reports no OS, so its native `C:\…` project roots alone mark it as Windows.
 */
export function matchRemoteProject(
  projects: ReadonlyArray<RemoteProject>,
  folder: { readonly path: string; readonly realPath: string; readonly os: string | null },
): RemoteProject | undefined {
  if (isWindowsShellOs(folder.os)) {
    const keys = new Set([windowsHostPathKey(folder.path), windowsHostPathKey(folder.realPath)]);
    return projects.find((project) => keys.has(windowsHostPathKey(project.workspaceRoot)));
  }
  const candidates = new Set([
    normalizeRemotePath(folder.path),
    normalizeRemotePath(folder.realPath),
  ]);
  const exact = projects.find((project) =>
    candidates.has(normalizeRemotePath(project.workspaceRoot)),
  );
  if (exact === undefined && folder.os === null) {
    const keys = new Set([windowsHostPathKey(folder.path), windowsHostPathKey(folder.realPath)]);
    return projects.find(
      (project) =>
        isWindowsAbsolutePath(project.workspaceRoot) &&
        keys.has(windowsHostPathKey(project.workspaceRoot)),
    );
  }
  if (exact !== undefined || folder.os !== "Darwin") return exact;
  // macOS volumes are usually case-insensitive, so a project can be saved with other casing.
  const folded = new Set([...candidates].map((candidate) => candidate.toLowerCase()));
  return projects.find((project) =>
    folded.has(normalizeRemotePath(project.workspaceRoot).toLowerCase()),
  );
}
