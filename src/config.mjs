import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  deepMerge,
  expandWindowsEnv,
  isPlainObject,
  readJsonFile,
  trimField
} from './utils.mjs';

const PERMANENT_RETENTION = 'permanent';

/**
 * 默认配置。
 * 这里定义的是程序真正使用的完整配置结构。
 * 用户配置文件只写想改的部分也能工作，缺的字段会从这里自动补齐。
 */
const DEFAULT_CONFIG = {
  service: {
    /**
     * 后台服务名。
     * 这个名字会同时出现在计划任务、状态文件和日志里。
     * 改完以后，已有计划任务不会自动跟着改，必须重新执行安装脚本。
     */
    name: 'CodexNotia',

    /**
     * 扫描会话目录的间隔，单位毫秒。
     * 改小以后通知更快，但磁盘扫描更频繁。
     * 改大以后资源占用更低，但通知会更晚到达。
     */
    pollIntervalMs: 1000,

    /**
     * 一个 turn 多久没有新事件就按超时失败处理，单位毫秒。
     * 只要超过这个时间还没看到真正结束事件，就会补发错误通知。
     */
    staleTurnTimeoutMs: 10800000,

    /**
     * 第一次启动时，是否把已经存在的旧会话内容当作历史基线直接跳过。
     * 开着以后，首次接管仓库时不会把一大堆旧消息重放成新通知。
     * 关掉以后，程序会把当前文件尾部之前的内容也当作待处理事件。
     */
    ignoreHistoricalSessionsOnFirstRun: true,

    /**
     * 同一类项目内部异常通知的冷却时间，单位毫秒。
     * 改小以后，同一错误会更频繁推送到手机。
     * 改大以后，重复异常更安静，但排障时手机反馈会更少。
     */
    internalErrorNotifyCooldownMs: 30000,

    /**
     * 已经发过的 turn 去重记录保留多久，单位毫秒。
     * 这个值决定同一个 turn 在多久以后允许再次发送相同类型通知。
     * 如果写成 `permanent`，程序会永久记住已经通知过的 turn。
     * 频繁从旧对话创建分支时，推荐用 `permanent`，这样旧 turn 不会在几年后重新弹出来。
     */
    notifiedTurnRetentionMs: "permanent",

    /**
     * 如果新追加事件的时间戳，比当前文件里已经见过的最新时间早了这么多，
     * 就把它视为历史分支回放，不再发送通知，单位毫秒。
     * 改小以后，对旧分支历史更敏感。
     * 改大以后，对时间戳乱序更宽容。
     */
    branchReplayTimeDriftMs: 5000,

    /**
     * 会话目录暂时不可用时，警告日志多久最多写一次，单位毫秒。
     * 这个值只影响日志刷屏，不影响真正的通知逻辑。
     */
    sessionDirectoryMissingWarnCooldownMs: 300000
  },

  startup: {
    /**
     * 包装进程连续失败多少次以后，把失败计数回卷到 0。
     * 它不会阻止重启，只是避免长期运行时失败计数一直无限增长。
     */
    restartCount: 3,

    /**
     * 服务异常退出后，包装进程等待多久再拉起下一次，单位秒。
     * 改小以后恢复更快。
     * 改大以后更克制，适合排查持续性崩溃。
     */
    restartIntervalSeconds: 5
  },

  codex: {
    /**
     * Codex 主目录。
     * 留空时会按 `CODEX_HOME`、用户目录等常见位置自动探测。
     * 只有你的会话目录不在标准位置时，才需要手动填写。
     */
    homeDir: '',

    /**
     * 实际要监听的会话目录。
     * 留空时默认使用 `homeDir\\sessions`。
     * 如果你把会话文件重定向到了别处，就在这里写实际路径。
     */
    sessionsDir: '',

    /**
     * CodexApp 本地日志目录。
     * 留空时会按当前 Windows 用户数据目录自动推导。
     * 这条路径只在会话文件里没有带出完整错误正文时，才会作为补抓来源使用。
     */
    appLogsDir: ''
  },

  push: {
    /**
     * Bark 推送地址。
     * 一般保持默认值即可。
     * 只有你使用自建 Bark 服务或反向代理时，才需要改这里。
     */
    url: 'https://api.day.app/push/',

    /**
     * Bark 设备 key。
     * 这是唯一必须由你自己填写的推送凭据。
     * 不填就无法把通知发到手机。
     */
    deviceKey: '',

    /**
     * Bark 通知级别。
     * 它决定手机接收这条通知时的系统优先级和提醒方式。
     */
    level: 'timeSensitive',

    /**
     * Bark 分组名。
     * 改完以后，手机里的通知会进入新的分组。
     */
    group: 'Codex通知',

    /**
     * Bark 归档标记。
     * 保持 `1` 时，通知会进入 Bark 的归档体系。
     */
    isArchive: '1',

    /**
     * 单次推送请求最长等待时间，单位毫秒。
     * 超过这个时间就判定本次请求失败，并进入重试。
     */
    requestTimeoutMs: 10000,

    /**
     * 推送正文的字符上限。
     * 这个值控制进入 Bark 前正文最多保留多少字符。
     * 改小以后通知更短，改大以后能看到更多正文。
     * 它只约束正文，不约束标题和副标题。
     */
    maxContentCharacters: 4096,

    /**
     * URL 编码后的整个请求体长度上限。
     * 如果正文经过字符截断后仍然太大，程序会继续压缩正文直到落入这个范围。
     */
    maxEncodedBodyLength: 7000,

    /**
     * 单条通知最多尝试多少次。
     * 这里包含第一次请求本身，所以最小值必须是 1。
     */
    maxAttempts: 3,

    /**
     * 两次推送尝试之间的等待时间，单位毫秒。
     * 只在前一次失败时生效。
     */
    retryDelayMs: 2000
  },

  runtime: {
    /**
     * 状态文件目录。
     * 留空时会自动落到当前用户的本地数据目录。
     * 这里会保存锁文件、健康状态和去重状态。
     */
    stateDir: '',

    /**
     * 日志目录。
     * 留空时会自动落到当前用户的本地数据目录。
     * 这里会保存按天滚动的运行日志和手动通知日志。
     */
    logDir: ''
  }
};

