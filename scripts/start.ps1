Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'common.ps1')

Set-CodexNotiaConsoleEncoding

<#
手动启动主流程。
如果服务已经在跑就直接返回，否则清理陈旧锁并隐藏启动后台链路。
整个流程分成三段。
1. 读取已经归一化后的最终配置和共享路径。
2. 检查当前服务锁，判断是否已经有可用实例。
3. 通过隐藏启动链路拉起后台，再回读锁文件确认启动结果。
#>
$context = Get-CodexNotiaServiceContext -ScriptRoot $PSScriptRoot

<#
优先读取现有服务锁。
如果锁对应的进程仍然存在，就直接返回成功。
如果锁已经陈旧，就只清理锁文件本身，不做其他额外处理，
让后面的隐藏启动链路按当前配置重新拉起后台。
#>
$serviceLock = Read-CodexNotiaLockFile -Path $context.ServiceLockPath

if ($serviceLock -and (Test-CodexNotiaLiveProcess -ProcessIdValue $serviceLock.pid)) {
  Write-Output (Get-CodexNotiaText 'start.alreadyRunning' @($serviceLock.pid))
  exit 0
}

if (Test-Path -LiteralPath $context.ServiceLockPath) {
  Remove-Item -LiteralPath $context.ServiceLockPath -Force -ErrorAction SilentlyContinue
}

<#
通过无窗口链路拉起后台。
这里显式传入 `-Silent`，确保自动路径下不会向桌面弹出任何可见窗口。
#>
Start-CodexNotiaHiddenScript `
  -LauncherPath $context.HiddenLauncherPath `
  -PowerShellPath $context.PowerShellPath `
  -ScriptPath $context.LaunchScriptPath `
  -AdditionalArguments @('-Silent')

$maxWaitSeconds = [Math]::Max(10, [int]$context.Config.startup.restartIntervalSeconds * 3)
$deadline = (Get-Date).AddSeconds($maxWaitSeconds)

<#
启动后重新读取锁文件做结果确认。
只有锁文件已经由新服务写回，且对应进程真实存在时，才认为本次手动启动成功。
否则统一返回失败，交给调用方继续排查。
#>
while ((Get-Date) -lt $deadline) {
  $startedLock = Read-CodexNotiaLockFile -Path $context.ServiceLockPath

  if ($startedLock -and (Test-CodexNotiaLiveProcess -ProcessIdValue $startedLock.pid)) {
    Write-Output (Get-CodexNotiaText 'start.completed' @($context.TaskName, $startedLock.pid))
    exit 0
  }

  Start-Sleep -Milliseconds 500
}

Write-Output (Get-CodexNotiaText 'start.failed' @($context.TaskName))
exit 1
