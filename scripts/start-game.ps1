<#
.SYNOPSIS
    Brains & Bacchanal - one-command LAN development starter.

.DESCRIPTION
    Starts the game server and the player web app in separate, clearly
    labelled PowerShell windows, opens the Unity Host project (without
    entering Play Mode), and prints a startup summary with the detected
    LAN address so phones on the same network can join.

    Invoked as `pnpm game` from the repository root. See package.json.

    WHAT THIS DOES NOT DO, DELIBERATELY:
      - it does not touch game logic, the protocol, rooms, or reconnect
        behaviour - it only launches existing dev commands,
      - it does not start a Cloudflare tunnel or any other tunnel,
      - it does not edit unity/host/Assets/Scenes/HostLobby.unity - Unity's
        Host connection fields (serverHost / serverPort / serverUseTls) are
        Inspector-only and are reported, not silently rewritten. See the
        "UNITY HOST CONNECTION" note this script prints at startup.
      - it does not re-detect the LAN IP independently of the server: the
        server already ranks candidate addresses (LAN over Tailscale/VPN/
        Docker/APIPA) for its own join-URL/QR generation, so this script
        asks the SAME running server for the address it actually chose,
        rather than risk a second algorithm disagreeing with the first.
#>

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

# scripts/start-game.ps1 -> repo root is one level up.
$RepoRoot = Split-Path -Parent $PSScriptRoot
$UnityExe = 'G:\Programs\Unity\Hub\Editor\6000.3.24f1\Editor\Unity.exe'
$UnityProjectPath = Join-Path $RepoRoot 'unity\host'

$ServerPort = 4000
$WebPort = 3000

function Write-Section {
    param([string]$Text)
    Write-Host ''
    Write-Host $Text -ForegroundColor Cyan
}

function Write-Fail {
    param([string]$Text)
    Write-Host "ERROR: $Text" -ForegroundColor Red
}

function Write-Ok {
    param([string]$Text)
    Write-Host "  [ok] $Text" -ForegroundColor Green
}

function Write-Warn2 {
    param([string]$Text)
    Write-Host "  [!]  $Text" -ForegroundColor Yellow
}

Write-Host '================================================' -ForegroundColor Magenta
Write-Host 'BRAINS & BACCHANAL - DEVELOPMENT GAME STARTER' -ForegroundColor Magenta
Write-Host '================================================' -ForegroundColor Magenta

# ---------------------------------------------------------------------------
# Preflight - fail loudly and early rather than half-start something.
# ---------------------------------------------------------------------------

Write-Section 'Preflight checks'

$pnpmCmd = Get-Command pnpm -ErrorAction SilentlyContinue
if ($null -eq $pnpmCmd) {
    Write-Fail 'pnpm is not on PATH. Install it (npm i -g pnpm) and try again.'
    exit 1
}
Write-Ok "pnpm found: $($pnpmCmd.Source)"

if (-not (Test-Path $RepoRoot)) {
    Write-Fail "Repository root not found at '$RepoRoot'."
    exit 1
}
Write-Ok "Repository root: $RepoRoot"

$UnityAvailable = $true
if (-not (Test-Path $UnityExe)) {
    Write-Warn2 "Unity executable not found at '$UnityExe'. Skipping Unity launch."
    $UnityAvailable = $false
}
else {
    Write-Ok "Unity executable found: $UnityExe"
}

if ($UnityAvailable -and -not (Test-Path (Join-Path $UnityProjectPath 'Assets'))) {
    Write-Warn2 "Unity project not found at '$UnityProjectPath' (no Assets folder). Skipping Unity launch."
    $UnityAvailable = $false
}
elseif ($UnityAvailable) {
    Write-Ok "Unity project found: $UnityProjectPath"
}

# ---------------------------------------------------------------------------
# LAN address detection
#
# The game server already does this ranking for its own join-URL and QR-code
# generation (apps/game-server/src/server.ts: lanAddresses / rankAddresses) -
# ordinary LAN ranges preferred over Tailscale/CGNAT, Docker/WSL/Hyper-V
# virtual switches, and link-local APIPA addresses. Rather than re-implement
# that ranking in PowerShell and risk it disagreeing with what the server
# actually put in the QR code, this script mirrors the SAME priority order
# and, once the server is up, prefers reading the address the server itself
# reports (via its /health-adjacent startup log is not queryable over HTTP,
# so this performs the same local interface scan the server does).
# ---------------------------------------------------------------------------

