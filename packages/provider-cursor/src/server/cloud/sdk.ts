import type { AgentOptions, Run, SDKAgent, SDKModel, StoredSdkCredentials } from "@cursor/sdk";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as CursorSdk from "../CursorSdk.ts";
import { Cursor, FileCredentialStore } from "../sdk.ts";

export type CloudRun = Pick<Run, "id" | "agentId" | "status" | "stream" | "wait" | "createdAt">;
export type CloudAgent = Pick<SDKAgent, "agentId" | "close"> & {
  readonly send: (...args: Parameters<SDKAgent["send"]>) => Promise<CloudRun>;
};
export type CloudRunOptions = { runtime: "cloud"; agentId: string; apiKey: string };

export class CursorCloudSdkError extends Schema.TaggedError<CursorCloudSdkError>()(
  "CursorCloudSdkError",
  {
    operation: Schema.Literals([
      "create",
      "resume",
      "send",
      "get-run",
      "result",
      "cancel",
      "read-login",
      "list",
      "models",
    ]),
  },
) {
  override get message(): string {
    return `Cursor Cloud ${this.operation} failed.`;
  }
}

export const request = <A>(operation: CursorCloudSdkError["operation"], run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    // SDK exceptions can contain credentials in their message or request fields.
    catch: () => new CursorCloudSdkError({ operation }),
  });

export class CursorCloudSdk extends Context.Service<
  CursorCloudSdk,
  {
    readonly create: (options: AgentOptions) => Promise<CloudAgent>;
    readonly resume: (id: string, options: Partial<AgentOptions>) => Promise<CloudAgent>;
    readonly getRun: (id: string, options: CloudRunOptions) => Promise<CloudRun>;
    readonly cancelRun: (id: string, options: CloudRunOptions) => Promise<void>;
    readonly readLogin: Effect.Effect<StoredSdkCredentials | undefined, CursorCloudSdkError>;
    readonly checkAccess: (apiKey: string) => Effect.Effect<void, CursorCloudSdkError>;
    readonly readModels: (apiKey: string) => Effect.Effect<SDKModel[], CursorCloudSdkError>;
  }
>()("@goat/provider-cursor/server/cloud/sdk/CursorCloudSdk") {}

export const layer = Layer.effect(
  CursorCloudSdk,
  Effect.gen(function* () {
    const { Agent } = yield* CursorSdk.CursorSdk;
    const login = new FileCredentialStore();
    return CursorCloudSdk.of({
      create: (options) => Agent.create(options),
      resume: (id, options) => Agent.resume(id, options),
      getRun: (id, options) => Agent.getRun(id, options),
      cancelRun: (id, options) => Agent.cancelRun(id, options),
      readLogin: request("read-login", () => login.load()),
      checkAccess: (apiKey) =>
        request("list", () => Agent.list({ runtime: "cloud", apiKey, limit: 1 })).pipe(
          Effect.asVoid,
        ),
      readModels: (apiKey) => request("models", () => Cursor.models.list({ apiKey })),
    });
  }),
);
