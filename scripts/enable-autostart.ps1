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
    Write-Output "任务计划不存在，无法启用开机自启: $($context.TaskName)"
    exit 1
  }

  if ([bool]$task.Settings.Enabled) {
    Write-Output "任务计划已经处于启用状态: $($context.TaskName)"
    exit 0
  }

  Enable-ScheduledTask -TaskName $context.TaskName -ErrorAction Stop | Out-Null
  $updatedTask = Get-ScheduledTask -TaskName $context.TaskName -ErrorAction SilentlyContinue

  if (-not $updatedTask) {
    Write-Output "启用开机自启失败，任务计划已不存在: $($context.TaskName)"
    exit 1
  }

  if ([bool]$updatedTask.Settings.Enabled) {
    Write-Output "已启用后续开机自启: $($context.TaskName)"
    exit 0
  }

  Write-Output "启用开机自启失败，任务仍处于禁用状态: $($context.TaskName)"
  exit 1
} catch {
  Write-Output ('启用开机自启失败: {0}' -f $_.Exception.Message)
  exit 1
}
