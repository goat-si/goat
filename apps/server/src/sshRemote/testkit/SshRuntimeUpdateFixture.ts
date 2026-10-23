import * as Schema from "effect/Schema";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect } from "@effect/vitest";
import { EnvironmentId, type SshHostResult, type SshHostStatus } from "@goat/contracts";
import * as FileSystem from "effect/FileSystem";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Context from "effect/Context";
import * as MaintenanceAudit from "../../maintenance/MaintenanceAudit.ts";
import * as ServerConfig from "../../config.ts";
import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import { dependencies } from "./SshHostSetupTestkit.ts";
import * as SshHostSetup from "../SshHostSetup.ts";
import * as SshRemoteDispatch from "../SshRemoteDispatch.ts";

const decodeAuditEntry = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

export const target = { alias: "box", hostname: "box", username: null, port: null };
export const stopped: SshHostStatus = {
  host: "box",
  state: "stopped",
  runtimeVersion: "0.4.2",
  requestedVersion: "0.4.3-owner",
};
export const invocation: McpInvocationScope = {
  environmentId: EnvironmentId.make("owner"),
  requestNamespace: "client:ssh",
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  thread: undefined,
  client: { sessionId: "client", label: "Agent", access: "full-access" },
  grantedScopes: ["environment:maintain"],
  reauthorize: () => Effect.void,
};

export const fixture = Effect.gen(function* () {
  let snapshot: SshHostResult = { kind: "ok", status: stopped };
  const events: string[] = [];
  const updates: { host: string; confirmReplacement: boolean }[] = [];
  const fs = yield* FileSystem.FileSystem.pipe(Effect.provide(NodeServices.layer));
  const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-ssh-audit-" });
  const config = yield* ServerConfig.ServerConfig.pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), baseDir).pipe(Layer.provide(NodeServices.layer)),
    ),
  );
  const audit = yield* MaintenanceAudit.MaintenanceAudit.pipe(
    Effect.provide(
      MaintenanceAudit.layer.pipe(
        Layer.provide(
          Layer.mergeAll(NodeServices.layer, Layer.succeed(ServerConfig.ServerConfig, config)),
        ),
      ),
    ),
  );
  const dispatch = Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({
    publishSetupOutcome: () => Effect.succeed(true),
    runtimeStatus: () => Effect.sync(() => snapshot),
    beginSetupOperation: (_host, { operationId }) =>
      Effect.succeed({ operationId, generation: 1, stage: "runtime" }),
    runtimeUpdate: (host, options) =>
      fs.readFileString(`${config.stateDir}/maintenance-audit.jsonl`).pipe(
        Effect.flatMap((line) => decodeAuditEntry(line.trim())),
        Effect.orDie,
        Effect.tap((entry) =>
          Effect.sync(() => {
            expect(entry).toMatchObject({ operationId: options.operationId, outcome: "requested" });
          }),
        ),
        Effect.andThen(
          Effect.sync(() => {
            events.push("update");
            updates.push({ host, confirmReplacement: options.confirmReplacement });
            snapshot = { kind: "ok", status: { ...stopped, state: "update_waiting" } };
            return snapshot;
          }),
        ),
      ),
  });
  const setup = Context.get(
    yield* Layer.build(
      SshHostSetup.layer.pipe(
        Layer.provide(Layer.succeed(MaintenanceAudit.MaintenanceAudit, audit)),
        Layer.provide(dispatch),
        Layer.provide(dependencies),
      ),
    ),
    SshHostSetup.SshHostSetup,
  );
  const scope: McpInvocationScope = {
    ...invocation,
    reauthorize: (required) =>
      Effect.sync(() => {
        expect(required).toEqual(["environment:maintain"]);
        events.push("authorize");
      }),
  };
  return { setup, scope, events, updates, journal: `${config.stateDir}/maintenance-audit.jsonl` };
});
