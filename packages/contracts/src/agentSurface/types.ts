import type { PermissionCapability } from "../permissionProfiles.ts";
import type { OperationKind } from "./operation.ts";

/** Metadata only: schemas and handlers remain with their owning toolkit. */
export type AgentSurfaceEffect = "read" | "write" | "destructive";
/**
 * The goatclaw capability a caller's profile needs before a write runs, or "none" when no
 * profile gates it and `capabilityReason` says what bounds it instead. Reads declare nothing.
 */
export type AgentSurfaceCapability = PermissionCapability | "none";
export interface AgentSurfaceExample {
  readonly title: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly expect: Readonly<Record<string, unknown>>;
}
export interface AgentSurfaceEntry {
  readonly resource: string;
  readonly verb: string;
  readonly name: string;
  readonly toolkit: string;
  readonly summary: string;
  /** What a listing shows; at most DESCRIPTION_BUDGET characters (descriptionBudget.ts). */
  readonly description: string;
  /** Guidance longer than the description, served only by goat_describe for one path. */
  readonly guide?: string;
  /**
   * "core" lists the tool in the core listing and marks it to load up front in every listing.
   * Everything else is found with goat_describe and called by name or through goat_call.
   */
  readonly listing?: "core";
  readonly effect: AgentSurfaceEffect;
  readonly hostRoutable: boolean;
  readonly requires: "thread" | "client" | "either";
  readonly dryRun: "supported" | "unsupported";
  readonly humanSteps: ReadonlyArray<
    "secret" | "approval" | "question" | "sign_in" | "host_trust" | "pairing"
  >;
  readonly capability?: AgentSurfaceCapability;
  readonly capabilityReason?: string;
  /** The kind of operation this path's accepted work becomes; goat_call returns its handle. */
  readonly operation?: OperationKind;
  readonly annotations: {
    readonly title?: string;
    readonly idempotentHint: boolean;
    readonly openWorldHint: boolean;
  };
}

/** Every write declares its capability; capabilities.test.ts checks the reasons. */
export type CapabilityDeclaration =
  | {
      readonly effect: "read";
      readonly capability?: undefined;
      readonly capabilityReason?: undefined;
    }
  | {
      readonly effect: "write" | "destructive";
      readonly capability: PermissionCapability;
      readonly capabilityReason?: undefined;
    }
  | {
      readonly effect: "write" | "destructive";
      readonly capability: "none";
      readonly capabilityReason: string;
    };
