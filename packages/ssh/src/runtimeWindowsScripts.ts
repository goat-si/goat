import * as NodeBuffer from "node:buffer";

import { GOAT_RUNTIME_CONTROL_HEADER, GOAT_RUNTIME_DRAIN_PATH } from "@goat/contracts";
import { GOAT_ACTIVITY_PATH, GOAT_ENVIRONMENT_PATH } from "@goat/contracts/legacyT3Names";

import { applyScriptPlaceholders } from "./remoteRuntime.ts";

/**
 * Native Windows OpenSSH runs cmd.exe or Windows PowerShell, never sh. Only this fixed loader
 * travels on the command line; the operation script, its request and any archive arrive
 * length-framed on stdin, so nothing a caller supplies reaches argv.
 */
export const WINDOWS_LOADER = String.raw`
$ErrorActionPreference='Stop'
try {
  if ([Environment]::OSVersion.Platform -ne 'Win32NT') { throw 'platform' }
  $stream=[Console]::OpenStandardInput()
  function Read-Exact([int]$n) {
    $b=New-Object byte[] $n; $at=0
    while ($at -lt $n) {
      $got=$stream.Read($b,$at,$n-$at)
      if ($got -eq 0) { throw 'truncated-frame' }; $at+=$got
    }
    return ,$b
  }
  $size=[BitConverter]::ToUInt32((Read-Exact 4),0)
  if ($size -lt 2 -or $size -gt 131072) { throw 'frame-size' }
  $envelope=[Text.Encoding]::UTF8.GetString((Read-Exact $size)) | ConvertFrom-Json
  $n=[long]$envelope.archiveBytes
  if ($n -lt 0 -or $n -gt 268435456) { throw 'archive-size' }
  $archive=Read-Exact ([int]$n)
  if ($stream.ReadByte() -ne -1) { throw 'trailing-frame' }
  & ([ScriptBlock]::Create([string]$envelope.script)) $envelope.request $archive
} catch {
  $reason=[string]$_.Exception.Message
  if ($reason -notmatch '^[a-z][a-z-]{0,63}$') { $reason='unexpected' }
  [Console]::Error.WriteLine('GOAT_NATIVE_ERROR='+$reason); exit 1
}
`;

/** Prints the language mode only on native Windows; it uses no .NET call a constrained mode denies. */
export const WINDOWS_DETECT =
  "if ($env:OS -eq 'Windows_NT') { 'GOAT_NATIVE_WINDOWS=' + $ExecutionContext.SessionState.LanguageMode } else { exit 2 }";

/** cmd.exe caps a command line near 8 KiB; the encoded loader stays well inside it. */
export const powershellCommand = (script: string) => {
  const encoded = NodeBuffer.Buffer.from(script, "utf16le").toString("base64");
  const args = [
    "powershell.exe",
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    encoded,
  ];
  if (args.join(" ").length > 7000) throw new Error("Native SSH command exceeds its budget.");
  return args;
};

/** The stdin frame: a little-endian length, the UTF-8 JSON envelope, then raw archive bytes. */
export const windowsFrame = (script: string, request: unknown, archive = new Uint8Array()) => {
  const header = NodeBuffer.Buffer.from(
    JSON.stringify({ script, request, archiveBytes: archive.byteLength }),
    "utf8",
  );
  if (header.byteLength > 131072 || archive.byteLength > 268435456)
    throw new Error("Native SSH frame exceeds its budget.");
  const length = NodeBuffer.Buffer.alloc(4);
  length.writeUInt32LE(header.byteLength);
  return NodeBuffer.Buffer.concat([length, header, archive]);
};

