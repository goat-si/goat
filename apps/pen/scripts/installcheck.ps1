# install.ps1 check on Windows against the relay stand-in serving build.sh output: a bare install only installs,
# --up founds on one home with every relay build.sh listed, --join joins another (neither leaves its download in
# TEMP), SHA256SUMS is read as install.sh reads it (the one line ending in " <archive>"), and a corrupted
# SHA256SUMS must stop the install. The Windows twin of installcheck.sh.
#   pwsh apps/pen/scripts/installcheck.ps1   (needs go, and bash for build.sh: Git Bash on Windows)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$here = Split-Path -Parent $PSScriptRoot
$go = if ($env:GO) { $env:GO } else { 'go' }
$work = Join-Path ([IO.Path]::GetTempPath()) ('peni-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $work | Out-Null
$relayProcs = @()
$nodes = @('z', 'a', 'b', 'd', 'e', 'f', 'c')
$savedTemp = @{ TMP = $env:TMP; TEMP = $env:TEMP }

function Fail([string]$msg) { throw "FAIL: $msg" }

# Disable-BackupRestore turns off SeBackupPrivilege and SeRestorePrivilege in this process's token: while
# either is enabled (an elevated shell may have them on), deleting ignores a deny ACE, so the locked-TEMP
# check below would prove nothing. install.ps1 runs in this process, so it is bound by the ACE too.
function Disable-BackupRestore {
	Add-Type -Namespace PenCheck -Name Token -MemberDefinition @'
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public struct TokenPrivilege { public int Count; public long Luid; public int Attributes; }
[DllImport("advapi32.dll", SetLastError = true)]
static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
[DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
static extern bool LookupPrivilegeValue(string system, string name, out long luid);
[DllImport("advapi32.dll", SetLastError = true)]
static extern bool AdjustTokenPrivileges(IntPtr token, bool disableAll, ref TokenPrivilege state, int length, IntPtr previous, IntPtr returned);
[DllImport("kernel32.dll")]
static extern IntPtr GetCurrentProcess();
public static void Disable(string name) {
	IntPtr token;
	if (!OpenProcessToken(GetCurrentProcess(), 0x28, out token)) throw new System.ComponentModel.Win32Exception();
	var p = new TokenPrivilege { Count = 1, Attributes = 0 };
	if (!LookupPrivilegeValue(null, name, out p.Luid)) throw new System.ComponentModel.Win32Exception();
	if (!AdjustTokenPrivileges(token, false, ref p, 0, IntPtr.Zero, IntPtr.Zero)) throw new System.ComponentModel.Win32Exception();
}
'@
	foreach ($p in @('SeBackupPrivilege', 'SeRestorePrivilege')) { [PenCheck.Token]::Disable($p) }
}

function Free-Port {
	$l = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 0)
	$l.Start()
	$p = $l.LocalEndpoint.Port
	$l.Stop()
	return $p
}

# Start-Relay starts relaytest and returns once it printed its first line (it is listening), or fails
# after 30 s instead of holding the job until its timeout.
function Start-Relay([int]$port, [string]$public) {
	$psi = New-Object Diagnostics.ProcessStartInfo
	$psi.FileName = Join-Path $work 'relaytest.exe'
	$psi.Arguments = "-addr 127.0.0.1:$port"
	if ($public) { $psi.Arguments += " -public `"$public`"" }
	$psi.UseShellExecute = $false
	$psi.RedirectStandardOutput = $true
	$p = [Diagnostics.Process]::Start($psi)
	$line = $p.StandardOutput.ReadLineAsync()
	if (-not $line.Wait(30000) -or $null -eq $line.Result) {
		if (-not $p.HasExited) { $p.Kill() }
		Fail "relaytest on port $port did not start"
	}
	return $p
}

# Inst runs install.ps1 for node n. With -LockTmp its TEMP denies this user deleting anything created in
# it, so install.ps1 cannot remove its download.
function Inst([string]$n, [string[]]$rest, [switch]$LockTmp) {
	$dir = Join-Path $work $n
	New-Item -ItemType Directory -Force -Path (Join-Path $dir 'tmp') | Out-Null
	if ($LockTmp) {
		$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
		& icacls (Join-Path $dir 'tmp') /deny "*$($sid):(OI)(CI)(DE,DC)" | Out-Null
		if ($LASTEXITCODE -ne 0) { Fail "icacls could not lock $n's TEMP" }
	}
	# install.ps1 downloads into a folder under TEMP; it must be gone also when install.ps1 ends by running pen.
	$env:TMP = Join-Path $dir 'tmp'
	$env:TEMP = $env:TMP
	$env:PEN_HOME = Join-Path $dir '.pen'
	$env:PEN_INSTALL_DIR = Join-Path $dir 'bin'
	$env:PEN_HOSTKEYS = 'none'
	$env:PEN_SSH_DIR = Join-Path $dir 'ssh'
	$script = Invoke-RestMethod -UseBasicParsing "$relay/install.ps1"
	& ([scriptblock]::Create($script)) --no-service @rest
}

function No-Tmp([string]$n, [string]$how) {
	$left = @(Get-ChildItem -Force (Join-Path (Join-Path $work $n) 'tmp'))
	if ($left.Count -gt 0) { Fail "install.ps1 $how left its download behind: $($left.Name -join ', ')" }
}

function Pen([string]$n, [string[]]$rest) {
	$env:PEN_HOME = Join-Path (Join-Path $work $n) '.pen'
	& (Join-Path $work "$n\bin\pen.exe") @rest
}

try {
	Push-Location $here
	try { & $go build -o (Join-Path $work 'relaytest.exe') ./internal/relaytest/cmd/relaytest } finally { Pop-Location }
	if ($LASTEXITCODE -ne 0) { Fail 'building relaytest' }
	$port = Free-Port
	$port2 = Free-Port
	$relay = "http://127.0.0.1:$port"
	$relay2 = "http://127.0.0.1:$port2"
	$public = Join-Path $work 'public'
	New-Item -ItemType Directory -Path $public | Out-Null
	$env:PEN_PUBLIC = $public -replace '\\', '/'
	$env:GO = (Get-Command $go).Source -replace '\\', '/'
	# Git's bash: a bare "bash" may resolve to WSL's launcher in System32.
	$bash = 'bash'
	$git = Get-Command git -ErrorAction SilentlyContinue
	if ($git) {
		$candidate = Join-Path (Split-Path (Split-Path $git.Source)) 'bin\bash.exe'
		if (Test-Path $candidate) { $bash = $candidate }
	}
	& $bash (Join-Path $here 'scripts/build.sh').Replace('\', '/') 0.0.0-check $relay $relay2 | Out-Null
	if ($LASTEXITCODE -ne 0) { Fail 'build.sh' }
	Remove-Item Env:PEN_PUBLIC
	$relayProcs += Start-Relay $port $public
	$relayProcs += Start-Relay $port2 ''

	$out = Inst 'z' @() | Out-String
	if ($out -notmatch 'Next: .*login') { Fail "a bare install did not say what to run next: $out" }
	if (Test-Path (Join-Path $work 'z\.pen\mesh.json')) { Fail 'a bare install founded a mesh' }
	Write-Output 'ok: a bare install.ps1 installs pen and founds nothing'

	Inst 'a' @('--name', 'a', '--up') | Out-Null
	No-Tmp 'a' '--up'
	$relays = Pen 'a' @('relay', 'ls') | Out-String
	foreach ($r in @($relay, $relay2)) {
		if ($relays -notmatch [regex]::Escape($r)) { Fail "a's relays lack $($r): $relays" }
	}
	$dl = (Pen 'a' @('relay', 'download') | Out-String).Trim()
	if ($dl -ne $relay) { Fail "a's download relay is $dl, want $relay" }
	Write-Output 'ok: install.ps1 --up gave a both relays and kept the download relay'

	$token = (Pen 'a' @('invite', '--auto') | Out-String).Trim()
	Inst 'b' @('--name', 'b', '--join', $token) | Out-Null
	No-Tmp 'b' '--join'
	$dl = (Pen 'b' @('relay', 'download') | Out-String).Trim()
	if ($dl -ne $relay) { Fail "b's download relay is $dl, want $relay" }
	$members = ([regex]::Matches((Pen 'a' @('ls', '--json') | Out-String), '"fingerprint"')).Count
	if ($members -ne 2) { Fail "a lists $members members" }
	Write-Output 'ok: install.ps1 installed and started a; install.ps1 --join added b (a lists 2)'

	$zero = '0' * 64
	$sums = Join-Path $public 'dl\0.0.0-check\SHA256SUMS'
	$good = [IO.File]::ReadAllText($sums)
	# Lines that name an archive only to a looser reader (binary mode, other case, a tab, a pattern match) are
	# other files' to install.sh and check-public.ts, so install.ps1 must ignore them too.
	$decoys = ''
	foreach ($a in @('pen-windows-amd64.exe.gz', 'pen-windows-arm64.exe.gz')) {
		$decoys += "$zero *$a`n$zero  $($a.ToUpperInvariant())`n$zero`t$a`n$zero  $($a -replace '\.gz$', 'Xgz')`n"
	}
	[IO.File]::WriteAllText($sums, $good + $decoys)
	try { Inst 'd' @('--name', 'd') | Out-Null } catch { Fail "install.ps1 refused a SHA256SUMS whose extra lines name other files: $_" }
	if (-not (Test-Path (Join-Path $work 'd\bin\pen.exe'))) { Fail 'install.ps1 installed nothing' }
	Write-Output 'ok: install.ps1 reads only the SHA256SUMS line that names its archive'

	# Two lines for the archive are refused even when both match, as install.sh refuses them.
	[IO.File]::WriteAllText($sums, $good + $good)
	$refused = $false
	try { Inst 'e' @('--name', 'e') | Out-Null } catch { $refused = "$_" -match 'checksum mismatch' }
	if (-not $refused) { Fail 'install.ps1 accepted a SHA256SUMS that lists its archive twice' }
	if (Test-Path (Join-Path $work 'e\bin\pen.exe')) { Fail 'a binary was installed from a SHA256SUMS that lists it twice' }
	Write-Output 'ok: a SHA256SUMS that lists the archive twice stops install.ps1'

	# A download install.ps1 cannot remove stops it before it runs pen: here --up must not found a mesh.
	[IO.File]::WriteAllText($sums, $good)
	Disable-BackupRestore
	$stopped = $false
	try { Inst 'f' @('--name', 'f', '--up') -LockTmp | Out-Null } catch { $stopped = "$_" -match 'could not remove its download' }
	if (-not $stopped) { Fail 'install.ps1 went on although it could not remove its download' }
	if (Test-Path (Join-Path $work 'f\.pen\mesh.json')) { Fail 'install.ps1 started pen although its download was left behind' }
	Write-Output 'ok: a download install.ps1 cannot remove stops it before pen starts'

	Set-Content -Path $sums -Value @("$zero  pen-windows-amd64.exe.gz", "$zero  pen-windows-arm64.exe.gz")
	$refused = $false
	try { Inst 'c' @('--name', 'c') | Out-Null } catch { $refused = "$_" -match 'checksum mismatch' }
	if (-not $refused) { Fail 'install.ps1 accepted a bad checksum' }
	if (Test-Path (Join-Path $work 'c\bin\pen.exe')) { Fail 'a binary was installed despite the mismatch' }
	Write-Output 'ok: a corrupted SHA256SUMS stops install.ps1 before anything is installed'
} finally {
	foreach ($n in $nodes) {
		$exe = Join-Path $work "$n\bin\pen.exe"
		if (Test-Path $exe) {
			$env:PEN_HOME = Join-Path (Join-Path $work $n) '.pen'
			try { & $exe down *> $null } catch { Write-Output "pen down for $($n): $_" }
		}
	}
	foreach ($p in $relayProcs) { if (-not $p.HasExited) { $p.Kill(); $p.WaitForExit() } }
	foreach ($v in @('PEN_HOME', 'PEN_INSTALL_DIR', 'PEN_HOSTKEYS', 'PEN_SSH_DIR')) { Remove-Item "Env:$v" -ErrorAction SilentlyContinue }
	$env:TMP = $savedTemp.TMP
	$env:TEMP = $savedTemp.TEMP
	$locked = Join-Path $work 'f\tmp'
	if (Test-Path $locked) {
		$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
		& icacls $locked /remove:d "*$sid" /T /C | Out-Null
	}
	Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