/**
 * 加载最终配置。
 * 顺序固定为默认值、用户配置、环境变量展开、路径归一化和校验。
 */
export async function loadConfig(configPath) {
  const absoluteConfigPath = path.resolve(configPath);
  const rawConfig = await readJsonFile(absoluteConfigPath, {});
  const configDir = path.dirname(absoluteConfigPath);

  if (!isPlainObject(rawConfig)) {
    throw new Error(`配置文件根节点必须是对象，文件: ${absoluteConfigPath}`);
  }

  const mergedConfig = deepMerge(DEFAULT_CONFIG, rawConfig);
  const expandedConfig = expandConfigTree(mergedConfig);
  const normalizedScalarConfig = normalizeScalarConfig(expandedConfig);
  const normalizedConfig = normalizeResolvedConfig(normalizedScalarConfig, configDir);
  validateConfig(normalizedConfig, absoluteConfigPath);

  return {
    ...normalizedConfig,
    __meta: {
      configPath: absoluteConfigPath
    }
  };
}

/**
 * 递归展开配置树里的 Windows 环境变量。
 * 例如 `%USERPROFILE%` 会在这里被替换成当前机器的真实路径。
 */
function expandConfigTree(value) {
  if (Array.isArray(value)) {
    return value.map((item) => expandConfigTree(item));
  }

  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, expandConfigTree(item)])
    );
  }

  return expandWindowsEnv(value);
}

/**
 * 统一清理和归一化标量配置。
 * 这里会处理字符串数字、布尔字符串和 `permanent` 这类特殊值。
 */
