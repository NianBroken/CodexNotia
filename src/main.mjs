import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildErrorNotification, buildSuccessNotification, pushToBark } from './bark.mjs';
import { loadConfig } from './config.mjs';
import { Logger } from './logger.mjs';
import { StateStore } from './state-store.mjs';
import { CodexNotiaService } from './service.mjs';
import { formatLocalDateTime, trimField } from './utils.mjs';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 命令行入口。
 * 负责解析参数、加载配置，并分发到服务、状态或手动通知流程。
 */
async function main() {
  const command = process.argv[2];
  const subcommand = process.argv[3];
  const options = parseOptions(process.argv.slice(4));
  const configPath = path.resolve(options.config ?? resolveDefaultConfigPath());
  const config = await loadConfig(configPath);

  if (command === 'service' && subcommand === 'run') {
    const service = new CodexNotiaService(config);
    attachProcessLevelErrorHandlers(service);
    await service.run();
    return;
  }

  if (command === 'service' && subcommand === 'status') {
    const stateStore = new StateStore(config.runtime.stateDir);
    await stateStore.initialize();
    const health = await fs.readFile(stateStore.healthFilePath, 'utf8')
      .then((content) => JSON.parse(content))
      .catch(() => null);

    console.log(JSON.stringify({
      configPath,
      stateFilePath: stateStore.stateFilePath,
      healthFilePath: stateStore.healthFilePath,
      health
    }, null, 2));
    return;
  }

  if (command === 'notify' && subcommand === 'success') {
    const logger = new Logger(path.join(config.runtime.logDir, 'manual-notify.log'));
    const text = options.text ?? 'CodexNotia 手动成功通知测试。';
    const notification = buildSuccessNotification(text, new Date(), {
      scene: 'project',
      maxContentCharacters: config.push.maxContentCharacters
    });
    await pushToBark(config, notification, logger);
    console.log(JSON.stringify(notification, null, 2));
    return;
  }

  if (command === 'notify' && subcommand === 'error') {
    const logger = new Logger(path.join(config.runtime.logDir, 'manual-notify.log'));
    const text = options.text ?? 'CodexNotia 手动错误通知测试。';
    const notification = buildErrorNotification(text, new Date(), {
      scene: 'project',
      maxContentCharacters: config.push.maxContentCharacters
    });
    await pushToBark(config, notification, logger);
    console.log(JSON.stringify(notification, null, 2));
    return;
  }

  if (command === 'config' && subcommand === 'show') {
    console.log(JSON.stringify(config, null, 2));
    return;
  }

  printHelp(configPath);
  process.exitCode = 1;
}

/**
 * 为服务模式绑定进程级兜底异常处理。
 * 这样未捕获异常和未处理的 Promise 拒绝也会进入项目日志和错误通知链路。
 */
function attachProcessLevelErrorHandlers(service) {
  process.on('uncaughtException', async (error) => {
    await service.reportInternalError('未捕获异常', error);
    service.isStopping = true;
  });

  process.on('unhandledRejection', async (reason) => {
    await service.reportInternalError('未处理的 Promise 拒绝', reason);
    service.isStopping = true;
  });
}

/**
 * 解析命令行附加参数。
 * 当前只支持 `--config` 和 `--text`。
 */
function parseOptions(args) {
  const options = {};

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];

    if (current === '--config') {
      options.config = args[index + 1];
      index += 1;
      continue;
    }

    if (current === '--text') {
      options.text = args[index + 1];
      index += 1;
    }
  }

  return options;
}

/**
 * 解析默认配置文件位置。
 * 允许通过环境变量覆盖默认配置，避免脚本和入口只能绑定仓库里的单一路径。
 */
function resolveDefaultConfigPath() {
  const configuredPath = trimField(process.env.CODEXNOTIA_CONFIG_PATH);

  if (!configuredPath) {
    return path.join(APP_ROOT, 'config', 'codexnotia.json');
  }

  return path.isAbsolute(configuredPath)
    ? configuredPath
    : path.resolve(APP_ROOT, configuredPath);
}

/**
 * 打印命令帮助。
 */
function printHelp(configPath) {
  console.log([
    'CodexNotia',
    '',
    `默认配置: ${configPath}`,
    '',
    '用法:',
    '  node ./src/main.mjs service run --config ./config/codexnotia.json',
    '  node ./src/main.mjs service status --config ./config/codexnotia.json',
    '  node ./src/main.mjs config show --config ./config/codexnotia.json',
    '  node ./src/main.mjs notify success --text "示例文本"',
    '  node ./src/main.mjs notify error --text "示例错误"',
    '',
    `当前时间: ${formatLocalDateTime(new Date())}`
  ].join('\n'));
}

main().catch((error) => {
  console.error(getFatalMessage(error));
  process.exitCode = 1;
});

/**
 * 把致命错误转换成终端可读文本。
 */
function getFatalMessage(error) {
  if (error instanceof Error) {
    return error.stack || error.message;
  }

  return String(error);
}
