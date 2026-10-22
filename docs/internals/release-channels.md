# Release channels

GOAT ships two release channels from one workflow, `.github/workflows/goat-nightly.yml`. This page records why the channels look the way they do and the rules that keep them consistent. Runner and signing setup live in [the Mac release runner guide](../operations/goat-mac-release-runner.md); the user view lives in [Updating GOAT](../user/updating.md).

## Where releases go

Every release is published to the public binary repository **goat-si/goat-releases**, which predates goat-si/goat becoming public. The desktop feed (`DESKTOP_UPDATE_REPOSITORY`), the SSH runtime supply and `goat update` (`CLI_RELEASE_REPOSITORY` in `packages/shared/src/cliRelease.ts`), and the install scripts all read from that one repository, so one publication updates every consumer.

The runtime archives can also be released on goat-si/goat itself: the publish job attaches them and the runtime manifest with their `SHA256SUMS` lines, tagged at the built commit, with nothing else attached and nothing committed. It needs the goat-releases App installed on goat-si/goat with Contents and Workflows write (`GITHUB_TOKEN` cannot create a release at a commit whose workflows differ from the default branch) and the repository variable `GOAT_SOURCE_RELEASES_PUBLISH=true`. Without the variable the step is skipped; with it but without the App installation, the token step fails after goat-releases has already published. Moving the runtime supply and `goat update` there is then the one line `CLI_RELEASE_REPOSITORY`, once goat-si/goat carries every version that installed apps still pin. Releases published before the variable was set exist only in goat-releases. Copy them before setting it, oldest first, because the publisher skips a nightly once a newer one exists in the target: for each version, `gh release download` its runtime archives, its `goat-<version>-runtime.json` if it has one, and `SHA256SUMS` from goat-releases, keep only those lines in `SHA256SUMS`, and run `publish-nightly-release.ts --repo goat-si/goat --assets-only --target <the commit in the release name>`. The desktop feed and install scripts stay in goat-releases until they move on their own.

Each release carries the same set of files on both channels:

- desktop installers: signed and notarized macOS DMG and ZIP (arm64, x64), Windows NSIS (x64, arm64), Linux AppImage and `.deb` (x64, arm64), with blockmaps;
- electron-updater manifests, merged across architectures (`<channel>-mac.yml`, `<channel>.yml` for Windows, `<channel>-linux.yml`, `<channel>-linux-arm64.yml`);
- CLI runtime archives `goat-<version>-<platform>-<arch>.tar.gz` (`.zip` on Windows) for darwin-arm64, linux-x64, linux-arm64, win32-x64 and win32-arm64, which SSH hosts download to run the matching server;
- runtime compatibility manifest `goat-<version>-runtime.json`, also embedded as `goat-runtime.json` beside each archive’s executable. Clients use it to choose a compatible fallback before transferring an archive;
- `SHA256SUMS` covering every file, the install scripts, and third-party notices.

## Channels

|                  | Nightly                                                  | Stable                                   |
| ---------------- | -------------------------------------------------------- | ---------------------------------------- |
| Built from       | dev: its daily schedule or a manual run                  | main: a manual run with `channel=stable` |
| Version          | `X.Y.Z-nightly.YYYYMMDD.N`                               | `X.Y.Z`                                  |
| GitHub release   | prerelease, never latest                                 | full release, marked latest              |
| Update manifests | `nightly*.yml`                                           | `latest*.yml`                            |
| Desktop app      | "GOAT (Nightly)", its own app ID                         | "GOAT"                                   |
| Retention        | pruned once outside the newest 30 and older than 30 days | kept                                     |

`X.Y.Z` is the version in the four release manifests that `scripts/check-release-version.ts` keeps in step. Everything else follows from the version string: `resolveDesktopUpdateChannel` picks the branding and the feed channel, and `cliReleaseChannelOf` picks the runtime channel. A build therefore cannot ship with a feed that disagrees with its name.

Both channels share one workflow because they differ only in version, manifest prefix, and release type. A separate stable workflow would duplicate the signing, verification and publish gates that the pre-push guard pins, and the two copies would drift.

## Cutting a stable release

Stable ships main, and main changes only by promotion: merge dev into main with a merge commit titled `Merge dev into main: release <date> (GOAT X.Y.Z)`, from a dev commit that already shipped as a nightly. Then run the workflow on main with `channel=stable` (`sha` defaults to the main tip and must be on main). The release uses the plain version from the manifests.

A hotfix lands on dev first like any other change, then is cherry-picked onto main and released from there; the next promotion carries dev forward again, so the two branches never disagree for long. Never patch main alone.

