import type {
  EnvironmentId,
  ProviderDriverKind,
  ServerProviderCompatibilityAdvisory,
  BackgroundScope,
  ChatAttachment,
  ServerSettings,
  ServerSettingsError,
} from "@goat/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";

import type { ProviderCredentialError } from "./errors.ts";

export type ProviderCompatibilityLookup = (
  driver: ProviderDriverKind,
  version: string,
) => Effect.Effect<ServerProviderCompatibilityAdvisory | undefined>;

export function brokenVersionDetail(input: {
  name: string;
  version: string;
  advisory: ServerProviderCompatibilityAdvisory | undefined;
}): string | undefined {
  if (input.advisory?.status !== "broken") return undefined;
  const target =
    input.advisory.recommendedVersion ?? input.advisory.recommendedRange ?? "a newer version";
  return `${input.name} ${input.version} does not work with this GOAT release. Update ${input.name} to ${target}, then retry.`;
}

export interface ProviderHostPaths {
  readonly cwd: string;
  readonly baseDir: string;
  readonly stateDir: string;
  readonly providerStatusCacheDir: string;
  /** Where chat attachments are stored; agents that sandbox file reads must be granted it. */
  readonly attachmentsDir: string;
}

export interface ProviderCredentials {
  /** Instances whose bindings are equal share these credentials. */
  readonly binding: { readonly owner: "t3"; readonly key: string };
  readonly get: Effect.Effect<Option.Option<Uint8Array>, ProviderCredentialError>;
  readonly set: (credentials: Uint8Array) => Effect.Effect<void, ProviderCredentialError>;
  readonly remove: Effect.Effect<void, ProviderCredentialError>;
}

export class ProviderHost extends Context.Service<
  ProviderHost,
  {
    readonly environmentId?: EnvironmentId;
    readonly compatibility: ProviderCompatibilityLookup;
    readonly paths: ProviderHostPaths;
    readonly settings: {
      readonly get: Effect.Effect<ServerSettings, ServerSettingsError>;
      /** Runs `use` on a settings snapshot that no settings write can change until it finishes. */
      readonly withSnapshot: <A, E, R>(
        use: (settings: ServerSettings) => Effect.Effect<A, E, R>,
      ) => Effect.Effect<A, E | ServerSettingsError, R>;
      readonly changes: Stream.Stream<ServerSettings>;
      /** Changes buffered from the moment the scoped subscription is acquired. */
      readonly subscribe: Effect.Effect<Stream.Stream<ServerSettings>, never, Scope.Scope>;
    };
    readonly shouldRunBackgroundWork: (scope: BackgroundScope) => Effect.Effect<boolean>;
    /** Completes once server startup finishes; first provider checks wait for it. */
    readonly awaitServerReady?: Effect.Effect<void>;
    /** Absolute attachment path, or null if the ID does not resolve inside attachmentsDir. */
    readonly resolveAttachmentPath: (attachment: ChatAttachment) => string | null;
    readonly resolveExtractedTextPath?: (path: string) => Effect.Effect<string | undefined>;
    readonly retainAgentPortDiscovery?: Effect.Effect<void, never, Scope.Scope>;
    readonly credentials: (
      namespace: string,
      bindingId: string,
    ) => Effect.Effect<ProviderCredentials>;
  }
>()("@goat/provider-core/server/ProviderHost") {}
