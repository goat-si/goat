// @effect-diagnostics nodeBuiltinImport:off - a one-shot helper the native Windows SSH path runs before any Effect runtime.
// @effect-diagnostics globalDate:off
// @effect-diagnostics globalFetch:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import {
  AuthSessionId,
  ChildSetupPurpose,
  EnvironmentId,
  ExecutionEnvironmentDescriptor,
  GOAT_RUNTIME_CONTROL_HEADER,
  GOAT_RUNTIME_SESSION_PATH,
  RuntimeSessionRequest,
  RuntimeSessionRevokeResult,
} from "@goat/contracts";
import { GOAT_ENVIRONMENT_PATH } from "@goat/contracts/legacyT3Names";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Schema from "effect/Schema";

import { PersistedServerRuntimeState } from "../serverRuntimeState.ts";

const MAX_BYTES = 65_536;
const Selection = Schema.Struct({
  version: Schema.String.check(
    Schema.isPattern(
      /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u,
    ),
  ),
  executablePath: Schema.String,
  baseDir: Schema.String,
  sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
  pid: Schema.Int,
  birth: Schema.String,
  environmentId: EnvironmentId,
  instanceId: Schema.String,
  nonce: Schema.String,
  port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
});
const decodeEnvelope = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ selection: Selection, request: RuntimeSessionRequest })),
);
const decodeIssued = Schema.decodeUnknownSync(
  Schema.Struct({
    sessionId: AuthSessionId,
    token: Schema.String,
    subject: Schema.String,
    scopes: Schema.Array(Schema.String),
    expiresAt: Schema.String,
    childSetupPurpose: Schema.optionalKey(ChildSetupPurpose),
  }),
);
const decodePairing = Schema.decodeUnknownSync(Schema.Struct({ credential: Schema.String }));
const decodeRevoked = Schema.decodeUnknownSync(RuntimeSessionRevokeResult);
const decodeRuntime = Schema.decodeUnknownSync(Schema.fromJsonString(PersistedServerRuntimeState));
const decodeDescriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);
const encodeRequest = Schema.encodeSync(Schema.fromJsonString(RuntimeSessionRequest));

const sameScopes = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
  left.length === new Set(left).size &&
  left.length === right.length &&
  left.every((scope) => right.includes(scope));

/** Refuses a path any of whose components is a symbolic link or junction. */
const noReparse = async (file: string) => {
  for (let current = NodePath.resolve(file); ; current = NodePath.dirname(current)) {
    if ((await NodeFSP.lstat(current)).isSymbolicLink()) throw new Error("Reparse path.");
    if (current === NodePath.dirname(current)) return;
  }
};
const readBounded = async (file: string) => {
  await noReparse(file);
  const stat = await NodeFSP.stat(file);
  if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error("Record size.");
  return NodeFSP.readFile(file, "utf8");
};
const fetchBounded = async (url: string, init?: RequestInit): Promise<unknown> => {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(10_000),
    redirect: "error",
  });
  if (!response.ok || response.body === null) throw new Error("Runtime control refused.");
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error("Runtime response size.");
  return JSON.parse(text) as unknown;
};

/**
 * Issues, revokes or pairs through the running server's own loopback endpoint. A session must
 * name its id and carry exactly the requested subject, scopes and Child setup purpose; a
 * revocation must acknowledge exactly the requested session. Nothing is retried.
 */
