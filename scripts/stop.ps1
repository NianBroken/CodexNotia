Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'common.ps1')

Set-CodexNotiaConsoleEncoding

<#
等待目标进程真正退出。
只有确认相关进程已经消失后，停止流程才算完成。
#>
function Wait-CodexNotiaProcessExit {
  param(
    [int[]]$ProcessIds,
    [int]$TimeoutSeconds = 10
  )

  $pendingProcessIds = @($ProcessIds | Where-Object { $_ -gt 0 } | Select-Object -Unique)

  if ($pendingProcessIds.Count -eq 0) {
    return @()
  }

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)

  while ((Get-Date) -lt $deadline) {
    $pendingProcessIds = @($pendingProcessIds | Where-Object {
      Test-CodexNotiaLiveProcess -ProcessIdValue $_
    })

    if ($pendingProcessIds.Count -eq 0) {
      return @()
    }

    Start-Sleep -Milliseconds 300
  }

  return @($pendingProcessIds | Where-Object {
    Test-CodexNotiaLiveProcess -ProcessIdValue $_
  })
}

<#
停止主流程。
结束服务进程、包装进程并清理对应锁文件，任务本身不会被卸载。
锁文件损坏时会自动忽略坏内容并继续清理，避免控制脚本本身被单个坏文件阻断。
#>
$context = Get-CodexNotiaServiceContext -ScriptRoot $PSScriptRoot
$serviceLock = Read-CodexNotiaLockFile -Path $context.ServiceLockPath
$wrapperLock = Read-CodexNotiaLockFile -Path $context.WrapperLockPath
$managedProcessIds = Get-CodexNotiaManagedProcessIds -ProjectRoot $context.ProjectRoot
$lockedProcessIds = @(
  if ($serviceLock) { $serviceLock.pid }
  if ($wrapperLock) { $wrapperLock.pid }
)
$processIdsToStop = @($lockedProcessIds + $managedProcessIds)
$processIdsToStop = @($processIdsToStop | Where-Object { $_ -gt 0 } | Select-Object -Unique)

foreach ($processIdValue in $processIdsToStop) {
  if (Test-CodexNotiaLiveProcess -ProcessIdValue $processIdValue) {
    Stop-Process -Id $processIdValue -Force -ErrorAction SilentlyContinue
  }
}

if (Get-ScheduledTask -TaskName $context.TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $context.TaskName -ErrorAction SilentlyContinue
}

$remainingProcessIds = Wait-CodexNotiaProcessExit -ProcessIds $processIdsToStop

if (@($remainingProcessIds).Count -gt 0) {
  throw (Get-CodexNotiaText 'stop.failedStillRunning' @([string]::Join(', ', $remainingProcessIds)))
}

if (Test-Path -LiteralPath $context.ServiceLockPath) {
  Remove-Item -LiteralPath $context.ServiceLockPath -Force -ErrorAction SilentlyContinue
}

if (Test-Path -LiteralPath $context.WrapperLockPath) {
  Remove-Item -LiteralPath $context.WrapperLockPath -Force -ErrorAction SilentlyContinue
}

Write-Output (Get-CodexNotiaText 'stop.completed' @($context.TaskName))
