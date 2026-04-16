Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'common.ps1')

Set-CodexNotiaConsoleEncoding

<#
只禁用后续开机自启。
不会停止当前后台服务，也不会删除计划任务本身。
#>
$context = $null

try {
  $context = Get-CodexNotiaServiceContext -ScriptRoot $PSScriptRoot
  Ensure-CodexNotiaScheduledTaskDisabled -Context $context
  Write-Output (Get-CodexNotiaText 'disableAutostart.completed' @($context.TaskName))
  exit 0
} catch {
  if ($context) {
    Write-CodexNotiaControlLog -Context $context -Level 'ERROR' -Message (
      Get-CodexNotiaText 'control.log.failure' @(Get-CodexNotiaText 'operation.disableAutostart')
    ) -Metadata @{
      error = $_.Exception.Message
    }
  }

  Write-Output (Get-CodexNotiaText 'disableAutostart.failed' @($_.Exception.Message))
  exit 1
}