const COMMON = String.raw`
$ErrorActionPreference='Stop'
Set-StrictMode -Version 2
$utf8=New-Object Text.UTF8Encoding($false)
function Quote-Arg([string]$s) {
  if ($s.IndexOf([char]0) -ge 0) { throw 'argument-nul' }
  return '"'+[regex]::Replace([regex]::Replace($s,'(\\*)"','$1$1\"'),'(\\+)$','$1$1')+'"'
}
function Assert-Tree([string]$p) {
  $item=[IO.Path]::GetFullPath($p)
  while ($item) {
    if (Test-Path -LiteralPath $item) {
      if ((Get-Item -Force -LiteralPath $item).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'reparse-path' }
    }
    $item=[IO.Path]::GetDirectoryName($item)
  }
}
function Json-Read([string]$p) {
  Assert-Tree $p
  if ((Get-Item -LiteralPath $p).Length -gt 65536) { throw 'record-size' }
  return ([IO.File]::ReadAllText($p,$utf8) | ConvertFrom-Json)
}
function Json-Write([string]$p,$v) {
  Assert-Tree $p
  $tmp=$p+'.'+[Guid]::NewGuid().ToString('N')+'.tmp'
  $bytes=$utf8.GetBytes(($v | ConvertTo-Json -Depth 20 -Compress))
  $f=[IO.File]::Open($tmp,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try { $f.Write($bytes,0,$bytes.Length); $f.Flush($true) } finally { $f.Dispose() }
  if (Test-Path -LiteralPath $p) { [IO.File]::Replace($tmp,$p,$null) } else { [IO.File]::Move($tmp,$p) }
}
function Hash([string]$p) {
  Assert-Tree $p
  return (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant()
}
function Run-Exe([string]$exe,[string[]]$arguments,[string]$body='') {
  $si=New-Object Diagnostics.ProcessStartInfo
  $si.FileName=$exe; $si.Arguments=($arguments | ForEach-Object { Quote-Arg $_ }) -join ' '
  $si.UseShellExecute=$false; $si.CreateNoWindow=$true
  $si.RedirectStandardInput=$true; $si.RedirectStandardOutput=$true; $si.RedirectStandardError=$true
  $si.StandardOutputEncoding=$utf8; $si.StandardErrorEncoding=$utf8
  $proc=New-Object Diagnostics.Process; $proc.StartInfo=$si
  [void]$proc.Start()
  $stdout=$proc.StandardOutput.ReadToEndAsync(); [void]$proc.StandardError.ReadToEndAsync()
  try {
    if ($body) { $b=$utf8.GetBytes($body); $proc.StandardInput.BaseStream.Write($b,0,$b.Length) }
    $proc.StandardInput.Close()
    if (-not $proc.WaitForExit(60000)) { $proc.Kill(); throw 'native-command-timeout' }
    if ($proc.ExitCode -ne 0) { throw 'native-command-failed' }
    return $stdout.GetAwaiter().GetResult().Trim()
  } finally { $proc.Dispose() }
}
function Http-Json([int]$port,[string]$path) {
  if ($port -lt 1 -or $port -gt 65535) { throw 'port' }
  return Invoke-RestMethod -UseBasicParsing -TimeoutSec 3 -Uri ('http://127.0.0.1:'+$port+$path)
}
$versionPattern='^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$'
function Verify-Binary($selected) {
  if ($selected.version -notmatch $versionPattern -or $selected.sha256 -notmatch '^[0-9a-f]{64}$') { throw 'selection' }
  $expected=Join-Path $versions ($selected.version+'\goat.exe')
  if ($selected.executablePath -ne $expected -or $selected.baseDir -ne $baseDir) { throw 'selection-path' }
  if ((Hash $expected) -ne $selected.sha256) { throw 'binary-changed' }
  if ([IO.File]::ReadAllText((Join-Path (Split-Path $expected) '.install-complete')).Trim() -ne $selected.version) { throw 'incomplete-install' }
  $record=Json-Read (Join-Path (Split-Path $expected) '.native-install.json')
  if ($record.version -ne $selected.version -or $record.sha256 -ne $selected.sha256) { throw 'install-record' }
  if ((Run-Exe $expected @('--version')) -ne ('goat v'+$selected.version)) { throw 'version' }
}
function Live($owner) {
  Verify-Binary $owner
  $process=Get-Process -Id ([int]$owner.pid) -ErrorAction Stop
  if ($process.StartTime.ToUniversalTime().Ticks.ToString() -ne $owner.birth -or $process.Path -ne $owner.executablePath) { throw 'process-identity' }
  $runtime=Json-Read (Join-Path $baseDir 'userdata\server-runtime.json')
  $diskId=[IO.File]::ReadAllText((Join-Path $baseDir 'userdata\environment-id')).Trim()
  if ($runtime.pid -ne $owner.pid -or $runtime.instanceId -ne $owner.instanceId -or $runtime.port -ne $owner.port -or $runtime.origin -ne ('http://127.0.0.1:'+$owner.port)) { throw 'runtime-identity' }
  $descriptor=Http-Json $owner.port '@@ENVIRONMENT_PATH@@'
  if ($diskId -ne $owner.environmentId -or $descriptor.environmentId -ne $diskId -or $descriptor.instanceId -ne $owner.instanceId -or $descriptor.serverVersion -ne $owner.version -or $descriptor.capabilities.runtimeSessions -ne $true) { throw 'environment-identity' }
  return $descriptor
}
$baseDir=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.goat'
$versions=Join-Path $baseDir 'runtime\goat\versions'
$state=Join-Path $baseDir 'ssh-launch\native-windows'
$ownerFile=Join-Path $state 'owner.json'
Assert-Tree $baseDir
`;

