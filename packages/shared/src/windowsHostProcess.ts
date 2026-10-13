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
 * Starts `GOAT_SPAWN_ARGS` (newline-separated program and arguments) through
 * `Win32_Process.Create`, appending its output to `GOAT_SPAWN_LOG` with the
 * `GOAT_SPAWN_ENV` assignments set, and prints the program's PID.
 *
 * Windows OpenSSH keeps a session open until every process in its job object exits and then
 * terminates them, so neither `nohup` nor a detached Node spawn outlives the session. A process
 * that WMI creates starts outside that job. cmd.exe only redirects output, so the PID printed is
 * the program it runs, which is the PID the server records about itself.
 */
export const WINDOWS_DETACHED_SPAWN_POWERSHELL = String.raw`$ErrorActionPreference = 'Stop'
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
$created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $line; CurrentDirectory = $env:USERPROFILE }
if ($created.ReturnValue -ne 0) { [Console]::Error.WriteLine('Win32_Process.Create returned ' + $created.ReturnValue); exit 3 }
$name = [IO.Path]::GetFileName($words[0])
if (-not [IO.Path]::HasExtension($name)) { $name += '.exe' }
$deadline = [DateTime]::UtcNow.AddSeconds(15)
while ([DateTime]::UtcNow -lt $deadline) {
  $child = Get-CimInstance Win32_Process -Filter ('ParentProcessId=' + $created.ProcessId) | Where-Object { $_.Name -ieq $name } | Select-Object -First 1
  if ($null -ne $child) { [Console]::Out.WriteLine($child.ProcessId); exit 0 }
  if ($null -eq (Get-CimInstance Win32_Process -Filter ('ProcessId=' + $created.ProcessId))) { exit 4 }
  Start-Sleep -Milliseconds 100
}
exit 5
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
