# 063 — Cycle 4 record (closes goalplan wp4; implements 030)

## Conclusion

Commit `852ebfb51`: SEA executable goat, archives goat-<v>-<platform>, runtimes in <home>/runtime/goat/versions, SSH remote root ~/.goat (runtime, ssh-launch, server home), retained runner reused only when its GOAT runtime is installed, installers/desktop shim/WSL/npm platform/workflows/help on goat; npm package t3 with bins goat+t3; hosting URLs and store ids unchanged.

## Evidence

Receipt: shared 63, ssh 78, server 200, desktop 87 (+13 platform skips), web 84, client-runtime 7, scripts 79 (+3 skips); tsc 8 packages; tunnel.ts has no $HOME/.t3. Audit 01a127f2 FAIL→PASS; review 01a127fb NEAR-PASS→PASS.

## Pessimist notes

- Not verified: SEA build, Linux/Windows installer execution (macOS skips), real SSH install — wp5 covers the macOS SSH path only.
- Died: "the plan's blanket renames are safe" — implementer had to preserve service keys, relay ids, mobile font classes, native helper names; reviewer caught invented store/cask identifiers.
- Refuting evidence: wp5 failing to launch goat from ~/.goat on juns-macbook-pro.

## Next

Cycle 5: closes the next goalplan phase (wp5 or wp6 per ready order) and runs 040 (e2e probe) with any fixes it finds.
