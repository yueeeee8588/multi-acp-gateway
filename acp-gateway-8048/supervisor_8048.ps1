# agy-gemini-8048 supervisor / watchdog  (hardened)
#
# Keeps the gateway alive on port 8048 and makes crashes self-healing:
#   * single instance  -> a named kernel mutex, so two watchdogs can never
#                         fight each other (the old race caused two buns to
#                         race for the port and flap).
#   * fast recovery    -> restarts within a few seconds of the process exiting.
#   * liveness, not just existence -> probes GET /api/status; if the process is
#                         alive but wedged (port dead / hung), it is killed and
#                         relaunched, so the web console never sits on a dead
#                         backend ("Failed to fetch" / SSE "重连中").
#   * no port fight    -> waits with backoff if 8048 is occupied by another
#                         process; never kills non-child processes.
#
# Why the process can die at all: Bun 1.3.14 on Windows x64 has a runtime bug
# that panics ("Internal assertion failure / Bun has crashed") after minutes of
# uptime. That crash is inside the Bun runtime, not this app, so the only
# durable mitigation is an external watchdog that relaunches promptly.
#
# Launch it detached via launch_8048.ps1 so it outlives the parent shell.

$ErrorActionPreference = 'Continue'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $root

$logDir = Join-Path $root 'data'
if (-not (Test-Path -LiteralPath $logDir)) {
  New-Item -ItemType Directory -Path $logDir | Out-Null
}
$outLog = Join-Path $logDir '8048.out.log'
$errLog = Join-Path $logDir '8048.err.log'
$supLog = Join-Path $logDir '8048.supervisor.log'

function Write-SupLog([string]$msg) {
  $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  for ($i = 0; $i -lt 3; $i++) {
    try {
      Add-Content -LiteralPath $supLog -Value $line -Encoding UTF8 -ErrorAction Stop
      return
    } catch {
      Start-Sleep -Milliseconds 20
    }
  }
}

