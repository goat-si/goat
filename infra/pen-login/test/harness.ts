// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - Test fixtures drive wrangler and HTTP directly.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import { signingKeyFromSeed, x25519PublicKey } from "@goat/pen-protocol/identity";
import {
  base64url,
  pollProofMessage,
  fromBase64url,
  startProofMessage,
} from "@goat/pen-protocol/login";

const PACKAGE_DIR = NodePath.join(import.meta.dirname, "..");

export interface Service {
  readonly url: string;
  stop(): Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = NodeNet.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address
          ? resolve(address.port)
          : reject(new Error("no port")),
      );
    });
  });
}

/** Runs `wrangler dev` in its own process group and resolves on its "Ready on" line. */
export async function startService(vars: Record<string, string>): Promise<Service> {
  const [port, inspectorPort] = [await freePort(), await freePort()];
  const persist = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pen-login-"));
  const args = [
    "dev",
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
    "--inspector-port",
    String(inspectorPort),
  ];
  args.push(
    "--persist-to",
    persist,
    ...Object.entries(vars).flatMap(([key, value]) => ["--var", `${key}:${value}`]),
  );
  const child = NodeChildProcess.spawn(
    NodePath.join(PACKAGE_DIR, "node_modules/.bin/wrangler"),
    args,
    {
      cwd: PACKAGE_DIR,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, WRANGLER_SEND_METRICS: "false", NO_COLOR: "1", FORCE_COLOR: "0" },
    },
  );
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const output: Array<string> = [];
  const url = await new Promise<string>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) =>
      reject(new Error(`wrangler dev exited ${code}:\n${output.join("\n")}`)),
    );
    for (const stream of [child.stdout, child.stderr]) {
      NodeReadline.createInterface({ input: stream }).on("line", (line) => {
        output.push(line);
        if (process.env.PEN_LOGIN_LOG) process.stderr.write(`[wrangler] ${line}\n`);
        const match = /Ready on (http:\/\/\S+)/.exec(line);
        if (match?.[1]) resolve(match[1].replace(/\/$/, ""));
      });
    }
  });
  return {
    url,
    stop: async () => {
      if (child.pid !== undefined && child.exitCode === null) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          // The group already exited.
        }
      }
      await exited;
      NodeFS.rmSync(persist, { recursive: true, force: true });
    },
  };
}

let sources = 0;
/** A fresh documentation-range address, so each test has its own rate limits. */
export function freshSource(): string {
  sources++;
  return `198.51.${100 + Math.floor(sources / 250)}.${(sources % 250) + 1}`;
}

export interface Page {
  readonly status: number;
  readonly headers: Headers;
  readonly body: string;
  /** Hidden csrf field of the page's form, if any. */
  readonly csrf: string | null;
  readonly location: string | null;
}

/** A browser with one cookie jar that never follows redirects on its own. */
export class Browser {
  private readonly cookies = new Map<string, string>();
  private readonly base: string;
  readonly source: string;

  constructor(base: string, source: string = freshSource()) {
    this.base = base;
    this.source = source;
  }

  async get(path: string): Promise<Page> {
    return this.send(path, { method: "GET" });
  }

  async post(path: string, form: Record<string, string>): Promise<Page> {
    return this.send(path, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
    });
  }

  private async send(path: string, init: RequestInit): Promise<Page> {
    const url = path.startsWith("http") ? path : this.base + path;
    const headers = new Headers(init.headers);
    headers.set("cf-connecting-ip", this.source);
    if (this.cookies.size > 0)
      headers.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    const response = await fetch(url, { ...init, headers, redirect: "manual" });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair = ""] = cookie.split(";");
      const index = pair.indexOf("=");
      this.cookies.set(pair.slice(0, index), pair.slice(index + 1));
    }
    const body = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      body,
      csrf: /name="csrf" value="([^"]+)"/.exec(body)?.[1] ?? null,
      location: response.headers.get("location"),
    };
  }
}

export interface Device {
  readonly signPub: string;
  readonly noisePub: string;
  readonly name: string;
  sign(message: Uint8Array): Promise<Uint8Array>;
}

export async function device(name = "box-1"): Promise<Device> {
  const key = await signingKeyFromSeed(crypto.getRandomValues(new Uint8Array(32)));
  const noisePub = await x25519PublicKey(crypto.getRandomValues(new Uint8Array(32)));
  return { signPub: base64url(key.signPub), noisePub: base64url(noisePub), name, sign: key.sign };
}

export async function api(base: string, path: string, body: unknown, source = freshSource()) {
  const response = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": source },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = { raw: text };
  }
  return { status: response.status, json };
}

export interface Started {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly interval: number;
  readonly expiresIn: number;
}

export async function startDevice(base: string, machine: Device, source?: string) {
  const proof = await machine.sign(
    startProofMessage(
      fromBase64url(machine.signPub),
      fromBase64url(machine.noisePub),
      machine.name,
    ),
  );
  return api(
    base,
    "/v1/device/start",
    {
      signPub: machine.signPub,
      noisePub: machine.noisePub,
      name: machine.name,
      proof: base64url(proof),
    },
    source,
  );
}

export async function poll(base: string, machine: Device, deviceCode: string, source?: string) {
  const proof = await machine.sign(pollProofMessage(fromBase64url(deviceCode)));
  return api(base, "/v1/device/token", { deviceCode, proof: base64url(proof) }, source);
}
