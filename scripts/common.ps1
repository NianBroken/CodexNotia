<#
脚本公共函数。
负责统一控制台编码、读取最终配置、读写 JSON 文件、判断进程存活和解析状态时间。
所有脚本都通过这里复用同一套基础能力，避免控制脚本之间出现规则漂移。
#>
function Set-CodexNotiaConsoleEncoding {
  $utf8Encoding = New-Object System.Text.UTF8Encoding($false)

  try {
    [Console]::InputEncoding = $utf8Encoding
  } catch {
  }

  try {
    [Console]::OutputEncoding = $utf8Encoding
  } catch {
  }

  $global:OutputEncoding = $utf8Encoding
  $PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'
  $PSDefaultParameterValues['Set-Content:Encoding'] = 'utf8'
  $PSDefaultParameterValues['Add-Content:Encoding'] = 'utf8'
}

<#
统一维护控制脚本用到的中文文本模板。
这里全部使用 ASCII 安全的 Unicode 转义，避免运行时代码依赖脚本文件本身的保存编码。
#>
$script:CodexNotiaMessages = @{
  'common.configReadFailedExitCode' = '\u8bfb\u53d6\u6700\u7ec8\u914d\u7f6e\u5931\u8d25\uff0c\u9000\u51fa\u7801: {0}'
  'common.configReadFailedError' = '\u8bfb\u53d6\u6700\u7ec8\u914d\u7f6e\u5931\u8d25\uff0c\u9000\u51fa\u7801: {0}\uff0c\u9519\u8bef: {1}'
  'common.hiddenLauncherMissing' = '\u9690\u85cf\u542f\u52a8\u8f85\u52a9\u811a\u672c\u4e0d\u5b58\u5728: {0}'
  'common.targetScriptMissing' = '\u76ee\u6807 PowerShell \u811a\u672c\u4e0d\u5b58\u5728: {0}'
  'task.description' = '\u6301\u7eed\u76d1\u542c Codex \u4f1a\u8bdd\u5e76\u63a8\u9001\u56de\u7b54\u5b8c\u6210\u6216\u5f02\u5e38\u901a\u77e5'
  'disableAutostart.taskMissing' = '\u4efb\u52a1\u8ba1\u5212\u4e0d\u5b58\u5728\uff0c\u65e0\u9700\u7981\u7528\u5f00\u673a\u81ea\u542f: {0}'
  'disableAutostart.alreadyDisabled' = '\u4efb\u52a1\u8ba1\u5212\u5df2\u7ecf\u5904\u4e8e\u7981\u7528\u72b6\u6001: {0}'
  'disableAutostart.taskGone' = '\u4efb\u52a1\u8ba1\u5212\u5df2\u4e0d\u5b58\u5728\uff0c\u540e\u7eed\u5f00\u673a\u81ea\u542f\u5df2\u5931\u6548: {0}'
  'disableAutostart.completed' = '\u5df2\u7981\u7528\u540e\u7eed\u5f00\u673a\u81ea\u542f: {0}'
  'disableAutostart.failedStillEnabled' = '\u7981\u7528\u5f00\u673a\u81ea\u542f\u5931\u8d25\uff0c\u4efb\u52a1\u4ecd\u5904\u4e8e\u542f\u7528\u72b6\u6001: {0}'
  'disableAutostart.failed' = '\u7981\u7528\u5f00\u673a\u81ea\u542f\u5931\u8d25: {0}'
  'enableAutostart.taskMissing' = '\u4efb\u52a1\u8ba1\u5212\u4e0d\u5b58\u5728\uff0c\u65e0\u6cd5\u542f\u7528\u5f00\u673a\u81ea\u542f: {0}'
  'enableAutostart.alreadyEnabled' = '\u4efb\u52a1\u8ba1\u5212\u5df2\u7ecf\u5904\u4e8e\u542f\u7528\u72b6\u6001: {0}'
  'enableAutostart.taskGone' = '\u542f\u7528\u5f00\u673a\u81ea\u542f\u5931\u8d25\uff0c\u4efb\u52a1\u8ba1\u5212\u5df2\u4e0d\u5b58\u5728: {0}'
  'enableAutostart.completed' = '\u5df2\u542f\u7528\u540e\u7eed\u5f00\u673a\u81ea\u542f: {0}'
  'enableAutostart.failedStillDisabled' = '\u542f\u7528\u5f00\u673a\u81ea\u542f\u5931\u8d25\uff0c\u4efb\u52a1\u4ecd\u5904\u4e8e\u7981\u7528\u72b6\u6001: {0}'
  'enableAutostart.failed' = '\u542f\u7528\u5f00\u673a\u81ea\u542f\u5931\u8d25: {0}'
  'install.completed' = '\u5df2\u5b89\u88c5\u8ba1\u5212\u4efb\u52a1\u5e76\u542f\u52a8\u540e\u53f0\u670d\u52a1: {0}'
  'removeTask.taskMissing' = '\u4efb\u52a1\u8ba1\u5212\u4e0d\u5b58\u5728\uff0c\u65e0\u9700\u5220\u9664: {0}'
  'removeTask.completed' = '\u5df2\u5220\u9664\u9879\u76ee\u5bf9\u5e94\u7684\u4efb\u52a1\u8ba1\u5212\u7a0b\u5e8f: {0}'
  'removeTask.failedStillExists' = '\u5220\u9664\u4efb\u52a1\u8ba1\u5212\u7a0b\u5e8f\u5931\u8d25\uff0c\u4efb\u52a1\u4ecd\u7136\u5b58\u5728: {0}'
  'removeTask.failed' = '\u5220\u9664\u4efb\u52a1\u8ba1\u5212\u7a0b\u5e8f\u5931\u8d25: {0}'
  'runService.exited' = 'CodexNotia \u540e\u53f0\u670d\u52a1\u9000\u51fa\uff0cexitCode={0}\uff0cfailureStreak={1}'
  'runService.exception' = 'CodexNotia \u5305\u88c5\u8fdb\u7a0b\u6355\u83b7\u5f02\u5e38\uff0cfailureStreak={0}\uff0cmessage={1}'
  'start.alreadyRunning' = '\u540e\u53f0\u670d\u52a1\u5df2\u7ecf\u5728\u8fd0\u884c\uff0cPID: {0}'
  'start.completed' = '\u5df2\u542f\u52a8\u540e\u53f0\u670d\u52a1: {0}, PID: {1}'
  'start.failed' = '\u540e\u53f0\u670d\u52a1\u672a\u6210\u529f\u8fdb\u5165\u8fd0\u884c\u72b6\u6001: {0}'
  'stop.completed' = '\u5df2\u505c\u6b62\u8ba1\u5212\u4efb\u52a1\u548c\u540e\u53f0\u670d\u52a1: {0}'
  'uninstall.completed' = '\u5df2\u5378\u8f7d\u8ba1\u5212\u4efb\u52a1\u5e76\u6e05\u7406\u8fd0\u884c\u72b6\u6001: {0}'
}

