Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'common.ps1')

Set-CodexNotiaConsoleEncoding

<#
只重新启用后续开机自启。
不会创建新任务，也不会启动或停止当前服务。
任务名统一来自 Node 侧最终配置，避免用户把任务名改到配置里后脚本还读旧值。
#>
try {
  $context = Get-CodexNotiaServiceContext -ScriptRoot $PSScriptRoot
  $task = Get-ScheduledTask -TaskName $context.TaskName -ErrorAction SilentlyContinue

  if (-not $task) {
    Write-Output (Get-CodexNotiaText 'enableAutostart.taskMissing' @($context.TaskName))
    exit 1
  }

  if ([bool]$task.Settings.Enabled) {
    Write-Output (Get-CodexNotiaText 'enableAutostart.alreadyEnabled' @($context.TaskName))
    exit 0
  }

  Enable-ScheduledTask -TaskName $context.TaskName -ErrorAction Stop | Out-Null
  $updatedTask = Get-ScheduledTask -TaskName $context.TaskName -ErrorAction SilentlyContinue

  if (-not $updatedTask) {
    Write-Output (Get-CodexNotiaText 'enableAutostart.taskGone' @($context.TaskName))
    exit 1
  }

  if ([bool]$updatedTask.Settings.Enabled) {
    Write-Output (Get-CodexNotiaText 'enableAutostart.completed' @($context.TaskName))
    exit 0
  }

  Write-Output (Get-CodexNotiaText 'enableAutostart.failedStillDisabled' @($context.TaskName))
  exit 1
} catch {
  Write-Output (Get-CodexNotiaText 'enableAutostart.failed' @($_.Exception.Message))
  exit 1
}
