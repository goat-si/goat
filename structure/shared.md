# Shared

`packages/shared` (`@goat/shared`) is a library of subpath exports. `packages/shared/package.json`
has no `"."` barrel. Server, desktop, web, and mobile import the module they need.

The exports that the rest of this map depends on:

| Export                            | File                                                                | Role                                                                                  |
| --------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `@goat/shared/serverSettings`     | `packages/shared/src/serverSettings.ts`                             | Patch and merge helpers for `ServerSettings`, including `goatBotHome` monotonic merge |
| `@goat/shared/devHome`            | `packages/shared/src/devHome.ts`                                    | `resolveWorktreeHome` and `resolveGitWorktreePath`                                    |
| `@goat/shared/mobileAppIdentity`  | `packages/shared/src/mobileAppIdentity.ts`                          | `MOBILE_APP_IDENTITY` for the GOAT mobile variants                                    |
| `@goat/shared/sshRuntimeProtocol` | `packages/shared/src/sshRuntimeProtocol.ts`                         | `SSH_RUNTIME_PROTOCOL_VERSION`, consumed by `packages/ssh`                            |
| `@goat/shared/cliRelease`         | `packages/shared/src/cliRelease.ts`                                 | Runtime archive names and download URLs for SSH host installs                         |
| `@goat/shared/KeyedLock`          | used by `apps/server/src/orchestration-v2/ThreadCommandExecutor.ts` | Per-thread command serialization                                                      |

Path helpers in `packages/shared/src/path.ts` normalize paths. They do not choose a home directory.
Home selection is [`settings-and-storage.md`](settings-and-storage.md).

Theme palettes (`packages/shared/src/themePalettes.ts`) and the other presentation helpers in this
package are shared data, not a second settings store. Environment settings still persist in the
server's `settings.json`.