function Convert-CodexNotiaEscapedUnicodeText {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Text
  )

  return [System.Text.RegularExpressions.Regex]::Replace($Text, '\\u([0-9a-fA-F]{4})', {
    param($Match)
    return [char][Convert]::ToInt32($Match.Groups[1].Value, 16)
  })
}

function Get-CodexNotiaText {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Key,
    [object[]]$Arguments = @()
  )

  $template = $script:CodexNotiaMessages[$Key]

  if ($null -eq $template) {
    throw "Missing text key: $Key"
  }

  $decodedText = Convert-CodexNotiaEscapedUnicodeText -Text $template

  if ($Arguments.Count -eq 0) {
    return $decodedText
  }

  return [string]::Format($decodedText, $Arguments)
}

<#
按 UTF 8 读取文本，并去掉可能存在的 BOM。
#>
function Read-CodexNotiaUtf8Text {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  $utf8Encoding = New-Object System.Text.UTF8Encoding($false, $true)
  $content = [System.IO.File]::ReadAllText($Path, $utf8Encoding)

  if ($content.Length -gt 0 -and $content[0] -eq [char]0xFEFF) {
    $content = $content.Substring(1)
  }

  return $content
}

<#
读取可选 JSON 文件。
文件不存在或内容损坏时统一返回空值，供状态脚本和控制脚本做兜底。
#>
function Read-CodexNotiaOptionalJsonFile {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  if (-not (Test-Path -LiteralPath $Path)) {
    return $null
  }

  try {
    return (Read-CodexNotiaUtf8Text -Path $Path) | ConvertFrom-Json
  } catch {
    return $null
  }
}

<#
按 UTF 8 写入 JSON 文件。
控制脚本写锁文件时统一走这里，避免不同脚本写出不同编码。
#>
function Write-CodexNotiaJsonFile {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,
    [Parameter(Mandatory = $true)]
    $Value
  )

  $directoryPath = Split-Path -Parent $Path

  if ($directoryPath) {
    New-Item -ItemType Directory -Force -Path $directoryPath | Out-Null
  }

  $utf8Encoding = New-Object System.Text.UTF8Encoding($false)
  $jsonText = $Value | ConvertTo-Json -Depth 12
  [System.IO.File]::WriteAllText($Path, $jsonText, $utf8Encoding)
}

