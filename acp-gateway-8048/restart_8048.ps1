<#
.SYNOPSIS
  Safe one-click restart script for agy-gemini-8048 gateway and its supervisor.

.DESCRIPTION
  1. Gracefully drains in-flight requests via POST http://127.0.0.1:8048/api/drain if gateway(8048) is running.
  2. Stops supervisor_8048.ps1 processes so the watchdog does not race to relaunch.
  3. Stops the 8048 listener / agy-gemini-8048 bun.exe process and cleans up its agy.exe worker children.
  4. Waits up to 10s for TCP port 8048 to be released.
  5. Launches the detached silent supervisor via launch_8048.ps1.
  6. Polls http://127.0.0.1:8048/api/status for up to 15s and reports health summary.

  Use -DryRun to inspect target processes without stopping or restarting anything.
#>
[CmdletBinding()]
param(
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $OutputEncoding = [System.Text.Encoding]::UTF8
} catch {}

$Port = 8048
$RootDir = $PSScriptRoot
$LaunchScript = Join-Path $RootDir 'launch_8048.ps1'
$SupLogPath = Join-Path $RootDir 'data\8048.supervisor.log'
$StatusUrl = "http://127.0.0.1:$Port/api/status"
$DrainUrl = "http://127.0.0.1:$Port/api/drain"

function Write-Info([string]$Message) {
  $ts = Get-Date -Format 'HH:mm:ss'
  Write-Host ("[{0}] [8048-restart] {1}" -f $ts, $Message)
}

function Write-WarnLine([string]$Message) {
  $ts = Get-Date -Format 'HH:mm:ss'
  Write-Host ("[{0}] [8048-restart] [WARN] {1}" -f $ts, $Message) -ForegroundColor Yellow
}

function Write-ErrLine([string]$Message) {
  $ts = Get-Date -Format 'HH:mm:ss'
  Write-Host ("[{0}] [8048-restart] [ERROR] {1}" -f $ts, $Message) -ForegroundColor Red
}

function Write-OkLine([string]$Message) {
  $ts = Get-Date -Format 'HH:mm:ss'
  Write-Host ("[{0}] [8048-restart] [OK] {1}" -f $ts, $Message) -ForegroundColor Green
}

function Get-PortListeners([int]$TargetPort) {
  try {
    $conns = Get-NetTCPConnection -LocalPort $TargetPort -State Listen -ErrorAction Stop
    return @($conns | Where-Object { $null -ne $_ })
  } catch {
    if ($_.CategoryInfo.Category -eq 'ObjectNotFound' -or
        $_.FullyQualifiedErrorId -like 'CmdletizationQuery_NotFound*') {
      return @()
    }
    throw
  }
}

function Get-TargetProcesses {
  $allProcs = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
  $procMap = @{}
  foreach ($p in $allProcs) {
    $procMap[[int]$p.ProcessId] = $p
  }

  # 1. Supervisor processes running supervisor_8048.ps1 (exclude self)
  $supervisors = @(
    $allProcs | Where-Object {
      [int]$_.ProcessId -ne $PID -and
      ($_.Name -ieq 'powershell.exe' -or $_.Name -ieq 'pwsh.exe') -and
      $_.CommandLine -and
      $_.CommandLine -like '*supervisor_8048.ps1*'
    }
  )
  $supPids = @($supervisors | ForEach-Object { [int]$_.ProcessId })

  # 2. Gateway processes: listening on port 8048, or bun.exe spawned by supervisor / agy-gemini-8048
  $listenerPids = @(
    Get-PortListeners -TargetPort $Port |
      Select-Object -ExpandProperty OwningProcess -Unique |
      ForEach-Object { [int]$_ }
  )

  $gatewayPidSet = New-Object 'System.Collections.Generic.HashSet[int]'
  foreach ($lpid in $listenerPids) {
    if ($lpid -gt 0 -and $lpid -ne $PID) {
      [void]$gatewayPidSet.Add($lpid)
    }
  }
  foreach ($p in $allProcs) {
    $pidInt = [int]$p.ProcessId
    if ($pidInt -eq $PID) { continue }
    if ($p.Name -ieq 'bun.exe') {
      $isSupChild = $supPids -contains [int]$p.ParentProcessId
      $isProjectBun = $p.CommandLine -and ($p.CommandLine -like '*agy-gemini-8048*')
      if ($isSupChild -or $isProjectBun) {
        [void]$gatewayPidSet.Add($pidInt)
      }
    }
  }

  $gateways = @()
  foreach ($gpid in $gatewayPidSet) {
    if ($procMap.ContainsKey($gpid)) {
      $gateways += $procMap[$gpid]
    }
  }

  # 3. Worker children: agy.exe acp --worker belonging to agy-gemini-8048 or parented by gateway bun.exe
  $workers = @(
    $allProcs | Where-Object {
      [int]$_.ProcessId -ne $PID -and
      $_.Name -ieq 'agy.exe' -and (
        $gatewayPidSet.Contains([int]$_.ParentProcessId) -or (
          $_.CommandLine -and
          $_.CommandLine -like '*agy-gemini-8048*' -and
          $_.CommandLine -like '*--worker*'
        )
      )
    }
  )

  return [pscustomobject]@{
    Supervisors = $supervisors
    Gateways    = $gateways
    Workers     = $workers
  }
}

