[CmdletBinding()]
param(
    [ValidateSet('public')]
    [string]$Profile = 'public',

    [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot),

    [string]$OutputDir = '',

    [string]$BunVersion = '1.2.15',

    [string]$NodeVersion = '22.16.0',

    [switch]$SkipBuild,

    [string]$RuntimeCacheDir = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Resolve-TargetPath {
    param(
        [Parameter(Mandatory = $true)][string]$PathValue,
        [Parameter(Mandatory = $true)][string]$BaseDir
    )
    if ([System.IO.Path]::IsPathRooted($PathValue)) {
        return [System.IO.Path]::GetFullPath($PathValue)
    }
    return [System.IO.Path]::GetFullPath((Join-Path $BaseDir $PathValue))
}

$RepoRoot = [System.IO.Path]::GetFullPath($RepoRoot)
if ([string]::IsNullOrWhiteSpace($OutputDir)) {
    $OutputDir = Join-Path $RepoRoot 'dist\windows-bundle'
} else {
    $OutputDir = Resolve-TargetPath -PathValue $OutputDir -BaseDir $RepoRoot
}

if ([string]::IsNullOrWhiteSpace($RuntimeCacheDir)) {
    $RuntimeCacheDir = Join-Path $RepoRoot '.cache\runtimes'
} else {
    $RuntimeCacheDir = Resolve-TargetPath -PathValue $RuntimeCacheDir -BaseDir $RepoRoot
}

Write-Host "=== Staging Windows Bundle ==="
Write-Host "Profile         : $Profile"
Write-Host "RepoRoot        : $RepoRoot"
Write-Host "OutputDir       : $OutputDir"
Write-Host "BunVersion      : $BunVersion"
Write-Host "NodeVersion     : $NodeVersion"
Write-Host "RuntimeCacheDir : $RuntimeCacheDir"

function Get-FileSha256Lower {
    param([Parameter(Mandatory = $true)][string]$FilePath)
    return (Get-FileHash -LiteralPath $FilePath -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Assert-Sha256 {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string]$ExpectedSha256,
        [Parameter(Mandatory = $true)][string]$Label
    )
    $actual = Get-FileSha256Lower -FilePath $FilePath
    $expected = $ExpectedSha256.Trim().ToLowerInvariant()
    if ($actual -ne $expected) {
        throw "SHA256 mismatch for $Label ($FilePath). Expected: $expected, Actual: $actual"
    }
}

function Get-Sha256FromManifest {
    param(
        [Parameter(Mandatory = $true)][string]$ManifestUrl,
        [Parameter(Mandatory = $true)][string]$TargetArtifactPattern
    )
    Write-Host "Fetching SHA256 manifest: $ManifestUrl"
    $resp = Invoke-WebRequest -Uri $ManifestUrl -UseBasicParsing -TimeoutSec 60
    $text = if ($resp.Content -is [byte[]]) {
        [System.Text.Encoding]::UTF8.GetString($resp.Content)
    } else {
        [string]$resp.Content
    }
    $lines = ($text -split "`r?`n")
    foreach ($line in $lines) {
        if ($line -match '^\s*([a-fA-F0-9]{64})\s+\*?(.+?)\s*$') {
            $hash = $Matches[1].ToLowerInvariant()
            $artifact = $Matches[2].Trim()
            if ($artifact -eq $TargetArtifactPattern) {
                return $hash
            }
        }
    }
    throw "Failed to find SHA256 entry for '$TargetArtifactPattern' in $ManifestUrl"
}

function Ensure-PortableBun {
    param(
        [Parameter(Mandatory = $true)][string]$Version,
        [Parameter(Mandatory = $true)][string]$CacheDir,
        [Parameter(Mandatory = $true)][string]$DestExePath
    )
    $knownHashes = @{
        '1.2.15' = '3cbfc2668aebd86718b9414fd4a4b4b1ec34a21ca544517310833563a937272f'
    }

    $bunCacheDir = Join-Path $CacheDir "bun-v$Version"
    New-Item -ItemType Directory -Path $bunCacheDir -Force | Out-Null
    $zipPath = Join-Path $bunCacheDir 'bun-windows-x64.zip'
    $manifestUrl = "https://github.com/oven-sh/bun/releases/download/bun-v$Version/SHASUMS256.txt"
    $zipUrl = "https://github.com/oven-sh/bun/releases/download/bun-v$Version/bun-windows-x64.zip"

    $expectedSha = $null
    if ($knownHashes.ContainsKey($Version)) {
        $expectedSha = $knownHashes[$Version]
    } else {
        $expectedSha = Get-Sha256FromManifest -ManifestUrl $manifestUrl -TargetArtifactPattern 'bun-windows-x64.zip'
    }

    $needDownload = $true
    if (Test-Path -LiteralPath $zipPath) {
        $actual = Get-FileSha256Lower -FilePath $zipPath
        if ($actual -eq $expectedSha) {
            Write-Host "Reusing cached Bun archive: $zipPath (SHA256 verified)"
            $needDownload = $false
        } else {
            Write-Warning "Cached Bun archive failed SHA256 check, re-downloading..."
            Remove-Item -LiteralPath $zipPath -Force
        }
    }

    if ($needDownload) {
        if (-not $knownHashes.ContainsKey($Version)) {
            # Already fetched above
        } else {
            # Also verify against official SHASUMS256.txt when downloading
            $remoteSha = Get-Sha256FromManifest -ManifestUrl $manifestUrl -TargetArtifactPattern 'bun-windows-x64.zip'
            if ($remoteSha -ne $expectedSha) {
                throw "Bun v$Version SHASUMS256.txt mismatch against pinned hash! Pinned=$expectedSha Remote=$remoteSha"
            }
        }
        Write-Host "Downloading Bun v$Version from $zipUrl ..."
        Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath -UseBasicParsing -TimeoutSec 300
        try {
            Assert-Sha256 -FilePath $zipPath -ExpectedSha256 $expectedSha -Label "bun-windows-x64.zip (v$Version)"
        } catch {
            Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
            throw
        }
    }

    $extractDir = Join-Path $bunCacheDir 'extracted'
    if (Test-Path -LiteralPath $extractDir) {
        Remove-Item -LiteralPath $extractDir -Recurse -Force
    }
    Expand-Archive -LiteralPath $zipPath -DestinationPath $extractDir -Force

    $bunExe = Get-ChildItem -Path $extractDir -Filter 'bun.exe' -Recurse -File | Select-Object -First 1
    if ($null -eq $bunExe) {
        throw "bun.exe not found inside $zipPath"
    }

    New-Item -ItemType Directory -Path (Split-Path -Parent $DestExePath) -Force | Out-Null
    Copy-Item -LiteralPath $bunExe.FullName -Destination $DestExePath -Force
    Write-Host "Staged Bun v$Version -> $DestExePath"
}

function Ensure-PortableNode {
    param(
        [Parameter(Mandatory = $true)][string]$Version,
        [Parameter(Mandatory = $true)][string]$CacheDir,
        [Parameter(Mandatory = $true)][string]$DestExePath
    )
    $nodeCacheDir = Join-Path $CacheDir "node-v$Version"
    New-Item -ItemType Directory -Path $nodeCacheDir -Force | Out-Null
    $cachedExe = Join-Path $nodeCacheDir 'node.exe'
    $manifestUrl = "https://nodejs.org/dist/v$Version/SHASUMS256.txt"
    $exeUrl = "https://nodejs.org/dist/v$Version/win-x64/node.exe"

    $expectedSha = Get-Sha256FromManifest -ManifestUrl $manifestUrl -TargetArtifactPattern 'win-x64/node.exe'

    $needDownload = $true
    if (Test-Path -LiteralPath $cachedExe) {
        $actual = Get-FileSha256Lower -FilePath $cachedExe
        if ($actual -eq $expectedSha) {
            Write-Host "Reusing cached Node.js binary: $cachedExe (SHA256 verified)"
            $needDownload = $false
        } else {
            Write-Warning "Cached Node.js binary failed SHA256 check, re-downloading..."
            Remove-Item -LiteralPath $cachedExe -Force
        }
    }

    if ($needDownload) {
        Write-Host "Downloading Node.js v$Version from $exeUrl ..."
        Invoke-WebRequest -Uri $exeUrl -OutFile $cachedExe -UseBasicParsing -TimeoutSec 300
        try {
            Assert-Sha256 -FilePath $cachedExe -ExpectedSha256 $expectedSha -Label "win-x64/node.exe (v$Version)"
        } catch {
            Remove-Item -LiteralPath $cachedExe -Force -ErrorAction SilentlyContinue
            throw
        }
    }

    New-Item -ItemType Directory -Path (Split-Path -Parent $DestExePath) -Force | Out-Null
    Copy-Item -LiteralPath $cachedExe -Destination $DestExePath -Force
    Write-Host "Staged Node.js v$Version -> $DestExePath"
}

function Copy-DirectoryFiltered {
    param(
        [Parameter(Mandatory = $true)][string]$SourceDir,
        [Parameter(Mandatory = $true)][string]$DestDir,
        [string[]]$ExcludeFilePatterns = @(),
        [string[]]$ExcludeDirNames = @('node_modules', 'data', '.git')
    )
    if (-not (Test-Path -LiteralPath $SourceDir -PathType Container)) {
        throw "Source directory not found: $SourceDir"
    }
    New-Item -ItemType Directory -Path $DestDir -Force | Out-Null
    $items = Get-ChildItem -LiteralPath $SourceDir -Force
    foreach ($item in $items) {
        if ($item.PSIsContainer) {
            if ($ExcludeDirNames -contains $item.Name) {
                continue
            }
            Copy-DirectoryFiltered -SourceDir $item.FullName -DestDir (Join-Path $DestDir $item.Name) -ExcludeFilePatterns $ExcludeFilePatterns -ExcludeDirNames $ExcludeDirNames
        } else {
            $skip = $false
            foreach ($pat in $ExcludeFilePatterns) {
                if ($item.Name -like $pat) {
                    $skip = $true
                    break
                }
            }
            if (-not $skip) {
                Copy-Item -LiteralPath $item.FullName -Destination (Join-Path $DestDir $item.Name) -Force
            }
        }
    }
}

# 1. Build step (unless -SkipBuild)
if (-not $SkipBuild) {
    $webDir = Join-Path $RepoRoot 'web'
    if (Test-Path -LiteralPath (Join-Path $webDir 'package.json')) {
        Write-Host "Building frontend (web/ npm run build)..."
        Push-Location $webDir
        try {
            & npm run build
            if ($LASTEXITCODE -ne 0) {
                throw "web/ npm run build failed with exit code $LASTEXITCODE"
            }
        } finally {
            Pop-Location
        }
    }

    Write-Host "Building Rust release binaries (cargo build --release)..."
    Push-Location $RepoRoot
    try {
        & cargo build --release
        if ($LASTEXITCODE -ne 0) {
            throw "cargo build --release failed with exit code $LASTEXITCODE"
        }
    } finally {
        Pop-Location
    }
}

# 2. Prepare clean OutputDir
if (Test-Path -LiteralPath $OutputDir) {
    Write-Host "Cleaning existing OutputDir: $OutputDir"
    Remove-Item -LiteralPath $OutputDir -Recurse -Force
}
New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null

# 3. Copy main executables
$releaseDir = Join-Path $RepoRoot 'target\release'
$traySrc = Join-Path $releaseDir 'gateway-tray.exe'
$proxySrc = Join-Path $releaseDir 'multi-acp-gateway.exe'
$proxyDestName = 'multi-acp-gateway.exe'

if (-not (Test-Path -LiteralPath $traySrc)) {
    throw "Missing release binary: $traySrc"
}
if (-not (Test-Path -LiteralPath $proxySrc)) {
    throw "Missing release binary: $proxySrc"
}

Copy-Item -LiteralPath $traySrc -Destination (Join-Path $OutputDir 'gateway-tray.exe') -Force
Copy-Item -LiteralPath $proxySrc -Destination (Join-Path $OutputDir $proxyDestName) -Force

# 4. Stage portable runtimes
Ensure-PortableBun -Version $BunVersion -CacheDir $RuntimeCacheDir -DestExePath (Join-Path $OutputDir 'runtime\bun\bun.exe')
Ensure-PortableNode -Version $NodeVersion -CacheDir $RuntimeCacheDir -DestExePath (Join-Path $OutputDir 'runtime\node\node.exe')

# 5. Whitelist assembly of services
# 5a. acp-gateway-8048
$service8048Src = Join-Path $RepoRoot 'acp-gateway-8048'
$service8048DestName = 'acp-gateway-8048'
$service8048Dest = Join-Path $OutputDir "services\$service8048DestName"
New-Item -ItemType Directory -Path $service8048Dest -Force | Out-Null

foreach ($f in @('package.json', 'tsconfig.json')) {
    $srcFile = Join-Path $service8048Src $f
    if (Test-Path -LiteralPath $srcFile) {
        Copy-Item -LiteralPath $srcFile -Destination (Join-Path $service8048Dest $f) -Force
    }
}
Copy-DirectoryFiltered -SourceDir (Join-Path $service8048Src 'src') -DestDir (Join-Path $service8048Dest 'src') -ExcludeFilePatterns @('*.test.ts')

$vendorSrc = Join-Path $service8048Src 'vendor'
if ((Test-Path -LiteralPath $vendorSrc -PathType Container) -and (@(Get-ChildItem -LiteralPath $vendorSrc -Force).Count -gt 0)) {
    Copy-DirectoryFiltered -SourceDir $vendorSrc -DestDir (Join-Path $service8048Dest 'vendor')
}

# 5b. gemini-app2api-8049
$service8049Src = Join-Path $RepoRoot 'gemini-app2api-8049'
$service8049Dest = Join-Path $OutputDir 'services\gemini-app2api-8049'
New-Item -ItemType Directory -Path $service8049Dest -Force | Out-Null

foreach ($f in @('package.json', '.env.example', 'LICENSE', 'DISCLAIMER.md')) {
    $srcFile = Join-Path $service8049Src $f
    if (Test-Path -LiteralPath $srcFile) {
        Copy-Item -LiteralPath $srcFile -Destination (Join-Path $service8049Dest $f) -Force
    }
}
foreach ($d in @('src', 'native-wire', 'bin')) {
    $srcSubDir = Join-Path $service8049Src $d
    if (Test-Path -LiteralPath $srcSubDir -PathType Container) {
        Copy-DirectoryFiltered -SourceDir $srcSubDir -DestDir (Join-Path $service8049Dest $d)
    }
}

# 5c. magpie-aistudio-2048
$service2048Src = Join-Path $RepoRoot 'magpie-aistudio-2048'
$service2048Dest = Join-Path $OutputDir 'services\magpie-aistudio-2048'
New-Item -ItemType Directory -Path $service2048Dest -Force | Out-Null

$aistudioExeSrc = Join-Path $service2048Src 'data\aistudio2api.exe'
if (Test-Path -LiteralPath $aistudioExeSrc -PathType Leaf) {
    $service2048Bin = Join-Path $service2048Dest 'bin'
    New-Item -ItemType Directory -Path $service2048Bin -Force | Out-Null
    Copy-Item -LiteralPath $aistudioExeSrc -Destination (Join-Path $service2048Bin 'aistudio2api.exe') -Force
}
Get-ChildItem -LiteralPath $service2048Src -Filter 'LICENSE*' -File | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $service2048Dest $_.Name) -Force
}
$upstreamInfoSrc = Join-Path $service2048Src 'UPSTREAM_INFO.txt'
if (Test-Path -LiteralPath $upstreamInfoSrc -PathType Leaf) {
    Copy-Item -LiteralPath $upstreamInfoSrc -Destination (Join-Path $service2048Dest 'UPSTREAM_INFO.txt') -Force
}