/**
 * Detached from the SSH session, it owns the spawned server's process handle. Until Home
 * acknowledges the launch within 90 seconds it kills only that child, so a lost startup channel
 * never leaves an unacknowledged server behind.
 */
const SUPERVISOR = String.raw`param([string]$RequestFile)
@@COMMON@@
$child=$null; $acknowledged=$false; $gate=$null; $outFile=$null; $errFile=$null
try {
  $r=Json-Read $RequestFile
  $gate=[IO.File]::Open((Join-Path $state 'gate'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  Verify-Binary $r.selection
  if (Test-Path -LiteralPath $ownerFile) {
    $old=Json-Read $ownerFile
    if (Get-Process -Id ([int]$old.pid) -ErrorAction SilentlyContinue) { throw 'already-running' }
  }
  $listener=New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback,0)
  $listener.Start(); $port=$listener.LocalEndpoint.Port; $listener.Stop()
  $si=New-Object Diagnostics.ProcessStartInfo
  $si.FileName=$r.selection.executablePath
  $si.Arguments=(@('serve','--host','127.0.0.1','--port',"$port",'--base-dir',$baseDir) | ForEach-Object { Quote-Arg $_ }) -join ' '
  $si.WorkingDirectory=$baseDir; $si.UseShellExecute=$false; $si.CreateNoWindow=$true
  $si.RedirectStandardOutput=$true; $si.RedirectStandardError=$true; $si.RedirectStandardInput=$true
  foreach ($key in @($si.EnvironmentVariables.Keys)) {
    if ($key -match '^(GOAT|T3|T3CODE)_') { $si.EnvironmentVariables.Remove($key) } # goat-rename: legacy
  }
  $si.EnvironmentVariables['GOAT_NO_BROWSER']='1'
  $child=New-Object Diagnostics.Process; $child.StartInfo=$si; [void]$child.Start(); $child.StandardInput.Close()
  $outFile=[IO.File]::Open((Join-Path $state ($r.nonce+'.stdout.log')),'CreateNew','Write','Read')
  $errFile=[IO.File]::Open((Join-Path $state ($r.nonce+'.stderr.log')),'CreateNew','Write','Read')
  $copyOut=$child.StandardOutput.BaseStream.CopyToAsync($outFile)
  $copyErr=$child.StandardError.BaseStream.CopyToAsync($errFile)
  $deadline=[DateTime]::UtcNow.AddSeconds(90); $owner=$null
  while ([DateTime]::UtcNow -lt $deadline -and -not $child.HasExited) {
    try {
      $runtime=Json-Read (Join-Path $baseDir 'userdata\server-runtime.json')
      if ($runtime.pid -ne $child.Id -or $runtime.port -ne $port) { throw 'not-ready' }
      $envId=[IO.File]::ReadAllText((Join-Path $baseDir 'userdata\environment-id')).Trim()
      $owner=[ordered]@{ version=$r.selection.version; sha256=$r.selection.sha256; baseDir=$baseDir; executablePath=$r.selection.executablePath; pid=$child.Id; birth=$child.StartTime.ToUniversalTime().Ticks.ToString(); port=$port; environmentId=$envId; instanceId=$runtime.instanceId; nonce=$r.nonce }
      [void](Live ([pscustomobject]$owner)); break
    } catch { $owner=$null; Start-Sleep -Milliseconds 100 }
  }
  if ($null -eq $owner) { throw 'startup-deadline' }
  Json-Write $ownerFile $owner
  Json-Write (Join-Path $state ($r.nonce+'.ready')) $owner
  $ack=Join-Path $state ($r.nonce+'.ack')
  while ([DateTime]::UtcNow -lt $deadline -and -not $child.HasExited) {
    if ((Test-Path -LiteralPath $ack) -and (Json-Read $ack).nonce -eq $r.nonce) { $acknowledged=$true; break }
    Start-Sleep -Milliseconds 100
  }
  if (-not $acknowledged) { throw 'ack-deadline' }
  $gate.Dispose(); $gate=$null
  $child.WaitForExit(); $copyOut.GetAwaiter().GetResult(); $copyErr.GetAwaiter().GetResult()
} finally {
  if ($null -ne $child -and -not $acknowledged -and -not $child.HasExited) { $child.Kill(); $child.WaitForExit() }
  if ($null -ne $outFile) { $outFile.Dispose() }; if ($null -ne $errFile) { $errFile.Dispose() }
  if ($null -ne $gate) { $gate.Dispose() }
  if ($null -ne $child) { $child.Dispose() }
}
`;

