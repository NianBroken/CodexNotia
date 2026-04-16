import fs from 'node:fs/promises';
import path from 'node:path';
import {
  createJsonSnapshot,
  ensureDirectory,
  isPlainObject,
  normalizeTimestamp,
  readJsonFile,
  writeJsonFile
} from './utils.mjs';

const STATE_VERSION = 1;

/**
 * 运行状态存储。
 * 负责管理状态文件、健康文件和服务锁文件的路径与读写。
 * 真正落盘前会先比对内容，只在内容变化时才写盘。
 */
export class StateStore {
  constructor(stateDir) {
    this.stateDir = stateDir;
    this.stateFilePath = path.join(stateDir, 'service-state.json');
    this.healthFilePath = path.join(stateDir, 'health.json');
    this.lockFilePath = path.join(stateDir, 'service.lock.json');
    this.state = createDefaultState();
    this.persistedStateSnapshot = createJsonSnapshot(this.state);
    this.persistedHealthSnapshot = '';
    this.hasPersistedState = false;
    this.hasPersistedHealth = false;
  }

  /**
   * 初始化内存状态。
   * 如果旧状态版本不兼容，就回退到默认结构。
   * 如果加载后的规范化结果和磁盘原始内容不同，后续第一次 `save` 会自动补齐。
   */
  async initialize() {
    await ensureDirectory(this.stateDir);
    const loadedState = await this.loadPersistedState();
    const hasCompatibleState = isPlainObject(loadedState) && loadedState.version === STATE_VERSION;

    if (!hasCompatibleState) {
      this.state = createDefaultState();
      this.persistedStateSnapshot = createJsonSnapshot(this.state);
      this.hasPersistedState = false;
      return;
    }

    const normalizedLoadedState = normalizePersistedStateTimestamps(loadedState);
    this.state = {
      ...createDefaultState(),
      ...normalizedLoadedState,
      files: isPlainObject(normalizedLoadedState.files) ? normalizedLoadedState.files : {},
      notifiedTurnKeys: isPlainObject(normalizedLoadedState.notifiedTurnKeys)
        ? normalizedLoadedState.notifiedTurnKeys
        : {}
    };
    this.persistedStateSnapshot = createJsonSnapshot(loadedState);
    this.hasPersistedState = true;
  }

  getState() {
    return this.state;
  }

  /**
   * 把当前内存状态写回 `service-state.json`。
   * 只有序列化结果发生变化时才真正落盘。
   */
  async save(options = {}) {
    const { force = false } = options;
    const nextSnapshot = createJsonSnapshot(this.state);

    if (
      !force
      && nextSnapshot === this.persistedStateSnapshot
      && (!this.hasPersistedState || await filePathExists(this.stateFilePath))
    ) {
      return false;
    }

    await writeJsonFile(this.stateFilePath, this.state);
    this.persistedStateSnapshot = nextSnapshot;
    this.hasPersistedState = true;
    return true;
  }

  /**
   * 写入 `health.json`。
   * 只有运行快照内容变化时才真正落盘。
   */
  async writeHealth(payload, logger, options = {}) {
    const { force = false } = options;
    const nextSnapshot = createJsonSnapshot(payload);

    if (
      !force
      && nextSnapshot === this.persistedHealthSnapshot
      && (!this.hasPersistedHealth || await filePathExists(this.healthFilePath))
    ) {
      return false;
    }

    await logger.writeHeartbeat(this.healthFilePath, payload);
    this.persistedHealthSnapshot = nextSnapshot;
    this.hasPersistedHealth = true;
    return true;
  }

  /**
   * 读取持久化状态。
   * 状态文件损坏时会自动备份坏文件并回退到默认状态，避免服务因为单个坏文件无法启动。
   */
  async loadPersistedState() {
    try {
      return await readJsonFile(this.stateFilePath, createDefaultState());
    } catch (error) {
      if (!(error instanceof SyntaxError)) {
        throw error;
      }

      const backupPath = `${this.stateFilePath}.corrupt-${Date.now()}.json`;
      await fs.rename(this.stateFilePath, backupPath).catch(async () => {
        const content = await fs.readFile(this.stateFilePath, 'utf8').catch(() => '');
        await writeJsonFile(backupPath, {
          reason: '状态文件 JSON 损坏，已自动备份',
          content
        });
        await fs.unlink(this.stateFilePath).catch(() => {
        });
      });
      return createDefaultState();
    }
  }
}

/**
 * 生成默认状态结构。
 */
export function createDefaultState() {
  return {
    version: STATE_VERSION,
    bootstrapComplete: false,
    files: {},
    notifiedTurnKeys: {}
  };
}

async function filePathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * 把持久化状态里的项目自有时间字段统一迁正。
 * 这里只处理状态结构中的时间字段，不碰最终回答等业务正文。
 */
function normalizePersistedStateTimestamps(state) {
  const normalizedState = {
    ...state,
    files: isPlainObject(state.files) ? {} : state.files,
    notifiedTurnKeys: isPlainObject(state.notifiedTurnKeys) ? {} : state.notifiedTurnKeys
  };

  if (isPlainObject(state.notifiedTurnKeys)) {
    normalizedState.notifiedTurnKeys = Object.fromEntries(
      Object.entries(state.notifiedTurnKeys).map(([notificationKey, sentAt]) => {
        return [notificationKey, normalizeTimestamp(sentAt, sentAt)];
      })
    );
  }

  if (isPlainObject(state.files)) {
    normalizedState.files = Object.fromEntries(
      Object.entries(state.files).map(([filePath, fileState]) => {
        return [filePath, normalizeFileStateTimestamps(fileState)];
      })
    );
  }

  return normalizedState;
}

/**
 * 归一化单个文件状态里的时间字段。
 */
function normalizeFileStateTimestamps(fileState) {
  if (!isPlainObject(fileState)) {
    return fileState;
  }

  const normalizedFileState = {
    ...fileState,
    lastEventAt: normalizeTimestamp(fileState.lastEventAt, fileState.lastEventAt)
  };

  if (isPlainObject(fileState.turns)) {
    normalizedFileState.turns = Object.fromEntries(
      Object.entries(fileState.turns).map(([turnId, turnState]) => {
        return [turnId, normalizeTurnStateTimestamps(turnState)];
      })
    );
  }

  return normalizedFileState;
}

/**
 * 归一化单个 turn 状态里的时间字段。
 */
function normalizeTurnStateTimestamps(turnState) {
  if (!isPlainObject(turnState)) {
    return turnState;
  }

  return {
    ...turnState,
    startedAt: normalizeTimestamp(turnState.startedAt, turnState.startedAt),
    lastEventAt: normalizeTimestamp(turnState.lastEventAt, turnState.lastEventAt),
    timeoutSuppressedAt: normalizeTimestamp(turnState.timeoutSuppressedAt, turnState.timeoutSuppressedAt)
  };
}
