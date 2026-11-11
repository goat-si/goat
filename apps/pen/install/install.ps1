# pen installer for Windows: downloads pen.exe for this machine from the relay and verifies it.
#   & ([scriptblock]::Create((irm <relay>/install.ps1)))                      (install only; prints what to run next)
#   & ([scriptblock]::Create((irm <relay>/install.ps1))) --join <token>       (then join the mesh the token invites to)
#   & ([scriptblock]::Create((irm <relay>/install.ps1))) --login              (then sign in with Google; add --yes for scripts)
#   & ([scriptblock]::Create((irm <relay>/install.ps1))) --up                 (then start a new mesh on this machine)
# --name N names this machine for --join, --login or --up. The node uses every relay in PEN_RELAYS; one or more
# --relay URL replace that list. pen downloads from PEN_RELAY, which invites name in their install line.
# pen.exe goes to %LOCALAPPDATA%\Programs\pen (PEN_INSTALL_DIR overrides it and then leaves PATH alone).
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# The one-liner runs this as a script block in the user's own PowerShell, where exit would close it:
# errors throw and the end returns.
function Fail([string]$msg) { throw "install.ps1: $msg" }

$PenRelay = if ($env:PEN_RELAY) { $env:PEN_RELAY } else { '__PEN_RELAY__' }
$PenRelays = if ($env:PEN_RELAYS) { $env:PEN_RELAYS } else { '__PEN_RELAYS__' }
$Version = if ($env:PEN_VERSION) { $env:PEN_VERSION } else { '__PEN_VERSION__' }
$Join = ''; $Login = $false; $Up = $false; $Name = ''; $NoService = $false; $Yes = $false; $Relays = @()

for ($i = 0; $i -lt $args.Count; $i++) {
	$a = [string]$args[$i]
	$needsValue = @('--join', '--name', '--relay') -contains $a
	if ($needsValue -and $i + 1 -ge $args.Count) { Fail "$a needs a value" }
	switch ($a) {
		'--join' { $i++; $Join = [string]$args[$i] }
		'--login' { $Login = $true }
		'--name' { $i++; $Name = [string]$args[$i] }
		'--no-service' { $NoService = $true }
		'--relay' { $i++; $Relays += [string]$args[$i] }
		'--up' { $Up = $true }
		'--yes' { $Yes = $true }
		default { Fail "unknown argument $a" }
	}
}
if ($Relays.Count -gt 0) { $PenRelays = $Relays -join ' ' }
$relayFlags = @()
foreach ($r in ($PenRelays -split '\s+' | Where-Object { $_ })) { $relayFlags += @('--relay', $r) }

$cpu = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
switch ($cpu) {
	'AMD64' { $arch = 'amd64' }
	'ARM64' { $arch = 'arm64' }
	default { Fail "unsupported CPU $cpu" }
}

# Windows PowerShell 5.1 may still default to TLS 1.0.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$file = "pen-windows-$arch.exe.gz"
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("pen-install-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
	Invoke-WebRequest -UseBasicParsing -Uri "$PenRelay/dl/$Version/$file" -OutFile (Join-Path $tmp $file)
	Invoke-WebRequest -UseBasicParsing -Uri "$PenRelay/dl/$Version/SHA256SUMS" -OutFile (Join-Path $tmp 'SHA256SUMS')
	# The one line ending in " <archive>", compared as text, as install.sh and check-public.ts read it.
	$suffix = " $file"
	$lines = @([IO.File]::ReadAllText((Join-Path $tmp 'SHA256SUMS')).Split([char]10) |
		Where-Object { $_.Length -gt $suffix.Length -and $_.EndsWith($suffix, [StringComparison]::Ordinal) })
	$want = if ($lines.Count -eq 1) { $lines[0].Substring(0, $lines[0].IndexOf(' ')) } else { '' }
	$got = (Get-FileHash -Algorithm SHA256 (Join-Path $tmp $file)).Hash
	if (-not $want -or $want -ne $got) { Fail "checksum mismatch for $file" }

	$dir = if ($env:PEN_INSTALL_DIR) { $env:PEN_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\pen' }
	New-Item -ItemType Directory -Force -Path $dir | Out-Null
	$new = Join-Path $dir 'pen.exe.new'
	$in = [IO.File]::OpenRead((Join-Path $tmp $file))
	try {
		$gz = New-Object IO.Compression.GZipStream($in, [IO.Compression.CompressionMode]::Decompress)
		$out = [IO.File]::Create($new)
		try { $gz.CopyTo($out) } finally { $out.Dispose(); $gz.Dispose() }
	} finally { $in.Dispose() }
	$pen = Join-Path $dir 'pen.exe'
	# A running pen.exe cannot be overwritten, but it can be renamed; the old copy goes once it exits.
	if (Test-Path $pen) { Move-Item -Force $pen (Join-Path $dir ("pen.exe.old-" + [Guid]::NewGuid().ToString('N'))) }
	Move-Item $new $pen
	Get-ChildItem $dir -Filter 'pen.exe.old-*' | Remove-Item -ErrorAction SilentlyContinue
} finally {
	Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
# Nothing below may run pen while the download is still there (install.sh removes it the same way).
if (Test-Path -LiteralPath $tmp) { Fail "could not remove its download $tmp; pen is installed but was not started" }
Write-Output "installed $pen ($Version)"

$cmd = 'pen'
if (-not $env:PEN_INSTALL_DIR) {
	$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
	$parts = @(); if ($userPath) { $parts = $userPath -split ';' | Where-Object { $_ } }
	if ($parts -notcontains $dir) {
		[Environment]::SetEnvironmentVariable('Path', (($parts + $dir) -join ';'), 'User')
		Write-Output "added $dir to your PATH (new terminals see it)"
	}
	if (($env:Path -split ';') -notcontains $dir) { $env:Path = "$env:Path;$dir" }
} else {
	$cmd = $pen
}

& $pen relay download $PenRelay | Out-Null
if ($LASTEXITCODE -ne 0) { Fail "pen relay download $PenRelay failed" }

$extra = @()
if ($Name) { $extra += @('--name', $Name) }
if ($NoService) { $extra += '--no-service' }
if ($Join) {
	& $pen join $Join @extra
	return
}
if ($Login) {
	if ($Yes) { $extra += '--yes' }
	& $pen login @relayFlags @extra
	return
}
if ($Up) {
	& $pen up @relayFlags @extra
	return
}
Write-Output "Next: $cmd login $($relayFlags -join ' ') (sign in with Google), $cmd join <token> (an invite), or $cmd up $($relayFlags -join ' ') (start a new mesh on this machine)."