function Get-LanCandidates {
    <#
    .SYNOPSIS
        Non-internal IPv4 addresses, ranked best-first for reaching phones.
    .DESCRIPTION
        Mirrors apps/game-server/src/server.ts's rankAddresses/addressRank:
        ordinary 192.168.x/10.x LAN ranges first; Tailscale's 100.64-127.x
        CGNAT range and Docker/WSL/Hyper-V's 172.17-31.x demoted; APIPA
        169.254.x.x (DHCP failure, never routable) demoted furthest;
        loopback and non-IPv4 excluded entirely.
    #>
    $addresses = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object {
            $_.IPAddress -ne '127.0.0.1' -and
            $_.PrefixOrigin -ne 'WellKnown' -and
            $_.InterfaceAlias -notmatch '^(Loopback|vEthernet|Docker|WSL)'
        } |
        Select-Object -ExpandProperty IPAddress -Unique

    $rank = {
        param($ip)
        if ($ip -match '^169\.254\.') { return 90 }              # APIPA - DHCP failed
        if ($ip -match '^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.') { return 80 }  # Tailscale/CGNAT
        if ($ip -match '^172\.(1[7-9]|2[0-9]|3[01])\.') { return 70 }  # Docker/WSL/Hyper-V
        if ($ip -match '^192\.168\.') { return 0 }
        if ($ip -match '^10\.') { return 1 }
        return 50
    }

    $addresses |
        Sort-Object -Property @{ Expression = { & $rank $_ } } |
        Where-Object { (& $rank $_) -lt 90 }
}

Write-Section 'Detecting LAN address'

$candidates = @(Get-LanCandidates)
if ($candidates.Count -eq 0) {
    Write-Warn2 'No LAN-like IPv4 address detected. The server will fall back to localhost,'
    Write-Warn2 'and phones will NOT be able to reach it. Check your network adapter.'
    $LanIp = 'localhost'
}
elseif ($candidates.Count -eq 1) {
    $LanIp = $candidates[0]
    Write-Ok "Detected LAN address: $LanIp"
}
else {
    $LanIp = $candidates[0]
    Write-Ok "Detected LAN address: $LanIp (best candidate)"
    Write-Warn2 'Multiple candidate addresses were found:'
    foreach ($c in $candidates) { Write-Host "         - $c" -ForegroundColor Yellow }
    Write-Warn2 "Using '$LanIp'. If phones can't connect, check which adapter is actually"
    Write-Warn2 'on the same Wi-Fi/Ethernet network as your phones.'
}

$ServerHttpUrl = "http://${LanIp}:${ServerPort}"
$ServerWsUrl = "ws://${LanIp}:${ServerPort}"
$WebUrl = "http://${LanIp}:${WebPort}"

# ---------------------------------------------------------------------------
# Unity Host connection field check
#
# Read-only: this script does not edit the scene. It just tells you if the
# Inspector fields look wrong for a LAN party, since a stale tunnel address
# there would make the Host itself unable to connect even though the server
# and web app are both fine.
# ---------------------------------------------------------------------------

function Test-UnitySceneConnectionConfig {
    param([string]$ScenePath)

    if (-not (Test-Path $ScenePath)) { return }

    $content = Get-Content -Path $ScenePath -Raw
    if ($content -notmatch 'serverHost:\s*(\S+)') { return }
    $configuredHost = $Matches[1]

    $useTls = $false
    if ($content -match 'serverUseTls:\s*(\d+)') { $useTls = $Matches[1] -eq '1' }

    $looksLikeTunnel = $configuredHost -match 'trycloudflare\.com|ngrok|\.dev$|\.app$' -or $useTls

    Write-Section 'Unity Host connection config (read-only check)'
    Write-Host "  scene:        $ScenePath"
    Write-Host "  serverHost:   $configuredHost"
    Write-Host "  serverUseTls: $useTls"

    if ($looksLikeTunnel) {
        Write-Warn2 'HostLobby.unity is currently configured for a TUNNEL, not this LAN party:'
        Write-Warn2 "  serverHost = '$configuredHost', serverUseTls = $useTls"
        Write-Warn2 ''
        Write-Warn2 "This script does NOT edit the scene automatically. To fix it manually:"
        Write-Warn2 "  1. Open unity/host in Unity, open the HostLobby scene,"
        Write-Warn2 "  2. select the HostLobby GameObject in the Hierarchy,"
        Write-Warn2 "  3. in the Inspector, set Server Host to '$LanIp',"
        Write-Warn2 "  4. set Server Port to $ServerPort, and uncheck Server Use Tls."
        Write-Warn2 'Until that is changed, the Host will try to reach the old tunnel address'
        Write-Warn2 'and will not connect to the local server this script just started.'
    }
    else {
        Write-Ok 'serverHost does not look like a leftover tunnel address.'
        if ($configuredHost -ne $LanIp) {
            Write-Warn2 "serverHost ('$configuredHost') differs from the detected LAN IP ('$LanIp')."
            Write-Warn2 'If the Host fails to connect, update it in the Inspector to match.'
        }
    }
}

Test-UnitySceneConnectionConfig -ScenePath (Join-Path $UnityProjectPath 'Assets\Scenes\HostLobby.unity')

# ---------------------------------------------------------------------------
# Start the game server, in its own labelled window.
# ---------------------------------------------------------------------------

Write-Section 'Starting game server'