function Stop-ProcessList([object[]]$Processes, [string]$Label) {
  if (-not $Processes -or $Processes.Count -eq 0) {
    Write-Info ("未发现运行中的 {0} 进程。" -f $Label)
    return
  }

  foreach ($p in $Processes) {
    $pidVal = [int]$p.ProcessId
    $cmdVal = if ($p.CommandLine) { $p.CommandLine } else { '(无命令行)' }
    if ($DryRun) {
      Write-Info ("[DryRun] 将停止 {0}: PID={1} Name={2} Cmd={3}" -f $Label, $pidVal, $p.Name, $cmdVal)
    } else {
      Write-Info ("正在停止 {0}: PID={1} Name={2}" -f $Label, $pidVal, $p.Name)
      try {
        Stop-Process -Id $pidVal -Force -ErrorAction Stop
      } catch {
        if ($_.CategoryInfo.Category -ne 'ObjectNotFound') {
          Write-WarnLine ("停止 PID={0} 时出现提示: {1}" -f $pidVal, $_.Exception.Message)
        }
      }
    }
  }
}

function Invoke-GatewayDrain([string]$Url, [int]$TimeoutSeconds = 3) {
  Write-Info ("正在优雅排空在途请求: POST {0} (超时 {1}s)..." -f $Url, $TimeoutSeconds)
  $body = '{"reason":"Gateway restarting via restart_8048.ps1"}'
  try {
    $resp = Invoke-RestMethod -Uri $Url -Method Post -ContentType 'application/json' -Body $body -TimeoutSec $TimeoutSeconds -ErrorAction Stop
    $drainedCalls = if ($null -ne $resp.PSObject.Properties['drainedCalls']) { $resp.drainedCalls }
                    elseif ($null -ne $resp.PSObject.Properties['drainedToolCalls']) { $resp.drainedToolCalls }
                    elseif ($null -ne $resp.PSObject.Properties['pendingCalls']) { $resp.pendingCalls }
                    elseif ($null -ne $resp.PSObject.Properties['drained']) { $resp.drained }
                    else { $null }
    $inFlight = if ($null -ne $resp.PSObject.Properties['inFlight']) { $resp.inFlight }
                elseif ($null -ne $resp.PSObject.Properties['inFlightRequests']) { $resp.inFlightRequests }
                elseif ($null -ne $resp.PSObject.Properties['activeRequests']) { $resp.activeRequests }
                else { $null }
    if ($null -ne $drainedCalls -or $null -ne $inFlight) {
      $callsText = if ($null -ne $drainedCalls) { $drainedCalls } else { 'n/a' }
      $flightText = if ($null -ne $inFlight) { $inFlight } else { 'n/a' }
      Write-OkLine ("网关优雅排空完成: 已排空挂起调用={0}, 在途请求={1}，等待 800ms 让响应 flush..." -f $callsText, $flightText)
    } else {
      $jsonSummary = try { ($resp | ConvertTo-Json -Compress -Depth 4) } catch { [string]$resp }
      Write-OkLine ("网关优雅排空完成: {0}，等待 800ms 让响应 flush..." -f $jsonSummary)
    }
    Start-Sleep -Milliseconds 800
  } catch {
    Write-WarnLine ("优雅排空请求未完成 (可能为旧版本无 /api/drain 或网关已无响应)，将继续执行停进程: {0}" -f $_.Exception.Message)
  }
}

function Wait-PortReleased([int]$TargetPort, [int]$TimeoutSeconds) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $listeners = @(Get-PortListeners -TargetPort $TargetPort)
    if ($listeners.Count -eq 0) {
      return $true
    }
    Start-Sleep -Milliseconds 400
  }
  return (@(Get-PortListeners -TargetPort $TargetPort).Count -eq 0)
}

function Wait-GatewayHealthy([string]$Url, [int]$TimeoutSeconds) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $lastError = $null
  while ((Get-Date) -lt $deadline) {
    try {
      $resp = Invoke-RestMethod -Uri $Url -Method Get -TimeoutSec 3 -ErrorAction Stop
      if ($null -ne $resp -and $resp.ok -eq $true) {
        return [pscustomobject]@{
          Ok     = $true
          Status = $resp
          Error  = $null
        }
      }
      $lastError = '接口返回 ok != true'
    } catch {
      $lastError = $_.Exception.Message
    }
    Start-Sleep -Milliseconds 600
  }
  return [pscustomobject]@{
    Ok     = $false
    Status = $null
    Error  = $lastError
  }
}

Write-Host '==================================================' -ForegroundColor Cyan
if ($DryRun) {
  Write-Host '  AGY Gemini 8048 网关重启预演 (DryRun 模式)' -ForegroundColor Yellow
} else {
  Write-Host '  AGY Gemini 8048 网关一键重启' -ForegroundColor Cyan
}
Write-Host '==================================================' -ForegroundColor Cyan
Write-Info ("网关目录: {0}" -f $RootDir)

