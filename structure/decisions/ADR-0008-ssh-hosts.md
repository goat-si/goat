# ADR-0008 — decision recorded under "Agent dispatch"

- Contract owner: [ssh.md](../ssh.md#agent-dispatch)
- Commit: `dfd768cb52af674316f49dadef3595fe39b8c08a` (2026-10-11)

## Decision record

- 목적과 의도: Let an agent browse a remote folder and start a thread on an SSH host.
- 기존 구현 및 제약 조건: The message says MCP tools only acted on their own server, so "run this on my Mac mini" had no path even when the desktop app was already connected to that host over SSH.
- 검토한 주요 대안: The commit message does not record a rejected transport. It describes the SSH session it added.
- 선택한 방식: Three MCP tools, named `t3_ssh_*` in this commit and later renamed by ADR-0007. `SshRemoteDispatch` and `remoteBrowse` start or reuse the remote server through `SshEnvironmentManager`, issue a short-lived MCP session over SSH, and launch a thread on the remote's own `/mcp`. Host aliases come from SSH config. SSH runs key/agent-only (`BatchMode`). The server's manager is a second client of the host: it does not stop a remote server another client is using.
- 다른 대안 대신 이 방식을 선택한 이유: The message says the local tools cannot see the other machine, so the remote server has to run the thread.
- 장점, 단점 및 영향: `apps/server/src/sshRemote/SshRemoteDispatch.ts` and `apps/server/src/mcp/toolkits/ssh/tools.ts` are still that path. The tool names are now `goat_ssh_host_list`, `goat_ssh_browse`, and `goat_ssh_thread_launch`. Launch watches and origin reports were added later (ADR-0009, ADR-0010).
