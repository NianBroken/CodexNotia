Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'common.ps1')

Set-CodexNotiaConsoleEncoding

<#
安装主流程。
读取已经归一化后的最终配置，重建同名计划任务，并立即以隐藏方式拉起后台链路。
如果旧任务已存在，会先注销再重新注册。
#>
$context = Get-CodexNotiaServiceContext -ScriptRoot $PSScriptRoot

$principal = New-ScheduledTaskPrincipal `
  -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) `
  -LogonType Interactive `
  -RunLevel Limited

$action = New-ScheduledTaskAction `
  -Execute $context.WscriptPath `
  -Argument "//B //Nologo `"$($context.HiddenLauncherPath)`" `"$($context.PowerShellPath)`" `"$($context.LaunchScriptPath)`" `"-Silent`""

$trigger = New-ScheduledTaskTrigger -AtLogOn

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew

if (Get-ScheduledTask -TaskName $context.TaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $context.TaskName -Confirm:$false
}

Register-ScheduledTask `
  -TaskName $context.TaskName `
  -Action $action `
  -Trigger $trigger `
  -Principal $principal `
  -Settings $settings `
  -Description (Get-CodexNotiaText 'task.description') `
  | Out-Null

Start-CodexNotiaHiddenScript `
  -LauncherPath $context.HiddenLauncherPath `
  -PowerShellPath $context.PowerShellPath `
  -ScriptPath $context.LaunchScriptPath `
  -AdditionalArguments @('-Silent')

$maxWaitSeconds = [Math]::Max(10, [int]$context.Config.startup.restartIntervalSeconds * 3)
$deadline = (Get-Date).AddSeconds($maxWaitSeconds)

while ((Get-Date) -lt $deadline) {
  $startedLock = Read-CodexNotiaLockFile -Path $context.ServiceLockPath

  if ($startedLock -and (Test-CodexNotiaLiveProcess -ProcessIdValue $startedLock.pid)) {
    Write-Output (Get-CodexNotiaText 'install.completed' @($context.TaskName))
    exit 0
  }

  Start-Sleep -Milliseconds 500
}

throw (Get-CodexNotiaText 'start.failed' @($context.TaskName))
