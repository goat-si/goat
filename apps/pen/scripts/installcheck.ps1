# install.ps1 check on Windows against the relay stand-in serving build.sh output: a bare install only installs,
# --up founds on one home with every relay build.sh listed, --join joins another, then a corrupted SHA256SUMS
# must stop the install. The Windows twin of installcheck.sh.
#   pwsh apps/pen/scripts/installcheck.ps1   (needs go, and bash for build.sh: Git Bash on Windows)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$here = Split-Path -Parent $PSScriptRoot
$go = if ($env:GO) { $env:GO } else { 'go' }
$work = Join-Path ([IO.Path]::GetTempPath()) ('peni-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $work | Out-Null
$relayProcs = @()
$nodes = @('z', 'a', 'b', 'c')

function Fail([string]$msg) { throw "FAIL: $msg" }

function Free-Port {
	$l = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 0)
	$l.Start()
	$p = $l.LocalEndpoint.Port
	$l.Stop()
	return $p
}

# Start-Relay starts relaytest and returns once it printed its first line (it is listening).
function Start-Relay([int]$port, [string]$public) {
	$psi = New-Object Diagnostics.ProcessStartInfo
	$psi.FileName = Join-Path $work 'relaytest.exe'
	$psi.Arguments = "-addr 127.0.0.1:$port"
	if ($public) { $psi.Arguments += " -public `"$public`"" }
	$psi.UseShellExecute = $false
	$psi.RedirectStandardOutput = $true
	$p = [Diagnostics.Process]::Start($psi)
	[void]$p.StandardOutput.ReadLine()
	return $p
}

function Inst([string]$n, [string[]]$rest) {
	$dir = Join-Path $work $n
	New-Item -ItemType Directory -Force -Path $dir | Out-Null
	$env:PEN_HOME = Join-Path $dir '.pen'
	$env:PEN_INSTALL_DIR = Join-Path $dir 'bin'
	$env:PEN_HOSTKEYS = 'none'
	$env:PEN_SSH_DIR = Join-Path $dir 'ssh'
	$script = Invoke-RestMethod -UseBasicParsing "$relay/install.ps1"
	& ([scriptblock]::Create($script)) --no-service @rest
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
	$relays = Pen 'a' @('relay', 'ls') | Out-String
	foreach ($r in @($relay, $relay2)) {
		if ($relays -notmatch [regex]::Escape($r)) { Fail "a's relays lack $($r): $relays" }
	}
	$dl = (Pen 'a' @('relay', 'download') | Out-String).Trim()
	if ($dl -ne $relay) { Fail "a's download relay is $dl, want $relay" }
	Write-Output 'ok: install.ps1 --up gave a both relays and kept the download relay'

	$token = (Pen 'a' @('invite', '--auto') | Out-String).Trim()
	Inst 'b' @('--name', 'b', '--join', $token) | Out-Null
	$dl = (Pen 'b' @('relay', 'download') | Out-String).Trim()
	if ($dl -ne $relay) { Fail "b's download relay is $dl, want $relay" }
	$members = ([regex]::Matches((Pen 'a' @('ls', '--json') | Out-String), '"fingerprint"')).Count
	if ($members -ne 2) { Fail "a lists $members members" }
	Write-Output 'ok: install.ps1 installed and started a; install.ps1 --join added b (a lists 2)'

	$zero = '0' * 64
	$sums = Join-Path $public 'dl\0.0.0-check\SHA256SUMS'
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
	Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
