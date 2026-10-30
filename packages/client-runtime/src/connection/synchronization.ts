import * as Duration from "effect/Duration";

/** How long a server has to send the first snapshot of a config subscription. */
export const SYNCHRONIZATION_TIMEOUT = Duration.seconds(75);
