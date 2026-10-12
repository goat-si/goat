import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId } from "@goat/contracts";
import {
  BearerConnectionTarget,
  SshConnectionTarget,
  SshConnectionProfile,
  type ConnectionCatalogEntry,
} from "@goat/client-runtime/connection";
import * as Option from "effect/Option";
import {
  savedSshWorktreeOptions,
  findSavedSshWorktreeOption,
  sshWorktreeSendBlockReason,
} from "./sshWorktree";

export function savedEntry(
  id = "host",
  enabled = true,
  username: string | undefined = undefined,
  port: number | undefined = undefined,
): ConnectionCatalogEntry {
  const environmentId = EnvironmentId.make(id);
  return {
    target: new SshConnectionTarget({ environmentId, connectionId: id, label: id }),
    enabled,
    profile: Option.some(
      new SshConnectionProfile({
        environmentId,
        connectionId: id,
        label: `Saved ${id}`,
        target: {
          alias: "build",
          hostname: "build.example",
          username: username ?? null,
          port: port ?? null,
        },
      }),
    ),
  };
}
const entries = (...items: ConnectionCatalogEntry[]) =>
  new Map(items.map((entry) => [entry.target.environmentId, entry]));
const options = () => savedSshWorktreeOptions(entries(savedEntry()), true);
describe("saved SSH worktrees", () => {
  it("includes saved alternate SSH routes but excludes discovered or bearer-only hosts", () => {
    const ssh = savedEntry();
    const bearer = new BearerConnectionTarget({
      environmentId: ssh.target.environmentId,
      connectionId: "direct",
      label: "Direct",
    });
    expect(
      savedSshWorktreeOptions(
        entries({
          ...ssh,
          target: bearer,
          profile: Option.none(),
          alternateRoutes: [{ target: ssh.target, profile: ssh.profile }],
        }),
        true,
      ),
    ).toHaveLength(1);
    expect(
      savedSshWorktreeOptions(entries({ ...ssh, target: bearer, profile: Option.none() }), true),
    ).toEqual([]);
    expect(savedSshWorktreeOptions(entries({ ...ssh, profile: Option.none() }), true)).toEqual([]);
  });
  it("deduplicates full SSH targets while preserving distinct user and port", () => {
    expect(
      savedSshWorktreeOptions(
        entries(
          savedEntry("disabled", false),
          savedEntry("enabled"),
          savedEntry("user", true, "jun"),
          savedEntry("port", true, undefined, 2202),
        ),
        true,
      ).map((o) => o.destination.connectionId),
    ).toEqual(["enabled", "port", "user"]);
  });
  it("lists disabled and outdated saved connections with reasons", () => {
    expect(
      savedSshWorktreeOptions(
        entries(savedEntry("disabled", false), {
          ...savedEntry("old", true, "other"),
          unsupportedReason: "Update GOAT",
        }),
        true,
      ).map((o) => o.disabledReason),
    ).toEqual(["Enable this saved connection in Settings → Connections.", "Update GOAT"]);
  });
  it("hides the entry for an empty browser catalog", () =>
    expect(savedSshWorktreeOptions(new Map(), false)).toEqual([]));
  it("rejects a stale browser SSH profile without desktop transport", () =>
    expect(savedSshWorktreeOptions(entries(savedEntry()), false)[0]?.disabledReason).toBe(
      "SSH worktrees are available in the desktop app.",
    ));
  it("requires the full saved identity and does not retarget removed duplicates", () => {
    const option = options()[0]!;
    expect(findSavedSshWorktreeOption(options(), option.destination)).toEqual(option);
    expect(
      findSavedSshWorktreeOption(options(), { ...option.destination, connectionId: "removed" }),
    ).toBeNull();
    expect(
      findSavedSshWorktreeOption(options(), {
        ...option.destination,
        environmentId: EnvironmentId.make("other"),
      }),
    ).toBeNull();
  });
  const valid = {
    selected: true,
    draftAvailable: true,
    sourceIsPrimary: true,
    sourceProjectAvailable: true,
    sourceIsGitRepo: true,
    desktopAvailable: true,
    catalogReady: true,
    option: options()[0]!,
    canLaunch: true,
    hasAttachments: false,
    hasContextRecords: false,
    multipleModels: false,
  };
  it.each([
    [{ draftAvailable: false }, "SSH worktrees need a new draft."],
    [{ desktopAvailable: false }, "SSH worktrees are available in the desktop app."],
    [{ sourceIsPrimary: false }, "Choose Local in Run on before sending to SSH."],
    [{ sourceProjectAvailable: false }, "Choose a local project before sending to SSH."],
    [{ sourceIsGitRepo: false }, "SSH worktrees need a Git project."],
    [{ catalogReady: false }, "Loading saved SSH connections."],
    [{ option: null }, "This saved SSH connection is unavailable. Choose another host."],
    [{ option: { ...valid.option, disabledReason: "Update GOAT" } }, "Update GOAT"],
    [{ canLaunch: false }, "This connection cannot copy code and start SSH threads."],
    [{ multipleModels: true }, "Choose one model before sending to SSH."],
    [{ hasAttachments: true }, "Remove attachments before sending to SSH."],
    [{ hasContextRecords: true }, "Remove context chips before sending to SSH."],
  ])("reports each SSH guard at its reachable activation %j", (override, reason) =>
    expect(sshWorktreeSendBlockReason({ ...valid, ...override })).toBe(reason),
  );
  it("ignores SSH guards when no destination is selected", () =>
    expect(
      sshWorktreeSendBlockReason({ ...valid, selected: false, draftAvailable: false }),
    ).toBeNull());
});
