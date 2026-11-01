# ADR-0015 — iMessage as a local channel kind

- Contract owner: [channels.md](../channels.md#gateway)
- Commit: pending on `codex/goat-imessage-ui` (recorded before implementation, 2026-10-19)

## Decision record

- 목적과 의도: Let a person text GOAT Bot from Apple Messages on the Mac that holds the GOAT Bot home, through the same gateway and ledger as GOAT, Slack, and MCP input, and get replies in the same Messages chat.
- 기존 구현 및 제약 조건: `ChannelKind` is `goat`, `slack`, `mcp` (`packages/contracts/src/channelCommon.ts`). Apple offers no public Messages API on macOS. Messages stores history in `~/Library/Messages/chat.db`, which needs Full Disk Access to read, and Messages accepts sends through AppleScript, which needs Automation permission.
- 검토한 주요 대안: Private Messages APIs (BlueBubbles private bundle), a hosted relay line (OpenInstinct uses Linq), an on-demand MCP tool instead of a channel, and treating an allowlisted phone number as an authorized requester.
- 선택한 방식: `ChannelKind` gains `imessage` with reply address `{ kind, connectionId, chatGuid }`. A macOS-only runtime opens chat.db read-only, polls by message `ROWID` from the worker-owner pass, and stores its cursor in `channel_runtime_state` behind the worker fence. Only direct iMessage chats from allowlisted handles are admitted; admission then goes through the same identity-link path as Slack, so an allowlisted but unlinked sender gets a link notice and cannot start work. Replies go to the same existing chat through a fixed AppleScript with user text passed as argv. An uncertain send is recorded as ambiguous and never retried. The adapter is off by default and configured by a `goat imessage` CLI with an `approval-required` ceiling unless the operator opts into full access.
- 다른 대안 대신 이 방식을 선택한 이유: Read-only polling plus public AppleScript keeps the adapter on supported macOS surfaces and needs no third-party service. One ledger keeps retries, deliveries, and permissions identical to Slack. Separating the allowlist from identity keeps a phone number from becoming a credential.
- 장점, 단점 및 영향: Works only on a signed-in Mac with Full Disk Access and Automation granted to the process that runs the server. Text-only direct chats; groups, attachments, and tapbacks are out. Polling adds up to one poll interval of latency. Messages delivery is not confirmed by AppleScript success.
