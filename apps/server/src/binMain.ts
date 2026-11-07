import { enableCliCompileCache } from "./cliCompileCache.ts";

const FULL_CLI_BUILTINS = new Set(["--completions", "--wizard", "--no-wizard", "--help", "-h"]);

export async function runCliCommand() {
  const command = process.argv[2];
  // Guard sockets before either dispatch path can load outbound-capable modules.
  const { ignoreMacosTypeOfServiceEinval } = await import("./outboundHttp.ts");
  ignoreMacosTypeOfServiceEinval();
  if (command === "--version" && process.argv.length === 3) {
    const { runVersionMain } = await import("./cli/helperMain.ts");
    runVersionMain();
  } else if (
    command === "__ssh-helper" &&
    !process.argv.some((arg) => FULL_CLI_BUILTINS.has(arg.split("=")[0] ?? arg))
  ) {
    const { runSshHelperMain } = await import("./cli/helperMain.ts");
    await runSshHelperMain(process.argv.slice(2));
  } else if (command === "__document-text") {
    const { extractDocumentText } = await import("./provider/documentTextWorker.ts");
    try {
      const [, , , documentPath, documentName] = process.argv;
      if (documentPath === undefined || documentName === undefined)
        throw new Error("Document path and name are required.");
      process.stdout.write(await extractDocumentText(documentPath, documentName));
    } catch (error) {
      if (error instanceof Error && "code" in error && /^E[A-Z0-9]+$/.test(String(error.code))) {
        throw error;
      }
      // Exit 2 identifies document rejections; OS and process failures remain retryable.
      process.exitCode = 2;
    }
  } else if (command === "__ssh-native-session") {
    // The native Windows SSH path runs this as the selected goat.exe; see sshNativeSession.ts.
    const { runSshNativeSession } = await import("./cli/sshNativeSession.ts");
    await runSshNativeSession();
  } else if (command === "__managed-chatgpt-token") {
    const { runManagedChatGptTokenCli } = await import("./cli/managedChatGptToken.ts");
    await runManagedChatGptTokenCli(process.argv.slice(3));
  } else if (command === "__speech-worker") {
    if (process.argv[3] !== "model") throw new Error("Unknown speech worker mode.");
    const { runNativeSpeechWorker } = await import("./speech/native.ts");
    await runNativeSpeechWorker();
  } else if (command === "__screen-run-child") {
    const { runScreenChild } = await import("./screenCode/ScreenRunChild.ts");
    await runScreenChild(process.stdin, process.stdout);
  } else if (command === "acp-mcp-bridge") {
    const { runAcpMcpBridgeFastPath } = await import("./mcp/AcpMcpStdioBridge.ts");
    await runAcpMcpBridgeFastPath();
  } else if (command === "cua-lease-proxy") {
    // Spawned by providers for an unattended thread's approved computer use; see ComputerUseLeaseProxy.
    const { runLeaseProxyCli } = await import("./cua/ComputerUseLeaseProxyCli.ts");
    await runLeaseProxyCli(process.argv.slice(3));
  } else if (command === "__open-url") {
    // A thread's BROWSER; see urlOpener/UrlOpenerShim.ts.
    const { runUrlOpenerCli } = await import("./urlOpener/urlOpenerCli.ts");
    process.exitCode = await runUrlOpenerCli(process.argv.slice(3));
  } else {
    const { agentSurfaceInvocation, nodeInputReader } =
      await import("./cli/agentSurfaceCommand.ts");
    const invocation = agentSurfaceInvocation(process.argv.slice(2), nodeInputReader);
    if (invocation !== undefined) {
      const { runAgentSurfaceCliMain } = await import("./cli/agentSurfaceCli.ts");
      process.exitCode = await runAgentSurfaceCliMain(invocation);
    } else {
      enableCliCompileCache();
      // Before anything reads stdin: the desktop app's Windows launcher starts
      // the CLI without one. Never for the fast paths, whose stdin is a pipe.
      const { attachConsoleStdin } = await import("./cli/consoleStdin.ts");
      attachConsoleStdin();
      const importStart = performance.now();
      const { runCli } = await import("./binCli.ts");
      if (process.env.GOAT_STARTUP_PROFILE_DIR) {
        performance.measure("server.import.binCli", { start: importStart });
      }
      runCli();
    }
  }
}
