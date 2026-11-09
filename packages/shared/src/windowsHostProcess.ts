/**
 * PowerShell programs that SSH launch scripts and the replacement supervisor run on a Windows
 * host (OpenSSH with Git Bash or Cygwin as the login shell). Both are passed with
 * `-EncodedCommand`, so no shell, MSYS, or cmd.exe quoting applies to their source; inputs travel
 * in environment variables.
 */

/**
 * Prints three lines for the process `GOAT_PROCESS_ID`: `self` or `other` for its owner,
 * its creation time, then each word of its command line on its own line. Exits non-zero when
 * the process does not exist. Callers translate Windows paths with `cygpath`, which knows the
 * host's mount table.
 */
export const WINDOWS_PROCESS_INFO_POWERSHELL = String.raw`$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$process = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$env:GOAT_PROCESS_ID)
if ($null -eq $process) { exit 1 }
$owner = (Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid).Sid
$self = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if ($owner -eq $self) { 'self' } else { 'other' }
$process.CreationDate.ToUniversalTime().ToString('o')
foreach ($match in [regex]::Matches([string]$process.CommandLine, '"([^"]*)"|([^\s"]+)')) {
  if ($match.Groups[1].Success) { $match.Groups[1].Value } else { $match.Groups[2].Value }
}
`;

/**
 * Starts `GOAT_SPAWN_ARGS` through `Win32_Process.Create`, outside the job whose processes Windows
 * OpenSSH ends with the session, with output appended to `GOAT_SPAWN_LOG` and `GOAT_SPAWN_ENV` set.
 * Leaves `$created` (cmd.exe), the program's `$name` and a 15 s `$deadline` to find it by.
 */
const WINDOWS_DETACHED_CREATE_POWERSHELL = String.raw`$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$words = @(([string]$env:GOAT_SPAWN_ARGS).Split([char]10) | Where-Object { $_ -ne '' })
$assignments = @(([string]$env:GOAT_SPAWN_ENV).Split([char]10) | Where-Object { $_ -ne '' })
$log = [string]$env:GOAT_SPAWN_LOG
if ($words.Count -eq 0 -or $log -eq '') { exit 2 }
foreach ($value in $words + $assignments + @($log)) {
  if ($value -match '["%\r]') { [Console]::Error.WriteLine("cmd.exe cannot pass: $value"); exit 2 }
}
$prefix = ($assignments | ForEach-Object { 'set "' + $_ + '" && ' }) -join ''
$command = ($words | ForEach-Object { '"' + $_ + '"' }) -join ' '
$line = 'cmd.exe /d /s /c "' + $prefix + $command + ' >> "' + $log + '" 2>&1"'
$created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $line; CurrentDirectory = $env:GOAT_SPAWN_CWD }
if ($created.ReturnValue -ne 0) { [Console]::Error.WriteLine('Win32_Process.Create returned ' + $created.ReturnValue); exit 3 }
$name = [IO.Path]::GetFileName($words[0])
if (-not [IO.Path]::HasExtension($name)) { $name += '.exe' }
$deadline = [DateTime]::UtcNow.AddSeconds(15)
`;

/** Starts a program as {@link WINDOWS_DETACHED_CREATE_POWERSHELL} does and prints its PID. */
export const WINDOWS_DETACHED_SPAWN_POWERSHELL = String.raw`${WINDOWS_DETACHED_CREATE_POWERSHELL}while ([DateTime]::UtcNow -lt $deadline) {
  $child = Get-CimInstance Win32_Process -Filter ('ParentProcessId=' + $created.ProcessId) | Where-Object { $_.Name -ieq $name } | Select-Object -First 1
  if ($null -ne $child) { [Console]::Out.WriteLine($child.ProcessId); exit 0 }
  if ($null -eq (Get-CimInstance Win32_Process -Filter ('ProcessId=' + $created.ProcessId))) { exit 4 }
  Start-Sleep -Milliseconds 100
}
exit 5
`;

/**
 * Starts the server, holds one handle to it, writes `<pid> <creation FILETIME>` to `GOAT_SPAWN_RECORD`
 * and then pid, port and managed beside the log, and waits for its 127.0.0.1 listener. Exits 2-5
 * before the record, then 0 listening, 3 exited, 4 past `GOAT_WAIT_UNTIL_MS`; 6/7 when the record
 * failed and the server, ended through the handle, has/has not been seen to exit.
 */