export const requestNativeRuntimeCredential = async (
  origin: string,
  secret: string,
  request: RuntimeSessionRequest,
): Promise<unknown> => {
  const raw = await fetchBounded(origin + GOAT_RUNTIME_SESSION_PATH, {
    method: "POST",
    headers: { [GOAT_RUNTIME_CONTROL_HEADER]: secret, "content-type": "application/json" },
    body: encodeRequest(request),
  });
  if (request.kind === "revoke") {
    const reply = decodeRevoked(raw);
    if (reply.sessionId !== request.sessionId) throw new Error("Revocation session mismatch.");
    return reply;
  }
  if (request.kind === "pairing") {
    if (decodePairing(raw).credential.trim().length === 0)
      throw new Error("Empty pairing credential.");
    return raw;
  }
  const reply = decodeIssued(raw);
  const expiry = Date.parse(reply.expiresAt);
  const purpose = request.childSetupPurpose;
  if (
    reply.token.trim().length === 0 ||
    reply.subject !== request.subject ||
    !sameScopes(reply.scopes, request.scopes) ||
    !Number.isFinite(expiry) ||
    expiry <= Date.now() ||
    !NodeUtil.isDeepStrictEqual(reply.childSetupPurpose, purpose) ||
    (purpose !== undefined && expiry > purpose.expiresAt)
  )
    throw new Error("Session grant mismatch.");
  return raw;
};

const readStdin = async () => {
  const chunks: Array<Buffer> = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const value = Buffer.from(chunk as Uint8Array);
    bytes += value.byteLength;
    if (bytes > MAX_BYTES) throw new Error("Request size.");
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
};

/**
 * `goat __ssh-native-session`: run by the native Windows SSH operation as the selected, hashed
 * goat.exe. It opens no database: it checks that this executable, the running record, the
 * on-disk environment and the live descriptor are all the selection, then asks the server.
 */
export const runSshNativeSession = async () => {
  try {
    if (HostProcess.Platform.defaultValue() !== "win32") throw new Error("Native Windows only.");
    const { selection, request } = decodeEnvelope(await readStdin());
    const base = NodePath.join(NodeOS.homedir(), ".goat");
    const executable = NodePath.join(
      base,
      "runtime",
      "goat",
      "versions",
      selection.version,
      "goat.exe",
    );
    const same = (left: string, right: string) =>
      NodePath.resolve(left).toLowerCase() === NodePath.resolve(right).toLowerCase();
    if (
      !same(selection.baseDir, base) ||
      !same(selection.executablePath, executable) ||
      !same(process.execPath, executable)
    )
      throw new Error("Selection identity.");
    await noReparse(executable);
    const digest = NodeCrypto.createHash("sha256")
      .update(await NodeFSP.readFile(executable))
      .digest("hex");
    if (digest !== selection.sha256) throw new Error("Executable changed.");
    const userdata = NodePath.join(base, "userdata");
    const identityFile = NodePath.join(userdata, "environment-id");
    const runtimeFile = NodePath.join(userdata, "server-runtime.json");
    const identity = (await readBounded(identityFile)).trim();
    const observed = await readBounded(runtimeFile);
    const runtime = decodeRuntime(observed);
    const origin = `http://127.0.0.1:${selection.port}`;
    if (
      identity !== selection.environmentId ||
      runtime.pid !== selection.pid ||
      runtime.instanceId !== selection.instanceId ||
      runtime.port !== selection.port ||
      runtime.origin !== origin
    )
      throw new Error("Destination identity.");
    const descriptor = decodeDescriptor(await fetchBounded(origin + GOAT_ENVIRONMENT_PATH));
    if (
      descriptor.environmentId !== identity ||
      descriptor.instanceId !== selection.instanceId ||
      descriptor.serverVersion !== selection.version ||
      descriptor.capabilities.runtimeSessions !== true
    )
      throw new Error("Runtime identity.");
    const purpose = request.kind === "session" ? request.childSetupPurpose : undefined;
    if (purpose !== undefined && purpose.destinationEnvironmentId !== identity)
      throw new Error("Setup destination.");
    const secret = (await readBounded(NodePath.join(userdata, "runtime-control.token"))).trim();
    const reply = await requestNativeRuntimeCredential(origin, secret, request);
    // The answer counts only for the runtime that was checked before asking.
    if (
      (await readBounded(runtimeFile)) !== observed ||
      (await readBounded(identityFile)).trim() !== identity
    )
      throw new Error("Runtime changed during the credential request.");
    process.stdout.write(JSON.stringify(reply) + "\n");
  } catch {
    process.stderr.write("Native GOAT credential operation refused.\n");
    process.exitCode = 1;
  }
};
