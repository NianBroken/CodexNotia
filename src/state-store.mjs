import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureDirectory, isPlainObject, readJsonFile, writeJsonFile } from './utils.mjs';

const STATE_VERSION = 1;

/**
 * 运行状态存储。
 * 负责管理状态文件、健康文件和服务锁文件的路径与读写。
 */
export class StateStore {
  constructor(stateDir) {
    this.stateDir = stateDir;
    this.stateFilePath = path.join(stateDir, 'service-state.json');
    this.healthFilePath = path.join(stateDir, 'health.json');
    this.lockFilePath = path.join(stateDir, 'service.lock.json');
  }

  /**
   * 初始化内存状态。
   * 如果旧状态版本不兼容，就回退到默认结构。
   */
  async initialize() {
    await ensureDirectory(this.stateDir);
    const loadedState = await this.loadPersistedState();

    if (!isPlainObject(loadedState) || loadedState.version !== STATE_VERSION) {
      this.state = createDefaultState();
      return;
    }

    this.state = {
      ...createDefaultState(),
      ...loadedState,
      files: isPlainObject(loadedState.files) ? loadedState.files : {},
      notifiedTurnKeys: isPlainObject(loadedState.notifiedTurnKeys) ? loadedState.notifiedTurnKeys : {}
    };
  }

  getState() {
    return this.state;
  }

  /**
   * 把当前内存状态写回 `service-state.json`。
   */
  async save() {
    await writeJsonFile(this.stateFilePath, this.state);
  }

  /**
   * 写入 `health.json`。
   * 真正落盘逻辑交给 `Logger` 统一处理。
   */
  async writeHealth(payload, logger) {
    await logger.writeHeartbeat(this.healthFilePath, payload);
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
