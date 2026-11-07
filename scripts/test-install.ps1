# Offline regression suite, run with BOTH Windows PowerShell 5.1 and PowerShell 7 in CI.
# No network, installer, registry or real user data is touched.
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/install.ps1"

function Assert-Equal($Actual, $Expected) {
    if ($Actual -cne $Expected) { throw "Expected '$Expected', got '$Actual'" }
}
function Assert-Throws([scriptblock]$Action, [string]$Message) {
    $caught = $false
    try { & $Action } catch {
        $caught = $true
        if ("$_" -notlike "*$Message*") { throw "Unexpected error: $_ (expected $Message)" }
    }
    if (-not $caught) { throw "Expected an error containing: $Message" }
}

$root = Join-Path ([IO.Path]::GetTempPath()) ('pier-installer-tests-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
$oldArch = $env:PROCESSOR_ARCHITECTURE
$oldNative = $env:PROCESSOR_ARCHITEW6432
try {
    Assert-Equal ((Get-PierRoutes auto) -join ',') 'github,ghfast,gh-proxy,ghproxy'
    Assert-Equal (Get-PierRoutes ghfast) 'ghfast'
    Assert-Equal (Get-PierRoutes 'https://mirror.example/sub//') 'https://mirror.example/sub/'
    Assert-Equal (Get-PierRouteUrl ghfast 'https://github.com/file') 'https://ghfast.top/https://github.com/file'
    Assert-Equal (Get-PierRouteUrl 'https://mirror.example/sub/' 'https://github.com/file') 'https://mirror.example/sub/https://github.com/file'
    foreach ($route in @('http://mirror.example', 'https://user:password@example.com', 'https://example.com/?token=secret', 'https://example.com/#fragment', 'bad')) {
        Assert-Throws { Get-PierRoutes $route } 'Invalid mirror'
    }
    $env:PROCESSOR_ARCHITEW6432 = ''
    $env:PROCESSOR_ARCHITECTURE = 'AMD64'
    Assert-Equal (Get-PierWindowsArchitecture) 'x64'
    $env:PROCESSOR_ARCHITECTURE = 'x86'
    $env:PROCESSOR_ARCHITEW6432 = 'AMD64'
    Assert-Equal (Get-PierWindowsArchitecture) 'x64'
    $env:PROCESSOR_ARCHITEW6432 = 'ARM64'
    Assert-Throws { Get-PierWindowsArchitecture } 'No native Windows release'
    $env:PROCESSOR_ARCHITEW6432 = ''
    Assert-Throws { Get-PierWindowsArchitecture } 'No native Windows release'
    $env:PROCESSOR_ARCHITECTURE = 'AMD64'

    $payload = Join-Path $root 'payload'
    [IO.File]::WriteAllText($payload, 'test installer')
    $hash = (Get-FileHash $payload -Algorithm SHA256).Hash
    $asset = 'pier-v0.2.60-windows-x64.setup.exe'
    $sums = "$hash  $asset`r`n$('a' * 64)  pier-v0.2.60-linux-x64`r`n"
    $release = Get-PierRelease $sums latest x64
    Assert-Equal $release.Tag 'v0.2.60'
    Assert-Equal $release.Name $asset
    Assert-Equal (Get-PierRelease $sums v0.2.60 x64).Hash $hash
    Assert-Equal (Get-PierRelease "$hash *$asset" latest x64).Name $asset
    Assert-Throws { Get-PierRelease $sums v0.2.59 x64 } 'Missing or ambiguous'
    Assert-Throws { Get-PierRelease ($sums + $sums) latest x64 } 'Missing or ambiguous'
    Assert-Throws { Get-PierRelease ('bad  ' + $asset) latest x64 } 'Missing or ambiguous'
    Assert-Throws { Get-PierRelease ("$hash  ../" + $asset) latest x64 } 'Missing or ambiguous'
    Assert-PierChecksum $payload $hash
    Assert-Throws { Assert-PierChecksum $payload ('0' * 64) } 'Checksum mismatch'

    $script:setupCode = 0
    $script:setupArguments = ''
    function Start-Process {
        param($FilePath, [switch]$Wait, [switch]$PassThru, $ArgumentList)
        Assert-Equal $FilePath $payload
        if ($Wait -or -not $PassThru) { throw 'Setup must wait only for the installer, not descendants' }
        $script:setupArguments = $ArgumentList
        $process = [pscustomobject]@{ ExitCode = $script:setupCode }
        $process | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value { $script:waited = $true }
        return $process
    }
    Start-PierSetup $payload -Quiet
    Assert-Equal $script:setupArguments '/S'
    Assert-Equal $script:waited $true
    $script:setupCode = 2
    Assert-Throws { Start-PierSetup $payload } 'failed or was cancelled'
    Remove-Item Function:Start-Process

    # Full installation orchestration on Windows, with the download and setup boundaries mocked.
    if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) {
        $script:requests = @()
        $script:launches = 0
        $script:failGithub = $false
        $script:badPayload = $false
        $script:running = $false
        $script:quiet = $false
        function curl.exe { throw 'No real network calls allowed' }
        function Get-Process {
            param($Name, $ErrorAction)
            if ($script:running) { return [pscustomobject]@{ Name = 'pier' } }
        }
        function Receive-PierFile {
            param([string]$Url, [string]$Destination, [switch]$Small)
            $script:requests += $Url
            if ($script:failGithub -and $Url.StartsWith('https://github.com/')) { throw 'Offline' }
            if ($Small) { [IO.File]::WriteAllText($Destination, $sums) }
            elseif ($script:badPayload) { [IO.File]::WriteAllText($Destination, 'tampered') }
            else { Copy-Item $payload $Destination }
            $script:stage = Split-Path $Destination
        }
        function Start-PierSetup {
            param([string]$Path, [switch]$Quiet)
            Assert-PierChecksum $Path $hash
            $script:quiet = [bool]$Quiet
            $script:launches++
        }
        Install-Pier -Silent
        Assert-Equal $script:launches 1
        Assert-Equal $script:quiet $true
        Assert-Equal $script:requests.Count 2
        Assert-Equal $script:requests[1] "https://github.com/yiranxiaohui/Pier/releases/download/v0.2.60/$asset"
        Assert-Equal (Test-Path $script:stage) $false

        $script:requests = @()
        $script:failGithub = $true
        Install-Pier -Version 0.2.60 -Mirror ghfast
        Assert-Equal $script:launches 2
        Assert-Equal $script:requests.Count 3
        Assert-Equal $script:requests[2] "https://ghfast.top/https://github.com/yiranxiaohui/Pier/releases/download/v0.2.60/$asset"
        Assert-Equal (Test-Path $script:stage) $false

        $script:requests = @()
        Install-Pier
        Assert-Equal $script:launches 3
        Assert-Equal $script:requests.Count 4
        Assert-Equal (Test-Path $script:stage) $false
        $script:failGithub = $false
        $script:badPayload = $true
        Assert-Throws { Install-Pier } 'Checksum mismatch'
        Assert-Equal $script:launches 3
        Assert-Equal (Test-Path $script:stage) $false

        $script:requests = @()
        $script:running = $true
        Assert-Throws { Install-Pier } 'Quit Pier'
        Assert-Equal $script:requests.Count 0
        $script:running = $false
        Assert-Throws { Install-Pier -Version '../escape' } 'Invalid version'
        Assert-Equal $script:requests.Count 0
        Install-Pier -Help
    } else {
        Assert-Throws { Install-Pier } 'Run this script on Windows'
        Write-Host 'Windows orchestration tests require Windows (covered by both Windows CI shells).'
    }
    Write-Host "Installer regression tests passed on PowerShell $($PSVersionTable.PSVersion)."
} finally {
    $env:PROCESSOR_ARCHITECTURE = $oldArch
    $env:PROCESSOR_ARCHITEW6432 = $oldNative
    Remove-Item -LiteralPath $root -Recurse -Force
}
