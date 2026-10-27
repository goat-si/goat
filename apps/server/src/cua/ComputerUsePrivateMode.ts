import type { ComputerUseCapabilities } from "@goat/contracts";

type Signals = ComputerUseCapabilities["signals"];

/**
 * Private mode is switched off: a secret-field report pauses nothing, so no host counts as
 * detecting secret fields whatever its helper advertises, and unattended computer use stays
 * refused. Turning it on must restore the pause in ComputerUseLeases (privateHost); the refusal
 * then lifts by itself. docs/internals/computer-use.md lists what else must change first.
 */
const privateModeOn: boolean = false;

/** A helper's safety signals as the server acts on them. */
export const honoredSignals = (signals: Signals): Signals =>
  privateModeOn ? signals : { ...signals, privateMode: "unsupported" };