function Test-OrphanDirectChildAttribution($proc, [string]$instanceRootHint) {
  if ($null -eq $proc) { return $false }
  $cmdLine = [string]$proc.CommandLine
  if ([string]::IsNullOrWhiteSpace($cmdLine)) { return $false }

  if (-not [string]::IsNullOrWhiteSpace($instanceRootHint)) {
    if ($cmdLine.IndexOf($instanceRootHint, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
      return $true
    }
  }

  $name = ([string]$proc.Name).ToLowerInvariant()
  if ($name -eq 'agy.exe' -or $name -like 'agy*.exe') {
    $hasAcp = $cmdLine -match '(?i)(?:^|\s)acp(?:\s|$)'
    $hasWorker = $cmdLine -match '(?i)(?:^|\s)--worker(?:\s|$)'
    $hasGeminiDir = $cmdLine -match '(?i)(?:^|\s)--gemini-dir(?:\s|$)'
    if ($hasAcp -and $hasWorker -and $hasGeminiDir) {
      return $true
    }
  }

  return $false
}

function Get-OwnedDescendantSnapshot(
  [int]$rootPid,
  [Nullable[datetime]]$rootCimCreation,
  [Nullable[datetime]]$rootProcStartTime,
  [string]$expectedRootExePath,
  [string]$expectedRootCmdToken,
  [Nullable[datetime]]$knownRootExitTime,
  [datetime]$snapshotCutoff,
  [string]$instanceRootHint
) {
  $result = @{}
  if ($rootPid -le 0) { return $result }
  if ($null -eq $rootCimCreation -and $null -eq $rootProcStartTime) { return $result }

  $allProcs = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
  if ($allProcs.Count -eq 0) { return $result }

  $byPid = @{}
  $childrenByParent = @{}
  foreach ($p in $allProcs) {
    $pidInt = [int]$p.ProcessId
    $ppidInt = [int]$p.ParentProcessId
    $byPid[$pidInt] = $p
    if (-not $childrenByParent.ContainsKey($ppidInt)) {
      $childrenByParent[$ppidInt] = New-Object 'System.Collections.Generic.List[object]'
    }
    $childrenByParent[$ppidInt].Add($p)
  }

  $rootStartUtc = if ($null -ne $rootCimCreation) {
    ([datetime]$rootCimCreation).ToUniversalTime()
  } else {
    ([datetime]$rootProcStartTime).ToUniversalTime()
  }
  $rootStartToleranceSec = if ($null -ne $rootCimCreation) { 0.005 } else { 0.05 }
  $cutoffUtc = $snapshotCutoff.ToUniversalTime()
  $knownExitUtc = if ($null -ne $knownRootExitTime) {
    ([datetime]$knownRootExitTime).ToUniversalTime()
  } else {
    $null
  }

  $rootAliveAndOwned = $false
  if ($byPid.ContainsKey($rootPid)) {
    $rootProc = $byPid[$rootPid]
    if ($null -eq $rootProc.CreationDate) { return $result }
    $liveRootUtc = ([datetime]$rootProc.CreationDate).ToUniversalTime()
    $diffSec = [Math]::Abs(($liveRootUtc - $rootStartUtc).TotalSeconds)
    if ($diffSec -gt $rootStartToleranceSec) {
      # Root PID was reused by a different process; fail closed.
      return $result
    }
    if (-not [string]::IsNullOrWhiteSpace($expectedRootExePath) -and -not [string]::IsNullOrWhiteSpace([string]$rootProc.ExecutablePath)) {
      if (-not ([string]$rootProc.ExecutablePath).Equals($expectedRootExePath, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $result
      }
    }
    if (-not [string]::IsNullOrWhiteSpace($expectedRootCmdToken) -and -not [string]::IsNullOrWhiteSpace([string]$rootProc.CommandLine)) {
      if (([string]$rootProc.CommandLine).IndexOf($expectedRootCmdToken, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
        return $result
      }
    }
    $rootAliveAndOwned = $true
    $rootStartUtc = $liveRootUtc
  }

  $queue = New-Object 'System.Collections.Generic.Queue[object]'
  $visited = New-Object 'System.Collections.Generic.HashSet[int]'
  [void]$visited.Add($rootPid)
  [void]$visited.Add($PID)

  $queue.Enqueue([pscustomobject]@{
    Pid             = $rootPid
    CreationDateUtc = $rootStartUtc
    ParentAlive     = $rootAliveAndOwned
    IsRoot          = $true
  })

  while ($queue.Count -gt 0) {
    $parent = $queue.Dequeue()
    $pPid = [int]$parent.Pid
    if (-not $childrenByParent.ContainsKey($pPid)) { continue }

    foreach ($childProc in $childrenByParent[$pPid]) {
      $cPid = [int]$childProc.ProcessId
      if ($cPid -le 0 -or $visited.Contains($cPid)) { continue }
      if ($null -eq $childProc.CreationDate) { continue }

      $cTimeUtc = ([datetime]$childProc.CreationDate).ToUniversalTime()
      $parentTolSec = if ($parent.IsRoot -and $null -eq $rootCimCreation) { 0.05 } else { 0.0 }
      if (($cTimeUtc - $parent.CreationDateUtc).TotalSeconds -lt (-1.0 * $parentTolSec)) { continue }
      if (($cTimeUtc - $rootStartUtc).TotalSeconds -lt (-1.0 * $rootStartToleranceSec)) { continue }
      if ($cTimeUtc -gt $cutoffUtc) { continue }

      if ($parent.IsRoot -and -not $parent.ParentAlive) {
        if ($null -ne $knownExitUtc -and $cTimeUtc -gt $knownExitUtc) {
          continue
        }
        if (-not (Test-OrphanDirectChildAttribution $childProc $instanceRootHint)) {
          continue
        }
      } elseif (-not $parent.ParentAlive) {
        continue
      }

      [void]$visited.Add($cPid)
      $result[$cPid] = [pscustomobject]@{
        ProcessId       = $cPid
        Name            = [string]$childProc.Name
        ExecutablePath  = [string]$childProc.ExecutablePath
        CreationDateUtc = $cTimeUtc
      }
      $queue.Enqueue([pscustomobject]@{
        Pid             = $cPid
        CreationDateUtc = $cTimeUtc
        ParentAlive     = $true
        IsRoot          = $false
      })
    }
  }

  return $result
}

function Stop-OwnedDescendants([hashtable]$candidates) {
  if ($null -eq $candidates -or $candidates.Count -eq 0) { return 0 }
  $ordered = @($candidates.Values | Sort-Object -Property CreationDateUtc -Descending)
  $stopped = 0
  foreach ($item in $ordered) {
    $targetPid = [int]$item.ProcessId
    if ($targetPid -le 0 -or $targetPid -eq $PID) { continue }
    $live = $null
    try {
      $live = Get-Process -Id $targetPid -ErrorAction Stop
    } catch {
      continue
    }
    if ($null -eq $live -or $live.Id -ne $targetPid -or $live.HasExited) { continue }

    $expectedBaseName = ([System.IO.Path]::GetFileNameWithoutExtension([string]$item.Name)).ToLowerInvariant()
    $liveBaseName = ([string]$live.ProcessName).ToLowerInvariant()
    if ([string]::IsNullOrEmpty($expectedBaseName) -or $expectedBaseName -ne $liveBaseName) {
      continue
    }

    try {
      $liveStartUtc = $live.StartTime.ToUniversalTime()
      if ([Math]::Abs(($liveStartUtc - $item.CreationDateUtc).TotalSeconds) -gt 0.05) {
        continue
      }
    } catch {
      continue
    }

    if (-not [string]::IsNullOrWhiteSpace([string]$item.ExecutablePath)) {
      try {
        $livePath = $live.MainModule.FileName
        if (-not [string]::IsNullOrWhiteSpace($livePath) -and -not $livePath.Equals([string]$item.ExecutablePath, [System.StringComparison]::OrdinalIgnoreCase)) {
          continue
        }
      } catch {}
    }

    try {
      Stop-Process -InputObject $live -Force -ErrorAction Stop
      $stopped++
    } catch {}
  }
  return $stopped
}

# --- singleton: a named mutex is released automatically when this process dies ---
$createdNew = $false
$mutex = New-Object System.Threading.Mutex($true, 'agy-gemini-8048-supervisor', [ref]$createdNew)
if (-not $createdNew) {
  Write-Host '[supervisor] another supervisor already owns the lock; exiting.'
  exit 0
}

$port = 8048
$bun = if ($env:AGY_8048_BUN) { $env:AGY_8048_BUN } else { 'D:\Alma\alma-server\resources\bun\bun.exe' }
if (-not (Test-Path -LiteralPath $bun)) {
  Write-SupLog "FATAL: bun binary not found: $bun"
  exit 1
}

function Get-Port8048Listeners([int]$p) {
  try {
    $raw = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction Stop
    $items = @()
    if ($null -ne $raw) {
      foreach ($c in @($raw)) {
        if ($null -ne $c) {
          $items += [pscustomobject]@{
            OwningProcess = [int]$c.OwningProcess
            LocalAddress  = [string]$c.LocalAddress
          }
        }
      }
    }
    return [pscustomobject]@{
      Ok        = $true
      Listeners = $items
      Error     = $null
    }
  } catch {
    if ($_.CategoryInfo.Category -eq 'ObjectNotFound' -or
        $_.FullyQualifiedErrorId -like 'CmdletizationQuery_NotFound*') {
      return [pscustomobject]@{
        Ok        = $true
        Listeners = @()
        Error     = $null
      }
    }
    return [pscustomobject]@{
      Ok        = $false
      Listeners = @()
      Error     = $_.Exception.Message
    }
  }
}

function Get-ProbeUrls([object[]]$listeners, [int]$p) {
  $urls = New-Object System.Collections.Generic.List[string]
  foreach ($l in $listeners) {
    $addr = ([string]$l.LocalAddress).Trim()
    if ([string]::IsNullOrEmpty($addr) -or $addr -eq '0.0.0.0' -or $addr -eq '*') {
      $u = "http://127.0.0.1:{0}/api/status" -f $p
      if (-not $urls.Contains($u)) { $urls.Add($u) }
    } elseif ($addr -eq '::' -or $addr -eq '[::]') {
      $u6 = "http://[::1]:{0}/api/status" -f $p
      if (-not $urls.Contains($u6)) { $urls.Add($u6) }
      $u4 = "http://127.0.0.1:{0}/api/status" -f $p
      if (-not $urls.Contains($u4)) { $urls.Add($u4) }
    } elseif ($addr -like '::ffff:*') {
      $v4 = $addr.Substring(7)
      if ($v4 -eq '0.0.0.0') { $v4 = '127.0.0.1' }
      $u = "http://{0}:{1}/api/status" -f $v4, $p
      if (-not $urls.Contains($u)) { $urls.Add($u) }
    } elseif ($addr.Contains(':')) {
      $clean = $addr.Trim('[', ']')
      $pctIdx = $clean.IndexOf('%')
      if ($pctIdx -gt 0) { $clean = $clean.Substring(0, $pctIdx) }
      $u = "http://[{0}]:{1}/api/status" -f $clean, $p
      if (-not $urls.Contains($u)) { $urls.Add($u) }
    } else {
      $u = "http://{0}:{1}/api/status" -f $addr, $p
      if (-not $urls.Contains($u)) { $urls.Add($u) }
    }
  }
  if ($urls.Count -eq 0) {
    $urls.Add(("http://127.0.0.1:{0}/api/status" -f $p))
  }
  return $urls.ToArray()
}

function Test-ChildHealth([int]$p, [int]$childPid) {
  $res = Get-Port8048Listeners $p
  if (-not $res.Ok) {
    return [pscustomobject]@{
      Status = 'ProbeError'
      Detail = $res.Error
    }
  }

  $childListeners = @($res.Listeners | Where-Object { $_.OwningProcess -eq $childPid })
  if ($childListeners.Count -eq 0) {
    $otherListeners = @($res.Listeners | Where-Object { $_.OwningProcess -ne $childPid })
    if ($otherListeners.Count -gt 0) {
      $otherPid = $otherListeners[0].OwningProcess
      $otherName = 'unknown'
      try {
        $otherName = (Get-Process -Id $otherPid -ErrorAction Stop).ProcessName
      } catch {}
      return [pscustomobject]@{
        Status = 'OccupiedByOther'
        Detail = ("port {0} held by {1} pid={2}" -f $p, $otherName, $otherPid)
      }
    }
    return [pscustomobject]@{
      Status = 'Unhealthy'
      Detail = ("no listener on port {0} for child pid={1}" -f $p, $childPid)
    }
  }

  $urls = Get-ProbeUrls $childListeners $p
  foreach ($url in $urls) {
    $response = $null
    try {
      $request = [System.Net.WebRequest]::Create($url)
      $request.Proxy = $null
      $request.AllowAutoRedirect = $false
      $request.Timeout = 5000
      $response = $request.GetResponse()
      if ([int]$response.StatusCode -eq 200) {
        return [pscustomobject]@{
          Status = 'Healthy'
          Detail = $url
        }
      }
    } catch {
      if ($_.Exception -is [System.Net.WebException]) {
        $response = $_.Exception.Response
      }
    } finally {
      if ($response) { $response.Dispose() }
    }
  }

  return [pscustomobject]@{
    Status = 'Unhealthy'
    Detail = ("HTTP probe failed on {0}" -f ($urls -join ', '))
  }
}

Write-SupLog "supervisor boot pid=$PID root=$root bun=$bun"

$backoff = 3

while ($true) {
  $pre = Get-Port8048Listeners $port
  if (-not $pre.Ok) {
    Write-SupLog ("port {0} listener probe failed before launch: {1}; waiting {2}s" -f $port, $pre.Error, $backoff)
    Start-Sleep -Seconds $backoff
    $backoff = [Math]::Min($backoff * 2, 30)
    continue
  }
  if ($pre.Listeners.Count -gt 0) {
    $otherPid = $pre.Listeners[0].OwningProcess
    $otherName = 'unknown'
    try {
      $otherName = (Get-Process -Id $otherPid -ErrorAction Stop).ProcessName
    } catch {}
    Write-SupLog ("port {0} occupied by {1} pid={2}; waiting {3}s without terminating" -f $port, $otherName, $otherPid, $backoff)
    Start-Sleep -Seconds $backoff
    $backoff = [Math]::Min($backoff * 2, 30)
    continue
  }

  # Keep the most recent crash report before the new run truncates the log.
  if ((Test-Path -LiteralPath $errLog) -and ((Get-Item -LiteralPath $errLog).Length -gt 0)) {
    Copy-Item -LiteralPath $errLog -Destination ($errLog + '.prev') -Force -ErrorAction SilentlyContinue
  }

  $started = Get-Date
  Write-SupLog 'launching: bun run src/server.ts'
  # WindowStyle Hidden keeps bun from opening any console of its own: bun inherits this
  # supervisor's already-hidden console, so no Windows Terminal frame is ever created.
  $child = Start-Process -FilePath $bun -ArgumentList 'run', 'src/server.ts' `
    -WorkingDirectory $root `
    -RedirectStandardOutput $outLog -RedirectStandardError $errLog `
    -WindowStyle Hidden -PassThru

  $childStartTime = $null
  $childCimCreation = $null
  try {
    $childStartTime = $child.StartTime
  } catch {}
  if ($null -ne $childStartTime -and -not $child.HasExited) {
    try {
      $cimSelf = Get-CimInstance Win32_Process -Filter ("ProcessId={0}" -f $child.Id) -ErrorAction SilentlyContinue
      if ($cimSelf -and $null -ne $cimSelf.CreationDate) {
        $diff = [Math]::Abs(($cimSelf.CreationDate.ToUniversalTime() - $childStartTime.ToUniversalTime()).TotalSeconds)
        if ($diff -le 0.05) {
          $childCimCreation = [datetime]$cimSelf.CreationDate
        }
      }
    } catch {}
  }

  # Health-gated wait: leave only when the child is gone, or when it has stayed
  # unhealthy long enough to be considered wedged.
  $healthy = $false
  $unhealthyStreak = 0
  $probeWarned = $false
  $preKillDescendants = @{}
  $killedByWatchdog = $false
  while (-not $child.HasExited) {
    Start-Sleep -Seconds 3
    if ($child.HasExited) { break }
    if ($null -eq $childCimCreation -and $null -ne $childStartTime) {
      try {
        $cimSelf = Get-CimInstance Win32_Process -Filter ("ProcessId={0}" -f $child.Id) -ErrorAction SilentlyContinue
        if ($cimSelf -and $null -ne $cimSelf.CreationDate) {
          $diff = [Math]::Abs(($cimSelf.CreationDate.ToUniversalTime() - $childStartTime.ToUniversalTime()).TotalSeconds)
          if ($diff -le 0.05) {
            $childCimCreation = [datetime]$cimSelf.CreationDate
          }
        }
      } catch {}
    }
    $health = Test-ChildHealth $port $child.Id
    if ($health.Status -eq 'Healthy') {
      if (-not $healthy) { Write-SupLog ("health OK (server pid={0} url={1})" -f $child.Id, $health.Detail) }
      $healthy = $true
      $unhealthyStreak = 0
      $probeWarned = $false
    } elseif ($health.Status -eq 'ProbeError') {
      if (-not $probeWarned) {
        Write-SupLog ("health probe info error (skipping strike for pid={0}): {1}" -f $child.Id, $health.Detail)
        $probeWarned = $true
      }
    } else {
      $probeWarned = $false
      $unhealthyStreak++
      if ($unhealthyStreak -ge 5 -and -not $child.HasExited) {
        Write-SupLog ("health probe failed {0}x ({1}); stopping own child pid={2}" -f $unhealthyStreak, $health.Detail, $child.Id)
        $preKillDescendants = Get-OwnedDescendantSnapshot `
          -rootPid $child.Id `
          -rootCimCreation $childCimCreation `
          -rootProcStartTime $childStartTime `
          -expectedRootExePath $bun `
          -expectedRootCmdToken 'src/server.ts' `
          -knownRootExitTime $null `
          -snapshotCutoff (Get-Date) `
          -instanceRootHint $root
        $killedByWatchdog = $true
        Stop-Process -InputObject $child -Force -ErrorAction SilentlyContinue
        try { [void]$child.WaitForExit(3000) } catch {}
        break
      }
    }
  }

  $deadTime = Get-Date
  $knownExitTime = $deadTime
  try {
    if ($child.HasExited) {
      $knownExitTime = $child.ExitTime
    }
  } catch {}
  if ($killedByWatchdog) {
    Start-Sleep -Milliseconds 150
  }
  $postDescendants = Get-OwnedDescendantSnapshot `
    -rootPid $child.Id `
    -rootCimCreation $childCimCreation `
    -rootProcStartTime $childStartTime `
    -expectedRootExePath $bun `
    -expectedRootCmdToken 'src/server.ts' `
    -knownRootExitTime $knownExitTime `
    -snapshotCutoff (Get-Date) `
    -instanceRootHint $root
  $allDescendants = @{}
  foreach ($k in $preKillDescendants.Keys) { $allDescendants[$k] = $preKillDescendants[$k] }
  foreach ($k in $postDescendants.Keys) { $allDescendants[$k] = $postDescendants[$k] }
  $cleanedCount = Stop-OwnedDescendants $allDescendants
  if ($cleanedCount -gt 0) {
    Write-SupLog ("cleaned {0} owned descendant process(es) of child pid={1}" -f $cleanedCount, $child.Id)
  }

  $ranSec = [int]((Get-Date) - $started).TotalSeconds
  $ec = 'killed/unknown'
  try { if ($child.HasExited) { $ec = $child.ExitCode } } catch {}
  Write-SupLog ("bun exited code={0} after {1}s" -f $ec, $ranSec)

  if ($ranSec -lt 10) { $backoff = [Math]::Min($backoff * 2, 30) } else { $backoff = 3 }
  Write-SupLog ("restart in {0}s" -f $backoff)
  Start-Sleep -Seconds $backoff
}
