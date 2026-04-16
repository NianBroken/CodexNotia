Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'common.ps1')

Set-CodexNotiaConsoleEncoding

<#
手动启动后台服务。
脚本会先识别当前是否已经处于完整运行状态。
如果发现半启动残留，会先清理再重新拉起，最后只以真实运行结果作为成功依据。
#>
$context = $null

try {
  $context = Get-CodexNotiaServiceContext -ScriptRoot $PSScriptRoot
  $snapshot = Start-CodexNotiaManagedService -Context $context
  Write-Output (Get-CodexNotiaText 'start.completed' @($context.TaskName, $snapshot.ServicePid))
  exit 0
} catch {
  if ($context) {
    Write-CodexNotiaControlLog -Context $context -Level 'ERROR' -Message (
      Get-CodexNotiaText 'control.log.failure' @(Get-CodexNotiaText 'operation.startService')
    ) -Metadata @{
      error = $_.Exception.Message
    }
  }

  Write-Output (Get-CodexNotiaText 'start.failed' @($_.Exception.Message))
  exit 1
}