/**
 * Every native operation: inspect, install, launch, ack, session, stop and log. Each refuses
 * rather than adopting another environment, replacing a running runtime or reusing an
 * unverified executable; an installed version directory is immutable once published.
 */
const OPERATIONS = String.raw`param($r,[byte[]]$archive)
@@COMMON@@
if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64' -and $env:PROCESSOR_ARCHITEW6432 -ne 'AMD64') { throw 'unsupported-architecture' }
function Report($selection,[bool]$live,$signals) {
  $out=@{selection=$selection; live=$live; binarySignals=((Run-Exe $selection.executablePath @('__ssh-helper','protocol')) | ConvertFrom-Json)}
  if ($null -ne $signals) { $out.signals=$signals }
  $out | ConvertTo-Json -Depth 20 -Compress
}
if ($r.op -eq 'inspect' -or $r.op -eq 'install') {
  foreach ($other in @((Join-Path $baseDir 'desktop\userdata'),(Join-Path (Split-Path $baseDir) '.t3\userdata'))) {
    Assert-Tree $other
    if (Test-Path -LiteralPath $other) { throw 'existing-environment-unavailable' }
  }
}
if ($r.op -eq 'inspect') {
  $owner=$null
  if (Test-Path -LiteralPath $ownerFile) {
    $owner=Json-Read $ownerFile
    if (Get-Process -Id ([int]$owner.pid) -ErrorAction SilentlyContinue) { Report $owner $true (Live $owner); return }
  }
  $runtimeFile=Join-Path $baseDir 'userdata\server-runtime.json'
  if (Test-Path -LiteralPath $runtimeFile) {
    # Only the exact record our dead owner left is stale; any other runtime is not ours to replace.
    $left=Json-Read $runtimeFile
    if ($null -eq $owner -or $left.pid -ne $owner.pid -or $left.instanceId -ne $owner.instanceId) { throw 'unverified-existing-runtime' }
  }
  $v=if ($null -ne $owner) { $owner.version } else { $r.version }
  if ($v -notmatch $versionPattern) { throw 'version' }
  $exe=Join-Path $versions ($v+'\goat.exe')
  if (-not (Test-Path -LiteralPath $exe)) {
    if (Test-Path -LiteralPath (Join-Path $baseDir 'userdata')) { throw 'unowned-data' }
    '{"selection":null,"live":false}'; return
  }
  $selection=[pscustomobject]@{ version=$v; executablePath=$exe; baseDir=$baseDir; sha256=(Hash $exe) }
  Verify-Binary $selection
  Report $selection $false $null; return
}
[void][IO.Directory]::CreateDirectory($state); Assert-Tree $state
$gate=$null
try {
  if ($r.op -ne 'launch' -and $r.op -ne 'ack') { $gate=[IO.File]::Open((Join-Path $state 'gate'),'OpenOrCreate','ReadWrite','None') }
  if ($r.op -eq 'install') {
    if ($r.version -notmatch $versionPattern -or $r.sha256 -notmatch '^[0-9a-f]{64}$' -or $archive.Length -ne $r.bytes) { throw 'archive-identity' }
    $sha=[Security.Cryptography.SHA256]::Create()
    try { $digest=([BitConverter]::ToString($sha.ComputeHash($archive))).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
    if ($digest -ne $r.sha256) { throw 'archive-digest' }
    if (Test-Path -LiteralPath (Join-Path $baseDir 'userdata\server-runtime.json')) { throw 'runtime-present' }
    [void][IO.Directory]::CreateDirectory($versions); Assert-Tree $versions
    $destination=Join-Path $versions $r.version
    if (Test-Path -LiteralPath $destination) { throw 'immutable-version-exists' }
    $stage=Join-Path $versions ('.native-'+[Guid]::NewGuid().ToString('N'))
    [void][IO.Directory]::CreateDirectory($stage)
    Add-Type -AssemblyName System.IO.Compression
    $memory=New-Object IO.MemoryStream(,$archive)
    $zip=New-Object IO.Compression.ZipArchive($memory,[IO.Compression.ZipArchiveMode]::Read)
    try {
      $names=New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
      $total=0L; $actualTotal=0L; $root=$null
      foreach ($entry in $zip.Entries) {
        $raw=$entry.FullName
        if ($raw -match '^[\\/]|^[A-Za-z]:|[:\x00-\x1f]') { throw 'zip-path' }
        $name=$raw.Replace('\','/')
        if ($name -match '(^|/)\.\.?(/|$)' -or -not $names.Add($name)) { throw 'zip-path' }
        $first=$name.Split('/')[0]
        if ($null -eq $root) { $root=$first }
        if ($first -ne $root) { throw 'zip-root' }
        if ($name.Length -le $root.Length+1) { continue }
        $relative=$name.Substring($root.Length+1)
        foreach ($part in $relative.TrimEnd('/').Split('/')) {
          if (-not $part -or $part -match '[. ]$|^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)') { throw 'windows-path-alias' }
        }
        $kind=($entry.ExternalAttributes -shr 16) -band 61440
        if (($entry.ExternalAttributes -band 1024) -ne 0 -or ($kind -ne 0 -and $kind -ne 32768 -and $kind -ne 16384)) { throw 'zip-link' }
        $total+=$entry.Length; if ($total -gt 1073741824 -or $names.Count -gt 20000) { throw 'zip-size' }
        $target=[IO.Path]::GetFullPath((Join-Path $stage $relative))
        if (-not $target.StartsWith($stage+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'zip-escape' }
        if ($name.EndsWith('/')) { [void][IO.Directory]::CreateDirectory($target); continue }
        [void][IO.Directory]::CreateDirectory((Split-Path $target)); Assert-Tree $target
        $source=$entry.Open(); $output=[IO.File]::Open($target,'CreateNew','Write','None')
        try {
          $buffer=New-Object byte[] 65536; $written=0L
          while (($got=$source.Read($buffer,0,$buffer.Length)) -gt 0) {
            $written+=$got; $actualTotal+=$got
            if ($written -gt $entry.Length -or $actualTotal -gt 1073741824) { throw 'zip-expanded-size' }
            $output.Write($buffer,0,$got)
          }
          if ($written -ne $entry.Length) { throw 'zip-entry-size' }; $output.Flush($true)
        } finally { $source.Dispose(); $output.Dispose() }
      }
      foreach ($required in @('goat.exe','goat-runtime.json','client\index.html','screen-code\quickjs.wasm')) {
        if (-not [IO.File]::Exists((Join-Path $stage $required))) { throw 'archive-layout' }
      }
      if ((Run-Exe (Join-Path $stage 'goat.exe') @('--version')) -ne ('goat v'+$r.version)) { throw 'archive-version' }
      $selection=[pscustomobject]@{version=$r.version; executablePath=(Join-Path $destination 'goat.exe'); baseDir=$baseDir; sha256=(Hash (Join-Path $stage 'goat.exe'))}
      Json-Write (Join-Path $stage '.native-install.json') $selection
      [IO.File]::WriteAllText((Join-Path $stage '.install-complete'),$r.version,$utf8)
      [IO.Directory]::Move($stage,$destination)
      Verify-Binary $selection
      Report $selection $false $null
    } finally { $zip.Dispose(); $memory.Dispose() }
    return
  }
  Verify-Binary $r.selection
  if ($r.op -eq 'launch') {
    if (Test-Path -LiteralPath $ownerFile) {
      $owner=Json-Read $ownerFile
      if (Get-Process -Id ([int]$owner.pid) -ErrorAction SilentlyContinue) {
        [void](Live $owner); @{selection=$owner; live=$true; reused=$true} | ConvertTo-Json -Depth 20 -Compress; return
      }
    }
    if ($r.nonce -notmatch '^[0-9a-f]{32}$') { throw 'nonce' }
    $script=Join-Path $state ($r.nonce+'.ps1'); $requestFile=Join-Path $state ($r.nonce+'.json')
    [IO.File]::WriteAllText($script,[string]$r.supervisor,$utf8)
    Json-Write $requestFile @{selection=$r.selection;nonce=$r.nonce}
    $source64=[Convert]::ToBase64String($utf8.GetBytes($script))
    $request64=[Convert]::ToBase64String($utf8.GetBytes($requestFile))
    $bootstrap='$s=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("'+$source64+'")); $q=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("'+$request64+'")); & ([ScriptBlock]::Create([IO.File]::ReadAllText($s))) -RequestFile $q'
    $encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($bootstrap))
    $psArgs=@('-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',$encoded)
    if (($psArgs -join ' ').Length -gt 6800) { throw 'supervisor-command-size' }
    $ps=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $supervisor=Start-Process -FilePath $ps -ArgumentList (($psArgs | ForEach-Object { Quote-Arg $_ }) -join ' ') -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $state ($r.nonce+'.supervisor.out')) -RedirectStandardError (Join-Path $state ($r.nonce+'.supervisor.err'))
    $deadline=[DateTime]::UtcNow.AddSeconds(70); $ready=Join-Path $state ($r.nonce+'.ready')
    while ([DateTime]::UtcNow -lt $deadline -and -not $supervisor.HasExited) {
      if (Test-Path -LiteralPath $ready) { $owner=Json-Read $ready; [void](Live $owner); @{selection=$owner;live=$true;reused=$false} | ConvertTo-Json -Depth 20 -Compress; return }
      Start-Sleep -Milliseconds 100
    }
    throw 'launch-deadline'
  }
  $owner=Json-Read $ownerFile
  foreach ($key in @('executablePath','sha256','version','environmentId','instanceId','pid','birth','nonce','port')) {
    if ($owner.$key -ne $r.selection.$key) { throw 'stale-selection' }
  }
  [void](Live $owner)
  switch ($r.op) {
    'ack' { Json-Write (Join-Path $state ($owner.nonce+'.ack')) @{nonce=$owner.nonce}; '{"acknowledged":true}'; return }
    'session' {
      Run-Exe $owner.executablePath @('__ssh-native-session') (@{selection=$owner;request=$r.request} | ConvertTo-Json -Depth 20 -Compress); return
    }
    'stop' {
      $activity=Http-Json $owner.port '@@ACTIVITY_PATH@@'
      if ($activity.activity -ne 'idle') { '{"stopped":false,"activity":"busy"}'; return }
      $process=Get-Process -Id ([int]$owner.pid)
      $tokenFile=Join-Path $baseDir 'userdata\runtime-control.token'; Assert-Tree $tokenFile
      $secret=[IO.File]::ReadAllText($tokenFile).Trim()
      $reply=Invoke-RestMethod -UseBasicParsing -Method Post -TimeoutSec 20 -Uri ('http://127.0.0.1:'+$owner.port+'@@DRAIN_PATH@@') -Headers @{'@@CONTROL_HEADER@@'=$secret} -ContentType 'application/json' -Body (@{expectedInstanceId=$owner.instanceId;targetVersion=$owner.version;graceSeconds=0;force=$false} | ConvertTo-Json -Compress)
      if ($reply.status -ne 'drained' -or $reply.instanceId -ne $owner.instanceId -or -not $process.WaitForExit(20000)) { '{"stopped":false,"activity":"unknown"}'; return }
      '{"stopped":true}'; return
    }
    'log' {
      $log=Join-Path $state ($owner.nonce+'.stderr.log'); Assert-Tree $log
      Get-Content -LiteralPath $log -Tail 80; return
    }
    default { throw 'operation' }
  }
} finally { if ($null -ne $gate) { $gate.Dispose() } }
`;

const fill = (script: string) =>
  applyScriptPlaceholders(applyScriptPlaceholders(script, { COMMON }), {
    ENVIRONMENT_PATH: GOAT_ENVIRONMENT_PATH,
    ACTIVITY_PATH: GOAT_ACTIVITY_PATH,
    DRAIN_PATH: GOAT_RUNTIME_DRAIN_PATH,
    CONTROL_HEADER: GOAT_RUNTIME_CONTROL_HEADER,
  });
export const WINDOWS_SUPERVISOR = fill(SUPERVISOR);
export const WINDOWS_OPERATIONS = fill(OPERATIONS);
