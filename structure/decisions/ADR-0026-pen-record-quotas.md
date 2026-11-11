# ADR-0026 — a mesh's record space is shared out by admission lineage

- Contract owner: [pen.md](../pen.md); wire rules in [CONTRACT.md](../../packages/pen-protocol/CONTRACT.md) "Records"
- Issues: goat-si/goat#2864
- Status: accepted, not implemented. Until step 4 below lands, the limit in CONTRACT.md "Records" applies.

## Decision record

- **Purpose.** Stop one member, together with every key it admits, from filling a mesh's record space
  so that nobody can record its revoke. The fix may break wire compatibility: the maintainer chose a
  versioned change over keeping the limit (decision on #2864, 2026-11-11).
- **Before.** A mesh stores at most 4096 records: other records stop at 3840, revokes at 4096
  (`MaxRecords`, `MaxOrdinary` in `apps/pen/internal/mesh/store.go`). The caps are checked in arrival
  order against the whole set. A member can sign valid records to 3840 and then repeated revokes of a key
  it admitted to 4096, after which every node refuses every record, the revoke of that member included
  (`TestOneMemberCanFillTheRecordSpaceSoEvenItsOwnRevokeIsRefused`). The remedy is a new mesh.
- **Alternatives.**
  - A share per signer key. A member admits more keys and spends each one's share.
  - A larger total. 0.2.4-0.2.6 nodes close a `have` over 4096 hashes with 4400, and the same member
    fills the larger space.
  - Room kept back for revokes. The member spends it on repeated revokes of keys it admitted, which is
    how the space fills today.
  - Shares checked in arrival order. Two nodes accept different records at the last free place.
  - Dropping a record's descendants with it. A record's `prev` names the set's current tips, so honest
    records name the member's records, and the member could erase honest history.
  - Rules that walk a record's past (today's "introduced in its past" check). Once records can be left
    out, the walk stops at them, so an honest record whose parent was left out could no longer show its
    signer was admitted. A first implementation lost honest records this way.
  - Keep the limit and document it. Rejected by the maintainer's decision.
- **Decision.** In a new mesh epoch, each record is charged to the admission lineage of its signer, each
  lineage keeps fixed shares of records chosen by a rule every node computes the same way, and admission
  and lineage are read from the kept `found` and `admit` records, never from a record's past. A record
  that does not fit is kept as a bare hash while a kept record names it, or dropped. Nodes of the old
  epoch and the new one do not sync.
- **Reasons.** A lineage cannot be multiplied by admitting more keys, since every key it admits joins it,
  and its number is fixed by the founder's invite, so records arriving later never renumber it.
  Shares chosen by a fixed key of each record make the kept set the same on every node once they have
  exchanged records. Reading admission from the kept admits, and having each record name its own
  previous record, means a left-out record of another lineage changes nothing about an honest record.

## Rule

- **Introducer.** A key's introducer is the kept `admit` naming it whose signer is introduced at the
  shallowest depth; of several there, the one with the smallest raw hash (the founder introduces itself).
  An admit names its signer as the card's inviter, so a card cannot be replayed by another member. A key
  without an introducer is not introduced. A record is admissible when its signer is introduced; a
  `revoke`'s subjects need not be, since it spends only its signer's lineage places. The view still
  decides what a record does at its turn; this only replaces the storage check "introduced in its past".
  That check moves into the view for revokes: a revoke reaches only subjects whose found or admit is in
  its own past, so no revoke can stop a later admission. A node signing a revoke names each subject's
  found or admit in `prev`, which keeps that link when records between them were dropped, and names at
  most 8 heads besides, so dropped records cannot push a body past 2048 bytes.
- **Depth.** The founder's depth is 0; a key's depth is its introducer's signer's depth plus 1. A key
  admitting itself, or admitted again deeper, keeps its shallowest introduction.
- **Lineage.** The founder alone is lineage 0. A key the founder admits is in lineage
  1 + (SHA-256 of its invite nonce) mod 15: the founder chose the nonce, and no other record changes it.
  Any other key is in the lineage of its introducer's signer. A record is charged to its signer's lineage.
- **Own chain.** A record with `n > 1` names its signer's record `n - 1` directly in `prev`, or has no
  effect. Its effect then depends on nothing another signer's records do.
