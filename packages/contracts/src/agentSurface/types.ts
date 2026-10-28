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
   * One-line signatures of other paths that the listing shows after the description, so an agent
   * can call them without asking goat_describe first (signature.ts renders the syntax).
   */
  readonly signatures?: ReadonlyArray<string>;
  /**
   * One line for each argument whose schema states nothing, keyed by name (a dotted name for a
   * field one object down). The served input schema shows it; the schema's own text wins.
   */
  readonly parameters?: Readonly<Record<string, string>>;
  /** Worked calls goat_describe serves for this path; each must decode as its arguments. */
  readonly examples?: ReadonlyArray<AgentSurfaceExample>;
  /**
   * "core" lists the tool in the core listing and marks it to load up front in every listing.
   * "core_eval" loads it up front only under the opt-in core_eval listing; full lists it like any
   * tool. Everything else is found with goat_describe and called by name or through goat_call.
   */
  readonly listing?: "core" | "core_eval";
  readonly effect: AgentSurfaceEffect;
  readonly hostRoutable: boolean;
  readonly requires: "thread" | "client" | "either";
  readonly dryRun: "supported" | "unsupported";
  readonly humanSteps: ReadonlyArray<
    "secret" | "approval" | "question" | "sign_in" | "host_trust" | "pairing"
  >;
  readonly capability?: AgentSurfaceCapability;
  readonly capabilityReason?: string;
  readonly idempotency?: "key" | "domain";
  readonly keyRequired?: true;
  readonly reconcile?: string;
  /** Why a write's key is not ToolAdmission's: idempotency.test.ts requires "key" or this. */
  readonly idempotencyReason?: string;
  /** Arguments that, when set, make a "domain" write's store ignore clientRequestId. */
  readonly keyIgnoredWith?: ReadonlyArray<string>;
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

/**
 * "key": ToolAdmission reserves clientRequestId, and `reconcile` reads whether an unknown outcome
 * happened (docs/internals/agent-surface.md#idempotency). "domain": the write's own store
 * deduplicates it unless a `keyIgnoredWith` argument is set. Others say why in `idempotencyReason`.
 */
export type IdempotencyDeclaration =
  | {
      readonly idempotency?: undefined;
      readonly keyRequired?: undefined;
      readonly reconcile?: undefined;
      readonly idempotencyReason?: undefined;
      readonly keyIgnoredWith?: undefined;
    }
  | {
      readonly idempotency: "key";
      readonly keyRequired?: true;
      readonly reconcile: string;
      readonly idempotencyReason?: undefined;
      readonly keyIgnoredWith?: undefined;
    }
  | {
      readonly idempotency: "domain";
      readonly keyRequired?: undefined;
      readonly reconcile?: undefined;
      readonly idempotencyReason: string;
      readonly keyIgnoredWith?: ReadonlyArray<string>;
    }
  | {
      readonly idempotency?: undefined;
      readonly keyRequired?: undefined;
      readonly reconcile?: undefined;
      readonly idempotencyReason: string;
      readonly keyIgnoredWith?: undefined;
    };
