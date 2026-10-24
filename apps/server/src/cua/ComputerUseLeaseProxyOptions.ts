import type {
  ComputerUseHumanInputSource,
  ComputerUseOverlayCommand,
  ComputerUseLeaseUpdate,
  ComputerUseCallAdmission,
  ComputerUseCallReservation,
} from "@goat/contracts";
import type * as DateTime from "effect/DateTime";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";
import type { AgentInputReport } from "./agentInputReports.ts";
import type { ComputerUseCallTarget } from "./computerUseTarget.ts";
import type { NamedWindow, WindowPlacement } from "./x11WindowPlacement.ts";

export interface LeaseProxyDriver {
  readonly send: (line: string) => Effect.Effect<void>;
  readonly lines: Stream.Stream<string>;
  readonly kill: Effect.Effect<void>;
  /**
   * The helper's cursor overlay channel, when this child draws one (#1214). Returns once the
   * change is on screen, so a capture forwarded after a hide cannot contain the overlay.
   */
  readonly overlay?: (command: ComputerUseOverlayCommand) => Effect.Effect<void>;
  /**
   * Keyboard and pointer events the macOS helper saw, each with when it happened on this
   * process's clock, every agent's own included (#1235). Absent where the child reports none.
   */
  readonly humanInput?: Stream.Stream<{
    readonly source: ComputerUseHumanInputSource;
    readonly at: number;
  }>;
}

export interface LeaseProxyOptions<EU, ED> {
  readonly connectionId: string;
  readonly reservation: (
    call: ComputerUseCallReservation,
  ) => Effect.Effect<ComputerUseCallAdmission>;
  readonly controlId: string;
  readonly expiresAt: DateTime.Utc;
  /** Lines the provider writes. The proxy stops when this ends. */
  readonly input: Stream.Stream<string>;
  readonly output: (line: string) => Effect.Effect<void>;
  /** The server's view of this thread's control, newest last. Ending or failing ends it. */
  readonly leaseUpdates: Stream.Stream<ComputerUseLeaseUpdate, EU>;
  /** Starts one driver child; run again after a pause, each time in its own scope. */
  readonly startDriver: Effect.Effect<LeaseProxyDriver, ED, Scope.Scope>;
  /**
   * Identifies the driver's capability manifest file as it is now (#1416), where the driver
   * reads one from a known path; absent elsewhere. A change starts a fresh driver child. It is
   * synchronous on purpose: with no wait between reading it and acting on it, no pause, end or
   * replacement can land in between.
   */
  readonly manifestStamp?: () => string | undefined;
  /** Runs once a lease update has been applied, under the lifecycle lock; for tests. */
  readonly onLeaseUpdateApplied?: (update: ComputerUseLeaseUpdate) => Effect.Effect<void>;
  /** Deny-only revocation of the driver sessions this connection named. */
  readonly revokeSessions: (sessions: ReadonlyArray<string>) => Effect.Effect<void>;
  /**
   * Where the windows the driver names are, against the X display GOAT gave it (#1358); absent
   * where there is no X display to check. Anything but "same" refuses.
   */
  readonly placement?: (windows: ReadonlyArray<NamedWindow>) => Effect.Effect<WindowPlacement>;
  /**
   * Tells the server the window a forwarded call names, the one a live picture shows (#1370);
   * true when the server took it. Reported only on a change, observations included.
   */
  readonly onTarget?: (target: ComputerUseCallTarget) => Effect.Effect<boolean>;
  /**
   * Tells the server of a keyboard or pointer event outside this agent's own input calls; the
   * server drops it if another agent's input covers it, else pauses every agent. True when the
   * server took it; until then each later event is offered again.
   */
  readonly onHumanInput?: (input: {
    readonly source: ComputerUseHumanInputSource;
    readonly at: number;
  }) => Effect.Effect<boolean>;
  /**
   * Tells the server one of this agent's calls that can post input started or ended, and the
   * kinds of event it can post, so another agent's helper seeing that input is not taken for a
   * person. Reports go one at a time in order; a call reaches the driver only after its start
   * report has answered, so the server knows the call before any helper can see its events.
   */
  readonly onAgentInput?: (report: AgentInputReport) => Effect.Effect<unknown>;
}
