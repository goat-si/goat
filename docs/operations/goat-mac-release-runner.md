# GOAT nightly releases and the Mac release runner

Merging into `dev` runs no CI. A successful full (`lane=all`, the default) `goat-ci` run that a maintainer starts by hand on `dev` (`gh workflow run goat-ci.yml --ref dev`) starts `.github/workflows/goat-nightly.yml`. It builds every platform from that commit, signs and notarizes macOS on one self-hosted Mac (the Mac Studio, `juns-mac-studio`), verifies the artifacts, and publishes a prerelease `v<version>` to the public repository goat-si/goat-releases. Windows and Linux builds are unsigned for now. The design and the decisions behind it are in `devlog/_plan/261012_release_nightly/`.

The Developer ID identity and the notary credentials live only in the Mac Studio's login keychain. The only release secret in GitHub is the goat-releases App key, which only the hosted publish job reads.

Everything below is done by a maintainer by hand. Steps 1–6 run on the Mac Studio, in Terminal, while logged in at its console (not over SSH): the runner is a LaunchAgent of the logged-in user, and only that session can use the login keychain (`launchctl managername` prints `Aqua`).

## 1. Signing identity

Export the Developer ID Application certificate for team U9ATA49N28 with its private key as a `.p12` from a Mac that has it (the release-channel design records the original under `~/secure/apple-signing/` on juns-macbook-pro), copy it to the Mac Studio yourself, then:

```sh
security import ~/Downloads/<identity>.p12 -k ~/Library/Keychains/login.keychain-db -T /usr/bin/codesign
security find-identity -v -p codesigning   # exactly one "Developer ID Application: … (U9ATA49N28)"
rm ~/Downloads/<identity>.p12
```

`security import` asks for the `.p12` password. If `find-identity` lists the certificate as untrusted, install Apple's "Developer ID - G2" intermediate certificate from https://www.apple.com/certificateauthority/.

codesign must then be able to use the key without a dialog, because nobody is there to click it during a nightly. Run the preflight (step 4) once in Terminal: when macOS asks whether codesign may use the key, enter the login password and choose **Always Allow**. If no dialog appears and the preflight still reports that codesign could not sign, set the key's partition list instead. This passes the login password on the command line, where other local processes can briefly see it:

```sh
read -rs LOGIN_PW
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -l "<private key name from Keychain Access>" -k "$LOGIN_PW" ~/Library/Keychains/login.keychain-db >/dev/null
unset LOGIN_PW
```

## 2. Notary credentials

Store the Apple ID app-specific password as the keychain profile `goat-notary`. notarytool prompts for the password, so it never appears on a command line:

```sh
xcrun notarytool store-credentials goat-notary --apple-id possuperkorea@naver.com --team-id U9ATA49N28 \
  --keychain ~/Library/Keychains/login.keychain-db
xcrun notarytool history --keychain-profile goat-notary   # succeeds, even with no submissions
```

## 3. Toolchain

The Xcode Command Line Tools are enough for codesign, notarytool and stapler. Install Rust for the runner user with both macOS targets, because the Intel app is cross-built on this Mac:

```sh
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
~/.cargo/bin/rustup target add aarch64-apple-darwin x86_64-apple-darwin
```

Node and pnpm come from the workflow. Rosetta is only needed to launch the Intel app locally (`softwareupdate --install-rosetta --agree-to-license`).

## 4. Check the Mac

```sh
bash scripts/goat-mac-runner/preflight.sh
```

Every line must read `ok`. Each macOS job runs the same script with `--ci` first and stops if anything fails.

## 5. Register the runner

```sh
bash scripts/goat-mac-runner/install-runner.sh --dry-run   # shows what it will do
bash scripts/goat-mac-runner/install-runner.sh
```

It downloads the pinned Actions runner, checks its SHA-256, registers it on goat-si/goat as `goat-mac-studio` with the labels `goat` and `mac-studio` (the token comes from your `gh` login and reaches the runner through its environment), and installs it as a LaunchAgent. It removes the `SessionCreate` key that the runner's `svc.sh` writes into that LaunchAgent: with it the runner starts in a new security session where the login keychain reads as locked, so codesign and notarytool fail even though the preflight passes in Terminal. Running it again skips the steps that are already done and repairs an existing LaunchAgent.

## 6. Keep it running

- The Mac must stay logged in. FileVault is on, so macOS cannot log in by itself after a restart: after an unplanned restart someone must unlock it at the console, which also logs the user in and starts the runner. Use `sudo fdesetup authrestart` for planned restarts.
- System sleep stays off (`pmset -g` shows `sleep 0`).
- macOS jobs run one at a time and clean their checkout each run.

## 7. GitHub setup and activation

1. **Publishing credentials.** Create a GitHub App owned by goat-si with repository permission _Contents: Read and write_, install it on goat-si/goat-releases only, and store its App ID and a private key in goat-si/goat as the Actions secrets `GOAT_RELEASES_APP_ID` and `GOAT_RELEASES_APP_PRIVATE_KEY` (`gh secret set GOAT_RELEASES_APP_PRIVATE_KEY --repo goat-si/goat < key.pem`).
2. **Protected releases.** Optionally set the repository variable `GOAT_PROTECTED_TAGS` (comma or newline separated tags) to keep bootstrap and rollback releases out of pruning.
3. **Activation.** `schedule` and `workflow_dispatch` only see workflows that exist on the default branch, which is `main`, so `goat-nightly.yml` must reach `main` (or the default branch must become `dev`) first. Confirm that the workflow is allowed under the repository's Actions policy, since every other upstream workflow is disabled. Nothing publishes until `gh variable set GOAT_RELEASES_PUBLISH --repo goat-si/goat --body true`; before that, run it by hand (`gh workflow run goat-nightly.yml --repo goat-si/goat --ref dev`) as a dry run. See [Release channels](../internals/release-channels.md) for the stable channel.
4. **Access boundary.** goat-si is on GitHub's free plan, which offers neither runner groups limited to selected workflows nor environments with required reviewers for private repositories. The runner is therefore registered on the repository, and any workflow pushed to goat-si/goat that targets the `mac-studio` label could run on it. The pre-push guard (`.vite-hooks/goat-workflow-guard.mjs`) refuses such workflows locally, but it can be bypassed. Accept that boundary explicitly before activation, or upgrade the plan and move the runner into a group limited to `goat-nightly.yml`.

## Removing the runner

```sh
cd ~/actions-runner/goat-mac-studio
./svc.sh stop && ./svc.sh uninstall
ACTIONS_RUNNER_INPUT_TOKEN="$(gh api -X POST repos/goat-si/goat/actions/runners/remove-token --jq .token)" ./config.sh remove
```

The signing identity and the `goat-notary` profile stay in the keychain until you delete them in Keychain Access.
