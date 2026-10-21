// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

// This supervisor owns the only (non-inheritable) job handle. It joins the job before
// starting the command, so even a shell that immediately exits cannot orphan its children.
// Killing the supervisor by Node's retained process handle closes the job and stops its
// members. The detached activation supervisor uses WMI and deliberately starts outside it.
const WINDOWS_JOB_SUPERVISOR = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;

public static class GoatRuntimeJob {
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
'@
`;

export function windowsJobCommand(input: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
}) {
  const payload = Buffer.from(
    JSON.stringify({ command: input.command, args: input.args }),
  ).toString("base64");
  const script = `${WINDOWS_JOB_SUPERVISOR}
$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json
[GoatRuntimeJob]::Run([string]$payload.command, [string[]]$payload.args)
`;
  return {
    command: NodePath.win32.join(
      input.env.SystemRoot ?? input.env.SYSTEMROOT ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
  };
}
