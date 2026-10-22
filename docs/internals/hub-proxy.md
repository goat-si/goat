# Hub proxy

A client paired only to a hub reaches every node's sessions through the hub. The node stays
its own environment on the client, with its real environment id; the hub is just one more
route to it, so the existing timeline, approval and composer screens work unchanged. This page
covers the decisions and traps behind that. The node list itself belongs to
[HubNodes](../../apps/server/src/hubNodes/HubNodes.ts).

## One environment, one more route

A node keeps its own environment id on the client and gains a `hub-proxy` route. The route
stores no credential. It names the hub environment and the hub route the client used, and
preparing it borrows that route's credential
([HubProxyAuthSource](../../packages/client-runtime/src/connection/hubProxyAuthSource.ts)).
That keeps one session, one shell and one retry owner per node, deduplicates a node the client
also reaches directly, and means unpairing the hub cannot leave node credentials behind.

The resolver must not depend on the registry: the registry builds drivers, which build the
resolver. The auth source reads the profile and credential stores and the web primary endpoint
instead.

Everything for a node lives below `/hub/nodes/<nodeId>/`. Client HTTP helpers used to reset the
path to `/`, and the socket builder only appended `/ws` to a root path, so prefix handling sits
in the shared URL helpers. Never normalize a proxied base to its origin. The Vite dev proxy
forwards `/hub`, including WebSocket upgrades, because dev is single origin.

## Two layers of authority

The client authenticates to the hub with its normal hub session: cookie, bearer, DPoP or the
hub's own `wsTicket`. Proxying needs the `hub:proxy` scope. It is granted only on request
(`goat pair --hub-proxy`), never by default and never implied by another scope. Signed sessions
decode their scopes strictly, so a server rolled back to a build without `hub:proxy` rejects
every session carrying it. Keeping it opt-in limits that to hub pairings; after a rollback,
pair those devices again. Node sessions never carry `hub:proxy`: they hold only the forwarded
scopes, which every supported node already knows, so an older node never meets an unknown scope.
Node-signed asset URLs
are capability URLs, described below; they can be loaded by native images and browser media
without a hub header.

The hub reaches the node with a session it holds itself:

- SSH and cloud nodes: the hub runs `goat auth session issue --subject hub-proxy` on the node
  over SSH, with explicit scopes and never `mcp-client`, because node `/ws` refuses that
  audience. Sessions are cached per node and exact scope set, refreshed ten minutes early, and
  dropped when the node answers 401.
- Linked nodes: their link token is an MCP credential and cannot open `/ws`. An admin spends a
  pairing link from that node once (`hubProxy.enrollNode`). The hub exchanges it at the node's
  `/oauth/token` for a bearer and keeps it in the server secret store under a hashed name. A node
  HTTP or WebSocket 401 marks that enrollment rejected until an admin enrolls again; it does not
  retry the same token or ask the client to pair with the hub again.

A client's rights on a node are its hub scopes intersected with
`HUB_PROXY_NODE_SCOPE_CEILING` ([hubProxy.ts](../../packages/contracts/src/hubProxy.ts)) and,
for linked nodes, with what the node granted at enrollment. The hub enforces this before
anything reaches the node: every client RPC envelope, batches included, goes through the
server's own `authorizeRpcCall` plus a method policy
([frames.ts](../../apps/server/src/hubProxy/frames.ts)). Calls that need more than
`orchestration:read` must be listed in the policy with a payload check, because one scope
(`orchestration:operate`) covers far more than the hub offers. A refusal is answered by the hub
as an RPC failure carrying `EnvironmentAuthorizationError` for the client's own request id, with
its JSON type kept: the RPC client ignores an exit whose id it does not recognize, so `"12"`
for `12` would leave the call hanging. An SSH node session holds exactly the intersection, so
the node enforces it again. A linked node only enforces its enrollment grant, which is why the
hub check is not optional.

