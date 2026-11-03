import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("goat/guard-error-emitters");
const message = /Create this emitter inside guardErrors\/guardChild/;

describe("goat/guard-error-emitters", () => {
  rule.valid(
    "accepts guarded creations and untracked APIs",
    `
    import { guardErrors as guard, guardChild } from "@goat/shared/errorGuards";
    import * as CP from "node:child_process";
    import * as R from "node:readline";
    import * as T from "node:tty";
    import * as W from "node:worker_threads";
    import * as WS from "ws";
    guardChild((CP.spawn("a") as unknown)!, route);
    guardChild(CP.fork("a"), route);
    guard(R.createInterface({}), route);
    guard(new W.Worker("a"), route);
    guard(new WS.WebSocket("a"), route);
    guard(new T.ReadStream(0), route);
    guardChild((custom ?? CP.spawn)("a"), route);
    CP.execFile("a"); CP.exec("a");
    require("node-pty").spawn();
    const pty = createRequire(url)("node-pty"); pty.spawn();
    function spawn() {} spawn();
    type Spawn = typeof CP.spawn;
    const proto = CP.ChildProcess.prototype;
    import * as Net from "node:net";
    const isSocket = value instanceof Net.Socket;
    const prototype = Net.Socket.prototype;
    const kind = typeof Net.createServer;
  `,
  );
  rule.valid(
    "accepts property keys that share a tracked import's name",
    `
    import { spawn } from "node:child_process";
    const options = { spawn: true };
    other.spawn;
  `,
  );
  for (const [name, source] of [
    ["namespace", `import * as CP from "node:child_process"; CP.spawn("x");`],
    ["named", `import { spawn as s } from "node:child_process"; s("x");`],
    ["conditional", `import * as CP from "node:child_process"; (custom ?? CP.spawn)("x");`],
    ["call", `import * as CP from "node:child_process"; CP.spawn.call(null, "x");`],
    ["apply", `import * as CP from "node:child_process"; CP.spawn.apply(null, []);`],
    ["bind", `import * as CP from "node:child_process"; CP.spawn.bind(null);`],
    ["destructure", `import * as CP from "node:child_process"; const { fork } = CP; fork("x");`],
    ["require", `const CP = require("node:child_process"); CP.spawn("x");`],
    ["dynamic import", `const CP = await import("node:child_process"); CP.spawn("x");`],
    ["createRequire", `const CP = createRequire(url)("node:child_process"); CP.spawn("x");`],
    [
      "late guard",
      `import * as R from "node:readline"; const r = R.createInterface({}); guardErrors(r, route);`,
    ],
    [
      "effect socket",
      `import * as S from "@effect/platform-node/NodeSocket"; new S.NodeWS.WebSocket("x");`,
    ],
    ["watch", `import * as FS from "node:fs"; FS.watch("x");`],
    ["default websocket", `import WebSocket from "ws"; new WebSocket("x");`],
    ["value", `import * as CP from "node:child_process"; consume({ spawn: CP.spawn });`],
    [
      "impostor",
      `import * as CP from "node:child_process"; function guardChild(x) { return x } guardChild(CP.spawn("x"), route);`,
    ],
    [
      "shadowed guard",
      `import { guardChild } from "@goat/shared/errorGuards"; import * as CP from "node:child_process"; function f(guardChild) { guardChild(CP.spawn("x"), route); }`,
    ],
    [
      "nested creation",
      `import { guardChild } from "@goat/shared/errorGuards"; import * as CP from "node:child_process"; guardChild(CP.spawn(CP.spawn("x")), route);`,
    ],
  ]) {
    rule.invalid(name, source, (output) => assert.match(output, message));
  }
});
