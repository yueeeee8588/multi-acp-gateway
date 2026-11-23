[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$TargetDir
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $TargetDir -PathType Container)) {
    throw "TargetDir does not exist or is not a directory: $TargetDir"
}

$resolvedRoot = (Resolve-Path -LiteralPath $TargetDir).Path
$selfPath = [System.IO.Path]::GetFullPath($PSCommandPath)
$skipDirNames = @('.git', 'target', 'node_modules', 'dist', '.cache')
$binaryExts = @(
    '.exe', '.dll', '.pdb', '.lib', '.so', '.dylib', '.bin', '.obj', '.o', '.a',
    '.ico', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svgz',
    '.zip', '.7z', '.tar', '.gz', '.xz', '.bz2', '.rar',
    '.woff', '.woff2', '.ttf', '.otf', '.eot',
    '.pdf', '.db', '.sqlite', '.sqlite3', '.lockb', '.pyc', '.wasm'
)

$rules = @(
    @{ Name = 'keyword:zakoai';  Regex = [regex]::new(('zako' + 'ai'), [System.Text.RegularExpressions.RegexOptions]::IgnoreCase) },
    @{ Name = 'keyword:huajian'; Regex = [regex]::new(('hua' + 'jian'), [System.Text.RegularExpressions.RegexOptions]::IgnoreCase) },
    @{ Name = 'keyword:cn1';     Regex = [regex]::new(([char]0x7834 + [char]0x7532)) },
    @{ Name = 'keyword:cn2';     Regex = [regex]::new(([char]0x7C89 + [char]0x54E5)) },
    @{ Name = 'keyword:cn3';     Regex = [regex]::new(([char]0x5CB3 + [char]0x5CB3)) },
    @{ Name = 'secret:oauth';    Regex = [regex]::new(('GOCSPX' + '-[A-Za-z0-9_-]{12,}')) },
    @{ Name = 'path:UsersAbs';   Regex = [regex]::new('[A-Za-z]:\\Users\\', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase) },
    @{ Name = 'path:DDriveAbs';  Regex = [regex]::new('D:\\', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase) }
)

$emailRegex = [regex]::new('[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}')
$ipv4Regex  = [regex]::new('\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b')

function Test-IsBinaryFile {
    param([Parameter(Mandatory = $true)][System.IO.FileInfo]$File)
    if ($binaryExts -contains $File.Extension.ToLowerInvariant()) {
        return $true
    }
    if ($File.Length -eq 0) {
        return $false
    }
    try {
        $fs = [System.IO.File]::OpenRead($File.FullName)
        try {
            $bufSize = [Math]::Min(8192, [int]$File.Length)
            $buf = New-Object byte[] $bufSize
            $read = $fs.Read($buf, 0, $bufSize)
            for ($i = 0; $i -lt $read; $i++) {
                if ($buf[$i] -eq 0) {
                    return $true
                }
            }
        } finally {
            $fs.Dispose()
        }
    } catch {
        return $true
    }
    return $false
}

