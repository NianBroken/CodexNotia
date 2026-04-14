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
    Write-Output "任务计划不存在，无需删除: $($context.TaskName)"
    exit 0
  }

  Unregister-ScheduledTask -TaskName $context.TaskName -Confirm:$false -ErrorAction Stop
  $updatedTask = Get-ScheduledTask -TaskName $context.TaskName -ErrorAction SilentlyContinue

  if (-not $updatedTask) {
    Write-Output "已删除项目对应的任务计划程序: $($context.TaskName)"
    exit 0
  }

  Write-Output "删除任务计划程序失败，任务仍然存在: $($context.TaskName)"
  exit 1
} catch {
  Write-Output ('删除任务计划程序失败: {0}' -f $_.Exception.Message)
  exit 1
}