- **Shares.** Per lineage: 160 records of other types, 16 `lock` records, 16 `admit` records signed by
  keys other than the founder, and 56 revoke places. The founder's own admits share 64 places, kept by
  the founder's counter `n` then raw hash, so a later admit never displaces an earlier one. A revoke place
  holds one revoke per (subject, compromised), the smallest of each, and a lineage keeps the 56 smallest of
  those. An `admit` this version cannot read introduces nobody and counts among its signer's records of
  other types. Otherwise a share keeps its smallest records by raw hash, admits by (depth, raw hash). A full set
  is 16 x 248 + 64 + the found record = 4033 records, so it fits a 4096-hash `have`.
- **Kept, bare and dropped.** A record outside its share is dropped; one whose signer has no admit yet
  waits in the bounded pool. A record's parents need not be present: a hash a kept record names without
  its record is kept bare, has no effect, and counts as present in canonical order.

## Convergence and bound

- **Same set on nodes that exchange records.** Compute level by level. The founder's admits and their
  lineages depend only on those admits; each further depth depends only on the kept admits above it, and
  a deeper admit never displaces a shallower one, so introducers, depths and lineages are the same on
  every node holding the same admits. Other records need only their signer's introducer and lineage, and
  each share keeps a fixed number by a fixed key, so the kept set is a function of the records a node
  holds. Nodes offer each other what they keep, so after an exchange they hold and keep the same set,
  whatever the arrival order. A record every node dropped does not come back if room opens later; with
  lineages fixed by nonce, an honest lineage's room does not move.
- **Bound.** At most 4033 records with bodies, plus bare hashes named by them (at most 64 each).
  Candidates outside the shares are dropped, so a flood of forks costs the sender, not the receivers.
- **A revoke fits.** A member in another lineage, or the founder, records the revoke in its own lineage's
  revoke places, where the filler cannot write. It fails only if that lineage already holds 56 smaller
  revokes of other subjects. Members sharing the filler's lineage cannot, until someone outside it
  revokes the filler.
- **Honest history.** A record left out of another lineage's share changes no honest record: admission
  and lineage come from kept admits, and an honest record's own chain is named directly.
- **What a hostile member can do.** Fill its own lineage, so honest keys in that lineage lose records
  with large hashes, and pull a key that signs a second card into its lineage (that key consented). A
  hostile founder can fill lineage 0 and the founder admits; the remedy for a hostile founder is still a new
  mesh.
- **Honest limits.** A lineage that legitimately signs more than 160 other records (renames, host key
  changes over years), or revokes more than 56 machines, loses the ones with the largest hashes. Two of the
  founder's machines can share a lineage by nonce. Lineage compaction is follow-up work if that happens.

## Compatibility

- The sync hello announces `"pen":"2.0"`. A 2.0 node closes a session whose hello does not, with a new
  close code (upgrade required), and sends no records; `pen ls` says the peer runs an older Pen.
- `have` lists only records with bodies; bare hashes are not sent, since a receiver keeps a named hash
  bare by itself.
- Existing meshes stay on the old rules. `pen` 2.0 founds new meshes in the new epoch and keeps running
  an old mesh with the old rules until every member runs 2.0 and the founder moves it (`pen mesh
  upgrade`), which re-founds it and re-admits the members; records do not cross epochs.

## Implementation plan

Each step lands as its own pull request, starting with a test that fails on `dev`.

1. Introducers, depths and lineages of a record set (`apps/pen/internal/mesh`): a key admitted by a
   member joins its lineage; a founder's admit's lineage does not move when other admits are missing; a
   self-admit does not move a key; the result does not depend on the order records are given in.
2. Shares and bare hashes in `Store`, behind the new epoch: the same candidates delivered in opposite
   orders, then exchanged, give the same kept set and bare hashes; an honest record naming a filler's
   left-out record is kept; a flood of one lineage's records keeps its share and drops the rest.
3. Epoch in the sync hello and the refusal code, the own-chain `prev` rule when signing and in the
   view, and mesh files that record their epoch.
4. `TestOneMemberCanFillTheRecordSpaceSoEvenItsOwnRevokeIsRefused` becomes a test that a member outside
   the filler's lineage records its revoke and every node applies it; docs and `pen ls`.
5. `pen mesh upgrade` for existing meshes.

## Tradeoffs

- 15 lineages below the founder; two of the founder's machines can share one, chosen by their invites.
- Mixed old and new nodes do not sync; members upgrade before a mesh moves.
- Honest members in the filler's own lineage lose records until it is revoked.
- Bare hashes add a second kind of stored entry to the set, the save file and sync.
