Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'common.ps1')

Set-CodexNotiaConsoleEncoding

<#
只启用后续开机自启。
不会启动当前后台服务，也不会修改其他运行状态。
#>
$context = $null

try {
  $context = Get-CodexNotiaServiceContext -ScriptRoot $PSScriptRoot

  if (-not (Get-CodexNotiaScheduledTask -Context $context)) {
    Write-Output (Get-CodexNotiaText 'enableAutostart.taskMissing' @($context.TaskName))
    exit 1
  }

  Ensure-CodexNotiaScheduledTaskEnabled -Context $context
  Write-Output (Get-CodexNotiaText 'enableAutostart.completed' @($context.TaskName))
  exit 0
} catch {
  if ($context) {
    Write-CodexNotiaControlLog -Context $context -Level 'ERROR' -Message (
      Get-CodexNotiaText 'control.log.failure' @(Get-CodexNotiaText 'operation.enableAutostart')
    ) -Metadata @{
      error = $_.Exception.Message
    }
  }

  Write-Output (Get-CodexNotiaText 'enableAutostart.failed' @($_.Exception.Message))
  exit 1
}
