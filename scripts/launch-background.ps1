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
优先复用仍然存活的包装进程，清理陈旧锁后再拉起 `run-service.ps1`。
这里会直接使用 Node 侧已经归一化的状态目录，确保默认配置和相对路径都能正确落地。
#>
$context = Get-CodexNotiaServiceContext -ScriptRoot $PSScriptRoot

New-Item -ItemType Directory -Force -Path $context.StateDir | Out-Null

$wrapperLock = Read-CodexNotiaLockFile -Path $context.WrapperLockPath

if ($wrapperLock -and (Test-CodexNotiaLiveProcess -ProcessIdValue $wrapperLock.pid)) {
  Write-CodexNotiaConsoleMessage ('Wrapper already running, PID: {0}' -f $wrapperLock.pid)
  exit 0
}

if (Test-Path -LiteralPath $context.WrapperLockPath) {
  Remove-Item -LiteralPath $context.WrapperLockPath -Force -ErrorAction SilentlyContinue
}

$serviceLock = Read-CodexNotiaLockFile -Path $context.ServiceLockPath

if ($serviceLock -and -not (Test-CodexNotiaLiveProcess -ProcessIdValue $serviceLock.pid)) {
  Remove-Item -LiteralPath $context.ServiceLockPath -Force -ErrorAction SilentlyContinue
}

$runScriptArguments = @(
  '-NoProfile',
  '-ExecutionPolicy',
  'Bypass',
  '-WindowStyle',
  'Hidden',
  '-File',
  $context.RunScriptPath
)

if ($Silent) {
  $runScriptArguments += '-Silent'
}

$process = Start-Process `
  -FilePath $context.PowerShellPath `
  -ArgumentList $runScriptArguments `
  -WorkingDirectory $context.ProjectRoot `
  -WindowStyle Hidden `
  -PassThru

Write-CodexNotiaJsonFile -Path $context.WrapperLockPath -Value @{
  pid = $process.Id
  startedAt = (Get-Date).ToString('o')
}

Write-CodexNotiaConsoleMessage ('Started wrapper, PID: {0}' -f $process.Id)
