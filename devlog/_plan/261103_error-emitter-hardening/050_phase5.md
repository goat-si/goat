# 050 — Phase 5 (wp7): lint rule goat/guard-error-emitters

Branch: `chore/lint-guard-error-emitters` from origin/dev after wp6. One PR. Lands at zero violations.
At P: re-run the 001 sweep to catch sites added since wp5/wp6 and fix them in this PR.

## NEW oxlint-plugin-goat/rules/guard-error-emitters.ts
Shape follows rules/no-raw-resize-observer.ts (visitor + report). `goat/namespace-node-imports` is
already on repo-wide (vite.config.ts:545), so `node:*` modules arrive as namespace imports; the rule
still resolves named and default imports so it does not depend on that rule.

Tracked creations (module -> members):
- node:child_process -> spawn, fork
- node:readline, node:readline/promises -> createInterface
- node:net -> createServer, createConnection, connect, Socket (new), Server (new)
- node:tls -> connect, createServer
- node:http, node:https -> request, get, createServer
- node:fs -> createReadStream, createWriteStream, watch
- node:tty -> ReadStream (new), WriteStream (new)
- node:worker_threads -> Worker (new)
- ws -> WebSocket (new), WebSocketServer (new); @effect/platform-node/NodeSocket -> NodeWS.WebSocket (new)

node-pty is not tracked: NodePtyAdapter.ts:33-36 loads it through a `createRequire` binding inside a
loader arrow and spawns on a value from `Effect.tryPromise(loadNodePtyModule)` (:222-229), which
same-file resolution cannot connect. A13 stays covered by wp3's listener and its comment.

Resolution (per file): a "tracked reference" is
1. a member path off a namespace/default import of a tracked module (`NodeChildProcess.spawn`), or a
   named import binding (`import { spawn }`), or
2. a `const` alias or destructuring of (1) (`const { spawn } = NodeChildProcess`, `const s = NodeChildProcess.spawn`), or
3. the result of `require("<tracked module>")` / `createRequire(...)("<tracked module>")` / `await import("<tracked>")`
   bound to an identifier, then a member path off it.
References in TS type positions (`typeof NodeChildProcess.spawn`, imessageSender.ts:34) are skipped.

Report a CallExpression or NewExpression when its callee — after unwrapping LogicalExpression and
ConditionalExpression operands, and `.call` / `.apply` / `.bind` member calls — contains a tracked
reference, unless the whole expression is `arguments[0]` of a call whose callee is the identifier
`guardErrors` or `guardChild`. A tracked reference passed as a value (`spawn: NodeChildProcess.spawn`
in an options object) is also reported, because whoever calls it later creates an unguarded emitter;
the fix there is to pass a guarded factory. Known production value-passing site:
apps/server/src/cloud/CliTokenManager.ts:541 passes `NodeHttp.createServer` to `NodeHttpServer.layer`,
which listens itself (NodeHttpServer.ts:135): it gets a disable comment with that reason (row B28 in 030).
execFile/exec are not tracked: Node attaches its own 'error' listener to those children.
Message: "Create this emitter inside guardErrors/guardChild from @goat/shared/errorGuards so its
'error' is heard from the start; an unheard 'error' ends the whole process."

## NEW oxlint-plugin-goat/rules/guard-error-emitters.test.ts
Uses `createOxlintRuleHarness` (as in rules/namespace-node-imports.test.ts:3). Cases — valid:
guarded spawn/fork/createInterface/new Worker/new ws WebSocket/new NodeTty.ReadStream, execFile, an
unrelated local `spawn` function, `typeof NodeChildProcess.spawn` in a type; invalid: bare `NodeChildProcess.spawn(...)`, `import { spawn }`,
`(custom ?? NodeChildProcess.spawn)(...)`, `NodeChildProcess.spawn.call(...)`, `const { fork } = NodeChildProcess; fork()`,
`require("node-pty").spawn()`, `createRequire(url)("node-pty")` then `.spawn()`, createInterface
assigned and guarded on a later line, `new NodeSocket.NodeWS.WebSocket(...)`, `NodeFS.watch(...)`,
passing `NodeChildProcess.spawn` as a value.

## MODIFY oxlint-plugin-goat/index.ts
Import and register `"guard-error-emitters": guardErrorEmitters` beside no-raw-resize-observer (:24, :63).

## MODIFY vite.config.ts (lint overrides)
Later overrides win and the only test-exemption block (vite.config.ts:562-569) comes earlier, so the
rule carries its own `excludeFiles`, the way the overrides at :741, :746-751, :762-768 do:
```ts
      {
        files: ["apps/server/src/**", "apps/desktop/src/**", "packages/*/src/**"],
        excludeFiles: [
          "**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts", "**/*.testkit.ts",
          "**/*fixture*", "**/*{Fixture,Fixtures}*", "**/*Harness*",
          "**/{test,tests,testkit,testing,testUtils,fixtures,integration}/**",
          "packages/provider-testing/**", "packages/source-control-testing/**",
        ],
        rules: { "goat/guard-error-emitters": "error" },
      },
```
(copy the exact excludeFiles idiom from :741 at P). No backlogs.json entry: any site left after wp5/wp6
carries `// oxlint-disable-next-line goat/guard-error-emitters -- <reason>` (require-suppression-reason applies).
packages/shared/src/errorGuards.ts receives already-created emitters, so it needs no exemption.

## Verification (C)
1. Rule test fails first (rule file absent / reports missing), then `vp test run oxlint-plugin-goat/rules/guard-error-emitters.test.ts` exit 0.
2. `vp run check:changed` exit 0, plus one scoped `vp lint apps/server/src apps/desktop/src packages`
   (the rule applies to whole trees; this is the scoped equivalent of what CI's lint will see) exit 0.
3. PR (label ci:full) -> CI -> terra review -> merge-pr.ts -> final origin.report completed.
