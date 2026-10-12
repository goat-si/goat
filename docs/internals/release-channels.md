# Release channels

GOAT ships two release channels from one workflow, `.github/workflows/goat-nightly.yml`. This page records why the channels look the way they do and the rules that keep them consistent. Runner and signing setup live in [the Mac release runner guide](../operations/goat-mac-release-runner.md); the user view lives in [Updating GOAT](../user/updating.md).

## Where releases go

goat-si/goat is private, so its releases are unreachable by an installed app or an SSH host without credentials. Every release is published to the public binary repository **goat-si/goat-releases** instead. The desktop feed (`DESKTOP_UPDATE_REPOSITORY`), the SSH runtime supply and `goat update` (`CLI_RELEASE_REPOSITORY` in `packages/shared/src/cliRelease.ts`), and the install scripts all read from that one repository, so one publication updates every consumer.

Each release carries the same set of files on both channels:

- desktop installers: signed and notarized macOS DMG and ZIP (arm64, x64), Windows NSIS (x64, arm64), Linux AppImage and `.deb` (x64, arm64), with blockmaps;
- electron-updater manifests, merged across architectures (`<channel>-mac.yml`, `<channel>.yml` for Windows, `<channel>-linux.yml`, `<channel>-linux-arm64.yml`);
- CLI runtime archives `goat-<version>-<platform>-<arch>.tar.gz` (`.zip` on Windows) for darwin-arm64, linux-x64, linux-arm64, win32-x64 and win32-arm64, which SSH hosts download to run the matching server;
- `SHA256SUMS` covering every file, the install scripts, and third-party notices.

## Channels

|                  | Nightly                                                 | Stable                             |
| ---------------- | ------------------------------------------------------- | ---------------------------------- |
| Starts from      | a successful goat-ci run of a dev push, or a manual run | a manual run with `channel=stable` |
| Version          | `X.Y.Z-nightly.YYYYMMDD.N`                              | `X.Y.Z`                            |
| GitHub release   | prerelease, never latest                                | full release, marked latest        |
| Update manifests | `nightly*.yml`                                          | `latest*.yml`                      |
| Desktop app      | "GOAT (Nightly)", its own app ID                        | "GOAT"                             |
| Retention        | pruned after 30 releases or 30 days                     | kept                               |

`X.Y.Z` is the version in the four release manifests that `scripts/check-release-version.ts` keeps in step. Everything else follows from the version string: `resolveDesktopUpdateChannel` picks the branding and the feed channel, and `cliReleaseChannelOf` picks the runtime channel. A build therefore cannot ship with a feed that disagrees with its name.

Both channels share one workflow because they differ only in version, manifest prefix, and release type. A separate stable workflow would duplicate the signing, verification and publish gates that the pre-push guard pins, and the two copies would drift.

## Cutting a stable release

Stable is a promotion of a commit that already ran as a nightly. Run the workflow with `channel=stable` and `sha` set to that nightly's commit. The release uses the plain version from the manifests.

After a stable `vX.Y.Z` is published, bump the release manifests to the next version. A nightly is a prerelease of `X.Y.Z` and sorts below it, so nightly installs would never move past the stable release and the no-downgrade rule would strand them. The prepare job enforces this: it refuses to build a nightly or a stable release while `vX.Y.Z` already exists in goat-releases.

## Publishing gate

Building and publishing are separate decisions:

- With the repository variable `GOAT_RELEASES_PUBLISH` unset, dev pushes start nothing, and a manual run builds, signs and verifies everything, then stops. The verified files remain on the run as the `release-assets` artifact, which is how to dry-run a channel.
- With `GOAT_RELEASES_PUBLISH=true`, every successful dev push publishes a nightly, and a manual run publishes when its `publish` input is checked.

Only the hosted publish job reads the goat-releases App credentials. Publishing is idempotent per tag: identical bytes count as already published, and different bytes fail the run rather than replacing a release that users may already have.
