Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'common.ps1')

Set-CodexNotiaConsoleEncoding

<#
状态脚本主流程。
输出计划任务、包装进程、服务进程和健康文件的汇总状态。
这里统一复用 Node 侧最终配置，避免默认值、相对路径和环境变量展开结果出现偏差。
#>
$context = Get-CodexNotiaServiceContext -ScriptRoot $PSScriptRoot
$task = Get-ScheduledTask -TaskName $context.TaskName -ErrorAction SilentlyContinue
$taskInfo = $null

if ($task) {
  $taskInfo = Get-ScheduledTaskInfo -TaskName $context.TaskName
}

$healthRaw = Read-CodexNotiaOptionalJsonFile -Path $context.HealthPath
$healthDisplay = $null
$healthUpdatedAtUtc = $null
$healthServiceStartedAtUtc = $null
$healthUpdatedAtValue = $null
$healthServiceStartedAtValue = $null

if ($healthRaw) {
  $healthDisplay = [pscustomobject]@{}

  foreach ($property in $healthRaw.PSObject.Properties) {
    Add-Member -InputObject $healthDisplay -MemberType NoteProperty -Name $property.Name -Value $property.Value
  }

  $healthUpdatedAtValue = if ($healthRaw.PSObject.Properties['updatedAt']) { $healthRaw.updatedAt } else { $null }
  $healthServiceStartedAtValue = if ($healthRaw.PSObject.Properties['serviceStartedAt']) { $healthRaw.serviceStartedAt } else { $null }
  $healthUpdatedAtUtc = Convert-CodexNotiaDateTimeValue -Value $healthUpdatedAtValue

  if ($healthUpdatedAtUtc) {
    $healthDisplay.updatedAt = $healthUpdatedAtUtc.ToLocalTime().ToString('yyyy-MM-dd HH:mm:ss')
  }

  $healthServiceStartedAtUtc = Convert-CodexNotiaDateTimeValue -Value $healthServiceStartedAtValue

  if ($healthServiceStartedAtUtc) {
    $healthDisplay.serviceStartedAt = $healthServiceStartedAtUtc.ToLocalTime().ToString('yyyy-MM-dd HH:mm:ss')
  }
}

$serviceLock = Read-CodexNotiaLockFile -Path $context.ServiceLockPath
$wrapperLock = Read-CodexNotiaLockFile -Path $context.WrapperLockPath
$serviceProcessRunning = [bool]($serviceLock -and (Test-CodexNotiaLiveProcess -ProcessIdValue $serviceLock.pid))
$wrapperProcessRunning = [bool]($wrapperLock -and (Test-CodexNotiaLiveProcess -ProcessIdValue $wrapperLock.pid))
$healthMatchesRunningService = $false

if ($healthRaw -and $serviceProcessRunning) {
  $healthPidValue = 0
  $hasHealthPid = [int]::TryParse([string]$healthRaw.pid, [ref]$healthPidValue)
  $healthStartedAt = [string]$healthServiceStartedAtValue
  $serviceLockStartedAt = if ($serviceLock) { [string]$serviceLock.startedAt } else { '' }

  if ($hasHealthPid -and $healthPidValue -eq $serviceLock.pid) {
    if ([string]::IsNullOrWhiteSpace($healthStartedAt) -or [string]::IsNullOrWhiteSpace($serviceLockStartedAt)) {
      $healthMatchesRunningService = $true
    } else {
      $healthMatchesRunningService = $healthStartedAt -eq $serviceLockStartedAt
    }
  }
}

[pscustomobject]@{
  Installed = [bool]$task
  TaskName = $context.TaskName
  TaskState = if ($task) { "$($task.State)" } else { $null }
  LastRunTime = if ($taskInfo) { Format-CodexNotiaDateTimeValue -Value $taskInfo.LastRunTime } else { $null }
  LastTaskResult = if ($taskInfo) { $taskInfo.LastTaskResult } else { $null }
  NextRunTime = if ($taskInfo) { Format-CodexNotiaDateTimeValue -Value $taskInfo.NextRunTime } else { $null }
  WrapperPid = if ($wrapperLock) { $wrapperLock.pid } else { $null }
  WrapperProcessRunning = $wrapperProcessRunning
  ServicePid = if ($serviceLock) { $serviceLock.pid } else { $null }
  ServiceProcessRunning = $serviceProcessRunning
  HealthCurrent = $healthMatchesRunningService
  HealthFresh = $healthMatchesRunningService
  HealthFreshThresholdSeconds = $null
  ConfigPath = $context.ConfigPath
  StateDir = $context.StateDir
  LogDir = $context.LogDir
  Health = $healthDisplay
} | ConvertTo-Json -Depth 8