<#
定位项目根目录。
所有脚本都在 scripts 目录下，所以项目根目录始终是当前脚本目录的上一级。
#>
function Get-CodexNotiaProjectRoot {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ScriptRoot
  )

  return Split-Path -Parent $ScriptRoot
}

<#
定位最终配置文件。
优先读取环境变量 CODEXNOTIA_CONFIG_PATH，没设置时才回退到项目默认配置。
#>
function Get-CodexNotiaConfigPath {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ProjectRoot
  )

  $configuredPath = [string]$env:CODEXNOTIA_CONFIG_PATH

  if ([string]::IsNullOrWhiteSpace($configuredPath)) {
    return (Join-Path $ProjectRoot 'config\codexnotia.json')
  }

  if ([System.IO.Path]::IsPathRooted($configuredPath)) {
    return [System.IO.Path]::GetFullPath($configuredPath)
  }

  return [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot $configuredPath))
}

<#
定位 node 命令。
后台服务和配置解析都依赖 Node 主程序，这里统一做探测。
#>
function Get-CodexNotiaNodePath {
  $nodeCommand = Get-Command node -ErrorAction Stop
  return $nodeCommand.Source
}

<#
定位可用的 PowerShell 可执行文件。
优先复用当前宿主，再回退到系统自带的 powershell.exe 或 pwsh.exe。
#>
function Get-CodexNotiaPowerShellPath {
  $currentProcessPath = (Get-Process -Id $PID -ErrorAction SilentlyContinue).Path

  if ($currentProcessPath -and (Test-Path -LiteralPath $currentProcessPath)) {
    return $currentProcessPath
  }

  if (Test-Path -LiteralPath (Join-Path $PSHOME 'powershell.exe')) {
    return (Join-Path $PSHOME 'powershell.exe')
  }

  if (Test-Path -LiteralPath (Join-Path $PSHOME 'pwsh.exe')) {
    return (Join-Path $PSHOME 'pwsh.exe')
  }

  return 'powershell.exe'
}

<#
读取经过 Node 侧归一化后的最终配置。
这样控制脚本可以直接复用默认值、环境变量展开和相对路径解析结果。
这里不直接接 PowerShell 对外部进程标准输出的解码结果，而是重定向到 UTF 8 临时文件后再读取。
这样可以避开 Windows PowerShell 5.1 对中文输出的历史兼容问题。
#>
function Get-CodexNotiaResolvedConfig {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ScriptRoot
  )

  $projectRoot = Split-Path -Parent $ScriptRoot
  $entryPath = Join-Path $projectRoot 'src\main.mjs'
  $configPath = Get-CodexNotiaConfigPath -ProjectRoot $projectRoot
  $nodeCommand = Get-Command node -ErrorAction Stop
  $stdoutPath = [System.IO.Path]::GetTempFileName()
  $stderrPath = [System.IO.Path]::GetTempFileName()

  try {
    $process = Start-Process `
      -FilePath $nodeCommand.Source `
      -ArgumentList @($entryPath, 'config', 'show', '--config', $configPath) `
      -WorkingDirectory $projectRoot `
      -WindowStyle Hidden `
      -Wait `
      -PassThru `
      -RedirectStandardOutput $stdoutPath `
      -RedirectStandardError $stderrPath

    if ($process.ExitCode -ne 0) {
      $errorText = Read-CodexNotiaUtf8Text -Path $stderrPath

      if ([string]::IsNullOrWhiteSpace($errorText)) {
        throw (Get-CodexNotiaText 'common.configReadFailedExitCode' @($process.ExitCode))
      }

      throw (Get-CodexNotiaText 'common.configReadFailedError' @($process.ExitCode, $errorText.Trim()))
    }

    $configText = Read-CodexNotiaUtf8Text -Path $stdoutPath
    return $configText | ConvertFrom-Json
  } finally {
    Remove-Item -LiteralPath $stdoutPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $stderrPath -Force -ErrorAction SilentlyContinue
  }
}

