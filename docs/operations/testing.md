# Testing policy

A test earns its place by failing when something a maintainer cares about breaks. Test count and
test lines are costs, not goals: every test is read in review, run in CI, and edited when the code
moves. This page says what a test must prove and what to delete. The deterministic-test rules in
[AGENTS.md](../../AGENTS.md#verifying) (TestClock, `Deferred`, no sleeps or polling) still apply,
and lint enforces them.

## What a test must prove

Each test proves at least one of these, and its title says which behavior:

- **Observable behavior** through the entry point callers use: a service method, an RPC or MCP
  handler, a reducer, a rendered control a user operates.
- **A contract** that crosses a boundary: a wire schema in `packages/contracts`, a persisted shape
  or migration, CLI output, a provider protocol message.
- **The regression of a real bug.** Name the issue or pull request in the test or a comment, so the
  next reader knows the failure it guards.
- **An invariant under concurrency**, ordering, retries, or restarts: two commands racing, a stream
  reconnecting, a worker resuming after a crash.

Ask what would fail if the test were deleted. If the answer is "nothing a user or caller could
see", the test does not belong.

## What not to write

- Tests that restate the implementation: asserting that a constant, lookup table, or schema literal
  equals itself, or recomputing the formula under test.
- Assertions on private call sequences: spies on the module's own internals, exact internal call
  counts, or mocks of the code under test. Mock at the boundary (provider process, network, clock)
  and assert the result.
- Duplicate coverage of one path at several levels. When an integration test proves a behavior,
  a unit test of the helper inside it adds nothing unless the helper has cases the integration
  test cannot reach cheaply.
- Snapshot or inline dumps without a stated intent. Assert the fields the behavior depends on.
- Trivial tests: getters, default values, type-only checks, "the module exports a function".
- Cases that prove the same behavior with a different input. Keep one, or make the cases one
  `it.each` table. A boundary value or an input from a real bug is a different behavior, even
  when it runs the same code.

## Choosing the level

Prefer one integration or contract test through the public entry point over several unit tests of
its internals. It survives refactors, and it proves the parts fit together. Write a focused unit
test when the logic has many cases that are expensive to reach from outside, such as a parser,
a reducer, or a merge rule, and express those cases as a table.

## Keeping tests small

Most test length is setup. When several tests build the same world, give the file one fixture
helper that takes the differences as arguments, and keep each test to its arrange-act-assert
lines. Copying a 100-line setup into a new test is the most common way a test file passes the
[size budget](code-quality.md#file-size).

## Deleting tests

Deleting a test that does not meet this policy is a normal change. The pull request lists each
removed test with its reason and names the test that still covers the behavior, when there is
one. Never delete the only test of a behavior, contract, or regression, or the tests that exercise
an invariant listed in [structure/overview.md](../../structure/overview.md#invariants).

Tests in files that also exist upstream (in `pingdotgg/t3code`) follow the
[fork delta rule](code-quality.md#goat-code-in-goat-modules): edit or delete the cases GOAT added,
and leave upstream's cases alone unless the code they test is gone from GOAT. Changing upstream
lines makes every upstream merge conflict on them.
