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
  - Shares checked in arrival order, or eviction that drops a record's descendants. Two nodes accept
    different records at the last free place, and since a record's `prev` names the set's current tips,
    honest records name the member's records: dropping descendants would let the member erase honest
    history by making its earlier records lose.
  - Keep the limit and document it. Rejected by the maintainer's decision.
- **Decision.** In a new mesh epoch, each record is charged to the admission lineage of its signer, each
  lineage keeps a fixed number of records chosen by a rule every node computes the same way, and a
  record that does not fit is kept as a bare hash when a kept record names it, or dropped otherwise.
  Nodes of the old epoch and the new one do not sync.
- **Reasons.** A lineage cannot be multiplied by admitting more keys, since every key it admits joins it.
  Choosing which records a lineage keeps by a fixed key of each record (its hash), and never removing a
  record's descendants, makes the kept set the same on every node once they have exchanged records,
  whatever the order. Records of one lineage never take room from another, so a member outside the
  filler's lineage can always record a revoke.

## Rule

- **Lineage.** The founder's key is lineage 0. Each of the founder's first 15 effective `admit`
  records in canonical order starts lineage 1 to 15, and its subject belongs to it. Any other admitted
  key belongs to the lineage of the key that admitted it, as of the admit's own past. In the new epoch
  a founder's 16th and later direct `admit` has no effect: the founder asks a member to admit further
  machines. A record is charged to its signer's lineage, worked out from the record's own past only.
- **Shares.** Each lineage keeps at most 240 records of other types and 16 `revoke` or `lock` records
  (16 lineages x 256 = 4096). Among the candidates of one lineage and kind, a node keeps the ones with the
  smallest hashes (raw 32-byte SHA-256, unsigned byte order).
- **Kept, named and dropped.** A candidate that is not among them is not stored. If a kept record names
  its hash in `prev`, the node keeps that hash alone (no body); a hash alone has no effect in the view
  and satisfies `prev` like a stored record. Otherwise the candidate is dropped. A record whose signer's
  lineage cannot be worked out (its introducing `admit` was not kept) is treated the same way.
- **View.** Unchanged: canonical replay of the kept records. A record whose own-chain predecessor
  (`n - 1`) is only a hash has no effect, so a lineage over its share loses effects inside that lineage
  only.
- **Prev.** Unchanged. A new record names the current tips; tips that are bare hashes are allowed.

## Convergence and bound

- **Same set on every node.** For each lineage and kind the kept records are the k smallest hashes among
  all candidates any node received. A node replaces a kept record only by a smaller one, and keeps
  offering its kept records, so after nodes exchange records they hold the same k. Which hashes are kept
  bare depends only on the kept records. Neither depends on arrival order.
- **Bound.** At most 4096 records with bodies, plus bare hashes named by them (at most 64 each).
  Candidates outside the shares are dropped, so a flood of forks costs the sender, not the receivers.
- **A revoke always fits.** A member in another lineage records the revoke within its own lineage's
  16 revoke places. The founder (lineage 0, alone unless it admits no one else) can always revoke.
  Members sharing the filler's lineage cannot, until the filler is revoked by someone outside it.
- **What a hostile member can do.** Fill its own lineage, so honest keys in that lineage lose effects
  (their newest records do not fit). A hostile founder can fill lineage 0 and refuse to start new ones;
  the remedy for a hostile founder is still a new mesh.
- **Honest limit.** A lineage that legitimately signs more than 240 records (renames, host key changes
  over years) loses its records with the largest hashes, not its oldest. Lineage-scoped compaction is
  follow-up work if that happens in practice.

## Compatibility

- The sync hello announces `"pen":"2.0"`. A 2.0 node closes a session whose hello does not, with a new
  close code (upgrade required), and sends no records; 1.1 nodes see a refused sync and `pen ls` says the
  peer runs an older Pen.
- Existing meshes stay on the old rules. `pen` 2.0 founds new meshes in the new epoch and keeps running
  an old mesh with the old rules until every member runs 2.0 and the founder moves it (`pen mesh
  upgrade`), which re-founds it and re-admits the members; records do not cross epochs.
- `have` lists only records with bodies, so it stays within 4096 hashes.

## Implementation plan

Each step lands as its own pull request, starting with a test that fails on `dev`.

1. Lineage of a record from its own past (`apps/pen/internal/mesh`): a key admitted by a member of
   lineage 3 is in lineage 3; a founder's 16th direct admit has no effect in the new epoch.
2. Shares and bare hashes in `Store`: the same candidates delivered in opposite orders give the same kept
   set and bare hashes; a flood of one lineage's forks keeps 256 of them and drops the rest.
3. Epoch in the sync hello and the refusal code; mesh files record their epoch.
4. `TestOneMemberCanFillTheRecordSpaceSoEvenItsOwnRevokeIsRefused` becomes a test that a member outside
   the filler's lineage records its revoke and every node applies it; docs and `pen ls`.
5. `pen mesh upgrade` for existing meshes.

## Tradeoffs

- A founder can admit at most 15 machines directly in a new mesh.
- Mixed old and new nodes do not sync; members upgrade before a mesh moves.
- Honest members in the filler's own lineage lose effects until it is revoked.
- Bare hashes add a second kind of stored entry to the set and the save file.

