import fs from 'node:fs/promises';
import path from 'node:path';

export function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function ensureDirectory(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

/**
 * 原子写入文本文件。
 * 先写同目录临时文件，再用重命名替换正式文件，降低中途崩溃造成文件损坏的概率。
 */
export async function atomicWriteFile(filePath, content, encoding = 'utf8') {
  await ensureDirectory(path.dirname(filePath));
  const tempPath = path.join(
    path.dirname(filePath),
    `${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
  );

  try {
    await fs.writeFile(tempPath, content, encoding);
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.unlink(tempPath).catch(() => {
    });
    throw error;
  }
}

/**
 * 深度合并默认配置和用户配置。
 * 数组整体覆盖，普通对象递归合并，标量优先使用覆盖值。
 */
export function deepMerge(baseValue, overrideValue) {
  if (Array.isArray(baseValue) || Array.isArray(overrideValue)) {
    return overrideValue ?? baseValue;
  }

  if (isPlainObject(baseValue) && isPlainObject(overrideValue)) {
    const merged = { ...baseValue };

    for (const [key, value] of Object.entries(overrideValue)) {
      merged[key] = key in baseValue
        ? deepMerge(baseValue[key], value)
        : value;
    }

    return merged;
  }

  return overrideValue ?? baseValue;
}

export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 展开 Windows 风格环境变量，例如 `%USERPROFILE%`。
 */
export function expandWindowsEnv(value) {
  if (typeof value !== 'string') {
    return value;
  }

  return value.replace(/%([^%]+)%/g, (_, name) => process.env[name] ?? '');
}

export function normalizeNewlines(value) {
  return String(value ?? '').replace(/\r\n/g, '\n');
}

/**
 * 清理字段首尾空白和空行。
 */
export function trimField(value) {
  return normalizeNewlines(value).trim();
}

/**
 * 按最大长度做硬截断。
 * 这里只负责长度保护，不负责语义完整性。
 */
export function limitLength(value, maxLength) {
  const normalized = String(value ?? '');

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return normalized.slice(0, maxLength);
}

/**
 * 统一格式化为 `yyyy-MM-dd HH:mm:ss`。
 */
export function formatLocalDateTime(input) {
  const date = input instanceof Date ? input : new Date(input);
  const year = date.getFullYear();
  const month = padNumber(date.getMonth() + 1);
  const day = padNumber(date.getDate());
  const hour = padNumber(date.getHours());
  const minute = padNumber(date.getMinutes());
  const second = padNumber(date.getSeconds());
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

function padNumber(value) {
  return String(value).padStart(2, '0');
}

/**
 * 读取 JSON 文件。
 * 文件不存在时返回调用方提供的回退值。
 */
export async function readJsonFile(filePath, fallbackValue) {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return parseJsonText(content);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return fallbackValue;
    }

    throw error;
  }
}

/**
 * 写入 JSON 文件，并自动创建父目录。
 */
export async function writeJsonFile(filePath, value) {
  await atomicWriteFile(filePath, JSON.stringify(value, null, 2), 'utf8');
}

export async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function getErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

/**
 * 递归列出目录下全部 `.jsonl` 文件，并按完整路径排序。
 * 根目录不存在或中途遇到不可读子目录时会跳过，避免后台扫描被单个异常目录拖垮。
 */
export async function listJsonlFiles(rootDir) {
  const discoveredFiles = [];
  const pendingDirs = [rootDir];

  while (pendingDirs.length > 0) {
    const currentDir = pendingDirs.pop();
    let entries;

    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch (error) {
      if (
        error
        && ['EACCES', 'ENOENT', 'ENOTDIR', 'EPERM'].includes(error.code)
      ) {
        continue;
      }

      throw error;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        pendingDirs.push(fullPath);
        continue;
      }

      if (entry.isFile() && entry.name.toLowerCase().endsWith('.jsonl')) {
        discoveredFiles.push(fullPath);
      }
    }
  }

  discoveredFiles.sort();
  return discoveredFiles;
}

/**
 * 解析一行 JSONL 文本。
 * 空行返回 `null`。
 */
export function parseJsonLine(line) {
  const trimmedLine = trimField(line);

  if (!trimmedLine) {
    return null;
  }

  return JSON.parse(trimmedLine);
}

export function nowIsoString() {
  return new Date().toISOString();
}

/**
 * 清理不适合直接写入日志的字符。
 */
export function toSafeLogText(value) {
  return normalizeNewlines(value).replace(/\0/g, '');
}

/**
 * 把多行文本压成单行，专供日志展示使用。
 */
export function toSingleLineLogText(value) {
  return toSafeLogText(value)
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 按 Unicode 码点统计字符数，避免直接使用 `length` 对中文和代理对计数失真。
 */
export function getCharacterLength(value) {
  return Array.from(String(value ?? '')).length;
}

/**
 * 解析 JSON 文本。
 * 这里兼容 UTF 8 BOM、`//` 行注释和块注释，方便配置文件直接写说明。
 */
export function parseJsonText(text) {
  const normalizedText = stripUtf8Bom(String(text ?? ''));
  return JSON.parse(stripJsonComments(normalizedText));
}

function stripUtf8Bom(text) {
  return text.charCodeAt(0) === 0xFEFF
    ? text.slice(1)
    : text;
}

function stripJsonComments(text) {
  let result = '';
  let insideString = false;
  let insideLineComment = false;
  let insideBlockComment = false;
  let isEscaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const currentCharacter = text[index];
    const nextCharacter = text[index + 1];

    if (insideLineComment) {
      if (currentCharacter === '\n' || currentCharacter === '\r') {
        insideLineComment = false;
        result += currentCharacter;
      }
      continue;
    }

    if (insideBlockComment) {
      if (currentCharacter === '*' && nextCharacter === '/') {
        insideBlockComment = false;
        index += 1;
      }
      continue;
    }

    if (insideString) {
      result += currentCharacter;

      if (isEscaped) {
        isEscaped = false;
        continue;
      }

      if (currentCharacter === '\\') {
        isEscaped = true;
        continue;
      }

      if (currentCharacter === '"') {
        insideString = false;
      }

      continue;
    }

    if (currentCharacter === '"') {
      insideString = true;
      result += currentCharacter;
      continue;
    }

    if (currentCharacter === '/' && nextCharacter === '/') {
      insideLineComment = true;
      index += 1;
      continue;
    }

    if (currentCharacter === '/' && nextCharacter === '*') {
      insideBlockComment = true;
      index += 1;
      continue;
    }

    result += currentCharacter;
  }

  return result;
}
