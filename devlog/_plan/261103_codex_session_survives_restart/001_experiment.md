# 001 — Experiment: detached codex app-server over a Unix socket

Date 2026-11-03, macOS arm64, codex-cli 0.163.0 (native binary under vite-plus node 26.13.0), isolated CODEX_HOME=/tmp/gcx/home,
mock Responses provider on 127.0.0.1 (model_provider=mock, wire_api=responses, requires_openai_auth=false). No credentials, no paid calls,
no GOAT server touched. Scripts: /tmp/gcx/{mock.cjs,client.mjs,phaseA.mjs,phaseB.mjs,phaseC1.mjs,phaseC2.mjs,big.mjs,*measure.mjs}.
Client = undici WebSocket with Agent({connect:{socketPath}}) to ws://localhost/.

## A. Client crash mid-turn
spawn('codex',['app-server','--listen','unix:///tmp/gcx/run/s.sock'],{detached:true,stdio:['ignore','ignore',log]}); unref.
initialize -> thread/start -> turn/start (status inProgress); mock holds the SSE stream; client SIGKILLs itself.
Notes before crash: thread/started, thread/status/changed, turn/started, item/started, item/completed.
After: pid 71212 alive, PPID 1, own process group (PGID 71212).
Socket: /tmp/gcx/run/s.sock -> symlink to /private/tmp/codex-daemon-501/<sha256> (srw-------), dir drwx------; alias dir created 0700.

## B. Reattach while the turn is still running
New connection: initialize -> thread/resume {threadId}:
  status {"type":"active"}, turns [{status:"inProgress", items:["userMessage"]}].
Mock released -> new connection received item/started, item/completed, thread/tokenUsage/updated, thread/status/changed, turn/completed.
thread/read: turn completed, items [userMessage, agentMessage:"released-1"].

## C. Turn finishes while no client is attached
turn/start, client SIGKILL, mock released, 2 s later reconnect: thread/resume status {"type":"idle"}, the turn completed with
agentMessage "released-2". Notifications on the new connection did NOT include the missed item/turn events -> no replay;
reconcile from history. A second concurrent connection could thread/read the same thread.
Mock log: the model stream stayed open across the client crash ("client closed stream" only after release).

## D. Limits
thread/read padded to 1 MB and 15 MB: ok. 20 MB single frame: server closed the connection (1006).
Codex uses tungstenite defaults (max_frame_size 16 MiB, max_message_size 64 MiB) -> GOAT must fragment outgoing messages
(ws: send(chunk,{fin:false})) and must not cap incoming messages below Codex's own sizes. Stdio JSONL had no cap.

## E. Resources (fresh, after initialize)
stdio: native app-server 47 fds, RSS 61.4 MB. unix: 48 fds (+listener), RSS 61.9 MB, 6 unix sockets vs pipes.
GOAT side: stdio needs 3 pipes per child; UDS needs 1 socket.

## F. Termination
kill -TERM -<pgid> after checking argv contains the socket path: process exited, socket file and alias removed by Codex itself.

## G. Codex source anchors (b01148de59)
app-server-transport/src/transport/unix_socket.rs:34 CONTROL_SOCKET_MODE 0o600; :80-96 parent dir 0700 + owner check;
:99-105 physical socket under shared daemon dir + rendezvous symlink.
app-server/src/lib.rs:1195-1218 stdio close ends single-client mode; UDS connections do not stop the server.
app-server/src/request_processors/thread_lifecycle.rs:58-64 unload needs no subscribers AND inactive.
cli/src/main.rs:644,710 `app-server proxy --sock` relays raw bytes (still WebSocket framing) -> not useful, extra process.


## H. Implementation checks run 2026-11-03 (014 residuals, macOS)
- `lsof -t -- <physical path>` returns the listener pid (28046); on the alias symlink it returns nothing -> always resolve the alias first.
- Physical path length 94 bytes (/private/tmp/codex-daemon-501/<64 hex>).
- `ps -A -ww -o pid=,pgid=,command=` gives full argv with the socket path; spawn('codex') from this PATH ran the native binary as the
  group leader (launcher exec'd), so group = 1 process here; the Node-launcher case (leader + native child) must still be handled.
- After SIGKILL of the app-server the physical socket FILE remains (stale, nothing listening; lsof empty). Liveness must be
  "accepts a connection", never "file exists". The stale file lives in Codex's own dir; GOAT unlinks only its alias.

