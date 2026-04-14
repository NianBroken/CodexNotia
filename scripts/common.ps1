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

  $script:OutputEncoding = $utf8Encoding
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
  $configOutput = & $nodeCommand.Source $entryPath config show --config $configPath

  if ($LASTEXITCODE -ne 0) {
    throw "读取最终配置失败，退出码: $LASTEXITCODE"
  }

  $configText = $configOutput -join [Environment]::NewLine
  return $configText | ConvertFrom-Json
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
    throw "隐藏启动辅助脚本不存在: $LauncherPath"
  }

  if (-not (Test-Path -LiteralPath $ScriptPath)) {
    throw "目标 PowerShell 脚本不存在: $ScriptPath"
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
