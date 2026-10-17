import {
  type ProviderDiagnoseOnHostInput,
  type ProviderDiagnoseOnHostResult,
  ProviderDiagnoseResult,
  EnvironmentAuthorizationError,
  OrchestratorMcpFailure,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SessionStore from "../auth/SessionStore.ts";
import * as HostThreads from "../mcp/HostThreadsMcpService.ts";
import { authorizeSshHost, type SshHostCaller } from "../sshRemote/SshHostAuthorization.ts";
import * as Dispatch from "../sshRemote/SshRemoteDispatch.ts";
import * as Local from "./ProviderDiagnosisService.ts";

const decode = Schema.decodeUnknownEffect(ProviderDiagnoseResult);
const diagnosisDeadlineMs = 120_000;
export class ProviderDiagnosisRouting extends Context.Service<
  ProviderDiagnosisRouting,
  {
    readonly diagnose: (
      input: ProviderDiagnoseOnHostInput,
      caller: SshHostCaller,
    ) => Effect.Effect<
      ProviderDiagnoseOnHostResult,
      EnvironmentAuthorizationError | OrchestratorMcpFailure | Dispatch.SshRemoteDispatchError
    >;
  }
>()("goat/provider/ProviderDiagnosisRouting") {}

export const layer = Layer.effect(
  ProviderDiagnosisRouting,
  Effect.gen(function* () {
    const local = yield* Local.ProviderDiagnosisService;
    const hosts = yield* HostThreads.HostThreadsMcpService;
    const dispatch = yield* Dispatch.SshRemoteDispatch;
    const sessions = yield* SessionStore.SessionStore;
    return ProviderDiagnosisRouting.of({
      diagnose: Effect.fn("ProviderDiagnosisRouting.diagnose")(function* (input, caller) {
        const { host, ...args } = input;
        yield* authorizeSshHost(sessions, caller, "orchestration:read");
        if (host === undefined)
          return yield* local.diagnose(args).pipe(
            Effect.mapError(
              () =>
                new OrchestratorMcpFailure({
                  code: "orchestration_error",
                  message: "Could not read this environment's provider settings.",
                }),
            ),
          );
        if (caller.kind === "mcp")
          return yield* hosts.readOnHost(
            caller.scope,
            {
              host,
              tool: "goat_provider_diagnose",
              arguments: args,
              timeoutMs: diagnosisDeadlineMs,
              requireReady: true,
            },
            decode,
          );
        // SessionStore.listActive exposes current permissions, but not a verified runtime-mode ceiling.
        // Approval does not confer an agent mode: client and resumed handoff calls deliberately
        // use approval-required, reloading the real session before issuance and transmission.
        const authorize = authorizeSshHost(sessions, caller, "orchestration:read").pipe(
          Effect.as("approval-required" as const),
        );
        const raw = yield* dispatch.callHostTool(
          {
            host,
            tool: "goat_provider_diagnose",
            arguments: args,
            timeoutMs: diagnosisDeadlineMs,
            writes: false,
            approvals: false,
            requireReady: true,
          },
          authorize,
        );
        const result = yield* decode(raw).pipe(
          Effect.mapError(
            () =>
              new OrchestratorMcpFailure({
                code: "orchestration_error",
                message: `Update GOAT on ${host}: it returned an unreadable provider diagnosis.`,
              }),
          ),
        );
        return { ...result, host };
      }),
    });
  }),
);