The policy lets a client send a follow-up (`message.dispatch`), stop a run (`run.interrupt`),
upload the attachments a follow-up references, answer a provider's approval request or question
(`runtime-request.respond`, `thread.user-input.dismiss`), and start a thread
(`orchestration.launchThread`, `thread.create`), browsing the node's folders and registering an
existing one as a project. A project carries no scripts (they need `settings:write`) and the hub
never asks the node to create a missing folder. A launch into a new worktree still creates it and
runs the node's configured setup script: `orchestration:operate` already lets a client run an
agent there, so the hub does not narrow launch strategies. Every other orchestration command, such as
archiving, deleting or renaming a thread, stays with the node's own clients. Approval support is
each provider's own on the node; the hub only forwards the generic response.

A forwarded follow-up carries only what a person's composer sends: text, context, attachments
that are pending uploads or already belong to that thread, the model picked in the composer, and
the plan it implements. The model and plan stay because ordinary follow-ups send them, and an
`orchestration:operate` session on the node itself allows the same. Fields only automation sets
(scheduled tasks, notifications, delegated completion, usage-limit recovery), a sender other than
the user, a deferred start that prepares a workspace, and memory grants are refused.

The same attachment rule holds for a launch's first message and for files attached to an answer:
a node hands any stored attachment id to its provider, whichever thread stored it, so the hub
admits only pending uploads and the destination thread's own files. A launch without a thread id
creates a thread that owns nothing yet, so it may carry pending uploads only.

The proxied `/api/auth/session` reports the intersection and `proxiedByHub: true`. Client
command permissions mirror the method policy for such sessions
([commandPermissions.ts](../../packages/client-runtime/src/state/commandPermissions.ts)), and the
RPC transport refuses such a call on a hub-proxy route before sending it
([client.ts](../../packages/client-runtime/src/rpc/client.ts)). Not every action reads a
permission atom, and the mirror only knows the client-guarded scopes, so some refused actions
stay visible and fail with the hub's refusal; the hub stays authoritative.

## Node credentials never leave the hub

- `/api/auth/websocket-ticket` and `/api/auth/session` under a node path are answered by the
  hub with hub state. A node ticket is a credential too, so none is ever requested.
- The upstream socket and requests carry `authorization: Bearer <node session>` set by the hub.
  The client's `wsTicket` and other credential query parameters are removed. The node would
  prefer a ticket over the header and fail, and the hub ticket must not reach the node.
- Only an allowlist of read paths is proxied. Auth, pairing, OAuth, `/mcp`, activity and
  runtime-control paths are not served under a node. Responses keep only content headers, so a
  node's `Set-Cookie` or `Location` never reaches the client.

Node-signed `/hub/nodes/<nodeId>/api/assets/<token>/<file>` URLs carry the node's asset
capability. GET and HEAD need no hub authentication, but only use a current, unexpired in-memory
node session with `orchestration:read`. Without one they return 404. This path never reads an
enrollment, issues a session, or dials SSH. The node validates the asset signature; the hub adds
only its cached node bearer and applies the same request and response header allowlists.
Signed attachment upload URLs (`POST .../api/attachments/upload/<token>`) work the same way, but
need a cached session with `orchestration:operate`. The body streams to the node unbuffered;
the node checks the token, size and type as it does for its own clients.

## Lifecycle

There is one upstream socket per client socket, so request ids, streams and Acks never mix
between clients. The hub dials the node and waits for it to accept before upgrading the client.
A dead node is a 503 the client's supervisor retries, not an open socket that never answers.
Effect's `makeWebSocket` dials when its reader is acquired, so the reader is acquired before
`request.upgrade`. When either side closes, both close, and the client resubscribes on its next
session.

A relay also ends when the client's hub session is revoked, or when the node's generation
changes: unenrollment, a new enrollment, removal from the node list, or a change of its
preferred route. Open and enrollment capture their generation and route before waiting for a permit or reading
credentials and re-check both against the node list before publishing. Enrollment captures that
baseline before fetching the descriptor, so a slow exchange cannot restore access that was just
removed. Snapshot publication also checks its originating generation atomically. A node that is merely offline keeps
its generation.

## Offline

