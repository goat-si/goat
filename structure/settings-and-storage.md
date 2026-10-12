# Settings and storage

Three homes show up in the tree. They are not aliases for one directory. The
[command commit](server.md#command-commit) writes orchestration rows into whichever SQLite file
this process derived from its base directory.

## State roots

`resolveBaseDir` in `apps/server/src/os-jank.ts` joins the home directory with `.t3` when the
caller passes an empty string. `apps/server/src/cli/config.ts` reads that value from `--base-dir`
or from `GOAT_HOME`. The flag help text calls it the GOAT data directory and says it is
equivalent to `GOAT_HOME`. There is no `GOAT_HOME` environment variable on this path.

`deriveServerPaths` in `apps/server/src/config.ts` then places runtime files under
`<baseDir>/userdata`, or under `<baseDir>/dev` when a dev URL is set and the base directory was
not explicit. The derived paths include:

| Path under the state directory | Role                                                   |
| ------------------------------ | ------------------------------------------------------ |
| `statev2.sqlite`               | Orchestration and other server SQLite state (`dbPath`) |
| `settings.json`                | Server settings (`settingsPath`)                       |
| `keybindings.json`             | Keybindings                                            |
| `secrets/`                     | Secret material                                        |
| `attachments/`                 | Attachment bytes                                       |
| `logs/`                        | Server and provider logs                               |
| `server-runtime.json`          | Runtime identity for an already-running server         |

`apps/server/src/serverSettings.ts` reads and writes `settingsPath`. The schema those files follow
is `ServerSettings` in `packages/contracts/src/settings.ts`, including `goatBotHome`.

A packaged desktop app does not use that default. `resolveDesktopBaseDir` in
`apps/desktop/src/app/DesktopStatePaths.ts` returns `~/.goat/desktop` when the build is not a
development build and `GOAT_HOME` is unset. A development desktop build returns `~/.t3`.
`resolveDesktopStateDir` still appends `userdata`, or `dev` for a development build with no
explicit home. Electron's own profile directory is separate: `apps/desktop/src/app/DesktopUserData.ts`
uses `goat-desktop`, `goat-desktop-dev`, and `goat-desktop-nightly`.

On an SSH host, the launch scripts in `packages/ssh/src/tunnel.ts` set
`DEFAULT_SERVER_HOME="$HOME/.goat"`. Runtime archives land under
`$HOME/.goat/runtime/goat/versions/`. That remote home is the host's server base directory. It is
not the local CLI default. Host _lists_ still come from the user's OpenSSH files under `~/.ssh`,
which [`ssh.md`](ssh.md) covers.

A linked git worktree gets its own directory. `resolveWorktreeHome` in
`packages/shared/src/devHome.ts` returns `<worktree>/.t3` so a worktree dev server does not open
the installed app's `~/.t3`. An explicit `GOAT_HOME` still wins, and it counts as an explicit
base directory, which selects `userdata` rather than `dev`.

> Decision record: [ADR-0005](decisions/ADR-0005-desktop-home.md)

> Decision record: [ADR-0006](decisions/ADR-0006-goat-cli-and-ssh-home.md)

## Database

`dbPath` is `statev2.sqlite`. `initializeV2Database` in
`apps/server/src/persistence/initializeV2Database.ts` runs before the server opens that file. If
`statev2.sqlite` is missing and a sibling `state.sqlite` exists, it copies the V1 file into the V2
path once, using a read-only snapshot. If the V2 file already exists, the V1 file is left alone.

Orchestration v2 tables, the channel ledger (`apps/server/src/persistence/Migrations/065_ChannelLedger.ts`),
and remote dispatch (`apps/server/src/persistence/Migrations/064_RemoteDispatches.ts`,
`apps/server/src/persistence/Migrations/063_RemoteReports.ts`,
`apps/server/src/persistence/Migrations/066_RemoteDispatchQuestions.ts`,
`apps/server/src/persistence/Migrations/068_RemoteReportRelay.ts`) are migrations on this database.
Launch watches are the exception that is not a table: they are JSON at
`<stateDir>/thread-launch-watches.json`. See [`launch-and-remote-dispatch.md`](launch-and-remote-dispatch.md).
