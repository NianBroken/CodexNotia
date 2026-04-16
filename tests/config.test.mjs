import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.mjs';
import { createDefaultState, StateStore } from '../src/state-store.mjs';
import { CodexNotiaService } from '../src/service.mjs';

const ISO_OFFSET_TIMESTAMP_PATTERN = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}[+-]\d\d:\d\d$/;

/**
 * 配置、状态存储和运行兜底测试。
 * 这组用例专门锁住默认值解析、坏状态恢复和会话目录暂时缺失时的稳定性。
 */

async function createTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'codexnotia-config-'));
}

test('loadConfig 支持带注释的配置文件，并会归一化相对路径、数字、布尔值和 permanent', async () => {
  const tempDir = await createTempDir();
  const configPath = path.join(tempDir, 'config', 'codexnotia.json');

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, `{
  // 服务层配置
  "service": {
    "pollIntervalMs": "750",
    "staleTurnTimeoutMs": "60000",
    "ignoreHistoricalSessionsOnFirstRun": "false",
    "internalErrorNotifyCooldownMs": "4000",
    "notifiedTurnRetentionMs": "permanent",
    "branchReplayTimeDriftMs": "9000",
    "sessionDirectoryMissingWarnCooldownMs": "3000"
  },
  "startup": {
    "restartCount": "4",
    "restartIntervalSeconds": "9"
  },
  "codex": {
    "homeDir": ".\\\\codex-home",
    "sessionsDir": ".\\\\codex-home\\\\sessions",
    "appLogsDir": ".\\\\codex-app-logs"
  },
  "push": {
    "deviceKey": "device-key",
    "requestTimeoutMs": "1500",
    "maxContentCharacters": "3200",
    "maxEncodedBodyLength": "6500",
    "maxAttempts": "5",
    "retryDelayMs": "120"
  },
  "runtime": {
    "stateDir": ".\\\\runtime\\\\state",
    "logDir": ".\\\\runtime\\\\logs"
  }
}`, 'utf8');

  const config = await loadConfig(configPath);

  assert.equal(config.service.pollIntervalMs, 750);
  assert.equal(config.service.staleTurnTimeoutMs, 60000);
  assert.equal(config.service.ignoreHistoricalSessionsOnFirstRun, false);
  assert.equal(config.service.notifiedTurnRetentionMs, 'permanent');
  assert.equal(config.service.branchReplayTimeDriftMs, 9000);
  assert.equal(config.service.sessionDirectoryMissingWarnCooldownMs, 3000);
  assert.equal(config.startup.restartCount, 4);
  assert.equal(config.push.maxContentCharacters, 3200);
  assert.equal(config.push.maxAttempts, 5);
  assert.equal(config.codex.homeDir, path.join(path.dirname(configPath), 'codex-home'));
  assert.equal(config.codex.sessionsDir, path.join(path.dirname(configPath), 'codex-home', 'sessions'));
  assert.equal(config.codex.appLogsDir, path.join(path.dirname(configPath), 'codex-app-logs'));
  assert.equal(config.runtime.stateDir, path.join(path.dirname(configPath), 'runtime', 'state'));
  assert.equal(config.runtime.logDir, path.join(path.dirname(configPath), 'runtime', 'logs'));
});

test('StateStore 遇到损坏的状态文件时会自动回退并备份坏文件', async () => {
  const stateDir = await createTempDir();
  const store = new StateStore(stateDir);

  await fs.writeFile(store.stateFilePath, '{bad json', 'utf8');
  await store.initialize();

  assert.deepEqual(store.getState(), createDefaultState());

  const stateDirEntries = await fs.readdir(stateDir);
  assert.equal(
    stateDirEntries.some((entry) => entry.startsWith('service-state.json.corrupt-')),
    true
  );
});

