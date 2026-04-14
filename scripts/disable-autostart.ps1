Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'common.ps1')

Set-CodexNotiaConsoleEncoding

<#
只禁用后续开机自启。
不会停止当前服务，也不会删除任务或清理其他资源。
#>
try {
  $context = Get-CodexNotiaServiceContext -ScriptRoot $PSScriptRoot
  $task = Get-ScheduledTask -TaskName $context.TaskName -ErrorAction SilentlyContinue

  if (-not $task) {
    Write-Output (Get-CodexNotiaText 'disableAutostart.taskMissing' @($context.TaskName))
    exit 0
  }

  if (-not [bool]$task.Settings.Enabled) {
    Write-Output (Get-CodexNotiaText 'disableAutostart.alreadyDisabled' @($context.TaskName))
    exit 0
  }

  Disable-ScheduledTask -TaskName $context.TaskName -ErrorAction Stop | Out-Null
  $updatedTask = Get-ScheduledTask -TaskName $context.TaskName -ErrorAction SilentlyContinue

  if (-not $updatedTask) {
    Write-Output (Get-CodexNotiaText 'disableAutostart.taskGone' @($context.TaskName))
    exit 0
  }

  if (-not [bool]$updatedTask.Settings.Enabled) {
    Write-Output (Get-CodexNotiaText 'disableAutostart.completed' @($context.TaskName))
    exit 0
  }

  Write-Output (Get-CodexNotiaText 'disableAutostart.failedStillEnabled' @($context.TaskName))
  exit 1
} catch {
  Write-Output (Get-CodexNotiaText 'disableAutostart.failed' @($_.Exception.Message))
  exit 1
}
