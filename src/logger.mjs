import fs from 'node:fs/promises';
import path from 'node:path';
import {
  ensureDirectory,
  formatLocalDateTime,
  normalizeTimestamp,
  nowIsoString,
  looksLikeIsoDateTime,
  toSafeLogText,
  writeJsonFile
} from './utils.mjs';

/**
 * 统一日志写入器。
 * 负责单行日志、块日志和健康文件落盘，并保证输出格式一致。
 */
export class Logger {
  constructor(logFilePath) {
    this.logFilePath = logFilePath;
    this.separator = '----------------------------------------';
    this.fileReady = false;
  }

  async info(message, metadata) {
    await this.write('INFO', message, metadata);
  }

  async warn(message, metadata) {
    await this.write('WARN', message, metadata);
  }

  async error(message, metadata) {
    await this.write('ERROR', message, metadata);
  }

  /**
   * 写入单行日志。
   * 这里统一补时间戳、级别和元数据序列化。
   */
  async write(level, message, metadata) {
    const timestamp = formatLocalDateTime(new Date());
    const metadataText = metadata === undefined
      ? ''
      : ` ${safeStringifyMetadata(metadata)}`;
    const line = `[${timestamp}] [${level}] ${toSafeLogText(message)}${metadataText}\n`;

    await this.ensureLogFileReady();
    await fs.appendFile(this.logFilePath, line, 'utf8');
  }

  /**
   * 写入块日志。
   * 适合完整回答、完整错误和通知内容这类长文本。
   */
  async writeBlock(level, title, content, metadata) {
    const timestamp = formatLocalDateTime(new Date());
    const metadataText = metadata === undefined
      ? ''
      : ` ${safeStringifyMetadata(metadata)}`;
    const normalizedContent = toSafeLogText(content || '[empty]');
    const block = [
      `[${timestamp}] [${level}] ${toSafeLogText(title)}${metadataText}`,
      this.separator,
      normalizedContent,
      this.separator
    ].join('\n') + '\n';

    await this.ensureLogFileReady();
    await fs.appendFile(this.logFilePath, block, 'utf8');
  }

  async infoBlock(title, content, metadata) {
    await this.writeBlock('INFO', title, content, metadata);
  }

  async warnBlock(title, content, metadata) {
    await this.writeBlock('WARN', title, content, metadata);
  }

  async errorBlock(title, content, metadata) {
    await this.writeBlock('ERROR', title, content, metadata);
  }

  /**
   * 写入健康检查文件。
   * `updatedAt` 统一在这里补齐。
   */
  async writeHeartbeat(healthFilePath, payload) {
    const content = {
      ...payload,
      updatedAt: nowIsoString()
    };
    await writeJsonFile(healthFilePath, content);
  }

  /**
   * 确保日志文件已经可写。
   * 首次调用时会创建父目录和空文件，后续直接复用。
   */
  async ensureLogFileReady() {
    if (this.fileReady) {
      return;
    }

    await ensureDirectory(path.dirname(this.logFilePath));

    try {
      await fs.access(this.logFilePath);
    } catch {
      await fs.writeFile(this.logFilePath, '\uFEFF', 'utf8');
    }

    this.fileReady = true;
  }
}

function safeStringifyMetadata(metadata) {
  try {
    return JSON.stringify(metadata, buildMetadataReplacer());
  } catch {
    return JSON.stringify({
      metadataError: '日志元数据序列化失败',
      fallback: toSafeLogText(String(metadata))
    });
  }
}

function buildMetadataReplacer() {
  const seenObjects = new WeakSet();

  return (_, value) => {
    if (typeof value === 'bigint') {
      return value.toString();
    }

    if (typeof value === 'string' && isTimestampMetadataField(_, value)) {
      return normalizeTimestamp(value, value);
    }

    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
        stack: value.stack
      };
    }

    if (typeof value === 'object' && value !== null) {
      if (seenObjects.has(value)) {
        return '[Circular]';
      }

      seenObjects.add(value);
    }

    return value;
  };
}

function isTimestampMetadataField(fieldName, value) {
  if (!looksLikeIsoDateTime(value)) {
    return false;
  }

  return /(^|_)(at|time|timestamp)$/i.test(fieldName)
    || /(At|Time|Timestamp)$/.test(fieldName);
}
