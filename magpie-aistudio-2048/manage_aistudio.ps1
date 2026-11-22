param(
    [Parameter(Position = 0)]
    [ValidateSet("start", "stop", "status")]
    [string]$Action = "status",

    [string]$Proxy = ""
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$RootDir = $PSScriptRoot
$DataDir = Join-Path $RootDir "data"
$StudioScript = Join-Path $RootDir "scripts\studio.mjs"
$PidFile = Join-Path $DataDir "backend.pid"
$ConfigFile = Join-Path $DataDir "config.json"
$EnvFile = Join-Path $DataDir ".env"
$BinFile = Join-Path $DataDir "aistudio2api.exe"
$AuthDir = Join-Path $DataDir "auth"
$LogFile = Join-Path $DataDir "backend.log"

function Normalize-PathKey {
    param([string]$PathValue)
    if (-not $PathValue) { return "" }
    try {
        return ([System.IO.Path]::GetFullPath($PathValue)).TrimEnd('\').ToLowerInvariant()
    } catch {
        return $PathValue.TrimEnd('\').ToLowerInvariant()
    }
}

function Get-ListenPort {
    if (Test-Path -LiteralPath $ConfigFile) {
        try {
            $cfg = Get-Content -LiteralPath $ConfigFile -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($cfg.port) { return [int]$cfg.port }
        } catch {}
    }
    return 2048
}

function Get-ListeningPortInfo {
    param(
        [int]$Port,
        [int]$ExpectedPid = 0,
        [switch]$IPv4Only
    )
    $conns = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    if ($conns.Count -eq 0) { return $null }

    $ipv4Addrs = @("127.0.0.1", "0.0.0.0")
    $preferredAddrs = if ($IPv4Only) { $ipv4Addrs } else { @("127.0.0.1", "0.0.0.0", "::1", "::") }
    $pool = if ($IPv4Only) { @($conns | Where-Object { $_.LocalAddress -in $ipv4Addrs }) } else { $conns }
    if ($pool.Count -eq 0) { return $null }

    $selected = $null

    if ($ExpectedPid -gt 0) {
        $selected = $pool |
            Where-Object { [int]$_.OwningProcess -eq $ExpectedPid -and $_.LocalAddress -in $preferredAddrs } |
            Sort-Object { [Array]::IndexOf($preferredAddrs, $_.LocalAddress) } |
            Select-Object -First 1
        if (-not $selected -and -not $IPv4Only) {
            $selected = $pool | Where-Object { [int]$_.OwningProcess -eq $ExpectedPid } | Select-Object -First 1
        }
        if ($IPv4Only -and -not $selected) {
            return $null
        }
    }

    if (-not $selected) {
        $selected = $pool |
            Where-Object { $_.LocalAddress -in $preferredAddrs } |
            Sort-Object { [Array]::IndexOf($preferredAddrs, $_.LocalAddress) } |
            Select-Object -First 1
    }

    if (-not $selected -and -not $IPv4Only) {
        $selected = $pool | Select-Object -First 1
    }

    if (-not $selected) { return $null }

    $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $($selected.OwningProcess)" -ErrorAction SilentlyContinue
    return [pscustomobject]@{
        Port           = $Port
        LocalAddress   = $selected.LocalAddress
        Pid            = [int]$selected.OwningProcess
        Name           = if ($proc) { $proc.Name } else { "" }
        ExecutablePath = if ($proc) { $proc.ExecutablePath } else { "" }
        TotalListeners = $conns.Count
    }
}

function Test-SessionEndpoint {
    param([int]$Port)
    try {
        $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/auth/session" -Method Get -TimeoutSec 3 -UseBasicParsing -ErrorAction Stop
        $statusCode = [int]$resp.StatusCode
        $body = $resp.Content
        $validJson = $false
        if ($statusCode -eq 200 -and $body) {
            try {
                $parsed = $body | ConvertFrom-Json
                if ($null -ne $parsed -and ($parsed.PSObject.Properties.Name -contains "authenticated")) {
                    $validJson = ($parsed.authenticated -is [bool])
                }
            } catch {}
        }
        return @{ Reachable = $true; StatusCode = $statusCode; Body = $body; ValidSessionJson = $validJson }
    } catch {
        if ($_.Exception.Response) {
            return @{ Reachable = $true; StatusCode = [int]$_.Exception.Response.StatusCode; Body = ""; ValidSessionJson = $false }
        }
        return @{ Reachable = $false; StatusCode = 0; Body = ""; ValidSessionJson = $false }
    }
}

function Get-AllAiStudioProcesses {
    @(Get-CimInstance Win32_Process -Filter "Name = 'aistudio2api.exe'" -ErrorAction SilentlyContinue |
        Select-Object ProcessId, ExecutablePath, CommandLine)
}

function Get-WorktreeManagedProcess {
    $expectedBin = Normalize-PathKey $BinFile
    $procs = Get-AllAiStudioProcesses
    foreach ($p in $procs) {
        if ((Normalize-PathKey $p.ExecutablePath) -eq $expectedBin) {
            return $p
        }
    }
    return $null
}

function Set-SavedProxyInEnv {
    param([string]$ProxyValue)
    if (-not (Test-Path -LiteralPath $EnvFile)) {
        return $false
    }
    $lines = Get-Content -LiteralPath $EnvFile -Encoding UTF8
    $updated = $false
    $next = foreach ($line in $lines) {
        if ($line -match '^\s*PROXY=') {
            $updated = $true
            "PROXY=$ProxyValue"
        } else {
            $line
        }
    }
    if (-not $updated) {
        $next += "PROXY=$ProxyValue"
    }
    Set-Content -LiteralPath $EnvFile -Value $next -Encoding UTF8
    return $true
}

switch ($Action) {
    "status" {
        $configuredPort = Get-ListenPort
        $worktreeProc = Get-WorktreeManagedProcess
        $allProcs = Get-AllAiStudioProcesses
        $expectedBin = Normalize-PathKey $BinFile

        if ($worktreeProc) {
            Write-Host "[worktree] Running: PID=$($worktreeProc.ProcessId) Port=$configuredPort Path=$($worktreeProc.ExecutablePath)"
        } else {
            Write-Host "[worktree] Stopped: no running process matching $BinFile (configured port=$configuredPort)."
        }

        $hostProcs = @($allProcs | Where-Object { (Normalize-PathKey $_.ExecutablePath) -ne $expectedBin })
        if ($hostProcs.Count -gt 0) {
            foreach ($hp in $hostProcs) {
                Write-Host "[host-external] Active aistudio2api.exe: PID=$($hp.ProcessId) Path=$($hp.ExecutablePath)"
            }
        } else {
            Write-Host "[host-external] None."
        }

        $listen2048 = Get-ListeningPortInfo -Port 2048
        if ($listen2048) {
            $ownerTag = if ((Normalize-PathKey $listen2048.ExecutablePath) -eq $expectedBin) { "worktree" } else { "host-external" }
            $sess2048 = Test-SessionEndpoint -Port 2048
            Write-Host "[port 2048] Listen ($($listen2048.LocalAddress)) by $ownerTag PID=$($listen2048.Pid) ($($listen2048.ExecutablePath)); /api/auth/session -> HTTP $($sess2048.StatusCode) $($sess2048.Body)"
        } else {
            Write-Host "[port 2048] Not listening."
        }

        if ($configuredPort -ne 2048) {
            $wtPid = if ($worktreeProc) { [int]$worktreeProc.ProcessId } else { 0 }
            $listenCfg = Get-ListeningPortInfo -Port $configuredPort -ExpectedPid $wtPid
            if ($listenCfg) {
                $sessCfg = Test-SessionEndpoint -Port $configuredPort
                Write-Host "[port $configuredPort] Listen ($($listenCfg.LocalAddress)) PID=$($listenCfg.Pid) ($($listenCfg.ExecutablePath)); /api/auth/session -> HTTP $($sessCfg.StatusCode)"
            } else {
                Write-Host "[port $configuredPort] Not listening."
            }
        }
    }

    "start" {
        $configuredPort = Get-ListenPort
        $expectedBin = Normalize-PathKey $BinFile
        $existingWorktree = Get-WorktreeManagedProcess

        if ($existingWorktree) {
            if ($PSBoundParameters.ContainsKey("Proxy")) {
                Write-Host "[error] Worktree AIStudio2API is already running (PID=$($existingWorktree.ProcessId)); -Proxy was NOT applied. Stop the service first before changing proxy."
                exit 1
            }
            $wtPid = [int]$existingWorktree.ProcessId
            $listenInfo = Get-ListeningPortInfo -Port $configuredPort -ExpectedPid $wtPid -IPv4Only
            $sess = Test-SessionEndpoint -Port $configuredPort
            if ($listenInfo -and $listenInfo.Pid -eq $wtPid -and (Normalize-PathKey $listenInfo.ExecutablePath) -eq $expectedBin -and $sess.ValidSessionJson) {
                Write-Host "[worktree] Already running and verified (PID=$wtPid, Port=$configuredPort, Address=$($listenInfo.LocalAddress), SessionHTTP=$($sess.StatusCode))."
                exit 0
            }
            Write-Host "[error] Worktree process PID=$wtPid exists, but port $configuredPort verification failed (ListenPid=$(if ($listenInfo) { $listenInfo.Pid } else { 'none' }), SessionValid=$($sess.ValidSessionJson))."
            exit 1
        }

        if (-not (Test-Path -LiteralPath $BinFile)) {
            Write-Host "[install] Binary missing, installing via scripts/studio.mjs..."
            $env:AI_STUDIO_DATA_DIR = $DataDir
            if ($Proxy) { $env:AI_STUDIO_PROXY = $Proxy }
            & node $StudioScript install --data-dir $DataDir
            if ($LASTEXITCODE -ne 0) {
                throw "studio.mjs install failed with exit code $LASTEXITCODE"
            }
            $configuredPort = Get-ListenPort
        }

        if ($PSBoundParameters.ContainsKey("Proxy")) {
            $saved = Set-SavedProxyInEnv -ProxyValue $Proxy
            if (-not $saved) {
                Write-Host "[error] Cannot apply -Proxy because $EnvFile does not exist."
                exit 1
            }
            Write-Host "[config] Updated saved PROXY in $EnvFile."
        }

        $hostProcs = @(Get-AllAiStudioProcesses | Where-Object { (Normalize-PathKey $_.ExecutablePath) -ne $expectedBin })
        if ($hostProcs.Count -gt 0) {
            Write-Host "[warn] Host external aistudio2api.exe already active (PID=$($hostProcs[0].ProcessId), Path=$($hostProcs[0].ExecutablePath))."
            Write-Host "[warn] Upstream Windows binary enforces a single-instance mutex; secondary instance may exit(0)."
        }

        if (-not (Test-Path -LiteralPath $AuthDir)) {
            New-Item -ItemType Directory -Path $AuthDir -Force | Out-Null
        }

        $savedProxy = @{}
        foreach ($k in @("HTTP_PROXY","HTTPS_PROXY","ALL_PROXY","NO_PROXY","http_proxy","https_proxy","all_proxy","no_proxy")) {
            $savedProxy[$k] = [Environment]::GetEnvironmentVariable($k, "Process")
            [Environment]::SetEnvironmentVariable($k, "", "Process")
        }

        try {
            $proc = Start-Process -FilePath $BinFile `
                -ArgumentList @("-open-ui=false", "-auth=$AuthDir") `
                -WorkingDirectory $DataDir `
                -WindowStyle Hidden `
                -PassThru

            Set-Content -LiteralPath $PidFile -Value "$($proc.Id)" -Encoding UTF8

            $deadline = (Get-Date).AddSeconds(15)
            $verified = $false
            $lastReason = "startup timeout"

            while ((Get-Date) -lt $deadline) {
                if ($proc.HasExited) {
                    Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
                    Write-Host "[error] Worktree aistudio2api.exe exited during startup with code $($proc.ExitCode) (see $LogFile)."
                    exit 1
                }

                $listenInfo = Get-ListeningPortInfo -Port $configuredPort -ExpectedPid $proc.Id -IPv4Only
                if (-not $listenInfo) {
                    $lastReason = "port $configuredPort IPv4 (127.0.0.1/0.0.0.0) not listening yet for PID=$($proc.Id)"
                } elseif ($listenInfo.Pid -ne $proc.Id -or (Normalize-PathKey $listenInfo.ExecutablePath) -ne $expectedBin) {
                    $lastReason = "port $configuredPort owned by PID=$($listenInfo.Pid) ($($listenInfo.ExecutablePath)), expected PID=$($proc.Id) ($BinFile)"
                } else {
                    $sess = Test-SessionEndpoint -Port $configuredPort
                    if ($sess.ValidSessionJson) {
                        $verified = $true
                        Write-Host "[ok] Started and verified worktree AIStudio2API (PID=$($proc.Id), Port=$configuredPort, Address=$($listenInfo.LocalAddress), SessionHTTP=$($sess.StatusCode))."
                        break
                    }
                    $lastReason = "/api/auth/session returned HTTP $($sess.StatusCode) (validJson=$($sess.ValidSessionJson))"
                }
                Start-Sleep -Milliseconds 500
            }

            if (-not $verified) {
                Write-Host "[error] Worktree AIStudio2API failed readiness check within 15s: $lastReason"
                exit 1
            }
        } finally {
            foreach ($k in $savedProxy.Keys) {
                [Environment]::SetEnvironmentVariable($k, $savedProxy[$k], "Process")
            }
        }
    }

    "stop" {
        $stopped = $false
        $expectedBin = Normalize-PathKey $BinFile
        $worktreeProc = Get-WorktreeManagedProcess

        if ($worktreeProc) {
            $targetPid = [int]$worktreeProc.ProcessId
            $recheck = Get-CimInstance Win32_Process -Filter "ProcessId = $targetPid" -ErrorAction SilentlyContinue
            if ($recheck -and (Normalize-PathKey $recheck.ExecutablePath) -eq $expectedBin) {
                Stop-Process -Id $targetPid -Force
                Write-Host "[stop] Stopped worktree AIStudio2API (PID=$targetPid, Path=$($recheck.ExecutablePath))."
                $stopped = $true
            }
        }

        if (Test-Path -LiteralPath $PidFile) {
            $pidText = (Get-Content -LiteralPath $PidFile -Raw -Encoding UTF8).Trim()
            if (-not $stopped -and $pidText -match '^\d+$') {
                $targetPid = [int]$pidText
                $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $targetPid" -ErrorAction SilentlyContinue
                if ($cim -and (Normalize-PathKey $cim.ExecutablePath) -eq $expectedBin) {
                    Stop-Process -Id $targetPid -Force
                    Write-Host "[stop] Stopped worktree AIStudio2API by pidfile (PID=$targetPid, Path=$($cim.ExecutablePath))."
                    $stopped = $true
                } elseif ($cim) {
                    Write-Host "[warn] Refusing to stop PID=$targetPid because ExecutablePath ($($cim.ExecutablePath)) does not match worktree binary ($BinFile)."
                }
            }
            Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
        }

        if (-not $stopped) {
            Write-Host "[stop] No running worktree AIStudio2API found in $DataDir (external host instances left untouched)."
        }
    }
}