function Get-RelativePathSafe {
    param(
        [Parameter(Mandatory = $true)][string]$BaseDir,
        [Parameter(Mandatory = $true)][string]$FullPath
    )
    if ($FullPath.StartsWith($BaseDir, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $FullPath.Substring($BaseDir.Length).TrimStart('\', '/')
    }
    return $FullPath
}

function Get-CandidateFiles {
    param([Parameter(Mandatory = $true)][string]$DirPath)
    $results = New-Object System.Collections.Generic.List[System.IO.FileInfo]
    $entries = Get-ChildItem -LiteralPath $DirPath -Force -ErrorAction SilentlyContinue
    foreach ($entry in $entries) {
        if ($entry.PSIsContainer) {
            if ($skipDirNames -contains $entry.Name) {
                continue
            }
            foreach ($subFile in (Get-CandidateFiles -DirPath $entry.FullName)) {
                $results.Add($subFile)
            }
        } else {
            $results.Add($entry)
        }
    }
    return $results
}

function Test-IsAllowedIp {
    param(
        [Parameter(Mandatory = $true)][string]$Ip,
        [Parameter(Mandatory = $true)][string]$RelPath
    )
    if ($Ip -eq '0.0.0.0' -or $Ip -eq '255.255.255.255' -or $Ip.StartsWith('127.') -or $Ip.StartsWith('10.') -or $Ip.StartsWith('192.168.') -or $Ip.StartsWith('169.254.') -or $Ip.StartsWith('224.')) {
        return $true
    }
    if ($Ip -match '^172\.(1[6-9]|2\d|3[0-1])\.' -or $Ip -match '^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.' -or $Ip -match '^198\.1[89]\.') {
        return $true
    }
    if ($Ip -match '^192\.0\.[02]\.' -or $Ip -match '^192\.88\.99\.' -or $Ip -match '^198\.51\.100\.' -or $Ip -match '^203\.0\.113\.') {
        return $true
    }
    if ($Ip -eq '146.0.0.0') {
        return $true
    }
    $normPath = $RelPath.Replace('\', '/')
    if (($normPath -match '(^|/)(tests?|spec)/' -or $normPath -match '\.(test|spec)\.[cm]?[jt]sx?$') -and $Ip -in @('1.1.1.1', '1.2.3.4', '2.2.2.2', '5.6.7.8', '9.9.9.9', '8.8.8.8', '93.184.215.14')) {
        return $true
    }
    return $false
}

function Test-IsAllowedEmail {
    param(
        [Parameter(Mandatory = $true)][string]$Email,
        [Parameter(Mandatory = $true)][string]$RelPath
    )
    if ($Email -imatch '@example\.(com|org|net|invalid)$' -or $Email -imatch '@users\.noreply\.github\.com$') {
        return $true
    }
    $normPath = $RelPath.Replace('\', '/')
    if ($normPath -match '(^|/)(tests?|spec)/' -or $normPath -match '\.(test|spec)\.[cm]?[jt]sx?$' -or $normPath -match 'smoke\.mjs$') {
        return $true
    }
    if ($Email -in @('a@gmail.com', 'b@gmail.com', 'user@gmail.com')) {
        return $true
    }
    return $false
}

$totalHits = 0
$files = Get-CandidateFiles -DirPath $resolvedRoot

foreach ($file in $files) {
    if ([System.IO.Path]::GetFullPath($file.FullName) -ieq $selfPath) {
        continue
    }
    if (Test-IsBinaryFile -File $file) {
        continue
    }

    $relPath = Get-RelativePathSafe -BaseDir $resolvedRoot -FullPath $file.FullName
    $lineNum = 0
    try {
        foreach ($line in [System.IO.File]::ReadLines($file.FullName)) {
            $lineNum++

            foreach ($rule in $rules) {
                if ($rule.Regex.IsMatch($line)) {
                    Write-Host "[HIT] ${relPath}:${lineNum} [$($rule.Name)]"
                    $totalHits++
                }
            }

            foreach ($m in $emailRegex.Matches($line)) {
                $email = $m.Value
                if (Test-IsAllowedEmail -Email $email -RelPath $relPath) {
                    continue
                }
                Write-Host "[HIT] ${relPath}:${lineNum} [email:$email]"
                $totalHits++
            }

            foreach ($m in $ipv4Regex.Matches($line)) {
                $ip = $m.Value
                if (Test-IsAllowedIp -Ip $ip -RelPath $relPath) {
                    continue
                }
                Write-Host "[HIT] ${relPath}:${lineNum} [public-ip:$ip]"
                $totalHits++
            }
        }
    } catch {
        Write-Warning "Skipping unreadable file ${relPath}: $($_.Exception.Message)"
    }
}

Write-Host "TOTAL_HITS=$totalHits"
if ($totalHits -gt 0) {
    exit 1
}
exit 0