test('StateStore 会把旧 UTC 时间戳自动归一化为本地时区偏移格式', async () => {
  const stateDir = await createTempDir();
  const store = new StateStore(stateDir);
  const filePath = path.join(stateDir, 'session.jsonl');

  await fs.writeFile(store.stateFilePath, JSON.stringify({
    version: 1,
    bootstrapComplete: true,
    files: {
      [filePath]: {
        filePath,
        offset: 12,
        remainder: '',
        sessionId: 'session-1',
        originator: 'Codex Desktop',
        source: 'vscode',
        currentTurnId: 'turn-1',
        lastEventAt: '2026-04-16T11:53:27.664Z',
        latestFinalAnswerText: '',
        latestErrorMessage: '',
        turns: {
          'turn-1': {
            startedAt: '2026-04-16T11:43:07.748Z',
            lastEventAt: '2026-04-16T11:53:27.664Z',
            finalAnswerText: '',
            lastErrorMessage: '',
            timeoutSuppressedAt: '2026-04-16T11:43:07.748Z'
          }
        },
        primed: true
      }
    },
    notifiedTurnKeys: {
      'session-1:turn-1:success': '2026-04-16T11:53:27.664Z'
    }
  }, null, 2), 'utf8');

  await store.initialize();

  const state = store.getState();
  const normalizedFileState = state.files[filePath];
  const normalizedTurnState = normalizedFileState.turns['turn-1'];
  const normalizedSentAt = state.notifiedTurnKeys['session-1:turn-1:success'];

  assert.match(normalizedFileState.lastEventAt, ISO_OFFSET_TIMESTAMP_PATTERN);
  assert.match(normalizedTurnState.startedAt, ISO_OFFSET_TIMESTAMP_PATTERN);
  assert.match(normalizedTurnState.lastEventAt, ISO_OFFSET_TIMESTAMP_PATTERN);
  assert.match(normalizedTurnState.timeoutSuppressedAt, ISO_OFFSET_TIMESTAMP_PATTERN);
  assert.match(normalizedSentAt, ISO_OFFSET_TIMESTAMP_PATTERN);
  assert.equal(Date.parse(normalizedFileState.lastEventAt), Date.parse('2026-04-16T11:53:27.664Z'));
  assert.equal(Date.parse(normalizedTurnState.startedAt), Date.parse('2026-04-16T11:43:07.748Z'));
  assert.equal(Date.parse(normalizedSentAt), Date.parse('2026-04-16T11:53:27.664Z'));

  await store.save();

  const persistedState = JSON.parse(await fs.readFile(store.stateFilePath, 'utf8'));
  assert.equal(persistedState.files[filePath].lastEventAt, normalizedFileState.lastEventAt);
  assert.equal(persistedState.files[filePath].turns['turn-1'].startedAt, normalizedTurnState.startedAt);
  assert.equal(
    persistedState.notifiedTurnKeys['session-1:turn-1:success'],
    normalizedSentAt
  );
});

test('会话目录暂时不存在时，服务会继续运行且只记录冷却内的一次警告', async () => {
  const tempDir = await createTempDir();
  const runtimeDir = await createTempDir();
  const missingSessionsDir = path.join(tempDir, 'missing-sessions');
  const config = {
    service: {
      name: 'CodexNotia-Test',
      pollIntervalMs: 250,
      staleTurnTimeoutMs: 60000,
      ignoreHistoricalSessionsOnFirstRun: true,
      internalErrorNotifyCooldownMs: 1000,
      notifiedTurnRetentionMs: 60000,
      branchReplayTimeDriftMs: 5000,
      sessionDirectoryMissingWarnCooldownMs: 60000
    },
    startup: {
      restartCount: 3,
      restartIntervalSeconds: 5
    },
    codex: {
      homeDir: tempDir,
      sessionsDir: missingSessionsDir,
      appLogsDir: path.join(runtimeDir, 'codex-app-logs')
    },
    push: {
      url: 'http://127.0.0.1:9/push/',
      deviceKey: 'test-device',
      level: 'timeSensitive',
      group: 'Codex通知',
      isArchive: '1',
      requestTimeoutMs: 1000,
      maxContentCharacters: 4096,
      maxEncodedBodyLength: 7000,
      maxAttempts: 1,
      retryDelayMs: 10
    },
    runtime: {
      stateDir: path.join(runtimeDir, 'state'),
      logDir: path.join(runtimeDir, 'logs')
    },
    __meta: {
      configPath: path.join(runtimeDir, 'config.json')
    }
  };

  const service = new CodexNotiaService(config);
  await service.stateStore.initialize();

  await service.scanOnce();
  await service.scanOnce();

  const logContent = await fs.readFile(service.logFilePath, 'utf8');
  const warningCount = (logContent.match(/会话目录暂不可用/g) ?? []).length;

  assert.equal(warningCount, 1);
  assert.equal(service.stateStore.getState().bootstrapComplete, false);
});
