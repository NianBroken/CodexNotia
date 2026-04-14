Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'common.ps1')

Set-CodexNotiaConsoleEncoding

<#
只删除计划任务本身。
不会停止服务、不会清理状态和日志，也不会修改其他配置。
#>
try {
  $context = Get-CodexNotiaServiceContext -ScriptRoot $PSScriptRoot
  $task = Get-ScheduledTask -TaskName $context.TaskName -ErrorAction SilentlyContinue

  if (-not $task) {
    Write-Output (Get-CodexNotiaText 'removeTask.taskMissing' @($context.TaskName))
    exit 0
  }

  Unregister-ScheduledTask -TaskName $context.TaskName -Confirm:$false -ErrorAction Stop
  $updatedTask = Get-ScheduledTask -TaskName $context.TaskName -ErrorAction SilentlyContinue

  if (-not $updatedTask) {
    Write-Output (Get-CodexNotiaText 'removeTask.completed' @($context.TaskName))
    exit 0
  }

  Write-Output (Get-CodexNotiaText 'removeTask.failedStillExists' @($context.TaskName))
  exit 1
} catch {
  Write-Output (Get-CodexNotiaText 'removeTask.failed' @($_.Exception.Message))
  exit 1
}