# 6. Mandatory cleanliness assertion
Write-Host "Running mandatory cleanliness assertion on $OutputDir ..."
$violations = New-Object System.Collections.Generic.List[string]

$allDirs = Get-ChildItem -LiteralPath $OutputDir -Directory -Recurse -Force
foreach ($dir in $allDirs) {
    if ($dir.Name -ieq 'data' -or $dir.Name -ieq 'node_modules') {
        $violations.Add("Forbidden directory: $($dir.FullName)")
    }
}

$allFiles = Get-ChildItem -LiteralPath $OutputDir -File -Recurse -Force
foreach ($file in $allFiles) {
    $name = $file.Name
    if ($name -ilike '*.log') {
        $violations.Add("Forbidden log file: $($file.FullName)")
    } elseif ($name -ieq '.env' -or ($name -ilike '.env.*' -and $name -ine '.env.example')) {
        $violations.Add("Forbidden env file: $($file.FullName)")
    } elseif ($name -ieq 'state.json') {
        $violations.Add("Forbidden state file: $($file.FullName)")
    } elseif ($name -ilike '*.db' -or $name -ilike '*.sqlite*' -or $name -ilike '*.key' -or $name -ilike '*.pem' -or $name -ilike '*.pfx' -or $name -ilike '*.p12') {
        $violations.Add("Forbidden database/key file: $($file.FullName)")
    } elseif ($name -imatch '(^|[-_.])(credentials?|oauth|token|secret)([-_.].*)?\.json$') {
        $violations.Add("Forbidden credential file: $($file.FullName)")
    }

    # Check text files for leaked Google OAuth client secret prefix
    $secretPrefix = 'GOCSPX' + '-'
    $relFromOutput = $file.FullName.Substring($OutputDir.Length).TrimStart('\', '/')
    $secretAllowlist = @(
        'services\gemini-app2api-8049\src\gateway\native-evidence.mjs',
        'services\gemini-app2api-8049\src\gateway\oauth-client-defaults.mjs'
    )
    if ($file.Length -gt 0 -and $file.Length -lt 5MB -and $file.Extension -notin @('.exe', '.dll', '.zip', '.png', '.ico') -and ($secretAllowlist -notcontains $relFromOutput)) {
        $rawText = Get-Content -LiteralPath $file.FullName -Raw -ErrorAction SilentlyContinue
        if ($null -ne $rawText -and $rawText.Contains($secretPrefix, [System.StringComparison]::Ordinal)) {
            $violations.Add("Sensitive credential pattern ($secretPrefix) found in: $($file.FullName)")
        }
    }
}

if ($violations.Count -gt 0) {
    Write-Error ("Cleanliness assertion FAILED:`n" + ($violations -join "`n"))
    throw "Bundle cleanliness assertion failed with $($violations.Count) violation(s)."
}

Write-Host "Cleanliness assertion PASSED (0 violations). Bundle ready at: $OutputDir"
