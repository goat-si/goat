# Shared

`packages/shared` (`@goat/shared`) is a library of subpath exports. `packages/shared/package.json`
has no `"."` barrel. Server, desktop, web, and mobile import the module they need.

The exports that the rest of this map depends on:

| Export                            | File                                                                | Role                                                                                                                                      |
| --------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `@goat/shared/goatConnect`        | `packages/shared/src/goatConnect.ts`                                | `GOAT_CONNECT_ENABLED=false` across server and clients; shared coming-soon copy and Tailscale guide                                       |
| `@goat/shared/serverSettings`     | `packages/shared/src/serverSettings.ts`                             | Patch and merge helpers for `ServerSettings`, including `goatBotHome` monotonic merge                                                     |
| `@goat/shared/devHome`            | `packages/shared/src/devHome.ts`                                    | `resolveWorktreeHome` and `resolveGitWorktreePath`                                                                                        |
| `@goat/shared/mobileAppIdentity`  | `packages/shared/src/mobileAppIdentity.ts`                          | `MOBILE_APP_IDENTITY` for the GOAT mobile variants                                                                                        |
| `@goat/shared/sshFailure`         | `packages/shared/src/sshFailure.ts`                                 | Browser-safe proxy diagnoses and reachability rules shared by SSH status and client reconnect supervision                                 |
| `@goat/shared/sshRuntimeProtocol` | `packages/shared/src/sshRuntimeProtocol.ts`                         | `SSH_RUNTIME_PROTOCOL_VERSION`, protocol ranges and `compareRuntimeProtocols` ([ssh.md](ssh.md#shared-runtime))                           |
| `@goat/shared/cliRelease`         | `packages/shared/src/cliRelease.ts`                                 | Runtime archive names and download URLs for SSH host installs                                                                             |
| `@goat/shared/cuaDriverRelease`   | `packages/shared/src/cuaDriverRelease.ts`                           | Pinned Cua Driver archives and the host options that turn its telemetry and update check off ([server.md](server.md#computer-use))        |
| `@goat/shared/cuaDriverManifest`  | `packages/shared/src/cuaDriverManifest.ts`                          | The capability manifest both driver hosts write at start: allowed tools and the apps agents may use ([server.md](server.md#computer-use)) |
| `@goat/shared/KeyedLock`          | used by `apps/server/src/orchestration-v2/ThreadCommandExecutor.ts` | Per-thread command serialization                                                                                                          |

Path helpers in `packages/shared/src/path.ts` normalize paths. They do not choose a home directory.
Home selection is [`settings-and-storage.md`](settings-and-storage.md).

Theme palettes (`packages/shared/src/themePalettes.ts`) and the other presentation helpers in this
package are shared data, not a second settings store. Environment settings still persist in the
server's `settings.json`.
