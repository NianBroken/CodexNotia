Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'common.ps1')

Set-CodexNotiaConsoleEncoding

<#
卸载主流程。
先停止后台服务，再删除计划任务，最后清理状态目录和日志目录。
即使任务已经不存在，也会继续完成其余清理并验证最终结果。
#>
$context = $null

try {
  $context = Get-CodexNotiaServiceContext -ScriptRoot $PSScriptRoot
  Stop-CodexNotiaManagedService -Context $context
  Ensure-CodexNotiaScheduledTaskRemoved -Context $context
  Remove-CodexNotiaRuntimeArtifacts -Context $context
  Write-Output (Get-CodexNotiaText 'uninstall.completed' @($context.TaskName))
  exit 0
} catch {
  if ($context) {
    Write-CodexNotiaControlLog -Context $context -Level 'ERROR' -Message (
      Get-CodexNotiaText 'control.log.failure' @(Get-CodexNotiaText 'operation.uninstall')
    ) -Metadata @{
      error = $_.Exception.Message
    }
  }

  Write-Output (Get-CodexNotiaText 'uninstall.failed' @($_.Exception.Message))
  exit 1
}
