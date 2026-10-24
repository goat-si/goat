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

|                  | Nightly                                                  | Stable                                                                                                     |
| ---------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Built from       | dev: its daily schedule or a manual run                  | a published nightly's dev commit, promoted on its own daily schedule or a manual run with `channel=stable` |
| Version          | `X.Y.Z-nightly.YYYYMMDD.N`                               | `X.Y.Z`                                                                                                    |
| GitHub release   | prerelease, never latest                                 | full release, marked latest                                                                                |
| Update manifests | `nightly*.yml`                                           | `latest*.yml`                                                                                              |
| Desktop app      | "GOAT (Nightly)", its own app ID                         | "GOAT"                                                                                                     |
| Retention        | pruned once outside the newest 30 and older than 30 days | kept                                                                                                       |

`X.Y.Z` is the patch after the newest stable tag in goat-releases, or the version in the four release manifests when that is higher, so a minor or major bump is still a one-line manifest change. Everything else follows from the version string: `resolveDesktopUpdateChannel` picks the branding and the feed channel, and `cliReleaseChannelOf` picks the runtime channel. A build therefore cannot ship with a feed that disagrees with its name.

Both channels share one workflow because they differ only in version, manifest prefix, and release type. A separate stable workflow would duplicate the signing, verification and publish gates that the pre-push guard pins, and the two copies would drift.

## Stable promotion

`dev` is the only long-lived branch and the repository's default, so schedules and manual runs use `dev`'s copy of the workflow and a workflow fix applies on the next run. Stable is a nightly that has soaked: once a day, at 15:00 KST, twelve hours after the nightly, the workflow promotes the newest published nightly that

- was published at least 24 hours ago,
- is newer than the current stable and its commit has not shipped as stable,

while no open issue carries the `release-blocker` label and the repository variable `GOAT_STABLE_HOLD` is not `true`. Otherwise it publishes nothing that day. `.github/scripts/release-train.cjs` makes the decision; the workflow runs it from its own commit, so an older nightly commit is promoted under the current rules. The build takes hours, so the serialized publish job checks again right before it creates the publishing token: a blocker opened or a hold set during the build still stops a scheduled promotion, and every release rechecks its version against goat-releases, so a nightly and a stable that ran side by side cannot publish a version that sorts below the other.

A promotion rebuilds exactly the nightly's commit with the plain version `X.Y.Z` of that nightly's base, signed and verified like every build. It never builds anything the nightly did not. The next nightly is then a prerelease of `X.Y.(Z+1)`, so no manifest bump is needed after a release.

To stop stable releases, label an issue `release-blocker` (and close it to resume), or set `GOAT_STABLE_HOLD=true` for a longer freeze. A manual run with `channel=stable` applies the same rules; with `sha` set to a published nightly's commit it promotes that nightly at once, without the soak, blocker or hold rules (`gh workflow run goat-nightly.yml --ref dev -f channel=stable -f sha=<commit> -f publish=true`). A hotfix therefore merges to dev, ships as a manual nightly of its commit, and is promoted by `sha`; it carries whatever else dev holds by then.

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
- The nightly prepare job stamps the base into its checkout and runs `check-release-version.ts --candidate <version> --published-tags <file>`: the version must sort above the newest stable and the previous build of its channel. A stable promotion also fails when the nightly's base differs from the next stable base.
- The CLI and desktop jobs verify the runtime archive (`smoke-cli-archive --expect-version`) and the bundled archives (`validateSshRuntimeArchives`) against the same version.

## Publishing gate

Building and publishing are separate decisions:

goat-ci does not run when commits land on dev. A maintainer starts it by hand (`gh workflow run goat-ci.yml --ref dev`, lane `all` by default); a run named `goat-ci all on dev` that succeeds marks its commit green. The nightly's daily schedule builds the newest green dev commit and does nothing when that commit is already a published nightly, so merges that land while goat-ci runs no longer cost the day's nightly. A manual run builds the newest green commit too, or any dev commit given as `sha` (`gh workflow run goat-nightly.yml --ref dev -f sha=<commit> -f publish=true`), which is how to ship a fix before its full run finishes.

- With the repository variable `GOAT_RELEASES_PUBLISH` unset, the schedule starts nothing, and a manual run of the nightly workflow builds, signs and verifies everything, then stops. The verified files stay for 72 hours in the run's draft release `goat-nightly-staging-<run id>--release-assets` in goat-si/goat (`node scripts/nightly-staging.ts get --repo goat-si/goat --tag goat-nightly-staging-<run id> --names release-assets --dir release` with `GOAT_RELEASES_TOKEN` set to a token with push access), which is how to dry-run a channel.
- With `GOAT_RELEASES_PUBLISH=true`, the nightly schedule publishes a nightly of each new green dev commit, the stable schedule publishes each promotion, and a manual run publishes when its `publish` input is checked.

The nightly's jobs pass their outputs to each other through such drafts, one per hand-off so parallel jobs never upload into the same release, not through Actions artifacts. goat-si is on the free plan, whose 0.5 GB Actions and Packages storage fills quickly and then fails every artifact upload; release assets do not count toward it. Each hand-off is a tar stream split into 256 MiB parts with a manifest of their sizes and SHA-256 hashes, the producer reads back what GitHub stored, and a consumer refuses any part that does not match. The cleanup job deletes the drafts when the run ends. When a job failed or was cancelled it keeps them, so "Re-run failed jobs" re-runs the failed jobs and the jobs that depend on them, reusing the hand-offs the passing jobs staged. A later run deletes kept drafts 72 hours after they were created. The pre-push guard refuses `actions/upload-artifact` and `actions/download-artifact` in both GOAT workflows.

Only the hosted publish job reads the goat-releases App credentials. Publishing is idempotent per tag: identical bytes count as already published, and different bytes fail the run rather than replacing a release that users may already have.