function normalizeScalarConfig(config) {
  return {
    ...config,
    service: {
      ...config.service,
      name: trimField(config.service.name),
      pollIntervalMs: normalizeInteger(config.service.pollIntervalMs, DEFAULT_CONFIG.service.pollIntervalMs),
      staleTurnTimeoutMs: normalizeInteger(config.service.staleTurnTimeoutMs, DEFAULT_CONFIG.service.staleTurnTimeoutMs),
      ignoreHistoricalSessionsOnFirstRun: normalizeBoolean(
        config.service.ignoreHistoricalSessionsOnFirstRun,
        DEFAULT_CONFIG.service.ignoreHistoricalSessionsOnFirstRun
      ),
      internalErrorNotifyCooldownMs: normalizeInteger(
        config.service.internalErrorNotifyCooldownMs,
        DEFAULT_CONFIG.service.internalErrorNotifyCooldownMs
      ),
      notifiedTurnRetentionMs: normalizeIntegerOrPermanent(
        config.service.notifiedTurnRetentionMs,
        DEFAULT_CONFIG.service.notifiedTurnRetentionMs
      ),
      branchReplayTimeDriftMs: normalizeInteger(
        config.service.branchReplayTimeDriftMs,
        DEFAULT_CONFIG.service.branchReplayTimeDriftMs
      ),
      sessionDirectoryMissingWarnCooldownMs: normalizeInteger(
        config.service.sessionDirectoryMissingWarnCooldownMs,
        DEFAULT_CONFIG.service.sessionDirectoryMissingWarnCooldownMs
      )
    },
    startup: {
      ...config.startup,
      restartCount: normalizeInteger(config.startup.restartCount, DEFAULT_CONFIG.startup.restartCount),
      restartIntervalSeconds: normalizeInteger(
        config.startup.restartIntervalSeconds,
        DEFAULT_CONFIG.startup.restartIntervalSeconds
      )
    },
    codex: {
      ...config.codex,
      homeDir: trimField(config.codex.homeDir),
      sessionsDir: trimField(config.codex.sessionsDir),
      appLogsDir: trimField(config.codex.appLogsDir)
    },
    push: {
      ...config.push,
      url: trimField(config.push.url),
      deviceKey: trimField(config.push.deviceKey),
      level: trimField(config.push.level),
      group: trimField(config.push.group),
      isArchive: trimField(config.push.isArchive) || DEFAULT_CONFIG.push.isArchive,
      requestTimeoutMs: normalizeInteger(config.push.requestTimeoutMs, DEFAULT_CONFIG.push.requestTimeoutMs),
      maxContentCharacters: normalizeInteger(
        config.push.maxContentCharacters,
        DEFAULT_CONFIG.push.maxContentCharacters
      ),
      maxEncodedBodyLength: normalizeInteger(
        config.push.maxEncodedBodyLength,
        DEFAULT_CONFIG.push.maxEncodedBodyLength
      ),
      maxAttempts: normalizeInteger(config.push.maxAttempts, DEFAULT_CONFIG.push.maxAttempts),
      retryDelayMs: normalizeInteger(config.push.retryDelayMs, DEFAULT_CONFIG.push.retryDelayMs)
    },
    runtime: {
      ...config.runtime,
      stateDir: trimField(config.runtime.stateDir),
      logDir: trimField(config.runtime.logDir)
    }
  };
}

/**
 * 把最终路径补齐成绝对路径。
 * 所有相对路径都统一按配置文件所在目录解释，不受当前工作目录影响。
 */
function normalizeResolvedConfig(config, configDir) {
  const codexHomeDir = normalizeCodexHomeDir(config.codex.homeDir, configDir);
  const sessionsDir = normalizeSessionsDir(config.codex.sessionsDir, codexHomeDir, configDir);
  const appLogsDir = normalizeCodexAppLogsDir(config.codex.appLogsDir, configDir);
  const runtimeStateDir = resolveConfiguredPath(
    config.runtime.stateDir,
    buildDefaultRuntimeDir('state'),
    configDir
  );
  const runtimeLogDir = resolveConfiguredPath(
    config.runtime.logDir,
    buildDefaultRuntimeDir('logs'),
    configDir
  );

  return {
    ...config,
    codex: {
      ...config.codex,
      homeDir: codexHomeDir,
      sessionsDir,
      appLogsDir
    },
    runtime: {
      ...config.runtime,
      stateDir: runtimeStateDir,
      logDir: runtimeLogDir
    }
  };
}

/**
 * 确定 Codex 主目录。
 * 留空时会依次尝试环境变量、用户目录和系统默认位置。
 */
function normalizeCodexHomeDir(configuredHomeDir, configDir) {
  if (configuredHomeDir) {
    return resolveConfiguredPath(configuredHomeDir, configuredHomeDir, configDir);
  }

  const candidateHomeDirs = [
    process.env.CODEX_HOME,
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, '.codex') : '',
    process.env.HOME ? path.join(process.env.HOME, '.codex') : '',
    path.join(os.homedir(), '.codex')
  ]
    .map((candidatePath) => trimField(candidatePath))
    .filter(Boolean);

  const existingHomeDir = candidateHomeDirs.find((candidatePath) => fs.existsSync(candidatePath));
  const fallbackHomeDir = existingHomeDir || candidateHomeDirs[0] || path.join(os.homedir(), '.codex');
  return path.resolve(fallbackHomeDir);
}

/**
 * 确定会话目录。
 * 留空时默认使用 `homeDir\\sessions`。
 */
function normalizeSessionsDir(configuredSessionsDir, codexHomeDir, configDir) {
  if (configuredSessionsDir) {
    return resolveConfiguredPath(configuredSessionsDir, configuredSessionsDir, configDir);
  }

  return path.resolve(path.join(codexHomeDir, 'sessions'));
}

/**
 * 确定 CodexApp 日志目录。
 * 留空时根据当前用户的本地数据目录自动推导默认位置。
 */
function normalizeCodexAppLogsDir(configuredAppLogsDir, configDir) {
  if (configuredAppLogsDir) {
    return resolveConfiguredPath(configuredAppLogsDir, configuredAppLogsDir, configDir);
  }

  const localAppDataDir = resolveLocalAppDataDir();
  return path.resolve(path.join(localAppDataDir, 'Codex', 'Logs'));
}

