# GOAT Mobile

> [!WARNING]
> GOAT Mobile is in development. Team members install it through TestFlight; see
> [Mobile TestFlight builds](../../docs/operations/mobile-testflight.md). You can also build it from source.

## Quickstart

> [!NOTE]
> Uses native modules so using Expo Go is not supported. You need to use the Expo Dev Client.

This app has three variants:

- `development`: Expo dev client, installable side-by-side as `GOAT Dev` (`si.goat.mobile.dev`)
- `preview`: persistent internal preview build, installable side-by-side as `GOAT Preview` (`si.goat.mobile.preview`)
- `production`: TestFlight/release build as `GOAT` (`si.goat.mobile`)

Names, URL schemes (`goat`, `goat-preview`, `goat-dev`) and bundle ids live in
[`packages/shared/src/mobileAppIdentity.ts`](../../packages/shared/src/mobileAppIdentity.ts).

Run commands from `apps/mobile`.

GOAT Connect is coming soon. T3 Connect is disabled in every build by
`GOAT_CONNECT_ENABLED=false` in `@goat/shared/goatConnect`, even with public configuration.
Use [direct pairing or Tailscale](../../docs/user/remote-access.md#tailscale-https).
Dormant Connect configuration belongs in the repository-root `.env` or `.env.local`,
not an `apps/mobile/.env` file; see the [setup runbook](../../docs/operations/connect-setup.md).

## Development

For simulator, emulator, or Android phone development, boot or connect a device, then install the
native client that matches this checkout before starting Metro:

```bash
vp run mobile:install ios [simulator-udid]
# Or: vp run mobile:install android [emulator-or-phone-serial]
vp run dev:client
```

The device argument can be omitted when exactly one device is booted or connected. The helper
compares this checkout's Expo fingerprint and the installed binary with its last install record,
and reuses a matching client. Otherwise it installs the build for that fingerprint from
`~/.cache/t3code/native-clients/artifacts`, then the shared task cache, and builds only when
neither has it. One iOS simulator build serves every iPhone and iPad simulator, and one APK per
ABI (x86_64 or arm64-v8a) serves every emulator and phone of that ABI. Build output goes to the
log file it prints (`GOAT_NATIVE_CLIENT_VERBOSE=1` streams it instead). Builds are shared back when
your task-cache login (`bash infra/task-cache/install.sh`) can write. `GOAT_NATIVE_CLIENT_CACHE=read`
skips the upload and `off` skips the shared cache. Physical iPhones still use `vp run ios:dev`.

`--session <name>` installs into an agent-device session opened elsewhere, such as a device pool
or a cloud simulator, instead of a local device: `vp run mobile:install android --session pool-1
--metro http://<this-machine>:8081`. It uses only the cached build (x86_64 by default; `--abi`
for ARM) and fails with the next step when no machine has built this fingerprint yet.

For a read-only decision, run `node ../../scripts/mobile-native-client.ts check <ios|android>
[device]`: exit 0 means compatible, 2 means an install is needed, and 1 means an operational error.
An externally installed client is unverified until the helper installs it once.

Start Metro for an already verified dev client:

```bash
vp run dev:client
```

Metro keeps its transform cache between ordinary starts. If the cache itself is causing stale or
invalid output, clear it for one development-client start:

```bash
vp run dev:client:reset
```

Run that reset once after installing or changing the Uniwind dependency patch. Cached transforms
can otherwise reference its previous pnpm package path. Ordinary Metro starts still keep the cache.

Component edits use Fast Refresh. See [mobile development lifecycle](../../docs/internals/mobile-development.md)
before changing runtime ownership or refresh behavior.

Build and run the local iOS dev client:

```bash
vp run ios:dev
```

After changing a native dependency patch, rerun CocoaPods before rebuilding an existing iOS
project. pnpm gives each patch hash a new package path; Pods can otherwise keep compiling the
previous directory.

If your Xcode account only has a Personal Team, use a bundle identifier you control and opt into the
reduced-capability local build. Personal Team builds omit the widget and share extensions, push
entitlement, and native Sign in with Apple entitlement; builds without this opt-in are unchanged.

```bash
GOAT_IOS_PERSONAL_TEAM=1 \
GOAT_IOS_PERSONAL_TEAM_BUNDLE_ID=com.example.t3code.dev \
vp run ios:dev
```

Build and install a self-contained Release app that does not need Metro:

```bash
vp run ios:release
```

The Personal Team equivalent also needs a unique bundle identifier:

```bash
GOAT_IOS_PERSONAL_TEAM=1 \
GOAT_IOS_PERSONAL_TEAM_BUNDLE_ID=com.example.t3code \
vp run ios:release
```

Build and run the local iOS preview app:

```bash
vp run ios:preview
```

Inspect the resolved Expo config for a variant:

```bash
vp run config:dev
vp run config:preview
```

Run static checks for mobile native code:

```bash
node ../../scripts/mobile-native-static-check.ts
```

The native lint task runs SwiftLint for Swift plus ktlint and detekt for Kotlin. Missing native tools are reported as warnings and skipped locally. CI installs the default toolset from `apps/mobile/Brewfile` before running the native checks.

## EAS Builds

Preview and production variants use Expo fingerprinting so OTA updates only reach binaries with matching native dependencies, config plugins, and patches. CI uses the `preview:dev` profile to reuse a compatible native build when possible.

The development variant uses `appVersion` to avoid recalculating the native fingerprint for each Metro launch manifest. `MOBILE_VERSION_POLICY` can override either default. If you distribute a custom Release build with the development identity and publish OTA updates to it, set `MOBILE_VERSION_POLICY=fingerprint` for both its build and updates. Changing the runtime policy requires a native rebuild for OTA matching; an existing dev client can still load local Metro bundles.

Clerk and relay EAS variables do not enable Connect while the shared gate is off.
The [setup runbook](../../docs/operations/connect-setup.md) retains those settings for
the dormant implementation.
EAS builds and OTA updates also need an EAS project the GOAT account owns:
set `GOAT_MOBILE_EAS_PROJECT_ID` and `GOAT_MOBILE_EAS_OWNER`. Without them the binary ships with
updates off.

Create a PR preview dev-client build manually:

```bash
vp run eas:ios:preview:dev
```

Create a cloud dev-client build:

```bash
vp run eas:ios:dev
```

Create a persistent preview build:

```bash
vp run eas:ios:preview
```

Android equivalents:

```bash
vp run eas:android:dev
vp run eas:android:preview:dev
vp run eas:android:preview
```
