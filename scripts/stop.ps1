Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'common.ps1')

Set-CodexNotiaConsoleEncoding

<#
停止主流程。
结束服务进程、包装进程并清理对应锁文件，任务本身不会被卸载。
锁文件损坏时会自动忽略坏内容并继续清理，避免控制脚本本身被单个坏文件阻断。
#>
$context = Get-CodexNotiaServiceContext -ScriptRoot $PSScriptRoot
$serviceLock = Read-CodexNotiaLockFile -Path $context.ServiceLockPath
$wrapperLock = Read-CodexNotiaLockFile -Path $context.WrapperLockPath

if ($serviceLock -and (Test-CodexNotiaLiveProcess -ProcessIdValue $serviceLock.pid)) {
  Stop-Process -Id $serviceLock.pid -Force -ErrorAction SilentlyContinue
}

if (Test-Path -LiteralPath $context.ServiceLockPath) {
  Remove-Item -LiteralPath $context.ServiceLockPath -Force -ErrorAction SilentlyContinue
}

if ($wrapperLock -and (Test-CodexNotiaLiveProcess -ProcessIdValue $wrapperLock.pid)) {
  Stop-Process -Id $wrapperLock.pid -Force -ErrorAction SilentlyContinue
}

if (Test-Path -LiteralPath $context.WrapperLockPath) {
  Remove-Item -LiteralPath $context.WrapperLockPath -Force -ErrorAction SilentlyContinue
}

if (Get-ScheduledTask -TaskName $context.TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $context.TaskName -ErrorAction SilentlyContinue
}

Write-Output (Get-CodexNotiaText 'stop.completed' @($context.TaskName))
