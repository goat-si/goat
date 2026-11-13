// @effect-diagnostics nodeBuiltinImport:off -- A fake Pen subprocess and a plain HTTP client for gateway tests.
import * as NodeHttp from "node:http";
import * as NodeEvents from "node:events";
import * as NodeStream from "node:stream";
import type * as NodeChildProcess from "node:child_process";

export const pin = { meshId: "m".repeat(26), nodeId: "a".repeat(26), noisePub: "a".repeat(43) };
export function fetchUrl(url: string, headers: Record<string, string> = {}, method = "GET") {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = NodeHttp.request(url, { headers, method }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}
export function fakeChild(
  script?: (request: string, stdout: NodeStream.PassThrough) => void,
  ready = true,
  memberPin = pin,
) {
  const child = new NodeEvents.EventEmitter() as NodeChildProcess.ChildProcess;
  const stdin = new NodeStream.PassThrough();
  const stdout = new NodeStream.PassThrough();
  const stderr = new NodeStream.PassThrough();
  Object.assign(child, {
    stdin,
    stdout,
    stderr,
    stdio: [stdin, stdout, stderr],
    pid: 123,
    exitCode: null,
    signalCode: null,
  });
  child.kill = () => {
    if (child.signalCode === null) {
      Object.assign(child, { signalCode: "SIGKILL" });
      child.emit("exit", null, "SIGKILL");
      stdout.destroy();
    }
    return true;
  };
  if (ready)
    queueMicrotask(() => stderr.write(`pen-ready v1 ${memberPin.nodeId} ${memberPin.noisePub}\n`));
  let request = "";
  stdin.on("data", (bytes: Buffer) => {
    request += bytes.toString();
    const split = request.indexOf("\r\n\r\n");
    if (split < 0) return;
    const length = Number(/\r\nContent-Length: (\d+)/i.exec(request)?.[1] ?? 0);
    if (Buffer.byteLength(request.slice(split + 4)) < length) return;
    stdin.removeAllListeners("data");
    script?.(request, stdout);
  });
  return child;
}
