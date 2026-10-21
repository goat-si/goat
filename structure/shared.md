# Shared

`packages/shared` (`@goat/shared`) is a library of subpath exports. `packages/shared/package.json`
has no `"."` barrel. Server, desktop, web, and mobile import the module they need.

The exports that the rest of this map depends on:

| Export                            | File                                                                | Role                                                                                                            |
| --------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `@goat/shared/goatConnect`        | `packages/shared/src/goatConnect.ts`                                | `GOAT_CONNECT_ENABLED=false` across server and clients; shared coming-soon copy and Tailscale guide             |
| `@goat/shared/serverSettings`     | `packages/shared/src/serverSettings.ts`                             | Patch and merge helpers for `ServerSettings`, including `goatBotHome` monotonic merge                           |
| `@goat/shared/devHome`            | `packages/shared/src/devHome.ts`                                    | `resolveWorktreeHome` and `resolveGitWorktreePath`                                                              |
| `@goat/shared/mobileAppIdentity`  | `packages/shared/src/mobileAppIdentity.ts`                          | `MOBILE_APP_IDENTITY` for the GOAT mobile variants                                                              |
| `@goat/shared/sshFailure`         | `packages/shared/src/sshFailure.ts`                                 | Browser-safe proxy diagnoses and reachability rules shared by SSH status and client reconnect supervision       |
| `@goat/shared/sshRuntimeProtocol` | `packages/shared/src/sshRuntimeProtocol.ts`                         | `SSH_RUNTIME_PROTOCOL_VERSION`, protocol ranges and `compareRuntimeProtocols` ([ssh.md](ssh.md#shared-runtime)) |
| `@goat/shared/cliRelease`         | `packages/shared/src/cliRelease.ts`                                 | Runtime archive names and download URLs for SSH host installs                                                   |
| `@goat/shared/KeyedLock`          | used by `apps/server/src/orchestration-v2/ThreadCommandExecutor.ts` | Per-thread command serialization                                                                                |

Path helpers in `packages/shared/src/path.ts` normalize paths. They do not choose a home directory.

`packages/shared/src/opencodexCompat.ts` judges linked OpenCodex pairs from served protocols
and capability features. Release numbers supply only a fallback floor; drift alone never
makes a pair incompatible.
Home selection is [`settings-and-storage.md`](settings-and-storage.md).

Theme palettes (`packages/shared/src/themePalettes.ts`) and the other presentation helpers in this
package are shared data, not a second settings store. Environment settings still persist in the
server's `settings.json`.
