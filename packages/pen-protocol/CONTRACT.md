# Pen transport contract v1.2

The binding wire contract for every Pen component: the `pen` node (apps/pen, Go), the relay (infra/pen-relay,
Cloudflare Worker + Durable Objects) and the shared constants and vectors (packages/pen-protocol). It is derived
from the Doriterm transport contract v1.10 (sisyphuslabs/doriterm, docs/transport.md, AGPL-3.0, adapted with its
author's permission; see NOTICE). Where Pen keeps a Doriterm rule unchanged this text says so; where it differs the
difference is stated. A rule here wins over the code.

Layering, outermost first:

1. WebSocket, binary messages only. Pen nodes and clients never offer permessage-deflate (the relay's static-asset
   router accepts it when a client offers it, so the rule sits with the dialer). The only text messages are listed under "Relay text".
2. Relay mux header (between relay and node uplink only; clients never see it).
3. Noise record layer: one WebSocket message = one Noise message.
4. Stream plaintext, framed per stream (see "Streams").

## Identities

- Node signing key: Ed25519. `nodeId` = lowercase base32 (RFC 4648 alphabet, no padding) of the first 16 bytes of
  SHA-256(signPub): 26 characters (Doriterm's hostId rule).
- Node Noise static key: X25519.
- Fingerprint shown to people: first 20 bytes of SHA-256(noiseStaticPub), uppercase hex, 10 groups of 4.
- Node name: 1 to 32 characters of `a-z 0-9 - _ .`, starting with a letter or digit (herdr machine-name rule).
- Mesh id: lowercase base32 (no padding) of the first 16 bytes of SHA-256 of the founding record's body bytes.
- Domain separation prefixes (ASCII): `pen-relay-v1` (uplink challenge), `pen/1` (Noise prologues),
  `pen-mesh/1` (records), `pen-mesh/1 card` (member cards), `pen/1 join psk` (invite psk), `pen/1 invite` (invite id).

## Relay

One Worker; one Durable Object per nodeId (`idFromName(nodeId)`), SQLite-backed class, WebSocket Hibernation API.
Socket attachments carry `{role, sid, sent, acked, at, deadline}`; client sockets are tagged `s:<sid>` so a DATA frame finds its socket without a scan. The relay never decrypts, never logs payloads, enforces a
1 MiB message cap (close 1009) and forwards at once. Worker observability stays off.

- `GET /healthz` -> `{"ok":true,"version":"pen-relay/1.0"}`.
- Uplink: `GET /v1/node/<nodeId>` (WebSocket). The relay sends a 32-byte random challenge as its first binary
  message. The node answers `signPub (32) || Ed25519 signature (64)` over
  `"pen-relay-v1" || relayOrigin || nodeId || challenge`, where relayOrigin is `wss://` (or `ws://` for a local relay) followed by the WHATWG `URL.host` of the URL the node
  dialed (lowercase host, port omitted when it is the scheme default); the relay rebuilds it from its own request URL
  (`https:` -> `wss://`, `http:` -> `ws://`). A wrong length,
  signature, or a signPub whose nodeId is not the path's closes the uplink 4403; no answer within AUTH_TIMEOUT_MS
  (10 s) closes 4403. One uplink per nodeId: a newer authenticated uplink replaces the old one, which closes 4409,
  and the old uplink's client sessions close 4404. A node that gets 4409 must not reconnect on its own.
- Client: `GET /v1/client/<nodeId>` (WebSocket). No relay-level auth (the Noise layer authenticates). With no
  authenticated uplink the relay accepts and closes 4404.
- A path whose nodeId is not 26 characters of `[a-z2-7]` is HTTP 400; a non-upgrade request to a WebSocket path is 426.
- Mux frame on the uplink: `[type u8][sid u32 LE][payload]`.
  - 1 OPEN (relay -> node): no payload. The relay assigns sid: a positive u32 from a per-node counter that
    survives hibernation and uplink replacement. Past 0xffffffff the counter wraps to 1 and skips every sid still
    live for that node, so a live sid is never handed out twice.
  - 2 DATA (both ways): opaque bytes.
  - 3 CLOSE (both ways): payload = u16 LE close code. Either side closing a session sends CLOSE; the relay closes the
    client socket with that code; a client socket that closes produces CLOSE toward the node with the client's code
    (1000 when the code is outside 1000..4999).
  - Types 4-7 are reserved (Doriterm PAIR_SLOT, PAIR_SLOT_ACK, CREDIT, PASS) and close the uplink 4402 in v1.0.
- Session admission: a session is pending until the node sends its first DATA on it; at most 8 pending per node,
  each with PENDING_TIMEOUT_MS (10 s) to that first DATA, else 4408. A 9th client closes the oldest pending one 4429.
  At most 32 active sessions; a pending session whose first node DATA would make a 33rd active one is closed 4429.
- Backpressure (Doriterm v1.7.2/v1.7.3 rules): the DO keeps `sent - acked` per socket, counted in WebSocket message
  bytes as sent on that socket (uplink frames include their 5-byte header). Toward a client: DATA that would take its
  socket past 4 MiB unacked ends that session only (client 4408, CLOSE 4408 to the node). Toward the uplink, DATA
  only: a session is light while its own unacked DATA on the uplink, the message in hand included, is at most 16 KiB,
  and a light message may use the whole 4 MiB; a heavier one may fill the window only to 4 MiB minus 16 KiB for each
  other open session (at least one). DATA that does not fit ends only its session with 4408. The relay's own frames
  (OPEN, CLOSE) may use 64 KiB more; an uplink that leaves even those unacked is closed 4408. Acks are cumulative
  `a:<n>` texts counting every binary message the socket received from the relay, the uplink's 32-byte challenge
  included; a non-decimal, a decrease, or more than was sent closes the socket 4402. A receiver counts bytes as they arrive (never
  held back for a slow consumer) and sends `a:<n>` once at least 64 KiB arrived since its last ack.
- Deadlines: one alarm, always set to the earliest pending deadline (auth, pending, idle). Idle: a socket whose
  auto-response timestamp (or accept time) is older than IDLE_TIMEOUT_MS (90 s) closes 4408.
- `wrangler dev` overrides (each clamps to its default as a maximum): `PENDING_TIMEOUT_MS`, `IDLE_TIMEOUT_MS`,
  `AUTH_TIMEOUT_MS`.
- Deferred from Doriterm v1.10: typed-code pairing slots, relay passes, relay-level credit, per-source rate limits,
  multi-socket dial racing. A Pen relay ignores their query parameters.

### Relay text

| Message                    | Sender                                                                     | Meaning                         |
| -------------------------- | -------------------------------------------------------------------------- | ------------------------------- |
| `ping`                     | client or node, every 30 s                                                 | keepalive                       |
| `pong`                     | relay via `setWebSocketAutoResponse`                                       | keepalive reply (no DO wake-up) |
| `a:<total bytes received>` | receiver of relay traffic, after each 64 KiB received (counted on arrival) | cumulative ack                  |

Any other text closes the socket 1003.

A relay sends nothing when an uplink authenticates and answers `ping` on its own (the Worker even before it has
handled the uplink's answer), so no message tells a node that clients now reach its uplink. A client that dials before
the relay has handled the answer reaches the uplink being replaced, whose sessions close 4404 when it is replaced, or
no uplink (4404). A node that needs a session on its new uplink at once (`pen relay check`) opens it again until its
own side answers.

## Sessions

The first message a client sends on a session starts with one kind byte:

| kind | Name    | Rest of the first message | Noise protocol                        | Prologue                      |
| ---- | ------- | ------------------------- | ------------------------------------- | ----------------------------- |
| 0x01 | session | Noise message 1           | Noise_IK_25519_ChaChaPoly_BLAKE2s     | `pen/1` \|\| nodeId \|\| 0x01 |
| 0x03 | join    | Noise message 1           | Noise_IKpsk2_25519_ChaChaPoly_BLAKE2s | `pen/1` \|\| nodeId \|\| 0x03 |
| 0x04 | account | Noise message 1           | Noise_IK_25519_ChaChaPoly_BLAKE2s     | `pen/1` \|\| nodeId \|\| 0x04 |

nodeId is the responder's 26 ASCII characters. Any other kind byte, or a first message over 4096 bytes, closes 4400
unanswered. Kind 0x02 (Doriterm's typed code) is not used.

- Join psk = HKDF-SHA256(ikm = invite secret (32 bytes), salt = empty,
  info = `pen/1 join psk` || nodeId (26 ASCII) || noiseStaticPub (32), length 32).
- The responder's first message is Noise message 2. The initiator's first transport record after message 2 has an
  empty plaintext (key confirmation); the responder acts on the stream (dials a port, admits a card)
  only after decrypting it.
- Handshake payloads are one JSON line (UTF-8 object + LF, at most 256 bytes, `"v":1`). Message 1: `{"v":1,"stream":S,…}`.
  Message 2: always `{"v":1}`. A responder that refuses after message 1 closes without answering; one that refuses
  after confirmation (port refused, invite lost a race) sends CLOSE with the code. Nothing a replayed message 1 can
  trigger depends on the stream's target.
- Admission: kind 0x01 admits only an initiator static key that is a current member's noisePub in the responder's
  mesh view (4401 otherwise). Kind 0x03 is valid only with `stream:"join"` and an `"invite"` member:
  base64url (no padding) of SHA-256(`pen/1 invite` || secret)[0..12]. In IKpsk2 the message 1 payload is readable before
  the psk is needed (psk2 is mixed in message 2), so the responder selects the live invite by that id and derives the
  psk from its secret; an unknown or expired id closes 4401 unanswered.
- A handshake not complete within 10 s closes 4408.

## Record layer

- Noise transport messages, ChaCha20-Poly1305, 64-bit counter nonces as Noise defines.
- Maximum plaintext per message 65519 bytes. Rekey (Noise `REKEY()`) every 2^20 messages per direction; n is not reset.
- Any decryption failure closes 4400. No reordering is tolerated (WebSocket is ordered).
- Reconnect always runs a fresh handshake.

## Streams

`stream` in message 1 selects what the plaintext carries.

- `tcp` (kind 0x01; extra member `"port"`: integer 1..65535): after key confirmation the responder dials
  `127.0.0.1:<port>`; a failed dial sends CLOSE 4404 (port refused). It never dials before confirmation. Plaintext records carry an inner type byte:
  - 0x00 DATA + bytes (at most 65518).
  - 0x01 FIN: the sender will send no more DATA (TCP half-close). A session ends when both sides sent FIN, or on error.
  - 0x02 CREDIT + u32 LE: the receiver consumed that many more DATA payload bytes.
    Window: a sender keeps at most 512 KiB of DATA payload uncredited; a receiver sends CREDIT once at least 64 KiB has
    been consumed since its last CREDIT, and on FIN. A receiver that gets DATA past the window closes 4408.
- `mesh` (kind 0x01): mesh sync lines (see "Mesh").
- `join` (kind 0x03; extra member `"name"`): the join exchange (see "Mesh").
- `service` (kind 0x01; extra member `"name"`, v1.2): delivered to a local program that registered that name,
  with `tcp`'s framing (see "Services").

## Mesh

A mesh is a set of nodes that trust each other fully. Mesh traffic is ordinary sessions; the relay learns which
nodeIds open sessions to which, from which addresses and when, and nothing it can forge, replay or splice.

### Records

- Record and card bodies are parsed with exact, case-sensitive member names; a body with a member name that differs
  from a known one only by case, or with a duplicate name, is malformed.
- A record is `{"body":"<base64url of body bytes>","sig":"<base64url Ed25519 sig>"}`; `sig` signs
  `"pen-mesh/1" || SHA-256(body)` with the key `body.by`. Its hash is base64url (no padding) of SHA-256(body).
- Body: I-JSON object, at most 2048 bytes: `v` (1), `mesh` (mesh id; `"-"` only in `found`), `type`, `by` (signer
  signPub, base64url), `n` (signer counter, 1 for its first record), `prev` (hashes of the signer's current heads,
  1 to 64; empty only in `found`), `at` (ms since epoch, display only), plus:
  - `found`: `card` (the founder's own card).
  - `admit`: `card` (the joiner's card, `card.mesh` = this mesh, `card.inviter` = signer nodeId).
  - `revoke`: `subjects` (1 to 16 distinct signPubs), `compromised` (bool).
  - `name`: `subject` (signPub), `name`.
  - `hostkeys`: `keys` (0 to 8 OpenSSH public key lines of the signer's own sshd, from `/etc/ssh/ssh_host_*_key.pub`)
    and optionally `user` (the login name of the account running pen there, `[a-z_][a-z0-9_.-]{0,31}`), which members use
    as the SSH user for that node.
    A node signs a new one when its sshd keys differ from its latest `hostkeys` record.
- A member card is `{"body":"<b64url>","sig":"<b64url>"}` signed by its subject over `"pen-mesh/1 card" || SHA-256(body)`;
  body `{"v":1,"mesh","inviter","nonce","nodeId","signPub","noisePub","name"}`. A card nonce admits once. The
  founder's own card (in `found`) has `"mesh":"-"` and `"inviter":"-"`, so the mesh id (a hash of the `found` body)
  is not circular.
- A node stores a record only if it is well formed, its signature verifies, its card (if any) verifies and matches,
  and it belongs to this mesh. A record whose `prev` is all present is stored at once only if its signer is the card
  subject of a `found` or `admit` in its past (records signed by any other key are dropped), and a `revoke` only if
  each of its subjects is too; it never enters the pool.
  A record whose `prev` is not all present waits in an in-memory pool of at most 256 records and at most 16 per signer
  key, the oldest dropped first; the pool is not persisted. A node's own records never enter the pool. A mesh holds at
  most 4096 records: a record that is not a `revoke` is refused once 3840 are stored, and a `revoke` once 4096 are
  stored, so a set full of other records can still revoke and every set fits a 4096-hash `have`. A node reloading its
  own saved set applies no cap. A node that refuses a received record for a cap closes that sync 4508 without its
  `done`, and one that cannot save what it received closes it 4507, so the sender learns the records were not taken.
  Limit: no signer has a share of the record space, so one member can fill it with valid records (ordinary ones to
  3840, then revokes to 4096), after which every node refuses every new record, the revoke of that member included;
  the remedy is a new mesh.

### View

Replay the record set in canonical order: Kahn's topological order over `prev` edges, smallest hash first among
ready records, comparing the raw 32-byte SHA-256 values as unsigned bytes (not their base64url text). Start with no members. Own chain: a record with `n > 1` has no effect unless the signer's record with
counter `n - 1` is in its past; a second record with the same signer and `n` (a fork) has no effect. `found` makes its card's subject a member. A record whose signer is not a
member at its turn has no effect. `admit` makes the card subject a member unless that signPub is revoked, the card
nonce was used, or the card's noisePub or nodeId already belongs to a member. `revoke` marks each subject revoked and removes it; with `compromised`, it also revokes every key
the subject admitted, transitively, as of that point. `name` sets a current member's name; `hostkeys` replaces the signer's
SSH host keys. Revoked keys never return. Known weakness: a stolen member key can choose `prev` and grind a
record hash so its revoke of honest members sorts before its own revocation; the remedy is a new mesh. Every node computes the same view from the same set, whatever order records arrived in.

### Join

1. The inviter's `pen invite` creates an invite `{id, secret (32 random bytes), expiresAt}` (default 10 minutes, single use)
   and prints a token: `pen1_` + base64url(no padding) of
   `version (1) || signPub (32) || noisePub (32) || secret (32) || relayURL (UTF-8)`. An inviter with several relays
   prints version 2 instead (see "Several relays"). The relay URL follows the version 2 scheme rule: `https` or `wss`,
   `http` or `ws` only for a loopback host. An invite that expired is refused and removed from the inviter's store.
2. The joiner dials `/v1/client/<inviter nodeId>` with kind 0x03, `{"v":1,"stream":"join","invite":"<id>","name":"<name>"}`.
3. The inviter sends `{"t":"offer","mesh":"<id>","inviter":"<nodeId>","nonce":"<b64url 16 bytes>"}`. The joiner answers
   `{"t":"card","card":{…}}` whose noisePub equals the key it authenticated with. The inviter burns the invite before
   it signs (an atomic check-and-set under the state lock; the loser of a race gets CLOSE 4401), signs an `admit`,
   and sends the whole set as `records` lines of at most 64 records each, then `{"t":"done","mesh":"<id>"}`.
4. The joiner checks the founding record against the mesh id and that the view makes it a member, then stores the set.
   Any refusal is `{"t":"refused","reason":"…"}` then close 4401.

### Sync

Stream `mesh` lines are UTF-8 JSON objects with a string `t`, LF-terminated, at most 256 KiB. `{"t":"hello","have":[hashes]}`
from each side (a `have` list longer than 4096 hashes is 4400); each answers with zero or more
`{"t":"records","records":[…]}` lines of at most 64 records (the ones the peer's `have` lacks) and `{"t":"done"}`. A node pushes after every record it signs (dialing each online member), on its uplink's return, and
every 10 minutes. Unknown `t` is ignored; a malformed or oversized line closes 4400. One session carries at most
4352 records (4096 stored plus 256 waiting for their `prev`, all an honest member can hold); a side that receives more
closes 4400.

### Revocation and leave

`pen revoke <member> [--compromised]` signs a `revoke` and pushes it; `--compromised` also accepts a key that is
already revoked (a machine found stolen after it left). Every member closes the revoked keys' sessions
(4401) and refuses them from then on; a session on which the revoke itself arrived is closed only after this side
sent its `done`, so a leaving node learns its push was taken. `pen leave` signs a revoke of its own key, pushes it, stops its uplink and
deletes its keys.

## Several relays

A node may use several relays at once. Each runs the contract in "Relay" on its own; relays do not talk to each other.

- Uplink per relay: the node keeps one authenticated uplink on every relay in its list (`config.json` `relays`; a
  v1 config's `relay` is a one-element list, and `relay` keeps naming the first relay for older binaries). Each
  uplink reconnects, acks and stops on 4409 independently; sessions from all of them are handled alike.
- Handshake race (kind 0x01): to open a session, a client opens one `/v1/client/<nodeId>` socket per relay in
  parallel and sends Noise message 1 on every socket that connects, each with its own fresh ephemeral key. It keeps
  the first socket whose message 2 verifies, sends the key confirmation on that socket only, and closes every other
  socket with 1000 unconfirmed. A pong shows only that a relay is up; the first verified message 2 shows the path
  that reached the node and back fastest. This is safe because a responder acts on a stream (dials a port, syncs)
  only after key confirmation ("Sessions", "Streams"), so a losing socket costs it one unconfirmed handshake and
  nothing else. A 4401 close, or a 4400 close from the far side, on any socket is the node's answer and ends the race;
  a message 2 that fails to verify at the client may be a relay's forgery, so the client closes that socket 4400 and
  keeps racing. Losers finish their dial before their close (an aborted handshake would reach the node as 1006);
  dials have their own 15 s deadline and each handshake the 10 s one. A relay where the node is offline closes 4404;
  a relay that is down never connects. Close codes are not authenticated, so a hostile relay can also close 4401 or
  4400 itself and end the race; that is an availability limit, the same as a relay that drops the socket.
- Ping race (kinds 0x03 and 0x04): a join's message 1 names a single-use invite and an account session reserves one
  of the node's account slots at message 1, so these send message 1 on one socket only. The client sends the text
  `ping` on every socket, keeps the first that answers `pong` and closes every other socket with 1000 before sending
  any other byte (Doriterm #1351 rule). Losers finish their dial first, and the race has its own 15 s deadline. A
  relay where the node is offline closes 4404 before any pong, so it never wins.
- Fallback (ping race): a relay can answer `pong` for a stale uplink. When the handshake on the winning socket fails
  with anything but a 4401 or 4400 close or a message 2 that fails to verify, the client drops that relay and races
  the rest; those three end the attempt.
- Token v2: `pen1_` + base64url(no padding) of
  `version (2) || signPub (32) || noisePub (32) || secret (32) || relay URLs (UTF-8, joined by LF)`: 1 to 8 URLs,
  each 1 to 256 bytes, naming distinct relay origins (`https://a` and `wss://A:443` are one relay), `https` or `wss` (`http` or `ws` only for loopback hosts, which local test
  relays use). A token with one relay stays version 1 so older nodes can join; version 1 keeps parsing. The joiner
  reaches the inviter over the token's relays with the ping race and keeps them as its own list.
- Relay-serve parity: `pen relay serve` (apps/pen/internal/relayserver) implements this contract's "Relay" section
  rule for rule (auth, origin binding, mux, caps, timeouts, backpressure, acks, ping, 1 MiB cap, `/healthz`) and is
  tested against the same cases as the Worker. It closes a client 4404 right after accept, before reading any text,
  when the node has no uplink. Its origin is fixed, never taken from the request: `--autocert <host>` serves
  `wss://<host>`, `--cert`/`--key` and a TLS terminator in front of `--plain` need `--public-origin wss://host`, and a
  request whose Host does not name that origin gets HTTP 421 before any upgrade. `--plain` without a public origin
  listens on loopback only (tests and local relays), where the origin follows the request. Beyond the contract it caps all
  connections (4096, `--max-sockets`) and one IPv4 address's or IPv6 /64's connections (64, `--max-per-ip`), counted
  from accept: one past a cap is closed before any request is read (HTTP 429 when a cap is reached between accept and
  upgrade). Past one node id's unauthenticated uplinks (4, `--max-unauth-per-node`) a new uplink closes the oldest one 4429. It counts the memory messages hold, charged before it is allocated: queued messages at their allocation size plus
  128 bytes, all of them at most 192 MiB (`--max-queued-mib`) and one source address's at most 16 MiB
  (`--max-queued-per-source-mib`; a source is an IPv4 address or an IPv6 /64). Each socket reads a message of up to
  96 KiB (a ping, an ack or a whole Noise message) without a charge; a larger message being read draws on a separate
  32 MiB pool, a source at most 4 MiB of it, and a socket whose message would pass that closes 4408. Queued session data
  is charged before it is copied, to the socket's window (4 MiB), the share of the address of the socket that will
  receive it (16 MiB) and the total (128 MiB on the reference unit). Data that does not fit any of the three ends the
  session that offered it 4408 (the client is closed 4408 and the node gets CLOSE 4408); nothing else ends because of
  memory: no other session, no other queue, never an uplink. A socket that stops reading is ended only when one write
  stalls for 10 s (WriteTimeout). A client session is admitted only if its OPEN and its
  eventual CLOSE frame toward the uplink fit, charged like data (136 bytes each in the queue, 12 bytes of window) and
  within 256 KiB of session frames per uplink queue; otherwise the new client is closed 4429 and nothing is queued,
  so a CLOSE always fits and session frames never end an uplink. The rest of what the relay queues is not charged and
  is bounded per socket by a constant: the 32-byte challenge once, at most 8 pongs, and one close frame, about 1.4 KiB.
  So a full relay still answers an uplink and closes sessions cleanly. Before the node has sent DATA for a session, its
  client may send one message of at most 4096 bytes (its first); a second message of any size, or a larger first one,
  ends the session 4408. Past 8 pending sessions per node, the oldest pending session of the address holding the most
  pending sessions there (the new client's own on a tie) closes 4429, so one address cannot displace another's
  pending session (the Worker keeps the node-wide rule above). So one source cannot end another source's sessions or uplinks, and data between other
  sources is not refused while the sources other than it together hold less than the total minus one share. Limits:
  the sessions on one uplink share its 4 MiB window, so a peer the node has answered can fill it while the node reads
  slowly, and other sessions' data toward that node is refused (4408) until the node reads; the node bounds such a peer
  itself (a `tcp` stream past its 512 KiB credit window is closed 4408, an account session that sends no assertion is
  closed after its wait). An address whose 16 MiB share is held by its sockets that do not read gets data for its other
  sockets refused until those sockets read or their writes time out. Under a flood from many addresses the relay is
  full for everyone and offered data is refused until stalled sockets time out. In each case the refused session ends
  4408, nothing reopens by itself, and the node's other relay is unaffected. Each connection
  gets fixed 64 KiB kernel send and receive buffers and at most 8 KiB of request headers. It
  reads at most the 96-byte answer from an uplink before it authenticates, drops a socket whose write or closing
  handshake stalls for 10 s, and applies the uplink fair share also to what it has queued for the uplink, so a client
  flooding empty DATA ends only its own session 4408. Session ids count per node id while
  that node has sockets on the relay and wrap like the Worker's (skipping live ids), so a node sees only its own
  sessions' ids and nothing is kept per node id once its last socket is gone. The room, and with it the counter, outlives an uplink only while clients
  remain, so a new counter always meets a new uplink connection, and a node keys sessions by its uplink connection:
  an id from an earlier counter (a restart, or a room that emptied) cannot reach a session of the new one. The counter
  does not read the clock. (The Worker keeps its counter in that node id's Durable Object, one stored integer per node
  id that ever had a client reach its authenticated uplink, with no cleanup.)

## Accounts (v1.1)

A login service lets a person add machines to their own mesh by signing in with Google instead of passing an invite token.
It never holds a mesh signing key and keeps no Google tokens after a sign-in. What it asserts is narrow: "the node key
`signPub` belongs to Google account `sub`". Admission is still an `admit` record signed by an existing member.

Trust: whoever controls the login service key, or tricks the account owner into approving a code, can mint an assertion
for that account. In auto mode such an assertion adds a machine to the account's mesh, and the registry decides which
mesh a new machine is offered. Defences: the person types the code and sees where the request came from; a joining
machine shows the account and the mesh's members and asks before it founds or joins; members announce every account
admission; lock mode makes every new machine wait for a member's approval; a Google-authenticated reset clears the
account's registry entry; `pen revoke --compromised` removes what got in.

### Login service

Base URL L (`https://pen-login.pos090001.workers.dev`). Ed25519 login keys with `kid` = lowercase base32 of
SHA-256(pub)[0..5] (8 characters). `GET L/v1/keys` -> `{"keys":[{"kid","pub"}]}` (pub base64url).

Device flow (RFC 8628 shaped):

1. `POST L/v1/device/start` `{"signPub","noisePub","name","proof"}`; proof = Ed25519 by signPub over
   `"pen-login/1 start" || signPub || noisePub || name` (UTF-8). Answer `{"deviceCode","userCode","verificationUri",
   "interval":2,"expiresIn":600}`. deviceCode: 32 random bytes base64url. userCode: 8 Crockford base32 characters shown
   as `XXXX-XXXX`. There is no URL with the code filled in: the person types it.
2. The person opens the verification URL, types the code, and signs in with Google (authorization code + PKCE S256 + state
   - nonce; scope `openid email`); the OIDC state names that user code. The service verifies the id_token: `iss` is
     `https://accounts.google.com` or `accounts.google.com`, `aud` is its client id, `exp` in the future, the RS256
     signature against Google's JWKS (fetched from discovery, cached, refetched at most once per 5 minutes for an unknown
     `kid`), `nonce` matches, `email_verified` true. The account key is `sub`; the email is for display only. The confirm
     page shows the code again, the machine name and fingerprint, when and from which country and city the request
     started, and says the machine will get full access to every machine in the mesh. Confirm is a POST with a per-page CSRF
     token. Five wrong codes from one source lock that source for 10 minutes.
3. `POST L/v1/device/token` `{"deviceCode","proof"}`; proof = Ed25519 by the device's signPub over
   `"pen-login/1 poll" || deviceCode`. Answers: 428 `{"status":"pending"}`, 429 `{"status":"slow_down"}` (polled faster than
   interval), 410 `{"status":"expired"}`, 403 `{"status":"denied"}`, or 200
   `{"assertion","account":{"sub","email"},"loginKey":{"kid","pub"},"mesh":{"meshId","members":[{"nodeId","signPub","noisePub","name"}]}|null}`.
   A deviceCode yields at most one 200.

Assertion: `{"body":"<base64url>","sig":"<base64url>"}`, body an I-JSON object
`{"v":1,"iss":L,"kid","sub","email","signPub","noisePub","iat","exp"}` (seconds; exp = iat + 600), sig = Ed25519 by the
login key over `"pen-login/1 assertion" || SHA-256(body)`. `sub` and `email` hold no C0 control character or DEL
(members print them); an assertion that does is malformed, and a node never signs an `admit` or `account` record that
carries one. Such a record from a node before 0.2.6 is stored and applied like any other, so every node computes the
same view; members print its text with control characters replaced.

Registry (Durable Object, SQLite): account `sub` -> one meshId and the nodes registered under it; nothing else long-lived.
The registry is not the mesh: any node with a valid sign-in registers, even one a locked mesh only queued, and any
registered node may forget the others under the same `sub`. A person who loses control of the Google account (one
phished sign-in is enough) can therefore make the registry offer new machines only their machine; meshes and their
members are unaffected. The remedy is lock mode plus the reset page, then `pen login` on a trusted member.

- `POST L/v1/mesh/register` `{"assertion","meshId","proof"}` adds the asserting node (nodeId, keys, name) under the
  assertion's sub; proof is Ed25519 by the assertion's signPub over `"pen-login/1 register" || SHA-256(assertion body) || meshId`,
  so only the node that owns the key can use its assertion. The assertion must verify under a current login key, be
  unexpired, and be issued after the account's last reset, and each assertion (by body hash) registers at most once, so a kept or phished assertion cannot re-register after a reset. The first meshId registered for a sub is
  kept and another is refused 409.
- `POST L/v1/mesh/forget` `{"nodeId","by","ts","proof"}` removes a node; `by` is the signPub of that node or of another node
  registered under the same sub, proof by `by` over `"pen-login/1 forget" || nodeId || ts (u64 BE, ms)`, ts within 2
  minutes. Members send it when they leave and for every key their view revokes.
- Reset: from the verification page, after a Google sign-in, "reset" removes the account's meshId and nodes (a separate
  confirm step with a CSRF token), records the reset time, marks the account's approved but unpolled device codes denied,
  and refuses assertions issued before it. The next machine to log in founds or binds again. At most 64 nodes are listed
  per account.

Sources are keyed by IPv4 address or IPv6 /64 of `cf-connecting-ip`. Limits per source: device/start 10 per minute,
verification pages and confirms 20 per minute, token polls at `interval`, register/forget 30 per minute; refusals are
HTTP 429. One Durable Object holds all state; it is a single point of failure for new logins, not for meshes that exist.

### Mesh records

v1.1 nodes store a record of an unknown `type`, or with top-level members they do not know, when it is otherwise valid,
forward it, and give it no effect. Unknown members inside a nested object (a card, `loginKey`) are ignored. Every member
must run v1.1 before any member signs an `account` or `lock` record (the signer checks the versions members announce
in sync `hello` as `"pen":"1.1"` and refuses otherwise); v1.0 nodes reject those types and would stall.

- `account`: `{"loginUrl","loginKey":{"kid","pub"},"sub"}` or `{"sub":null}` (unbind). The binding is the last `account`
  record in canonical order whose signer was not revoked as compromised (directly or as an admit of a compromised key);
  a plain `leave` or `revoke` keeps the signer's binding in effect. `{"sub":null}` means unbound.
- `lock`: `{"on":true|false}`. The mesh is locked if some `lock` `on` record is not in the past of an effective
  `lock` `off` record: an `off` counts only when every `on` is in its past. An `off` signed by a key revoked as
  compromised loses effect; an `on` keeps it, whoever signed it, so revoking a stolen machine never unlocks the mesh (a
  stray `on` costs nothing: any member's later `off` clears it). A plain leave or revoke does not unlock the mesh.
- `admit` may carry `"via":"google"`, `"email"` (copied from the assertion the admitting member verified) and `"assertion"`
  (base64url SHA-256 of that assertion's body). Without `via` it was an invite. The admit's body stays within 2048 bytes;
  an email longer than 254 bytes is refused, and an admitting member lists at most 8 heads in `prev`.

### Account join

Kind 0x04, `account`: `Noise_IK_25519_ChaChaPoly_BLAKE2s`, prologue `pen/1` || nodeId || 0x04, valid only with
`{"v":1,"stream":"account","name"}`. The responder accepts any initiator key on this kind; at most 4 such sessions run at
once, a fifth evicts the oldest one that has not sent its assertion (4429), and a session that sends no assertion within
10 s after key confirmation, or no card within 10 s after the offer, closes 4408. The slot is taken at message 1, before
key confirmation, so an initiator that never confirms holds it for up to the 10 s handshake timeout and can evict another
unasserted session; asserted sessions are never evicted. The joiner sends `{"t":"assertion","assertion":{...}}`; the member sends
`{"t":"offer","mesh","inviter","nonce"}` and the joiner answers `{"t":"card","card":{...}}` as in Join. The member refuses
(`refused` then 4401) unless: the mesh is bound; the assertion's `kid` names the binding's login key and the signature
verifies; `iss` equals `loginUrl`; `sub` equals the binding's `sub`; `iat` <= now + 60 s and now < `exp` + 60 s (a
refusal for time says "clock skew" so a person can fix it); the assertion's signPub and noisePub equal the card's and the
card's noisePub equals the session key; the key is not revoked. When the card arrives the member first syncs with every
other member it can reach (5 s at most), then takes the binding and lock state from one view and checks the assertion
against that view again, so a lock, unbind or revoke it slept through counts once any reachable member holds it. Lock
mode cannot bind a member that reaches no member holding the lock record; such a member decides on what it has. Then:

- unlocked: the member signs `admit` with `via` and the assertion hash, sends the records and `done` as in Join, and every
  member shows "<name> joined via Google <email>, fingerprint ..." for 7 days in `pen ls`.
- locked: the member stores a pending request `{id, card, assertion, at}` where id is the first 8 characters of the
  joiner's fingerprint (`XXXX XXXX`), at most 32 (oldest dropped), kept 24 hours, sends `{"t":"queued","id","member"}` and
  closes 1000. The joiner prints the id, its full fingerprint (10 groups of 4) and the member's name: approval happens on
  that member. `pen approve` takes the full fingerprint, or an id only when exactly one pending request matches it; given
  an id it shows name, full fingerprint, email and request time and waits for an explicit yes before it signs (a full
  fingerprint argument signs at once). `pen deny` drops the request and refuses that key for 24 hours. The joiner retries every 5 s with kind 0x01 `stream:"mesh"` and an empty `have`, applying Join step 4's
  checks to what it receives; after 30 minutes without approval it stops and tells the person to run `pen login` again
  (a dropped request is then queued again; a key approved meanwhile is already a member, and the new run only syncs).

The joining side: `pen login` shows the returned email and, when the registry offers a mesh, its member names and
fingerprints, and asks before founding or joining (`--yes` skips the question for scripts; `install.sh --login` does not
pass it). After joining it syncs with at least two members, or warns that only one was reachable, checks that it is still
a member after those syncs, and only then serves `tcp` streams and registers. It also syncs with every node the registry
offered that its copy of the mesh does not count as a member. One that refuses it (4401) is asked again with a check on
kind 0x04: the first line is `{"t":"check","assertion":{...}}` instead of `assertion`. The node runs the assertion
checks above (a lock does not matter here) and then a sync as on kind 0x01, with the joiner as initiator, except that it
sends its own records and `done` only after the joiner's `done`, and only if both hold in a scratch copy of its own set
with the joiner's records merged in: the joiner is a member, and a walk from the joiner toward the founder accepts it.
The walk visits a key, starting with the joiner's: if this node's own view counts the key as a current member, it
accepts; if its own view revoked the key (plainly or as compromised), or the key has no admitter (a founder this node
does not count), it refuses; otherwise it moves to the key's admitter (the member entry's `admittedBy` in the merged
copy, current or revoked) and visits that. It never walks past a key its own view revoked: an admit by a revoked key
that this node does not already hold looks the same as one signed after the revoke. Keys it never heard of are walked
through, so the walk must still reach a current member. Otherwise it sends `refused` and closes 4401. It stores nothing
the joiner sent. A node that left, was revoked, or has not heard of the joiner yet so passes it its records whenever the
joiner's admits reach a member it still counts, and the joiner applies them like any sync. A node that still refuses
holds a revoke along the joiner's admits (a revoked or stolen member can serve a cut copy and a stolen key can win a
revoke race in the merged order, so the check decides on the node's own view), so the join fails with that node's name
and nothing is installed. The walk refuses in two honest cases.
If a machine Y admitted by a since-revoked key X admits the joiner and this node has not received X's admit of Y yet,
the join succeeds once the members have synced that admit. If X's admit of Y and a plain revoke of X share their past
and the revoke sorts first in the canonical order, replay ignores the admit: Y was never a member in any converged view,
no sync changes that, and Y has to join again (invite, or sign-in through a current member) before machines can join
through it. The joiner's message says to run `pen login` again and, if it keeps failing, to join the admitting machine
again. A node that is not a member of its own view (revoked, or its admit never took effect) admits nobody: on kind 0x04 it
answers an `assertion`, at once and again after the refresh before deciding, and on kind 0x03 a card, before the
invite is used, with `{"t":"refused","reason":"this machine is not a member of the mesh","notMember":true}` and 4401,
signing and queueing nothing; it still answers a `check`. The membership check and the admit's signature (with the
invite's burn, or the queueing of a request) are one step under the node's store lock, so a revoke that arrives in
between still stops them. For a Google join that step also repeats the decision: the assertion against the binding
then in effect, and the lock; a lock merged in the meantime queues the request, an unbind or rebind refuses it. An
approval checks the request's account and login key against the binding at signing time. A Google joiner leaves such a node out and races the other
listed nodes again in the same sign-in; an invited joiner is told the invite was not used and to ask a current member
for a new one. An older joiner ignores `notMember` and reports the refusal as before. A refusal also stands when the check
does not complete. A node older than the check (pen 0.2.6 and before) answers `refused` ("expected an assertion") and
4401, so while such a node is the one refusing, a join fails in exactly the cases the check was added for; updating it,
or joining by invite, is the way through. A listed node that does not answer (offline, out of session slots, slower than
the 30 s push timeout) takes no part, so the cut-copy protection holds only while an honest listed node answers.
When its assertion has expired by then
(a slow approval), it stays a member and says registration waits for the next `pen login`. `pen login` on a member whose
mesh is unbound, or bound to an older login key, offers to bind it again (same question).

## Services (v1.2)

A node can hand a member's session to a local program that registered a name with it, and tell that program, with
proof, which member is calling. GOAT is the first such program (name `goat`). Nothing here changes `tcp`, `mesh`,
`join` or `account`: v1.2 adds no record type and no sync message, and nodes keep announcing `"pen":"1.1"`. Until
a program registers, a node refuses every service stream.

### The service stream

- Kind 0x01, message 1 `{"v":1,"stream":"service","name":N}`. A service name is 1 to 32 characters of `a-z 0-9 -`,
  starting with a letter; `pen` is reserved. Admission is that of `tcp`: only a current member's key, otherwise 4401
  unanswered, and a malformed name is refused the same way.
- After key confirmation the responder counts the session as a live session of that member, exactly as it counts a
  `tcp` session: a revoke closes it 4401, before and after delivery. It then delivers the session to the program
  that holds N ("Local delivery"). If no program holds N it sends CLOSE 4404; if 32 deliveries are already in
  progress it sends CLOSE 4429; a delivery that fails sends CLOSE 4404.
- Plaintext records use the `tcp` framing (DATA, FIN, CREDIT, the same window). They carry the caller's and the
  program's bytes only; the local handshake never reaches the caller.
- A responder older than v1.2 refuses message 1 with 4401 unanswered, the answer a non-member gets. A caller
  reports it as "has Pen older than 1.2, or does not count this machine as a member".
- Close codes on a service stream do not, by themselves, tell the caller whether the program processed its bytes.
  4401, 4404, 4408, 4429, 1000 or a dropped socket can each arrive after the program read some of them. A caller
  knows its data was not delivered only when it wrote none; once it has written a byte, any failure leaves the
  outcome unknown, and only operations that are safe to repeat may be retried.

### Registration

A program registers over the control socket, which only the OS user that runs the node can open. There is no other
way: the local management page (dashboard) cannot register, and neither can a member.

- Request line: `{"op":"service.register","name":N,"port":P,"key":K}`. P is the loopback TCP port the program
  listens on (1 to 65535). K is 32 random bytes the program created for this run, base64url without padding.
- Answer: `{"t":"registered","id":R,"name":N,"port":P}`, where R is a fresh registration id. The registration lives
  exactly as long as this connection. When the connection closes, the node removes registration R and nothing
  else, so an old holder's exit never removes a newer registration.
- A new registration for N replaces the current one: the node sends `{"t":"replaced","id":R}` (R the old id) on the
  old connection and closes it, so the old holder learns it lost the name. A node holds at most 8 names; a request
  for a ninth is refused.
- A refusal is `{"error":"..."}` and closes the connection with nothing registered. The node never writes K to disk
  or to a log, and keeps it only in memory.

`pen service register <name> --port <P>` is the child a program runs to hold its registration. It reads K from stdin
as one line (43 characters and LF), so K never appears in an argument, the environment or a file. It prints
`pen-service v1 registered <name> <R>` on stdout once the node answers, then holds the registration until stdin
ends (exit 0), the node replaces it (exit 3, reason on stderr) or the node closes the connection (exit 1). Any
other failure, before or at registration, exits 2 with the reason on stderr.

### Local delivery

For each confirmed service stream the node dials `127.0.0.1:P` of N's registration (5 s deadline), and the node and
the program prove to each other that they hold K before any caller byte moves. Nd and Ng are 32 random bytes each,
fresh for every connection, written as 43 base64url characters without padding. A MAC is HMAC-SHA256 keyed with K,
written the same way. `||` concatenates bytes; Nd and Ng enter a MAC as their 32 raw bytes, text as ASCII.

1. Node: `PENSVC/1 <Nd>` LF.
2. Program: `<Ng> <A>` LF, with A = HMAC(K, `pen-svc/1 ` || N || Nd || Ng). The node reads at most 128 bytes up
   to the LF, within 5 s of writing line 1, and compares A in constant time.
3. Node: `<J> <B>` LF. J is `{"v":1,"mesh":M,"self":S,"caller":{"nodeId","signPub","noisePub","name"},"stream":N}`
   with exactly these members in this order: M the node's mesh id, S its node id, `caller` the calling member as the
   node's view holds it at delivery, `stream` the service name. B = HMAC(K, `pen-svc/1 pen` || Nd || Ng || J).
4. From then on the connection carries the stream's payload both ways, half-closed like `tcp`.

If any step fails (the dial, a deadline, the cap, a malformed line, a wrong A, or N registered again meanwhile), the
node closes the socket, sends CLOSE 4404 to the caller and logs the cause at most once a minute per cause. A
refused delivery passes no caller byte to the program, but the caller still classifies its own data by what it
wrote (above). At most 32 deliveries are in progress at once, from key confirmation to the end of step 3.

Rules for the program; GOAT implements them:

- Before the proof: at most 16 connections in the handshake at once, the 17th closed at accept; 3 s from accept to a
  verified line 3; line 1 read with a 128-byte cap up to the LF, line 3 with a 2,200-byte cap. Decoding is exact: the
  fixed prefix, base64url fields of exactly 43 characters that decode to 32 bytes and encode back to the same text, no
  CR, J strict JSON with no unknown, missing or duplicate members. The program checks B, then that M and S equal the
  mesh id and node id it pinned for this machine. Any violation, EOF or timeout closes the socket with no reply.
- After the proof: at most 32 live connections per calling node id and 128 in total, extras closed at once. A
  connection is closed as idle only after 120 s with no request open on it and no WebSocket upgraded on it.

K never crosses the wire and both nonces are fresh, so a recorded handshake cannot be replayed or moved to another
connection. Another OS user can connect to P but cannot produce B, and cannot listen on P while the program holds it.
A program that exits loses its registration with its connection, so the node never dials a port the program gave
up. Processes of the same OS user can register a name or read K; they are the owner, outside this boundary.

### Exact dial and the ready line

Programs dial members with `pen pipe --node <nodeId> --noise <noisePub> [--home <dir>] (<port> | @<name>)`:

- `--node` names only the member whose node id is exactly that in the local view; there is no name or prefix
  fallback. A node id that is not a current member, or a member whose Noise key differs from `--noise`, fails before
  any dial (exit 255, reason on stderr). The handshake pins that Noise key, so no other machine can answer.
- `@<name>` opens a service stream. After key confirmation, and before it reads any stdin byte, the pipe writes
  exactly one line to stderr: `pen-ready v1 <nodeId> <noisePub>` LF (84 bytes). Nothing reaches stdout and nothing
  else reaches stderr before that line (`PEN_TRACE` is ignored in this form). The line proves only that the
  responder holds that Noise key; it says nothing about delivery to the program.
- `<port>` opens a `tcp` stream as `pen pipe <node> <port>` does, without a ready line; ssh checks the host key.

A program that spawns the pipe for a service reads stderr up to the first LF with a 128-byte cap and accepts only
exactly `pen-ready v1 <requested nodeId> <pinned noisePub>`. On any stdout byte before it, a longer or different
line, or an exit before it, the program kills the child, waits until it has exited and sends nothing. After the line
it keeps reading stderr to its end, holding at most a bounded tail. `@goat/pen-protocol/ready` implements this.

### Snapshot watch

Control op `watch.snapshot` (control socket only) answers one line now and one on every change of the view or of a
member's online state:
`{"t":"snapshot","gen":G,"mesh":M,"self":S,"members":[{"nodeId","signPub","noisePub","name","user","hostKeys","online"}],"revoked":[{"nodeId","name"}]}`.
Every line is complete, and `user` and `hostKeys` are always present (empty when the member published none). G
counts the snapshots this daemon run produced and rises by exactly 1 from one line to the next on a watch. A watcher
that falls 16 lines behind is closed. A gap in G or a closed watch means the list is stale: drop it and watch again.
Nothing may authorize from this list. The `watch` op keeps its v1.1 lines.

### SSH config for exact routes

`pen ssh-config` writes a `Host pen-<nodeId>` block for every member, ahead of the name blocks, with
`ProxyCommand <pen> pipe --node <nodeId> --noise <noisePub> 22`, `StrictHostKeyChecking yes`, Pen's known_hosts,
and, where ssh has connection reuse, `ControlMaster no` and `ControlPath none`, so the `pen-*` block's shared
connection never carries it. `pen-<name>` blocks are unchanged, and written only for a name exactly one member has
that is not also a member's node id; any other name falls to the `pen-*` block, where `pen pipe` resolves it as
before.

## Close codes

Doriterm's codes, same meanings: 4400 crypto or framing failure; 4401 not admitted (unknown key, revoked member,
no live invite, refused card); 4402 relay protocol error; 4403 relay auth failed; 4404 node offline or port refused;
4408 idle, backpressure or handshake timeout; 4409 uplink replaced; 4429 caps; 4507 a mesh sync whose records the node could not save, or while it holds records it could not save;
4508 a mesh sync that brought a record the node refused for its record cap (relays never send 45xx). 4410 and 4412 are unused. Kind 0x04 uses 4429 for an evicted session without an assertion and 4408 for an assertion
or card that did not arrive within 10 s.
On a service stream 4404 also means that no program holds the name or that its local delivery failed, and 4429
that 32 deliveries are already in progress.

## Vectors

`packages/pen-protocol/vectors/*.json`, read by the TypeScript and Go tests: nodeId and fingerprint from fixed
keys; the uplink challenge message bytes and signature; mux frames (identity.json, relay.json: generated by TS);
the invite token, invite id and join psk; version 1 and 2 invite tokens with rejected v2 relay lists (token.json,
generated by Go); Noise IK and IKpsk2 transcripts with fixed ephemerals and payloads; a card,
a record and its hash; and a canonical-order view case (session.json, mesh.json: generated by Go with flynn/noise,
verified by Go now and by later TS clients). login.json (generated by TS, verified by Go): the start, poll and forget
proofs, an assertion body and signature under a fixed login key and its kid, and assertion checks that must fail.
service.json (generated by Go, verified by Go and TS): a local delivery with a fixed K, name, Nd, Ng and identity line J,
the three lines on the wire and both MACs.

## Change log

- v1.0 (2026-11-09): first Pen contract, derived from Doriterm transport v1.10.
- v1.0 (2026-11-09): "Several relays": an uplink per relay, the ping race with fallback, invite token v2, and
  `pen relay serve` parity.
- v1.1 (2026-11-10): "Accounts": Google sign-in through a login service, session kind 0x04, `account` and `lock` records,
  and unknown record types stored without effect.
- v1.1 (2026-11-10): "Several relays": kind 0x01 sessions race the handshake on every relay instead of the ping race
  (message 1 on every socket, the first verified message 2 wins, losers close 1000 unconfirmed); joins and account
  sessions keep the ping race. Clients only; no wire change, and v1.0 and v1.1 responders answer both alike.
- v1.1 (2026-11-10): a version 1 token's relay URL obeys the version 2 scheme rule, and one sync session carries at most
  4352 records. Both tighten what a node accepts; an honest peer never sent either.
- v1.1 (2026-11-11): assertion `sub` and `email` refuse control characters and nodes no longer sign records carrying
  them (stored ones still apply, as older nodes apply them); a member
  syncs with reachable members before deciding an account join; a joiner also checks the registry's other nodes; a key
  already revoked can be revoked again as compromised. The registry's trust limit and the kind 0x04 slot timing are
  stated. Vectors: two new login check cases.
- v1.1 (2026-11-11): `pen relay serve` counts connections against its caps from accept, counts queued and partly read
  messages at their allocation size, and gives each source address a share of that budget (16 MiB by default), so one source alone cannot
  fill it. Relay implementation only; no wire change.
- v1.1 (2026-11-11): `pen relay serve` admits a client session only when its OPEN and CLOSE toward the uplink fit
  (else 4429), and past 8 pending sessions per node the address holding the most loses its oldest (4429). Go relay
  only; the Worker keeps the node-wide rule. No wire change.
- v1.1 (2026-11-11): session ids wrap past 0xffffffff to 1 and skip live ones, on both relays (the Worker's counter
  grew past u32 and its frames truncated it); the Go relay counts them per node id. No wire change.
- v1.1 (2026-11-11): a mesh sync that brings a record the receiver refuses for its cap closes 4508 (4429 is the relays' busy code), and one whose
  records it cannot save closes 4507; before, both answered `done`. Older nodes still answer `done`; an older
  sender reads 4507 and 4508 as a failed sync (the member shown offline), never as taken.
- v1.1 (2026-11-11): `refused` may carry `"notMember":true` from a node that is not a member of its own view; joiners
  try another node (Google join) or report that the invite was not used. Older joiners ignore the member. No vector.
- v1.1 (2026-11-11): `pen relay serve` reads a message of up to 96 KiB per socket without a charge and larger ones
  from a separate 32 MiB pool; data that does not fit the window, the receiving address's share or the total ends only
  the session that offered it, and a session the node has not answered may send one message of at most 4096 bytes.
  Control messages are not charged. The "Relay text" section states that nothing confirms an uplink's authentication
  and that a pong proves nothing about it. No wire change.
- v1.1 (2026-11-11): kind 0x04 `check`: a Google joiner that a listed node refused asks it to check the joiner's
  records against its own, so a node that left or has not heard of the joiner no longer fails the join while the
  joiner's admits reach a member it counts; a copy whose admits pass a key it revoked, plainly or as compromised,
  still fails. Nodes before this answer the check as an unexpected first line (4401), which
  the joiner counts as the refusal it was. No account-stream messages are in the shared vectors.
- v1.2 (2026-11-11): "Services": stream `service` delivered to a program that registered its name over the control
  socket, with a mutual proof on loopback; the exact dial `pen pipe --node --noise` and its ready line; the
  `watch.snapshot` control op; `pen-<nodeId>` ssh-config blocks. No record or sync change; `tcp` is unchanged. Vectors:
  service.json.
