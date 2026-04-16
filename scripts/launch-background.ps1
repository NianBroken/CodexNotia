param(
  [switch]$Silent
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'common.ps1')

<#
只有在非静默模式下才输出文本，用于兼顾手动调试和自动启动静默。
#>
function Write-CodexNotiaConsoleMessage {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Message
  )

  if (-not $Silent) {
    Write-Output $Message
  }
}

Set-CodexNotiaConsoleEncoding

<#
隐藏启动主流程。
这里只负责把包装进程稳定拉起，并验证包装进程已经进入运行状态。
服务进程本身由包装进程继续守护和重启。
#>
$context = $null

try {
  $context = Get-CodexNotiaServiceContext -ScriptRoot $PSScriptRoot
  $initialSnapshot = Get-CodexNotiaServiceStateSnapshot -Context $context
  $snapshot = Start-CodexNotiaWrapperProcess -Context $context -Silent:$Silent

  if ($snapshot.WrapperRunning) {
    if ($initialSnapshot.WrapperRunning) {
      Write-CodexNotiaConsoleMessage (Get-CodexNotiaText 'launch.wrapperRunning' @($snapshot.WrapperPid))
    } else {
      Write-CodexNotiaConsoleMessage (Get-CodexNotiaText 'launch.wrapperStarted' @($snapshot.WrapperPid))
    }
    exit 0
  }

  Write-CodexNotiaConsoleMessage (Get-CodexNotiaText 'launch.failed' @('wrapper not running'))
  exit 1
} catch {
  if ($context) {
    Write-CodexNotiaControlLog -Context $context -Level 'ERROR' -Message (
      Get-CodexNotiaText 'control.log.failure' @(Get-CodexNotiaText 'operation.startWrapper')
    ) -Metadata @{
      error = $_.Exception.Message
    }
  }

  Write-CodexNotiaConsoleMessage (Get-CodexNotiaText 'launch.failed' @($_.Exception.Message))
  exit 1
}