After a stable `vX.Y.Z` is published, bump the release manifests to the next version. A nightly is a prerelease of `X.Y.Z` and sorts below it, so nightly installs would never move past the stable release and the no-downgrade rule would strand them. The prepare job enforces this: it refuses to build a nightly or a stable release while `vX.Y.Z` already exists in goat-releases, and its error names the bump command (see the version rule below).

## Version rule

Every build carries exactly one version, and the desktop bundle, the server inside it, and the SSH runtime archive all report it. SSH remotes download the runtime archive named after the server's version, so a server that reports a version nobody published (#339) breaks every remote. The source manifests always hold the plain base `X.Y.Z`; a build stamps its full version into all four with `node scripts/update-release-package-versions.ts <version>` before anything is built.

| Build                | Version                               | Ordered by                                             |
| -------------------- | ------------------------------------- | ------------------------------------------------------ |
| Stable               | `X.Y.Z`                               | the base                                               |
| Nightly              | `X.Y.Z-nightly.YYYYMMDD.<run>`        | date, then the workflow run number                     |
| Preview (PR builds)  | `X.Y.Z-pr.<pr>.<run>`                 | run number within one PR                               |
| Local or dev desktop | `X.Y.Z-dev.<commit unix time>.g<sha>` | commit time; SSH refresh reads it from the version too |

Only a published stable release may report the bare `X.Y.Z`. `scripts/build-desktop-artifact.ts` gives a local build of a plain base the dev version automatically, and `--build-version` (or `GOAT_DESKTOP_VERSION`) is stamped into all four manifests for the build step, then restored. Outside CI nothing ships with the bare base. In CI the release jobs stamp the manifests first and the build packages that version. With `--skip-build` the server is already built, so a bundle version that differs from the manifests fails with the stamp command. To bundle a local SSH runtime, build it at the same version: `node scripts/dev-runtime-archive.ts --version <desktop version>`.

Three checks hold the rule:

- `build-desktop-artifact` runs the built server's `--version` and fails unless it equals the bundle version, on every platform and in every build, local or CI.
- The nightly prepare job runs `check-release-version.ts --candidate <version> --published-tags <file>`: the version must sort above the newest stable and the previous build of its channel. Once the base has shipped stable it fails with `node scripts/update-release-package-versions.ts <next patch>`; merge that bump as a PR to dev and rerun.
- The CLI and desktop jobs verify the runtime archive (`smoke-cli-archive --expect-version`) and the bundled archives (`validateSshRuntimeArchives`) against the same version.

## Publishing gate

Building and publishing are separate decisions:

goat-ci does not run when commits land on dev. A maintainer starts it by hand (`gh workflow run goat-ci.yml --ref dev`, lane `all` by default); a run named `goat-ci all on dev` that succeeds marks its commit green. The nightly's daily schedule builds the newest green dev commit and does nothing when that commit is already a published nightly, so merges that land while goat-ci runs no longer cost the day's nightly. A manual run builds the newest green commit too, or any dev commit given as `sha` (`gh workflow run goat-nightly.yml --ref dev -f sha=<commit> -f publish=true`), which is how to ship a fix before its full run finishes. A schedule runs the workflow file on the default branch, main, so a trigger change takes effect at the next promotion.

- With the repository variable `GOAT_RELEASES_PUBLISH` unset, the schedule starts nothing, and a manual run of the nightly workflow builds, signs and verifies everything, then stops. The verified files stay for 72 hours in the run's draft release `goat-nightly-staging-<run id>--release-assets` in goat-si/goat (`node scripts/nightly-staging.ts get --repo goat-si/goat --tag goat-nightly-staging-<run id> --names release-assets --dir release` with `GOAT_RELEASES_TOKEN` set to a token with push access), which is how to dry-run a channel.
- With `GOAT_RELEASES_PUBLISH=true`, the schedule publishes a nightly of each new green dev commit, and a manual run of the nightly workflow publishes when its `publish` input is checked.

The nightly's jobs pass their outputs to each other through such drafts, one per hand-off so parallel jobs never upload into the same release, not through Actions artifacts. goat-si is on the free plan, whose 0.5 GB Actions and Packages storage fills quickly and then fails every artifact upload; release assets do not count toward it. Each hand-off is a tar stream split into 256 MiB parts with a manifest of their sizes and SHA-256 hashes, the producer reads back what GitHub stored, and a consumer refuses any part that does not match. The cleanup job deletes the drafts when the run ends, so re-run a failed nightly with "Re-run all jobs". The pre-push guard refuses `actions/upload-artifact` and `actions/download-artifact` in both GOAT workflows.

Only the hosted publish job reads the goat-releases App credentials. Publishing is idempotent per tag: identical bytes count as already published, and different bytes fail the run rather than replacing a release that users may already have.