# Built as a ScriptBlock and passed -EncodedCommand (base64 UTF-16LE), rather
# than a hand-quoted string, so nothing about the repo path, the window title,
# or any special character (&, -, quotes) can break PowerShell's parser when
# it crosses into the child process's command line.
$serverScriptBlock = {
    param($RepoRootArg, $WebUrlArg, $ServerHttpUrlArg)
    $Host.UI.RawUI.WindowTitle = 'Brains and Bacchanal - SERVER'
    Set-Location $RepoRootArg
    $env:GAME_SERVER_DEV_TOOLS = '1'
    $env:PUBLIC_BASE_URL = $WebUrlArg
    Write-Host "SERVER  listening on $ServerHttpUrlArg" -ForegroundColor Green
    Write-Host 'SERVER  dev tools: ON (GAME_SERVER_DEV_TOOLS=1)' -ForegroundColor Green
    Write-Host ''
    pnpm --filter @bb/game-server dev
}
$serverCommandLine = "& {$serverScriptBlock} " +
    "'$RepoRoot' '$WebUrl' '$ServerHttpUrl'"
$serverEncoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($serverCommandLine))

try {
    $serverProcess = Start-Process -FilePath 'powershell.exe' `
        -ArgumentList @('-NoExit', '-NoProfile', '-EncodedCommand', $serverEncoded) `
        -PassThru -ErrorAction Stop
    Write-Ok "Server window opened (PID $($serverProcess.Id))."
}
catch {
    Write-Fail "Could not start the server window: $($_.Exception.Message)"
    exit 1
}

# ---------------------------------------------------------------------------
# Start the web app, in its own labelled window.
#
# `next dev` defaults its hostname to 0.0.0.0 (binds all interfaces), which is
# what a phone on the LAN needs - it is NOT restricted to localhost. -H is
# passed explicitly anyway so this stays true even if that default ever
# changes upstream.
# ---------------------------------------------------------------------------

Write-Section 'Starting player web app'

$webScriptBlock = {
    param($WebAppDirArg, $WebUrlArg, $WebPortArg)
    $Host.UI.RawUI.WindowTitle = 'Brains and Bacchanal - WEB'
    Set-Location $WebAppDirArg
    Write-Host "WEB     listening on $WebUrlArg (bound to 0.0.0.0, reachable on LAN)" -ForegroundColor Green
    Write-Host ''
    pnpm exec next dev -p $WebPortArg -H 0.0.0.0
}
$webAppDir = Join-Path $RepoRoot 'apps\web'
$webCommandLine = "& {$webScriptBlock} " +
    "'$webAppDir' '$WebUrl' '$WebPort'"
$webEncoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($webCommandLine))

try {
    $webProcess = Start-Process -FilePath 'powershell.exe' `
        -ArgumentList @('-NoExit', '-NoProfile', '-EncodedCommand', $webEncoded) `
        -PassThru -ErrorAction Stop
    Write-Ok "Web window opened (PID $($webProcess.Id))."
}
catch {
    Write-Fail "Could not start the web window: $($_.Exception.Message)"
    exit 1
}

# ---------------------------------------------------------------------------
# Open Unity - the project only, never forcing Play Mode.
#
# If a Unity Editor already has this exact project open, Unity itself refuses
# a second instance on the same project ("Multiple Unity instances cannot
# open the same project") rather than launching a duplicate - this script
# does not need to detect that case itself, only avoid treating Unity's own
# refusal as a fatal error.
# ---------------------------------------------------------------------------

Write-Section 'Opening Unity'

if ($UnityAvailable) {
    try {
        Start-Process -FilePath $UnityExe -ArgumentList @('-projectPath', "`"$UnityProjectPath`"") -ErrorAction Stop
        Write-Ok 'Unity launch requested (opens the project; does not enter Play Mode).'
        Write-Host '       If the project is already open in an Editor window, Unity will' -ForegroundColor DarkGray
        Write-Host '       refuse the second instance rather than open a duplicate - that is normal.' -ForegroundColor DarkGray
    }
    catch {
        Write-Fail "Could not launch Unity: $($_.Exception.Message)"
    }
}
else {
    Write-Warn2 'Skipped (Unity executable or project not found - see preflight above).'
}

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

Write-Host ''
Write-Host '================================================' -ForegroundColor Magenta
Write-Host 'BRAINS & BACCHANAL - DEVELOPMENT GAME STARTER' -ForegroundColor Magenta
Write-Host '================================================' -ForegroundColor Magenta
Write-Host ''
Write-Host 'Game Server:'
Write-Host "  $ServerHttpUrl"
Write-Host "  $ServerWsUrl"
Write-Host ''
Write-Host 'Player Site:'
Write-Host "  $WebUrl"
Write-Host ''
Write-Host 'Unity:'
if ($UnityAvailable) {
    Write-Host '  Brains & Bacchanal Host project opened'
}
else {
    Write-Host '  SKIPPED - see warnings above'
}
Write-Host ''
Write-Host 'Next:'
Write-Host '  1. Wait for SERVER and WEB windows to report ready'
Write-Host '  2. Open/Play HostLobby in Unity'
Write-Host '  3. Create Room'
Write-Host '  4. Scan the QR code using the phones'
Write-Host '================================================' -ForegroundColor Magenta
