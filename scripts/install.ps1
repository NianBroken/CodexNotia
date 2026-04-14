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
  -Description '持续监听 Codex 会话并推送回答完成或异常通知' `
  | Out-Null

Start-CodexNotiaHiddenScript `
  -LauncherPath $context.HiddenLauncherPath `
  -PowerShellPath $context.PowerShellPath `
  -ScriptPath $context.LaunchScriptPath `
  -AdditionalArguments @('-Silent')

Write-Output "已安装计划任务并启动后台服务: $($context.TaskName)"
