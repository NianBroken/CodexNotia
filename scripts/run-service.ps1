param(
  [switch]$Silent
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'common.ps1')

<#
只有在非静默模式下才输出文本。
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
包装进程主循环。
持续守护 `node src/main.mjs service run`，服务异常退出时按配置等待后重启。
包装进程自己的锁文件会在退出时清理，避免留下长期陈旧的包装锁。
#>
$context = Get-CodexNotiaServiceContext -ScriptRoot $PSScriptRoot
$nodePath = Get-CodexNotiaNodePath
$entryPath = Join-Path $context.ProjectRoot 'src\main.mjs'
$retryCount = [int]$context.Config.startup.restartCount
$retryDelaySeconds = [Math]::Max([int]$context.Config.startup.restartIntervalSeconds, 1)
$failureStreak = 0

New-Item -ItemType Directory -Force -Path $context.StateDir | Out-Null
Write-CodexNotiaJsonFile -Path $context.WrapperLockPath -Value @{
  pid = $PID
  startedAt = (Get-Date).ToString('o')
}

try {
  while ($true) {
    try {
      $serviceLock = Read-CodexNotiaLockFile -Path $context.ServiceLockPath

      if ($serviceLock -and (Test-CodexNotiaLiveProcess -ProcessIdValue $serviceLock.pid)) {
        Start-Sleep -Seconds $retryDelaySeconds
        continue
      }

      if (Test-Path -LiteralPath $context.ServiceLockPath) {
        Remove-Item -LiteralPath $context.ServiceLockPath -Force -ErrorAction SilentlyContinue
      }

      & $nodePath $entryPath service run --config $context.ConfigPath
      $exitCode = $LASTEXITCODE

      if ($exitCode -eq 0) {
        exit 0
      }

      $failureStreak += 1
      Write-CodexNotiaConsoleMessage (Get-CodexNotiaText 'runService.exited' @($exitCode, $failureStreak))

      if ($failureStreak -gt $retryCount) {
        $failureStreak = 1
      }
    } catch {
      $failureStreak += 1
      Write-CodexNotiaConsoleMessage (
        Get-CodexNotiaText 'runService.exception' @($failureStreak, $_.Exception.Message)
      )
    }

    Start-Sleep -Seconds $retryDelaySeconds
  }
} finally {
  $wrapperLock = Read-CodexNotiaLockFile -Path $context.WrapperLockPath

  if ($wrapperLock -and $wrapperLock.pid -eq $PID) {
    Remove-Item -LiteralPath $context.WrapperLockPath -Force -ErrorAction SilentlyContinue
  }
}
