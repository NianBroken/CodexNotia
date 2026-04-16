Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'common.ps1')

Set-CodexNotiaConsoleEncoding

<#
停止后台服务主流程。
这里只处理后台启动器、包装进程和服务进程本身，不会触碰计划任务。
执行完成后会重新验证真实进程和锁文件是否都已经清理干净。
#>
$context = $null

try {
  $context = Get-CodexNotiaServiceContext -ScriptRoot $PSScriptRoot
  Stop-CodexNotiaManagedService -Context $context
  Write-Output (Get-CodexNotiaText 'stop.completed' @($context.TaskName))
  exit 0
} catch {
  if ($context) {
    Write-CodexNotiaControlLog -Context $context -Level 'ERROR' -Message (
      Get-CodexNotiaText 'control.log.failure' @(Get-CodexNotiaText 'operation.stopService')
    ) -Metadata @{
      error = $_.Exception.Message
    }
  }

  Write-Output (Get-CodexNotiaText 'stop.failedStillRunning' @($_.Exception.Message))
  exit 1
}
