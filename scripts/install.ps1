Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'common.ps1')

Set-CodexNotiaConsoleEncoding

<#
安装主流程。
会先停掉现有后台服务，再按当前配置重建计划任务，最后重新启动后台服务。
整个流程每一步都以最终状态验证为准，避免只执行动作不确认结果。
#>
$context = $null

try {
  $context = Get-CodexNotiaServiceContext -ScriptRoot $PSScriptRoot
  Stop-CodexNotiaManagedService -Context $context
  Ensure-CodexNotiaScheduledTaskRegistered -Context $context
  Start-CodexNotiaManagedService -Context $context | Out-Null
  Write-Output (Get-CodexNotiaText 'install.completed' @($context.TaskName))
  exit 0
} catch {
  if ($context) {
    Write-CodexNotiaControlLog -Context $context -Level 'ERROR' -Message (
      Get-CodexNotiaText 'control.log.failure' @(Get-CodexNotiaText 'operation.install')
    ) -Metadata @{
      error = $_.Exception.Message
    }
  }

  Write-Output (Get-CodexNotiaText 'install.failed' @($_.Exception.Message))
  exit 1
}