/**
 * 构造状态目录和日志目录的默认根路径。
 */
function buildDefaultRuntimeDir(kind) {
  const baseDir = resolveLocalAppDataDir() || process.env.TEMP || os.tmpdir();
  return path.resolve(path.join(baseDir, 'CodexNotia', kind));
}

function resolveLocalAppDataDir() {
  return trimField(process.env.LOCALAPPDATA)
    || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Local') : '')
    || path.join(os.homedir(), 'AppData', 'Local');
}

/**
 * 把配置路径统一转成绝对路径。
 */
function resolveConfiguredPath(configuredPath, fallbackPath, configDir) {
  const effectivePath = trimField(configuredPath) || fallbackPath;
  return path.isAbsolute(effectivePath)
    ? path.normalize(effectivePath)
    : path.resolve(configDir, effectivePath);
}

/**
 * 校验最终配置。
 * 这里只做必须的字段存在性和取值范围检查。
 */
function validateConfig(config, configPath) {
  const requiredStringPaths = [
    ['push', 'url'],
    ['push', 'deviceKey'],
    ['codex', 'homeDir'],
    ['codex', 'sessionsDir'],
    ['codex', 'appLogsDir'],
    ['runtime', 'stateDir'],
    ['runtime', 'logDir'],
    ['service', 'name']
  ];

  for (const pathParts of requiredStringPaths) {
    const value = pathParts.reduce((current, key) => current?.[key], config);

    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`配置文件缺少必填字符串: ${pathParts.join('.')}，文件: ${configPath}`);
    }
  }

  const requiredNonNegativeIntegerPaths = [
    ['push', 'requestTimeoutMs'],
    ['push', 'maxContentCharacters'],
    ['push', 'maxEncodedBodyLength'],
    ['push', 'maxAttempts'],
    ['push', 'retryDelayMs'],
    ['service', 'pollIntervalMs'],
    ['service', 'staleTurnTimeoutMs'],
    ['service', 'internalErrorNotifyCooldownMs'],
    ['service', 'branchReplayTimeDriftMs'],
    ['service', 'sessionDirectoryMissingWarnCooldownMs'],
    ['startup', 'restartCount'],
    ['startup', 'restartIntervalSeconds']
  ];

  for (const pathParts of requiredNonNegativeIntegerPaths) {
    const value = pathParts.reduce((current, key) => current?.[key], config);

    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`配置项必须是非负整数: ${pathParts.join('.')}，文件: ${configPath}`);
    }
  }

  if (!isIntegerOrPermanent(config.service.notifiedTurnRetentionMs)) {
    throw new Error(
      `service.notifiedTurnRetentionMs 必须是非负整数或 permanent，文件: ${configPath}`
    );
  }

  if (config.push.maxAttempts < 1) {
    throw new Error(`push.maxAttempts 至少为 1，文件: ${configPath}`);
  }

  if (config.push.maxContentCharacters < 1) {
    throw new Error(`push.maxContentCharacters 至少为 1，文件: ${configPath}`);
  }

  if (config.service.pollIntervalMs < 250) {
    throw new Error(`service.pollIntervalMs 不能小于 250，文件: ${configPath}`);
  }

  if (typeof config.service.ignoreHistoricalSessionsOnFirstRun !== 'boolean') {
    throw new Error(`service.ignoreHistoricalSessionsOnFirstRun 必须是布尔值，文件: ${configPath}`);
  }

  try {
    const normalizedUrl = new URL(config.push.url);

    if (!['http:', 'https:'].includes(normalizedUrl.protocol)) {
      throw new Error('协议必须是 http 或 https');
    }
  } catch (error) {
    throw new Error(`push.url 不是有效地址，文件: ${configPath}，原因: ${error.message}`);
  }
}

function normalizeInteger(value, fallbackValue) {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value;
  }

  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    return Number.parseInt(value.trim(), 10);
  }

  return fallbackValue;
}

function normalizeIntegerOrPermanent(value, fallbackValue) {
  if (value === PERMANENT_RETENTION) {
    return PERMANENT_RETENTION;
  }

  if (typeof value === 'string' && trimField(value).toLowerCase() === PERMANENT_RETENTION) {
    return PERMANENT_RETENTION;
  }

  return normalizeInteger(value, fallbackValue);
}

function normalizeBoolean(value, fallbackValue) {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const normalizedValue = value.trim().toLowerCase();

    if (normalizedValue === 'true') {
      return true;
    }

    if (normalizedValue === 'false') {
      return false;
    }
  }

  return fallbackValue;
}

function isIntegerOrPermanent(value) {
  return value === PERMANENT_RETENTION
    || (Number.isInteger(value) && value >= 0);
}
