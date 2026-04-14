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
    Write-Output "任务计划不存在，无需禁用开机自启: $($context.TaskName)"
    exit 0
  }

  if (-not [bool]$task.Settings.Enabled) {
    Write-Output "任务计划已经处于禁用状态: $($context.TaskName)"
    exit 0
  }

  Disable-ScheduledTask -TaskName $context.TaskName -ErrorAction Stop | Out-Null
  $updatedTask = Get-ScheduledTask -TaskName $context.TaskName -ErrorAction SilentlyContinue

  if (-not $updatedTask) {
    Write-Output "任务计划已不存在，后续开机自启已失效: $($context.TaskName)"
    exit 0
  }

  if (-not [bool]$updatedTask.Settings.Enabled) {
    Write-Output "已禁用后续开机自启: $($context.TaskName)"
    exit 0
  }

  Write-Output "禁用开机自启失败，任务仍处于启用状态: $($context.TaskName)"
  exit 1
} catch {
  Write-Output ('禁用开机自启失败: {0}' -f $_.Exception.Message)
  exit 1
}