if (-not (Test-Path -LiteralPath $LaunchScript)) {
  Write-ErrLine ("未找到启动脚本: {0}" -f $LaunchScript)
  exit 1
}

# Step 1: Discover running processes
$targets = Get-TargetProcesses
Write-Info ("检测到进程: supervisor={0} 个, gateway(8048)={1} 个, agy-worker={2} 个" -f $targets.Supervisors.Count, $targets.Gateways.Count, $targets.Workers.Count)

if ($DryRun) {
  Write-Info ("[DryRun] 实际重启时将先调用 POST {0} 排空在途请求并等待约 1s，再停止进程。" -f $DrainUrl)
  Stop-ProcessList -Processes $targets.Supervisors -Label 'supervisor'
  Stop-ProcessList -Processes $targets.Gateways -Label 'gateway(8048)'
  if ($targets.Workers.Count -gt 0) {
    Write-Info ("[DryRun] 检测到 {0} 个关联 agy.exe worker 子进程，实际重启时将一并清理 (PIDs: {1})" -f $targets.Workers.Count, (($targets.Workers | ForEach-Object { $_.ProcessId }) -join ', '))
  } else {
    Write-Info '[DryRun] 未发现关联 agy.exe worker 子进程。'
  }
  Write-Info ("[DryRun] 后续步骤将等待端口 {0} 释放 (最多 10s) -> 调用 {1} -> 轮询 {2} (最多 15s)。" -f $Port, $LaunchScript, $StatusUrl)
  Write-OkLine 'DryRun 预演完成：未停止任何进程，未修改任何状态。'
  exit 0
}

# Step 2: Gracefully drain in-flight requests if gateway(8048) is running
if ($targets.Gateways.Count -gt 0) {
  Invoke-GatewayDrain -Url $DrainUrl -TimeoutSeconds 3
} else {
  Write-Info '未发现运行中的 gateway(8048) 进程，跳过优雅排空。'
}

# Step 3: Stop supervisor first, then gateway, then leftover workers
Stop-ProcessList -Processes $targets.Supervisors -Label 'supervisor'
Stop-ProcessList -Processes $targets.Gateways -Label 'gateway(8048)'
Start-Sleep -Milliseconds 500

# Refresh worker list after stopping bun.exe so we only touch still-alive orphan workers
$remainingTargets = Get-TargetProcesses
if ($remainingTargets.Workers.Count -gt 0) {
  Stop-ProcessList -Processes $remainingTargets.Workers -Label 'agy-worker'
}

# Step 4: Wait for port 8048 release (max 10s)
Write-Info ("等待端口 {0} 释放 (最多 10 秒)..." -f $Port)
if (-not (Wait-PortReleased -TargetPort $Port -TimeoutSeconds 10)) {
  $stuck = @(Get-PortListeners -TargetPort $Port)
  $stuckPids = ($stuck | Select-Object -ExpandProperty OwningProcess -Unique) -join ', '
  Write-ErrLine ("端口 {0} 在 10 秒内未释放，仍被 PID={1} 占用。请手动检查后重试。" -f $Port, $stuckPids)
  exit 1
}
Write-OkLine ("端口 {0} 已释放。" -f $Port)

# Step 5: Relaunch silently via launch_8048.ps1
Write-Info ("调用静默启动脚本: {0}" -f $LaunchScript)
& $LaunchScript
if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) {
  Write-ErrLine ("launch_8048.ps1 返回非零退出码: {0}，请查看日志: {1}" -f $LASTEXITCODE, $SupLogPath)
  exit $LASTEXITCODE
}

# Step 6: Poll /api/status for health verification (max 15s)
Write-Info ("等待网关就绪: {0} (最多 15 秒)..." -f $StatusUrl)
$health = Wait-GatewayHealthy -Url $StatusUrl -TimeoutSeconds 15

if ($health.Ok) {
  $newTargets = Get-TargetProcesses
  $newGwPids = if ($newTargets.Gateways.Count -gt 0) { ($newTargets.Gateways | ForEach-Object { $_.ProcessId }) -join ', ' } else { 'unknown' }
  $newSupPids = if ($newTargets.Supervisors.Count -gt 0) { ($newTargets.Supervisors | ForEach-Object { $_.ProcessId }) -join ', ' } else { 'unknown' }
  $s = $health.Status
  Write-Host '--------------------------------------------------' -ForegroundColor Green
  Write-OkLine '8048 网关重启成功！'
  Write-Host ("  新网关 PID     : {0}" -f $newGwPids)
  Write-Host ("  新守护进程 PID : {0}" -f $newSupPids)
  Write-Host ("  就绪账号数     : {0} / {1}" -f $s.accountsReady, $s.accountsTotal)
  Write-Host ("  运行时长       : {0} ms" -f $s.uptimeMs)
  Write-Host '--------------------------------------------------' -ForegroundColor Green
  exit 0
} else {
  Write-ErrLine ("健康检查超时 (15 秒内未收到 ok: true)。最后错误: {0}" -f $health.Error)
  Write-ErrLine ("请查看守护日志排查原因: {0}" -f $SupLogPath)
  exit 1
}