While a relay to a node is open, the hub keeps a copy of the node's shell. It refreshes the copy
when a client reads the shell, every 60 seconds, and once more when the last relay closes. The
copy is capped at 4 MiB of encoded bytes and served at `/hub/nodes/<nodeId>/snapshot` to clients that may read
the node. When a hub-proxy environment cannot connect, the client hydrates its shell from that
copy. A live snapshot always replaces it. The offline age shown is the capture time stored with
the snapshot actually displayed. If the client is showing its own newer cache without a known
capture time, it shows no age.

A node the hub cannot reach is answered with `503 hub_node_unavailable`, which clients treat as an
unreachable host: quiet retries on the normal backoff. Every open asks the SSH manager for the
node's endpoint, and the manager probes a reused forward and relaunches the node's server behind a
new one when it stopped. A cached node session outlives that forward, so the upstream is rebuilt
from the session's credential and the current endpoint; reusing the cached address kept a
recovered node unreachable on a dead local port.

Shell reads stream to the client while retaining at most that cap, and only complete bodies are
cacheable. Oversized bodies keep streaming without a retained copy. Background refreshes stop
reading at the cap and have a 20-second Clock deadline covering headers and body.

Cloud machines are never woken by proxying. A stopped machine is offline until someone resumes
it.

## Threat model

The hub host is fully trusted: it holds SSH keys and node sessions for every node, so its disk
must be encrypted and its screen locked. Clients are trusted within their scopes. Other tailnet
peers and nodes are not trusted with anything the hub holds.

| Threat                                                                 | Mitigation                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A stranger makes the hub dial nodes                                    | Authentication and `hub:proxy` precede session acquisition; capability assets use cached sessions only                                                                                                                                |
| Capability asset URLs are loaded without hub headers                   | The node validates its signed URL; only current, unexpired cached read sessions are forwarded, with no SSH or enrollment read                                                                                                         |
| Capability upload URLs are posted without hub headers                  | The node validates its signed URL; only cached sessions with `orchestration:operate` forward, with no SSH or session acquisition, as a streamed request to the cached node endpoint bounded by size, deadline and four slots per node |
| An old or narrowed pairing proxies                                     | `hub:proxy` is required; it is not implied by any other scope                                                                                                                                                                         |
| A client exceeds its rights on a node                                  | Per-envelope `authorizeRpcCall` against the intersection, then the method policy, before forwarding                                                                                                                                   |
| A full-scope client reaches settings, terminals or providers on a node | The ceiling excludes them; the node session never holds them                                                                                                                                                                          |
| A batch smuggles a forbidden call                                      | Every envelope is judged; only refused ids are answered locally                                                                                                                                                                       |
| Node credentials reach the client                                      | Hub-answered auth endpoints, header and query allowlists, no node tickets                                                                                                                                                             |
| Hub tickets reach a node                                               | Credential query parameters are stripped before dialing                                                                                                                                                                               |
| Path tricks pick another destination                                   | The node id only selects an entry in the hub's node list; upstream URLs come from that entry                                                                                                                                          |
| Access survives revocation, unenrollment or node removal               | Relays race session invalidation and the node generation                                                                                                                                                                              |
| A stale session is reused at a broader scope set                       | The session cache key is the exact scope set                                                                                                                                                                                          |
| Proxied requests are forged cross-site                                 | Cookie authentication keeps the hub's origin checks                                                                                                                                                                                   |
| Loopback-only node endpoints become reachable                          | They are not on the allowlist                                                                                                                                                                                                         |
| Browsing a cloud node wakes or bills it                                | Proxying uses the never-wake readiness path                                                                                                                                                                                           |
| A large node shell exhausts hub memory                                 | Byte-counted copies are capped per node; refresh reads stop at the cap and have a whole-response deadline                                                                                                                             |
| A peer that stops reading makes the hub queue relay frames             | Each relay direction sends with ws completion callbacks and pulls again only once its last batch is sent, and closes past 8 MiB queued, compression queue included ([relay.ts](../../apps/server/src/hubProxy/relay.ts))              |
