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
- **Reasons.** A lineage cannot be multiplied by admitting more keys, since every key it admits joins it.
  Shares chosen by a fixed key of each record make the kept set the same on every node once they have
  exchanged records. Reading admission from the kept admits, and having each record name its own
  previous record, means a left-out record of another lineage changes nothing about an honest record.

## Rule

- **Introducer.** A key's introducer is the kept `found` or `admit` whose card subject is that key; of
  several, the one with the smallest raw hash. A key without one is not introduced. A record is admissible
  when its signer is introduced and, for a `revoke`, each subject is too. The view still decides what a
  record does at its turn; this only replaces the storage check "introduced in its past".
- **Depth.** The founder's depth is 0; a key's depth is its introducer's signer's depth plus 1.
- **Lineage.** The founder is lineage 0. The founder's admits, ordered by the founder's counter `n` then
  raw hash, put their subjects in lineages 1 to 15 in that order; later ones put their subjects in
  lineage 0. Any other key is in the lineage of its introducer's signer. A record is charged to its
  signer's lineage.
- **Own chain.** A record with `n > 1` names its signer's record `n - 1` directly in `prev`, or has no
  effect. Its effect then depends on nothing another signer's records do.
- **Shares.** Per lineage: 220 records of other types, 16 `revoke` or `lock` records, and 16 `admit`
  records signed by keys other than the founder. The founder's own admits share 64 places. Total
  16 x 252 + 64 = 4096. Within a share a node keeps the smallest records by a fixed key: raw hash, and
  for admits (depth, raw hash), so an admit never displaces a shallower one.
- **Kept, bare and dropped.** A record outside its share is dropped; one whose signer has no admit yet
  waits in the bounded pool. A record's parents need not be present: a hash a kept record names without
  its record is kept bare, has no effect, and counts as present in canonical order.

## Convergence and bound

- **Same set on every node.** Compute level by level. The founder's admits depend on nothing but the
  candidates, so every node that has exchanged them keeps the same 64. Each further depth depends only on
  the kept admits above it, and within a share a deeper admit never displaces a shallower one, so the kept
  admits, the introducers, depths and lineages are the same on every node. Other records only need their
  signer's introducer and lineage, so each share's kept records are the same k smallest. Bare hashes
  follow from the kept records. A node replaces a kept record only by a smaller one and keeps offering
  what it keeps, so exchanging records reaches that set whatever the arrival order.
- **Bound.** At most 4096 records with bodies, plus bare hashes named by them (at most 64 each).
  Candidates outside the shares are dropped, so a flood of forks costs the sender, not the receivers.
- **A revoke always fits.** A member in another lineage records the revoke within its own lineage's
  16 revoke places. The founder can always revoke. Members sharing the filler's lineage cannot, until
  someone outside it revokes the filler.
- **Honest history.** A record left out of another lineage's share changes no honest record: admission
  and lineage come from kept admits, and an honest record's own chain is named directly.
- **What a hostile member can do.** Fill its own lineage, so honest keys in that lineage lose records
  with large hashes. A hostile founder can fill lineage 0 and the founder admits; the remedy for a hostile
  founder is still a new mesh.
- **Honest limit.** A lineage that legitimately signs more than 220 other records (renames, host key
  changes over years) loses the ones with the largest hashes, not its oldest. Lineage compaction is
  follow-up work if that happens in practice.

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
   member of lineage 3 is in lineage 3; the founder's 16th admit's subject is in lineage 0; the result
   does not depend on the order records are given in.
2. Shares and bare hashes in `Store`, behind the new epoch: the same candidates delivered in opposite
   orders, then exchanged, give the same kept set and bare hashes; an honest record naming a filler's
   left-out record is kept; a flood of one lineage's records keeps its share and drops the rest.
3. Epoch in the sync hello and the refusal code, the own-chain `prev` rule when signing and in the
   view, and mesh files that record their epoch.
4. `TestOneMemberCanFillTheRecordSpaceSoEvenItsOwnRevokeIsRefused` becomes a test that a member outside
   the filler's lineage records its revoke and every node applies it; docs and `pen ls`.
5. `pen mesh upgrade` for existing meshes.

## Tradeoffs

- A founder starts at most 15 lineages; later direct admits share the founder's.
- Mixed old and new nodes do not sync; members upgrade before a mesh moves.
- Honest members in the filler's own lineage lose records until it is revoked.
- Bare hashes add a second kind of stored entry to the set, the save file and sync.
