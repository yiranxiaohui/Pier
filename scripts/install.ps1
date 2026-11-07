#requires -Version 5.1
<#
Install the official Pier Windows desktop release after checking SHA256SUMS.txt.
Run in Windows PowerShell or PowerShell 7 (no Node, Bun, WSL or admin shell needed):
  & ([scriptblock]::Create((Invoke-RestMethod https://raw.githubusercontent.com/yiranxiaohui/Pier/main/scripts/install.ps1)))
Options: -Version vX.Y.Z -Mirror auto|github|ghfast|gh-proxy|ghproxy|https://prefix/
         -Silent (NSIS /S) -Help
PIER_VERSION and PIER_MIRROR provide defaults. No service is installed and no data is deleted.
The complete script is parsed before any download or installation is started.
#>
[CmdletBinding()]
param(
    [string]$Version = $(if ($env:PIER_VERSION) { $env:PIER_VERSION } else { 'latest' }),
    [string]$Mirror = $(if ($env:PIER_MIRROR) { $env:PIER_MIRROR } else { 'auto' }),
    [switch]$Silent,
    [switch]$Help
)

function Get-PierRouteUrl([string]$Route, [string]$Url) {
    switch ($Route) {
        'github' { return $Url }
        'ghfast' { return "https://ghfast.top/$Url" }
        'gh-proxy' { return "https://gh-proxy.com/$Url" }
        'ghproxy' { return "https://ghproxy.net/$Url" }
        default { return "$($Route.TrimEnd('/'))/$Url" }
    }
}

function Get-PierRoutes([string]$Route) {
    if ($Route -eq 'auto') { return @('github', 'ghfast', 'gh-proxy', 'ghproxy') }
    if ($Route -in @('github', 'ghfast', 'gh-proxy', 'ghproxy')) { return @($Route) }
    if ($Route -cnotmatch '^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._~/-]*)?$') {
        throw 'Invalid mirror. Use auto, github, ghfast, gh-proxy, ghproxy or an HTTPS prefix without credentials, query or fragment.'
    }
    return @($Route.TrimEnd('/') + '/')
}

function Get-PierWindowsArchitecture {
    # The native OS architecture, not the bitness of the PowerShell process.
    $native = $env:PROCESSOR_ARCHITEW6432
    if (-not $native) { $native = $env:PROCESSOR_ARCHITECTURE }
    if ($native -eq 'AMD64') { return 'x64' }
    throw "No native Windows release for architecture '$native'. Use a supported x64 Windows PC; ARM64 and 32-bit installers are not published."
}

function Get-PierRelease([string]$Checksums, [string]$RequestedVersion, [string]$Architecture) {
    $suffix = '-windows-' + $Architecture + '.setup.exe'
    $pattern = '^([0-9a-fA-F]{64})\s+\*?(pier-(v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)' + [regex]::Escape($suffix) + ')$'
    $assets = @()
    foreach ($line in ($Checksums -split '\r?\n')) {
        if ($line -cmatch $pattern) {
            if ($RequestedVersion -eq 'latest' -or $Matches[3] -ceq $RequestedVersion) {
                $assets += [pscustomobject]@{ Hash = $Matches[1]; Name = $Matches[2]; Tag = $Matches[3] }
            }
        }
    }
    if ($assets.Count -ne 1) { throw "Missing or ambiguous Windows $Architecture installer checksum for $RequestedVersion." }
    return $assets[0]
}

function Receive-PierFile([string]$Url, [string]$Destination, [switch]$Small) {
    # curl.exe ships with supported Windows 10/11 versions. Unlike the PowerShell curl
    # alias, it enforces HTTPS on redirects and supports resumable downloads on 5.1 too.
    $arguments = @('--proto', '=https', '--proto-redir', '=https', '--fail', '--location',
        '--connect-timeout', '15', '--silent', '--show-error', '--output', $Destination)
    if ($Small) { $arguments += @('--max-time', '60') }
    else { $arguments += @('--continue-at', '-', '--speed-limit', '102400', '--speed-time', '20') }
    & curl.exe @arguments $Url
    $code = $LASTEXITCODE
    if ($code -eq 33 -and -not $Small) {
        # A mirror without Range support cannot reuse the partial file.
        Remove-Item -LiteralPath $Destination -Force -ErrorAction SilentlyContinue
        & curl.exe @arguments $Url
        $code = $LASTEXITCODE
    }
    if ($code -ne 0) { throw "Download failed (curl exit $code)." }
}

function Assert-PierChecksum([string]$Path, [string]$Expected) {
    if ((Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash -ine $Expected) {
        throw 'Checksum mismatch; the installer was not executed. Nothing was changed.'
    }
}

function Start-PierSetup([string]$Path, [switch]$Quiet) {
    $options = @{ FilePath = $Path; PassThru = $true }
    if ($Quiet) { $options.ArgumentList = '/S' }
    $process = Start-Process @options
    # Wait only for setup, not a Pier window launched by the wizard's Finish page.
    # Start-Process -Wait waits for descendants too on Windows.
    $process.WaitForExit()
    if ($process.ExitCode -notin @(0, 3010)) { throw "Pier setup failed or was cancelled (exit $($process.ExitCode))." }
    if ($process.ExitCode -eq 3010) { Write-Warning 'Windows requests a restart to finish installation.' }
}

function Install-Pier {
    [CmdletBinding()]
    param([string]$Version = 'latest', [string]$Mirror = 'auto', [switch]$Silent, [switch]$Help)
    $ErrorActionPreference = 'Stop'
    if ($Help) {
        Write-Output @'
Install or update Pier on Windows x64 (Windows PowerShell 5.1 / PowerShell 7).
  -Version vX.Y.Z  Install a specific release (default: latest)
  -Mirror ROUTE   auto (GitHub then mirrors), github, ghfast, gh-proxy, ghproxy,
                  or a custom https:// prefix
  -Silent         Run the Windows installer without its wizard (/S)
  -Help           Show help
Defaults: PIER_VERSION, PIER_MIRROR. Close Pier from the tray before updating.
No system service, Node.js, Bun or WSL required. State and Agent data are kept.
'@
        return
    }
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Run this script on Windows. On Linux/macOS use scripts/install.sh.' }
    $architecture = Get-PierWindowsArchitecture
    if ($Version -ne 'latest') {
        if (-not $Version.StartsWith('v')) { $Version = "v$Version" }
        if ($Version -cnotmatch '^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$') { throw 'Invalid version; expected vX.Y.Z.' }
    }
    $routes = @(Get-PierRoutes $Mirror)
    if (-not (Get-Command curl.exe -ErrorAction SilentlyContinue)) { throw 'curl.exe is required. Install Windows updates or download the .setup.exe from GitHub Releases.' }
    if (Get-Process -Name 'pier', 'pier-host', 'pier-desktop' -ErrorAction SilentlyContinue) {
        throw 'Quit Pier from its tray menu before installing or updating. Running sessions will not be terminated automatically.'
    }
    $root = 'https://github.com/yiranxiaohui/Pier/releases'
    $sumsUrl = if ($Version -eq 'latest') { "$root/latest/download/SHA256SUMS.txt" } else { "$root/download/$Version/SHA256SUMS.txt" }
    $stage = Join-Path ([IO.Path]::GetTempPath()) ('pier-install-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $stage | Out-Null
    try {
        $sums = Join-Path $stage 'SHA256SUMS.txt'
        $sumsRoutes = @('github') + @($routes | Where-Object { $_ -ne 'github' })
        $received = $false
        foreach ($route in $sumsRoutes) {
            try {
                Receive-PierFile (Get-PierRouteUrl $route $sumsUrl) $sums -Small
                $received = $true
                if ($route -ne 'github') { Write-Warning "GitHub did not answer; checksums came through $route. Only proceed if you trust this mirror." }
                break
            } catch { Write-Warning "Checksums via ${route}: $_" }
        }
        if (-not $received) { throw 'Could not download release checksums. Check the network, version or -Mirror.' }
        $release = Get-PierRelease ([IO.File]::ReadAllText($sums)) $Version $architecture
        $setup = Join-Path $stage $release.Name
        $url = "$root/download/$($release.Tag)/$($release.Name)"
        $received = $false
        # Automatic fallback retains partial downloads; a pinned route never switches.
        foreach ($route in $routes) {
            Write-Host "Downloading Pier $($release.Tag) (Windows $architecture) via $route..."
            try {
                Receive-PierFile (Get-PierRouteUrl $route $url) $setup
                $received = $true
                break
            } catch { Write-Warning "Installer via ${route}: $_" }
        }
        if (-not $received) { throw 'Download failed on every selected route; nothing was changed.' }
        Assert-PierChecksum $setup $release.Hash
        if (Get-Process -Name 'pier', 'pier-host', 'pier-desktop' -ErrorAction SilentlyContinue) {
            throw 'Quit Pier from its tray menu before running setup.'
        }
        Write-Host 'SHA-256 verified. Starting the Pier installation wizard...'
        Start-PierSetup $setup -Quiet:$Silent
        Write-Host "Pier $($release.Tag) installed. Open Pier from the Start menu. Updates: Settings > About & Updates."
    } finally {
        Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# Dot-sourcing exposes helpers for the offline regression tests without installing anything.
if ($MyInvocation.InvocationName -ne '.') { Install-Pier -Version $Version -Mirror $Mirror -Silent:$Silent -Help:$Help }