export const WINDOWS_SPAWN_AND_WAIT_POWERSHELL = String.raw`${WINDOWS_DETACHED_CREATE_POWERSHELL}$found = $null
while ($null -eq $found) {
  if ([DateTime]::UtcNow -ge $deadline) { exit 5 }
  $found = Get-CimInstance Win32_Process -Filter ('ParentProcessId=' + $created.ProcessId) | Where-Object { $_.Name -ieq $name } | Select-Object -First 1
  if ($null -ne $found) { break }
  if ($null -eq (Get-CimInstance Win32_Process -Filter ('ProcessId=' + $created.ProcessId))) { exit 4 }
  Start-Sleep -Milliseconds 100
}
# WMI's creation time is the handle's cut to whole microseconds; any other one is a reused PID.
try {
  $server = [Diagnostics.Process]::GetProcessById([int]$found.ProcessId)
  $null = $server.Handle
  $started = $server.StartTime.ToUniversalTime()
} catch { exit 5 }
$apart = $started.Ticks - $found.CreationDate.ToUniversalTime().Ticks
if ($apart -lt 0 -or $apart -ge 10) { exit 5 }
$directory = [IO.Path]::GetDirectoryName([string]$env:GOAT_SPAWN_LOG)
$record = [IO.Path]::Combine($directory, [string]$env:GOAT_SPAWN_RECORD)
try {
  [IO.File]::WriteAllText($record + '.next', [string]$server.Id + ' ' + $started.ToFileTimeUtc() + [char]10)
  [IO.File]::Delete($record)
  [IO.File]::Move($record + '.next', $record)
  [IO.File]::WriteAllText([IO.Path]::Combine($directory, 'pid'), [string]$server.Id + [char]10)
  [IO.File]::WriteAllText([IO.Path]::Combine($directory, 'port'), [string]$env:GOAT_LISTEN_PORT + [char]10)
  [IO.File]::WriteAllText([IO.Path]::Combine($directory, 'managed'), 'managed' + [char]10)
} catch {
  try { $server.Kill() } catch { }
  if ($server.WaitForExit(2000)) { exit 6 }
  exit 7
}
$port = [int]$env:GOAT_LISTEN_PORT
$until = [long]$env:GOAT_WAIT_UNTIL_MS
while ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -lt $until) {
  if ($server.HasExited) { exit 3 }
  $connections = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
  if ($connections | Where-Object { $_.OwningProcess -eq $server.Id -and $_.LocalAddress -eq '127.0.0.1' }) { exit 0 }
  Start-Sleep -Milliseconds 100
}
exit 4
`;

/**
 * Ends `GOAT_PROCESS_ID` only if its creation FILETIME is `GOAT_PROCESS_BIRTH`, checking and
 * terminating through one handle, which keeps the PID from being reused in between. Exits 0 exited,
 * 2 no such PID (both confirm a stop), 3 another process, 4 unreadable, 5/6 not ended within 2 s.
 */
export const WINDOWS_STOP_RECORDED_POWERSHELL = String.raw`$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -Namespace GoatLaunch -Name Native -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
[DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
[DllImport("kernel32.dll", SetLastError = true)] public static extern bool TerminateProcess(IntPtr process, uint code);
[DllImport("kernel32.dll", SetLastError = true)] public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
'@
$birth = [long]$env:GOAT_PROCESS_BIRTH
# PROCESS_TERMINATE, PROCESS_QUERY_LIMITED_INFORMATION and SYNCHRONIZE, for the wait.
$handle = [GoatLaunch.Native]::OpenProcess(0x00101001, $false, [uint32]$env:GOAT_PROCESS_ID)
if ($handle -eq [IntPtr]::Zero) {
  if ([Runtime.InteropServices.Marshal]::GetLastWin32Error() -eq 87) { exit 2 }
  exit 4
}
$created = 0L; $ended = 0L; $kernel = 0L; $user = 0L
if (-not [GoatLaunch.Native]::GetProcessTimes($handle, [ref]$created, [ref]$ended, [ref]$kernel, [ref]$user)) { exit 4 }
if ($created -ne $birth) { exit 3 }
if ([GoatLaunch.Native]::WaitForSingleObject($handle, 0) -eq 0) { exit 0 }
if (-not [GoatLaunch.Native]::TerminateProcess($handle, 1)) { exit 5 }
if ([GoatLaunch.Native]::WaitForSingleObject($handle, 2000) -ne 0) { exit 6 }
exit 0
`;

/** The `-EncodedCommand` form of a PowerShell program: base64 of its UTF-16LE bytes. */
export function encodePowerShellCommand(script: string): string {
  let binary = "";
  for (let index = 0; index < script.length; index++) {
    const code = script.charCodeAt(index);
    binary += String.fromCharCode(code & 0xff, code >> 8);
  }
  return btoa(binary);
}
