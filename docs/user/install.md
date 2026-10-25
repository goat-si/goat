# Install GOAT

GOAT runs coding agents on your computer and lets you control them from its
desktop, web, or mobile app. Set up the machine where the agents will work first.

## Requirements

You need an installed, authenticated provider before starting a thread. You can
launch GOAT and configure providers afterwards.

## Command line

```bash
curl -fsSL https://raw.githubusercontent.com/goat-si/goat-releases/main/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://raw.githubusercontent.com/goat-si/goat-releases/main/install.ps1 | iex
```

This installs the `goat` binary to `~/.local/bin`. If your shell reports `command not found`
afterwards, that directory is not on your `PATH` yet; the installer prints the
line to add. Set `GOAT_CHANNEL=nightly` to install the nightly train, or
`GOAT_VERSION` to pin an exact version.

| Task                                             | Command                                                                   |
| ------------------------------------------------ | ------------------------------------------------------------------------- |
| Start the server and open the web app            | `goat`                                                                    |
| Start the server without a browser               | `goat serve`                                                              |
| Keep it running in the background (macOS, Linux) | `goat service install` ([details](./background-service.md))               |
| Move to the newest release                       | `goat update`                                                             |
| Reclaim database space                           | `goat doctor` ([details](./background-service.md#reclaim-database-space)) |
| Remove it again                                  | `goat uninstall`                                                          |

Run `goat help` or `goat --help` for the full reference. To start in a new working
directory, use an explicit path such as `goat ./my-project`. A bare directory name
is accepted only if it already exists.

If `goat` or `goat start` reports an already running server, connect to that server
instead. Stop it before starting a replacement, or use a different `--base-dir`
for an independent server.

### Install with npm

GOAT is distributed as an npm-installable tarball in
[GOAT Releases](https://github.com/goat-si/goat-releases/releases), rather than
through an npm registry package. The unscoped `goat` registry package is an
unrelated blockchain toolkit; `t3` is upstream T3 Code.

With Node.js 20.11 or newer and npm installed, install the latest stable release:

```bash
npm install --global https://github.com/goat-si/goat-releases/releases/latest/download/goat-npm.tgz
goat --version
goat help
```

For an exact stable or nightly version, copy its tag from GOAT Releases and use
that release's `goat-npm.tgz` URL. For example, in a POSIX shell:

```bash
# Enter the version from the release tag, without the leading v.
read -r GOAT_VERSION
npm install --global "https://github.com/goat-si/goat-releases/releases/download/v${GOAT_VERSION}/goat-npm.tgz"
```

This route becomes available with the first release containing `goat-npm.tgz`;
older releases require the archive installer above. The tarball has the private
identity `@goat-si/goat` and exposes `goat` plus the legacy `t3` command. This does
not claim that npm scope is available or published. If you already have a separate
`t3` command, use a dedicated npm prefix rather than forcing npm to overwrite it.

The first invocation downloads the exact version's CLI archive and checks its
SHA-256 against `SHA256SUMS`. Later invocations stay pinned to that npm package's
version. To update, install the target release's tarball again with the same npm
prefix. For a custom prefix, use `npm --prefix <prefix> install --global <URL>`
and put that prefix's executable directory on `PATH`. Native `goat update` can
update the server runtime but does not change an npm-owned launcher pin.

For a clean Linux or cloud machine, set up its
[OpenCodex Child](./providers-codex.md#use-opencodex-home) on that same machine,
install GOAT above, then run `goat serve`. Add the environment's
[MCP URL](./outside-agents.md#get-the-mcp-url) to your agent and authorize it
through the normal sign-in flow. OpenCodex serves the provider; GOAT serves MCP.

### Intel Macs

There is no `goat` executable for Intel Macs (the desktop app is available). To
run a server there, build it from source with Node.js 26 and `vp`
([Install vp](https://github.com/goat-si/goat#development)):

```bash
git clone https://github.com/goat-si/goat
cd goat && vp i && vp run build:desktop
node apps/server/dist/bin.mjs
```

`goat update` and the background service do not apply to a server run this way;
update it with `git pull` and a rebuild.

### A server-only machine

For a machine you only reach from other devices, such as a VPS or a spare Mac,
install just the server. It needs no desktop app, browser or Node.js:

```bash
curl -fsSL https://raw.githubusercontent.com/goat-si/goat-releases/main/install-goat-server.sh | sh -s -- --tailscale
```

This installs the `goat` command, keeps the server running as a
[background service](./background-service.md), and prints two pairing links.
Paste the first into **Settings → Connections** on your other device, or scan
its QR code, to see the machine's threads there. Give the second to an agent in
your main GOAT so it can
[link the machine](./remote-access.md#link-a-goat-server-for-agents-without-ssh)
and start, read and message threads on it. The second link only grants agent
access. Each link works once and expires after five minutes; run `goat pair`
on the machine for new ones.

`--tailscale` publishes the server on your tailnet so other devices can reach
it. Leave it out when you reach the machine another way, such as
[direct pairing over your LAN](./remote-access.md#pair-over-a-lan-or-private-network). Pass `--no-service` to skip the
background service and run `goat serve` yourself. To install a CLI archive you
already downloaded, for example on a machine without internet access, pass
`--archive goat-<version>-<platform>-<arch>.tar.gz`.

## Desktop app

Download a release from [GitHub Releases](https://github.com/goat-si/goat-releases/releases).
On Debian and Ubuntu, install the `.deb` with `sudo apt install ./<file>.deb`.

The `.deb` updates itself like the other desktop builds. It asks for your
password to install each update. If your desktop has no password prompt, the
update fails. Download the new `.deb` and install it the same way.

### The `goat` command

The desktop app includes the `goat` command-line tool. To run it from any
terminal, open **Settings → General → About** and choose **Install** next to
**goat command**. On macOS and Linux it adds a `goat` link to a folder on your
`PATH`; on Windows it adds the app's command folder to your `PATH`. Open a new
terminal afterwards. **Remove** takes it off again. If you already have `t3`
from npm, it stays as it is. With both GOAT and GOAT (Nightly) installed, `goat`
runs the app you installed it from. If it runs the other app, choose **Remove** and
then **Install** in the app you want.

### Windows Subsystem for Linux

Choose a WSL distro in **Settings → Connections** to run agents and projects
there. Install the provider CLIs inside that distro. GOAT installs its own
server runtime there automatically; the first launch after an app update can
take longer.

### Open a project from a terminal

With the desktop app already running on the same machine:

```bash
goat app
```

This opens a new thread for the current directory, adding the project if needed.
Pass a path, such as `goat app ../my-project`, to open another directory. It requires
the desktop app, so a standalone server or an SSH session is not enough. If the
command cannot reach the app, start or update the desktop app and try again.

## Mobile app

GOAT's mobile app for iPhone, iPad and Android is in development and is not in the
App Store or Google Play yet. Today you can get it two ways:

- **iPhone and iPad:** through TestFlight, which is invite-only for now.
- **iPhone, iPad or Android:** build it from source and install it on your own
  device, following the [mobile app README](../../apps/mobile/README.md).

The phone connects to a GOAT server on another machine. Follow
[remote access](./remote-access.md) to pair it directly or over Tailscale.

The "T3 Code" app in the App Store and Google Play belongs to T3 Code, the <!-- goat-rename: legacy -->
project GOAT is forked from. It is not GOAT and cannot connect to a GOAT server,
which runs a newer server protocol than that app.

If the app crashes during launch, open Settings → Diagnostics on the next launch
that succeeds. It lists startup crashes from the last 7 days with the error and
component stack that store crash reports leave out. Copy the report and paste it
into a GitHub issue. Error messages can quote values from the app, so read it over
before sharing.

## Providers

Open **Settings → Providers** in the web or desktop app, select the environment,
and enable the provider you want. Installation, login, and configuration belong
to that environment's machine, even when you connect from a phone or another
computer.

To add one while you work, open the composer's model picker and select **+** at
the bottom of the provider list. The window lists every provider with whether it
is installed, then installs it when GOAT can and signs you in with the provider's
own flow: a browser page, a device code, an API key, or the provider's login
command in a terminal inside the window. When a provider can only sign in from
its own terminal, the window shows the command to run on that machine and
**Check again** confirms it. The picker adds providers to the environment the
composer targets, including an SSH-connected machine. The **+** is disabled when
your device cannot manage that environment's providers.

An agent can ask you to add or sign in to a provider. Its request appears as a
card in the thread; **Review request** opens the same window, and the agent never
sees what you enter.

An agent in a full-access thread can also change provider settings itself:
turn providers on or off, add one (including ACP Registry agents such as Devin),
choose which local provider Cursor Cloud, Claude Cloud, or Devin Cloud signs in
with, or remove one. With [permission profiles](./hub.md#permission-profiles) on,
its profile must allow managing providers; **Owner** does. Any other agent asks
first, and approving its card makes the change. Signing in to a provider's
account always stays with you.

| Provider    | Install and authenticate                                                                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex       | [Connect with ChatGPT](./providers-codex.md#connect-with-chatgpt), or install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`. |
| Claude      | Install [Claude Code](https://claude.com/product/claude-code), then sign in from GOAT, which runs `claude auth login` in the app.                         |
| Cursor      | Install [Cursor CLI](https://cursor.com/cli), then run `agent login`.                                                                                     |
| Grok Build  | Install [Grok Build CLI](https://x.ai/cli), then sign in from GOAT with an xAI API key, or run `grok login`.                                              |
| OpenCode    | Install [OpenCode](https://opencode.ai), then run `opencode auth login`.                                                                                  |
| Antigravity | Install and sign in with Google from GOAT's provider settings.                                                                                            |
| Pi          | Install [Pi](./providers-pi.md#set-up-pi) with Node.js 22.19 or newer, then run `pi` and `/login`.                                                        |
| Muse Code   | Install [Muse Code](https://dev.meta.ai/docs/muse-code) on the server, run `muse login`, then enable it in Settings → Providers.                          |

Provider CLIs must be on the server's `PATH`. If GOAT cannot find one, set its
**Binary path** in provider settings, especially when using a version manager.
Cursor's executable is `cursor-agent`, although its login command is
`agent login`. Codex connected through ChatGPT and Antigravity can use their
managed runtimes without a `PATH` entry.

GOAT warns when a provider version has known compatibility problems with your
release. Check **Settings → Providers** on that environment for the recommended
version or range. When its package manager supports installing a specific version,
you can install the recommendation there. Otherwise use the provider's installer
on the environment's machine. An unlisted version is unverified.

When a provider CLI is behind its latest release, its provider card shows the
available version. **Update now** runs the installer that owns the CLI
(Homebrew, or a global npm, pnpm, Yarn, Bun, Volta, or Vite+ install), or the
CLI's own update command when GOAT cannot tell. Update a CLI installed with
mise through mise. Cursor and Antigravity update with GOAT. Homebrew installs
compare against the version Homebrew offers, which can trail the npm release by
a few hours.

Add another provider instance for a separate account or configuration. Each
instance can have its own environment variables, such as API keys or a custom
base URL. Mark secret values as sensitive; after saving, GOAT does not display
their original values.

For provider-specific setup and accounts, see [Codex](./providers-codex.md),
[Claude](./providers-claude.md), [OpenCode](./providers-opencode.md),
[Antigravity](./providers-antigravity.md), [Pi](./providers-pi.md), and
[Muse Code](./providers-muse.md).

## Next steps

- [Working with threads](./thread-sidebar.md): start tasks and organize parallel work.
- [Permission modes](./permission-modes.md): choose when agents ask before acting.
- [Remote access](./remote-access.md): connect from another device.
- [Running in the background](./background-service.md): keep a Linux or macOS host available.
- [Updating GOAT](./updating.md): update the app and connected servers.