<#
构造脚本共享上下文。
这里统一汇总任务名、状态目录、日志目录和后台启动链路涉及到的关键路径。
#>
function Get-CodexNotiaServiceContext {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ScriptRoot
  )

  $projectRoot = Split-Path -Parent $ScriptRoot
  $config = Get-CodexNotiaResolvedConfig -ScriptRoot $ScriptRoot
  $healthFreshThresholdSeconds = [Math]::Max(
    15,
    [int][Math]::Ceiling(([double]$config.service.pollIntervalMs * 5) / 1000)
  )

  return [pscustomobject]@{
    ProjectRoot = $projectRoot
    Config = $config
    ConfigPath = $config.__meta.configPath
    TaskName = $config.service.name
    StateDir = $config.runtime.stateDir
    LogDir = $config.runtime.logDir
    ServiceLockPath = Join-Path $config.runtime.stateDir 'service.lock.json'
    WrapperLockPath = Join-Path $config.runtime.stateDir 'wrapper.lock.json'
    HealthPath = Join-Path $config.runtime.stateDir 'health.json'
    LaunchScriptPath = Join-Path $projectRoot 'scripts\launch-background.ps1'
    RunScriptPath = Join-Path $projectRoot 'scripts\run-service.ps1'
    HiddenLauncherPath = Join-Path $projectRoot 'scripts\invoke-hidden-powershell.vbs'
    PowerShellPath = Get-CodexNotiaPowerShellPath
    WscriptPath = Get-CodexNotiaWscriptPath
    HealthFreshThresholdSeconds = $healthFreshThresholdSeconds
  }
}

<#
返回 wscript 命令名。
Windows 11 默认可直接通过命令名解析到系统自带的 wscript.exe。
#>
function Get-CodexNotiaWscriptPath {
  return 'wscript.exe'
}

<#
通过隐藏启动辅助脚本拉起目标 PowerShell 脚本。
这里不直接弹出窗口，供安装、自恢复和手动启动脚本复用。
#>
function Start-CodexNotiaHiddenScript {
  param(
    [Parameter(Mandatory = $true)]
    [string]$LauncherPath,
    [Parameter(Mandatory = $true)]
    [string]$PowerShellPath,
    [Parameter(Mandatory = $true)]
    [string]$ScriptPath,
    [string[]]$AdditionalArguments = @()
  )

  if (-not (Test-Path -LiteralPath $LauncherPath)) {
    throw (Get-CodexNotiaText 'common.hiddenLauncherMissing' @($LauncherPath))
  }

  if (-not (Test-Path -LiteralPath $ScriptPath)) {
    throw (Get-CodexNotiaText 'common.targetScriptMissing' @($ScriptPath))
  }

  $wscriptPath = Get-CodexNotiaWscriptPath
  $argumentList = @('//B', '//Nologo', $LauncherPath, $PowerShellPath, $ScriptPath) + $AdditionalArguments
  Start-Process -FilePath $wscriptPath -ArgumentList $argumentList -WindowStyle Hidden | Out-Null
}

<#
根据 PID 判断进程是否仍然存活。
#>
function Test-CodexNotiaLiveProcess {
  param(
    [Parameter(Mandatory = $true)]
    [int]$ProcessIdValue
  )

  return [bool](Get-Process -Id $ProcessIdValue -ErrorAction SilentlyContinue)
}

<#
读取并校验锁文件。
锁文件损坏、PID 缺失或 PID 非数字时会自动删除坏锁，避免控制脚本被脏状态卡住。
#>
function Read-CodexNotiaLockFile {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  $lock = Read-CodexNotiaOptionalJsonFile -Path $Path

  if ($null -eq $lock) {
    Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    return $null
  }

  $pidValue = 0

  if (-not [int]::TryParse([string]$lock.pid, [ref]$pidValue)) {
    Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    return $null
  }

  return [pscustomobject]@{
    pid = $pidValue
    startedAt = $lock.startedAt
  }
}

<#
把任意时间值统一转成 UTC 时间。
状态新鲜度判断全部基于 UTC，避免本地时区和字符串解析差异造成误判。
#>
function Convert-CodexNotiaDateTimeValue {
  param(
    $Value
  )

  if ($null -eq $Value) {
    return $null
  }

  if ($Value -is [datetime]) {
    return $Value.ToUniversalTime()
  }

  if ($Value -is [string]) {
    $trimmedValue = $Value.Trim()

    if (-not $trimmedValue) {
      return $null
    }

    try {
      return ([datetimeoffset]::Parse($trimmedValue)).UtcDateTime
    } catch {
      try {
        return ([datetime]$trimmedValue).ToUniversalTime()
      } catch {
        return $null
      }
    }
  }

  return $null
}

<#
把任意时间值格式化成本地可读文本。
明显只是占位意义的旧时间会回退为空值。
#>
function Format-CodexNotiaDateTimeValue {
  param(
    $Value
  )

  $dateTimeValue = Convert-CodexNotiaDateTimeValue -Value $Value

  if ($null -eq $dateTimeValue) {
    return $null
  }

  if ($dateTimeValue.Year -lt 2001) {
    return $null
  }

  return $dateTimeValue.ToLocalTime().ToString('yyyy-MM-dd HH:mm:ss')
}
