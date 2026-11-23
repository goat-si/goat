import type { AcpMcpContext } from "./mcpContext.ts";

export function createTerminalEnvironmentState(
  initialEnvironment: NodeJS.ProcessEnv | undefined,
  initialSessionId: string | undefined,
) {
  const terminalEnvironmentBySessionId = new Map<string, NodeJS.ProcessEnv>();
  /**
   * The Cua Driver each native session was activated with, by `cuaDriverKey`. A session
   * activated without one has no entry, so `has` means the activation listed a driver.
   */
  const computerUseKeyBySessionId = new Map<string, string>();
  interface PendingTerminalEnvironment {
    readonly environment: NodeJS.ProcessEnv | undefined;
    readonly claimUnknownSession: boolean;
    readonly sessionId: string | null;
  }
  let pendingTerminalEnvironment: PendingTerminalEnvironment | null = {
    environment: initialEnvironment,
    claimUnknownSession: initialSessionId === undefined,
    sessionId: initialSessionId ?? null,
  };
  const prepareTerminalEnvironment = (mcpContext: AcpMcpContext, sessionId?: string): void => {
    pendingTerminalEnvironment = {
      environment: mcpContext.processEnvironment,
      claimUnknownSession: false,
      sessionId: sessionId ?? null,
    };
  };
  const prepareClaimableTerminalEnvironment = (mcpContext: AcpMcpContext): void => {
    pendingTerminalEnvironment = {
      environment: mcpContext.processEnvironment,
      claimUnknownSession: true,
      sessionId: null,
    };
  };
  const rememberTerminalEnvironment = (sessionId: string, mcpContext: AcpMcpContext): void => {
    const environment = mcpContext.processEnvironment;
    pendingTerminalEnvironment = null;
    if (mcpContext.computerUse === true && mcpContext.computerUseKey)
      computerUseKeyBySessionId.set(sessionId, mcpContext.computerUseKey);
    else computerUseKeyBySessionId.delete(sessionId);
    if (environment === undefined) {
      terminalEnvironmentBySessionId.delete(sessionId);
    } else {
      terminalEnvironmentBySessionId.set(sessionId, environment);
    }
  };
  const environmentForSession = (sessionId: string) => {
    const remembered = terminalEnvironmentBySessionId.get(sessionId);
    if (remembered !== undefined) return remembered;
    if (pendingTerminalEnvironment === null) return undefined;
    if (
      pendingTerminalEnvironment.sessionId === null &&
      pendingTerminalEnvironment.claimUnknownSession
    ) {
      pendingTerminalEnvironment = {
        ...pendingTerminalEnvironment,
        sessionId,
      };
    }
    return pendingTerminalEnvironment.sessionId === sessionId
      ? pendingTerminalEnvironment.environment
      : undefined;
  };
  return {
    terminalEnvironmentBySessionId,
    computerUseKeyBySessionId,
    prepareTerminalEnvironment,
    prepareClaimableTerminalEnvironment,
    rememberTerminalEnvironment,
    environmentForSession,
  };
}
