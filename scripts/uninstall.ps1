Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'common.ps1')

Set-CodexNotiaConsoleEncoding

<#
卸载主流程。
删除计划任务，停止后台链路，并清理状态目录和日志目录。
即使锁文件内容损坏，也会继续尝试按现有目录和任务状态完成清理。
#>
$context = Get-CodexNotiaServiceContext -ScriptRoot $PSScriptRoot
$serviceLock = Read-CodexNotiaLockFile -Path $context.ServiceLockPath
$wrapperLock = Read-CodexNotiaLockFile -Path $context.WrapperLockPath

if (Get-ScheduledTask -TaskName $context.TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $context.TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $context.TaskName -Confirm:$false
}

if ($serviceLock -and (Test-CodexNotiaLiveProcess -ProcessIdValue $serviceLock.pid)) {
  Stop-Process -Id $serviceLock.pid -Force -ErrorAction SilentlyContinue
}

if ($wrapperLock -and (Test-CodexNotiaLiveProcess -ProcessIdValue $wrapperLock.pid)) {
  Stop-Process -Id $wrapperLock.pid -Force -ErrorAction SilentlyContinue
}

if (Test-Path -LiteralPath $context.StateDir) {
  Remove-Item -LiteralPath $context.StateDir -Recurse -Force
}

if (Test-Path -LiteralPath $context.LogDir) {
  Remove-Item -LiteralPath $context.LogDir -Recurse -Force
}

Write-Output (Get-CodexNotiaText 'uninstall.completed' @($context.TaskName))
