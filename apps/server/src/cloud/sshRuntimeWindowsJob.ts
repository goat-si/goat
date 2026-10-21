// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off - Bounds the native compiler and waits for its close event.
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";

// This supervisor owns the only (non-inheritable) job handle. It joins the job before
// starting the command, so even a shell that immediately exits cannot orphan its children.
// Killing the supervisor by Node's retained process handle closes the job and stops its
// members. The detached activation supervisor uses WMI and deliberately starts outside it.
const WINDOWS_JOB_SUPERVISOR = String.raw`
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;

public static class GoatRuntimeJob {
  public static void Main(string[] args) {
    var arguments = new string[args.Length - 1];
    Array.Copy(args, 1, arguments, 0, arguments.Length);
    Run(args[0], arguments);
  }
  [StructLayout(LayoutKind.Sequential)]
  struct BasicLimits {
    public long ProcessTime, JobTime;
    public uint Flags;
    public UIntPtr MinWorkingSet, MaxWorkingSet;
    public uint ActiveProcesses;
    public UIntPtr Affinity;
    public uint Priority, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct IoCounters {
    public ulong ReadOperations, WriteOperations, OtherOperations;
    public ulong ReadBytes, WriteBytes, OtherBytes;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct ExtendedLimits {
    public BasicLimits Basic;
    public IoCounters Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, uint size);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

  // Kept open until process exit, never inherited by a command. Closing it while this
  // supervisor is alive would terminate the supervisor before it returns the exit code.
  static IntPtr job;

  static string Quote(string value) {
    var result = new StringBuilder("\"");
    int slashes = 0;
    foreach (char c in value) {
      if (c == '\\') { slashes++; continue; }
      result.Append('\\', c == '"' ? slashes * 2 + 1 : slashes);
      result.Append(c);
      slashes = 0;
    }
    result.Append('\\', slashes * 2);
    return result.Append('"').ToString();
  }

  static async Task Input(Stream source, Stream target) {
    try { await source.CopyToAsync(target); }
    catch (IOException) { }
    finally { target.Dispose(); }
  }

  public static void Run(string command, string[] args) {
    try {
      job = CreateJobObject(IntPtr.Zero, null);
      if (job == IntPtr.Zero) throw new Win32Exception();
      var limits = new ExtendedLimits();
      limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
      if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits)))
        throw new Win32Exception();
      using (var self = Process.GetCurrentProcess()) {
        if (!AssignProcessToJobObject(job, self.Handle)) throw new Win32Exception();
      }
      var quoted = Array.ConvertAll(args, Quote);
      var start = new ProcessStartInfo(command, string.Join(" ", quoted));
      start.UseShellExecute = false;
      start.CreateNoWindow = true;
      start.RedirectStandardInput = true;
      start.RedirectStandardOutput = true;
      start.RedirectStandardError = true;
      using (var child = Process.Start(start)) {
        var input = Input(Console.OpenStandardInput(), child.StandardInput.BaseStream);
        var output = child.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
        var error = child.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());
        child.WaitForExit();
        // Descendants may still hold these pipes after the command exits. Keep the job's
        // owner alive until they close or Node terminates this exact supervisor handle.
        Task.WaitAll(input, output, error);
        Environment.Exit(child.ExitCode);
      }
    } catch (Exception error) {
      Console.Error.WriteLine("Windows runtime job failed: " + error.GetType().Name);
      Environment.Exit(1);
    }
  }
}
`;

export class WindowsJobCompilationError extends Error {
  readonly code: number | null;
  constructor(reason: "start" | "exit" | "timeout", code: number | null) {
    super(`Windows runtime job compilation failed: ${reason}.`);
    this.code = code;
  }
}

export async function windowsJobCommand(input: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
}) {
  const directory = await NodeFS.promises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "goat-job-"));
  const command = NodePath.join(directory, "supervisor.exe");
  const dispose = () => NodeFS.promises.rm(directory, { recursive: true, force: true });
  // Windows PowerShell 5.1 silently exits under DETACHED_PROCESS before evaluating its script.
  // Compile while attached, then detach the executable that owns the job and its process HANDLE.
  const script = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(WINDOWS_JOB_SUPERVISOR).toString("base64")}'))) -OutputAssembly '${command.replaceAll("'", "''")}' -OutputType ConsoleApplication
`;
  const powershell = NodePath.win32.join(
    input.env.SystemRoot ?? input.env.SYSTEMROOT ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  try {
    await new Promise<void>((resolve, reject) => {
      const compiler = NodeChildProcess.spawn(
        powershell,
        [
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(script, "utf16le").toString("base64"),
        ],
        { env: input.env, windowsHide: true, stdio: "ignore" },
      );
      let failedToStart = false;
      let timedOut = false;
      compiler.once("error", () => {
        failedToStart = true;
      });
      const deadline = setTimeout(() => {
        timedOut = true;
        compiler.kill();
      }, 30_000);
      compiler.once("close", (code) => {
        clearTimeout(deadline);
        // Even spawn errors must reach close before the temporary compiler output is removed.
        if (timedOut) reject(new WindowsJobCompilationError("timeout", null));
        else if (failedToStart) reject(new WindowsJobCompilationError("start", null));
        else if (code !== 0) reject(new WindowsJobCompilationError("exit", code));
        else resolve();
      });
    });
    return { command, args: [input.command, ...input.args], dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
