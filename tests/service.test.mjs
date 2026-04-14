import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexNotiaService } from '../src/service.mjs';

/**
 * 后台服务状态机测试。
 * 通过临时会话目录和本地假 Bark 服务验证通知触发时机。
 */

async function createTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'codexnotia-'));
}

/**
 * 启动本地假 Bark 服务，并记录所有请求体。
 */
async function startCaptureServer() {
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = '';

    request.on('data', (chunk) => {
      body += chunk.toString();
    });

    request.on('end', () => {
      requests.push(body);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"code":200}');
    });
  });

  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  return {
    requests,
    port: server.address().port,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    }
  };
}

/**
 * 构造测试专用配置。
 * 所有路径都落在临时目录，所有推送都发往本地假服务。
 */
function buildConfig({ sessionsDir, runtimeDir, port }) {
  return {
    service: {
      name: 'CodexNotia-Test',
      pollIntervalMs: 250,
      staleTurnTimeoutMs: 10 * 24 * 60 * 60 * 1000,
      ignoreHistoricalSessionsOnFirstRun: false,
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
      homeDir: sessionsDir,
      sessionsDir,
      appLogsDir: path.join(runtimeDir, 'codex-app-logs')
    },
    push: {
      url: `http://127.0.0.1:${port}/push/`,
      deviceKey: 'test-device',
      level: 'timeSensitive',
      group: 'Codex通知',
      isArchive: '1',
      requestTimeoutMs: 1000,
      maxContentCharacters: 4096,
      maxEncodedBodyLength: 7000,
      maxAttempts: 3,
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
}

async function writeSessionFile(rootDir, name, lines) {
  const dayDir = path.join(rootDir, '2026', '04', '13');
  await fs.mkdir(dayDir, { recursive: true });
  const filePath = path.join(dayDir, name);
  await fs.writeFile(filePath, `${lines.join('\n')}\n`, 'utf8');
  return filePath;
}

/**
 * 写入一份假的 CodexApp 日志文件。
 * 日志目录保持桌面端真实的按日分层结构，方便直接覆盖补抓逻辑。
 */
async function writeCodexAppLog(rootDir, name, lines) {
  const dayDir = path.join(rootDir, '2026', '04', '13');
  await fs.mkdir(dayDir, { recursive: true });
  const filePath = path.join(dayDir, name);
  await fs.writeFile(filePath, `${lines.join('\n')}\n`, 'utf8');
  return filePath;
}

/**
 * 把假 Bark 服务收到的表单正文还原成可直接断言的字段对象。
 */
function parseRequestBody(body) {
  return new URLSearchParams(body);
}

test('只在 task_complete 后发送成功通知', async () => {
  const sessionsDir = await createTempDir();
  const runtimeDir = await createTempDir();
  const capture = await startCaptureServer();

  try {
    const config = buildConfig({ sessionsDir, runtimeDir, port: capture.port });
    config.service.staleTurnTimeoutMs = 10 * 24 * 60 * 60 * 1000;
    const service = new CodexNotiaService(config);
    await service.stateStore.initialize();

    await writeSessionFile(sessionsDir, 'success.jsonl', [
      JSON.stringify({
        timestamp: '2026-04-12T16:39:10.407Z',
        type: 'session_meta',
        payload: {
          id: 'session-1',
          originator: 'Codex Desktop',
          source: 'vscode'
        }
      }),
      JSON.stringify({
        timestamp: '2026-04-12T16:39:21.916Z',
        type: 'event_msg',
        payload: {
          type: 'task_started',
          turn_id: 'turn-1'
        }
      }),
      JSON.stringify({
        timestamp: '2026-04-12T16:40:00.000Z',
        type: 'event_msg',
        payload: {
          type: 'agent_message',
          phase: 'commentary',
          message: '中间状态'
        }
      }),
      JSON.stringify({
        timestamp: '2026-04-12T16:40:30.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          phase: 'final_answer',
          content: [
            { type: 'output_text', text: '最终回答第一句。最终回答第二句。' }
          ]
        }
      }),
      JSON.stringify({
        timestamp: '2026-04-12T16:40:31.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: 'turn-1',
          last_agent_message: '最终回答第一句。最终回答第二句。'
        }
      })
    ]);

    await service.scanOnce();
    await service.scanOnce();

    assert.equal(capture.requests.length, 1);
    assert.ok(capture.requests[0].includes('title=Codex%E5%9B%9E%E7%AD%94%E5%AE%8C%E6%AF%95'));
    assert.ok(capture.requests[0].includes('markdown=%E6%9C%80%E7%BB%88%E5%9B%9E%E7%AD%94%E7%AC%AC%E4%B8%80%E5%8F%A5%E3%80%82%E6%9C%80%E7%BB%88%E5%9B%9E%E7%AD%94%E7%AC%AC%E4%BA%8C%E5%8F%A5%E3%80%82'));

    const logContent = await fs.readFile(service.logFilePath, 'utf8');
    assert.ok(logContent.includes('----------------------------------------'));
    assert.ok(logContent.includes('AI 最终完整消息'));
    assert.ok(logContent.includes('messageLength'));
    assert.ok(logContent.includes('title=Codex回答完毕'));
    assert.ok(logContent.includes('requestBodyEncodedLength'));
    assert.ok(logContent.includes('{"code":200}'));
  } finally {
    await capture.close();
  }
});

test('turn_aborted 会发送错误通知', async () => {
  const sessionsDir = await createTempDir();
  const runtimeDir = await createTempDir();
  const capture = await startCaptureServer();

  try {
    const config = buildConfig({ sessionsDir, runtimeDir, port: capture.port });
    config.service.staleTurnTimeoutMs = 60000;
    const service = new CodexNotiaService(config);
    await service.stateStore.initialize();

    await writeSessionFile(sessionsDir, 'aborted.jsonl', [
      JSON.stringify({
        timestamp: '2026-04-12T16:39:10.407Z',
        type: 'session_meta',
        payload: {
          id: 'session-2',
          originator: 'codex_cli_rs',
          source: 'cli'
        }
      }),
      JSON.stringify({
        timestamp: '2026-04-12T16:39:21.916Z',
        type: 'event_msg',
        payload: {
          type: 'task_started',
          turn_id: 'turn-2'
        }
      }),
      JSON.stringify({
        timestamp: '2026-04-12T16:39:22.916Z',
        type: 'event_msg',
        payload: {
          type: 'turn_aborted',
          turn_id: 'turn-2',
          reason: 'interrupted'
        }
      })
    ]);

    await service.scanOnce();

    assert.equal(capture.requests.length, 1);
    assert.ok(capture.requests[0].includes('title=Codex%E5%87%BA%E7%8E%B0%E9%94%99%E8%AF%AF'));
    assert.ok(capture.requests[0].includes('interrupted'));
  } finally {
    await capture.close();
  }
});

test('中间工具错误不会立刻误发，超时后才发错误通知', async () => {
  const sessionsDir = await createTempDir();
  const runtimeDir = await createTempDir();
  const capture = await startCaptureServer();

  try {
    const config = buildConfig({ sessionsDir, runtimeDir, port: capture.port });
    config.service.staleTurnTimeoutMs = 10 * 24 * 60 * 60 * 1000;
    const service = new CodexNotiaService(config);
    await service.stateStore.initialize();

    const filePath = await writeSessionFile(sessionsDir, 'stale.jsonl', [
      JSON.stringify({
        timestamp: '2026-04-12T16:39:10.407Z',
        type: 'session_meta',
        payload: {
          id: 'session-3',
          originator: 'Codex Desktop',
          source: 'vscode'
        }
      }),
      JSON.stringify({
        timestamp: '2026-04-12T16:39:21.916Z',
        type: 'event_msg',
        payload: {
          type: 'task_started',
          turn_id: 'turn-3'
        }
      }),
      JSON.stringify({
        timestamp: '2026-04-12T16:39:25.000Z',
        type: 'event_msg',
        payload: {
          type: 'mcp_tool_call_end',
          result: {
            Err: 'tool call error: Transport send error'
          }
        }
      })
    ]);

    await service.scanOnce();
    assert.equal(capture.requests.length, 0);

    const state = service.stateStore.getState();
    const fileState = state.files[filePath];
    service.config.service.staleTurnTimeoutMs = 1;
    fileState.turns['turn-3'].lastEventAt = '2026-04-12T16:00:00.000Z';

    await service.checkStaleTurns();

    assert.equal(capture.requests.length, 1);
    assert.ok(capture.requests[0].includes('Transport+send+error'));
  } finally {
    await capture.close();
  }
});

test('超时错误通知的副标题使用超时真正发生的时间', async () => {
  const sessionsDir = await createTempDir();
  const runtimeDir = await createTempDir();
  const capture = await startCaptureServer();

  try {
    const config = buildConfig({ sessionsDir, runtimeDir, port: capture.port });
    config.service.staleTurnTimeoutMs = 10 * 24 * 60 * 60 * 1000;
    const service = new CodexNotiaService(config);
    await service.stateStore.initialize();

    const filePath = await writeSessionFile(sessionsDir, 'stale-subtitle.jsonl', [
      JSON.stringify({
        timestamp: '2026-04-12T16:39:10.000Z',
        type: 'session_meta',
        payload: {
          id: 'session-stale-subtitle',
          originator: 'Codex Desktop',
          source: 'vscode'
        }
      }),
      JSON.stringify({
        timestamp: '2026-04-12T16:39:21.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_started',
          turn_id: 'turn-stale-subtitle'
        }
      })
    ]);

    await service.scanOnce();

    const state = service.stateStore.getState();
    const fileState = state.files[filePath];
    service.config.service.staleTurnTimeoutMs = 5000;
    fileState.turns['turn-stale-subtitle'].lastEventAt = '2026-04-12T16:40:00.000Z';

    await service.checkStaleTurns();

    assert.equal(capture.requests.length, 1);
    const requestBody = parseRequestBody(capture.requests[0]);
    assert.equal(requestBody.get('subtitle'), '2026-04-13 00:40:05');
  } finally {
    await capture.close();
  }
});

test('没有已知 turn 状态时，task_complete 仍然会发送成功通知', async () => {
  const sessionsDir = await createTempDir();
  const runtimeDir = await createTempDir();
  const capture = await startCaptureServer();

  try {
    const config = buildConfig({ sessionsDir, runtimeDir, port: capture.port });
    const service = new CodexNotiaService(config);
    await service.stateStore.initialize();

    await writeSessionFile(sessionsDir, 'late-complete.jsonl', [
      JSON.stringify({
        timestamp: '2026-04-12T16:39:10.407Z',
        type: 'session_meta',
        payload: {
          id: 'session-4',
          originator: 'Codex Desktop',
          source: 'vscode'
        }
      }),
      JSON.stringify({
        timestamp: '2026-04-12T16:40:31.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: 'turn-4',
          last_agent_message: '补偿完成第一句。补偿完成第二句。'
        }
      })
    ]);

    await service.scanOnce();

    assert.equal(capture.requests.length, 1);
    assert.ok(capture.requests[0].includes('%E8%A1%A5%E5%81%BF%E5%AE%8C%E6%88%90%E7%AC%AC%E4%B8%80%E5%8F%A5'));
  } finally {
    await capture.close();
  }
});

/**
 * 这组测试专门覆盖“最终结束事件本身是 `task_complete`，
 * 但实际应该按错误场景处理”的情况。
 * 这些分支都是结束分类里最容易误判的情况。
 * 1. 没有最终回答内容。
 * 2. 结束前已经收到明确错误文本。
 * 3. 结束事件自己就带着失败字段。
 */
test('task_complete 缺少最终回答内容时会改走错误通知', async () => {
  const sessionsDir = await createTempDir();
  const runtimeDir = await createTempDir();
  const capture = await startCaptureServer();

  try {
    const config = buildConfig({ sessionsDir, runtimeDir, port: capture.port });
    const service = new CodexNotiaService(config);
    await service.stateStore.initialize();

    await writeSessionFile(sessionsDir, 'missing-final-answer.jsonl', [
      JSON.stringify({
        timestamp: '2026-04-12T18:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'session-missing-final',
          originator: 'Codex Desktop',
          source: 'exec'
        }
      }),
      JSON.stringify({
        timestamp: '2026-04-12T18:00:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_started',
          turn_id: 'turn-missing-final'
        }
      }),
      JSON.stringify({
        timestamp: '2026-04-12T18:00:10.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: 'turn-missing-final',
          last_agent_message: null
        }
      })
    ]);

    await service.scanOnce();

    assert.equal(capture.requests.length, 1);
    const requestBody = parseRequestBody(capture.requests[0]);
    assert.equal(requestBody.get('title'), 'Codex出现错误');
    assert.equal(requestBody.get('markdown'), 'Codex 在最终回答完成前终止。结束事件未携带最终回答内容。');
  } finally {
    await capture.close();
  }
});

/**
 * 验证 CodexApp 会话文件本身没有错误正文时，
 * 系统会回退到 Electron 日志里的结构化 `error={...}` 字段。
 */
test('CodexApp 的 task_complete 会回退读取 App 日志里的结构化错误正文', async () => {
  const sessionsDir = await createTempDir();
  const runtimeDir = await createTempDir();
  const capture = await startCaptureServer();

  try {
    const config = buildConfig({ sessionsDir, runtimeDir, port: capture.port });
    const service = new CodexNotiaService(config);
    await service.stateStore.initialize();

    await writeSessionFile(sessionsDir, 'task-complete-app-log-json.jsonl', [
      JSON.stringify({
        timestamp: '2026-04-13T10:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'session-app-log-json',
          originator: 'Codex Desktop',
          source: 'vscode'
        }
      }),
      JSON.stringify({
        timestamp: '2026-04-13T10:00:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_started',
          turn_id: 'turn-app-log-json'
        }
      }),
      JSON.stringify({
        timestamp: '2026-04-13T10:00:10.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: 'turn-app-log-json',
          last_agent_message: null
        }
      })
    ]);

    await writeCodexAppLog(config.codex.appLogsDir, 'codex-desktop-test-json.log', [
      '2026-04-13T10:00:04.000Z info [electron-message-handler] [desktop-notifications] show turn-complete conversationId=other-session turnId=other-turn',
      '2026-04-13T10:00:05.000Z error [electron-message-handler] Request failed conversationId=session-app-log-json durationMs=51 error={"code":-32603,"message":"sqlite state db unavailable for thread session-app-log-json"} id=42e5fa1b method=thread/metadata/update pendingCountAfter=0 timeoutMs=0'
    ]);

    await service.scanOnce();

    assert.equal(capture.requests.length, 1);
    const requestBody = parseRequestBody(capture.requests[0]);
    assert.equal(requestBody.get('title'), 'Codex出现错误');
    assert.equal(
      requestBody.get('markdown'),
      'sqlite state db unavailable for thread session-app-log-json [code: -32603]'
    );
  } finally {
    await capture.close();
  }
});

/**
 * 验证 CodexApp 会话文件本身没有错误正文时，
 * 系统也会回退读取 Electron 日志里的 `errorMessage="..."` 字段。
 */
test('CodexApp 的 task_complete 会回退读取 App 日志里的 errorMessage 正文', async () => {
  const sessionsDir = await createTempDir();
  const runtimeDir = await createTempDir();
  const capture = await startCaptureServer();

  try {
    const config = buildConfig({ sessionsDir, runtimeDir, port: capture.port });
    const service = new CodexNotiaService(config);
    await service.stateStore.initialize();

    await writeSessionFile(sessionsDir, 'task-complete-app-log-quoted.jsonl', [
      JSON.stringify({
        timestamp: '2026-04-13T10:05:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'session-app-log-quoted',
          originator: 'Codex Desktop',
          source: 'exec'
        }
      }),
      JSON.stringify({
        timestamp: '2026-04-13T10:05:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_started',
          turn_id: 'turn-app-log-quoted'
        }
      }),
      JSON.stringify({
        timestamp: '2026-04-13T10:05:47.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: 'turn-app-log-quoted',
          last_agent_message: null
        }
      })
    ]);

    await writeCodexAppLog(config.codex.appLogsDir, 'codex-desktop-test-quoted.log', [
      '2026-04-13T10:05:20.000Z info [electron-message-handler] maybe_resume_success conversationId=session-app-log-quoted latestTurnStatus=completed',
      '2026-04-13T10:05:46.486Z warning [AppServerConnection] Failed to resume thread for automation archive errorMessage="no rollout found for thread id session-app-log-quoted" errorName=Error threadId=session-app-log-quoted'
    ]);

    await service.scanOnce();

    assert.equal(capture.requests.length, 1);
    const requestBody = parseRequestBody(capture.requests[0]);
    assert.equal(requestBody.get('title'), 'Codex出现错误');
    assert.equal(
      requestBody.get('markdown'),
      'Failed to resume thread for automation archive: no rollout found for thread id session-app-log-quoted'
    );
  } finally {
    await capture.close();
  }
});

/**
 * 验证没有 `turn_aborted` 时，之前收集到的真实运行时错误
 * 也能在结束阶段把通知拉回错误分支。
 * 这里直接使用真实出现过的 `503 Service Unavailable` 文本做回归样本，
 * 目的是锁住这次实际故障对应的收尾路径。
 */
test('task_complete 前收集到真实错误文本时会发送对应错误通知', async () => {
  const sessionsDir = await createTempDir();
  const runtimeDir = await createTempDir();
  const capture = await startCaptureServer();

  try {
    const config = buildConfig({ sessionsDir, runtimeDir, port: capture.port });
    const service = new CodexNotiaService(config);
    await service.stateStore.initialize();
    const errorText = 'unexpected status 503 Service Unavailable: Service temporarily unavailable, url: https://codex.ciii.club/responses, cf-ray: 9ebd7267aae30976-HKG, request id: 5d3408ac-cb46-4a79-bfc2-5e2cb40284c4';

    await writeSessionFile(sessionsDir, 'task-complete-runtime-error.jsonl', [
      JSON.stringify({
        timestamp: '2026-04-12T18:10:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'session-runtime-error',
          originator: 'codex_cli_rs',
          source: 'cli'
        }
      }),
      JSON.stringify({
        timestamp: '2026-04-12T18:10:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_started',
          turn_id: 'turn-runtime-error'
        }
      }),
      JSON.stringify({
        timestamp: '2026-04-12T18:10:05.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          output: errorText
        }
      }),
      JSON.stringify({
        timestamp: '2026-04-12T18:10:08.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: 'turn-runtime-error',
          last_agent_message: null
        }
      })
    ]);

    await service.scanOnce();

    assert.equal(capture.requests.length, 1);
    const requestBody = parseRequestBody(capture.requests[0]);
    assert.equal(requestBody.get('title'), 'Codex出现错误');
    assert.equal(requestBody.get('markdown'), errorText);
  } finally {
    await capture.close();
  }
});

/**
 * 验证结束事件显式携带失败字段时，不依赖其他中间事件，
 * 服务也能直接识别为错误场景并发送对应错误通知。
 */
test('task_complete 自带失败字段时会发送真实错误通知', async () => {
  const sessionsDir = await createTempDir();
  const runtimeDir = await createTempDir();
  const capture = await startCaptureServer();

  try {
    const config = buildConfig({ sessionsDir, runtimeDir, port: capture.port });
    const service = new CodexNotiaService(config);
    await service.stateStore.initialize();

    await writeSessionFile(sessionsDir, 'task-complete-explicit-error.jsonl', [
      JSON.stringify({
        timestamp: '2026-04-12T18:20:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'session-explicit-error',
          originator: 'Codex Desktop',
          source: 'vscode'
        }
      }),
      JSON.stringify({
        timestamp: '2026-04-12T18:20:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_started',
          turn_id: 'turn-explicit-error'
        }
      }),
      JSON.stringify({
        timestamp: '2026-04-12T18:20:09.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: 'turn-explicit-error',
          status: 'failed',
          error_message: 'network error: upstream service unavailable',
          last_agent_message: null
        }
      })
    ]);

    await service.scanOnce();

    assert.equal(capture.requests.length, 1);
    const requestBody = parseRequestBody(capture.requests[0]);
    assert.equal(requestBody.get('title'), 'Codex出现错误');
    assert.equal(requestBody.get('markdown'), 'network error: upstream service unavailable');
  } finally {
    await capture.close();
  }
});

/**
 * 验证 Codex 原生错误事件会被收集到当前 turn 的错误上下文里。
 * 真实线上 `401` 和同类网络错误就是这条路径，如果这里漏掉，
 * 后面的 `task_complete` 就只能退回固定兜底文案。
 */
test('event_msg error 会让后续 task_complete 发送真实错误正文', async () => {
  const sessionsDir = await createTempDir();
  const runtimeDir = await createTempDir();
  const capture = await startCaptureServer();

  try {
    const config = buildConfig({ sessionsDir, runtimeDir, port: capture.port });
    const service = new CodexNotiaService(config);
    await service.stateStore.initialize();
    const errorText = 'unexpected status 401 Unauthorized: {"code":"API_KEY_DISABLED","message":"API key is disabled"}, url: https://codex.ciii.club/responses, cf-ray: 9ebdbc618dd6dd8a-HKG, request id: d5382e50-4f3a-48a5-82df-a97926dfe35f';

    await writeSessionFile(sessionsDir, 'task-complete-codex-error-event.jsonl', [
      JSON.stringify({
        timestamp: '2026-04-12T18:30:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'session-codex-error-event',
          originator: 'codex_cli_rs',
          source: 'cli'
        }
      }),
      JSON.stringify({
        timestamp: '2026-04-12T18:30:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_started',
          turn_id: 'turn-codex-error-event'
        }
      }),
      JSON.stringify({
        timestamp: '2026-04-12T18:30:05.000Z',
        type: 'event_msg',
        payload: {
          type: 'error',
          message: errorText,
          codex_error_info: 'other'
        }
      }),
      JSON.stringify({
        timestamp: '2026-04-12T18:30:06.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: 'turn-codex-error-event',
          last_agent_message: null
        }
      })
    ]);

    await service.scanOnce();

    assert.equal(capture.requests.length, 1);
    const requestBody = parseRequestBody(capture.requests[0]);
    assert.equal(requestBody.get('title'), 'Codex出现错误');
    assert.equal(requestBody.get('markdown'), errorText);
  } finally {
    await capture.close();
  }
});

/**
 * 验证 CodexApp 下工具输出只要带着明确失败正文，
 * 即使不是 `event_msg error`，结束阶段也会优先发送真实错误内容。
 */
test('CodexApp 的非零退出工具输出会让 task_complete 发送真实错误正文', async () => {
  const sessionsDir = await createTempDir();
  const runtimeDir = await createTempDir();
  const capture = await startCaptureServer();

  try {
    const config = buildConfig({ sessionsDir, runtimeDir, port: capture.port });
    const service = new CodexNotiaService(config);
    await service.stateStore.initialize();
    const errorText = 'Access is denied.';

    await writeSessionFile(sessionsDir, 'task-complete-app-tool-error.jsonl', [
      JSON.stringify({
        timestamp: '2026-04-12T18:40:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'session-app-tool-error',
          originator: 'Codex Desktop',
          source: 'vscode'
        }
      }),
      JSON.stringify({
        timestamp: '2026-04-12T18:40:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_started',
          turn_id: 'turn-app-tool-error'
        }
      }),
      JSON.stringify({
        timestamp: '2026-04-12T18:40:05.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          output: `Exit code: 1\nWall time: 2.1 seconds\nOutput:\n${errorText}\nAt line:1 char:1\n+ demo`
        }
      }),
      JSON.stringify({
        timestamp: '2026-04-12T18:40:06.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: 'turn-app-tool-error',
          last_agent_message: null
        }
      })
    ]);

    await service.scanOnce();

    assert.equal(capture.requests.length, 1);
    const requestBody = parseRequestBody(capture.requests[0]);
    assert.equal(requestBody.get('title'), 'Codex出现错误');
    assert.equal(requestBody.get('markdown'), `${errorText}\nAt line:1 char:1\n+ demo`);
  } finally {
    await capture.close();
  }
});

/**
 * 验证 CodexApp 下工具输出即使退出码是 0，
 * 只要正文里已经有 PowerShell 异常信息，系统也会提取真实错误内容。
 */
test('CodexApp 的 PowerShell 异常工具输出会让 task_complete 发送真实错误正文', async () => {
  const sessionsDir = await createTempDir();
  const runtimeDir = await createTempDir();
  const capture = await startCaptureServer();

  try {
    const config = buildConfig({ sessionsDir, runtimeDir, port: capture.port });
    const service = new CodexNotiaService(config);
    await service.stateStore.initialize();
    const errorText = [
      'Cannot overwrite variable PID because it is read-only or constant.',
      'At line:13 char:288',
      '+ ... [void][WinEnum]::GetWindowText($h,$sb,$sb.Capacity); $pid = 0; [void] ...',
      '+                                                          ~~~~~~~~',
      'CategoryInfo          : WriteError: (PID:String) [], SessionStateUnauthorizedAccessException',
      'FullyQualifiedErrorId : VariableNotWritable'
    ].join('\n');

    await writeSessionFile(sessionsDir, 'task-complete-app-powershell-error.jsonl', [
      JSON.stringify({
        timestamp: '2026-04-12T18:50:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'session-app-powershell-error',
          originator: 'Codex Desktop',
          source: 'vscode'
        }
      }),
      JSON.stringify({
        timestamp: '2026-04-12T18:50:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_started',
          turn_id: 'turn-app-powershell-error'
        }
      }),
      JSON.stringify({
        timestamp: '2026-04-12T18:50:05.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          output: `Exit code: 0\nWall time: 7.5 seconds\nOutput:\n${errorText}`
        }
      }),
      JSON.stringify({
        timestamp: '2026-04-12T18:50:06.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: 'turn-app-powershell-error',
          last_agent_message: null
        }
      })
    ]);

    await service.scanOnce();

    assert.equal(capture.requests.length, 1);
    const requestBody = parseRequestBody(capture.requests[0]);
    assert.equal(requestBody.get('title'), 'Codex出现错误');
    assert.equal(requestBody.get('markdown'), errorText);
  } finally {
    await capture.close();
  }
});

/**
 * 验证项目自身错误通知不会误用 Codex 成功标题。
 * 这条测试和业务会话无关，只检查内部异常路径的标题规则。
 */
test('项目内部异常通知使用项目名作为标题', async () => {
  const sessionsDir = await createTempDir();
  const runtimeDir = await createTempDir();
  const capture = await startCaptureServer();

  try {
    const config = buildConfig({ sessionsDir, runtimeDir, port: capture.port });
    const service = new CodexNotiaService(config);
    await service.stateStore.initialize();

    await service.reportInternalError('测试内部异常', new Error('内部错误消息'));

    assert.equal(capture.requests.length, 1);
    assert.ok(capture.requests[0].includes('title=CodexNotia'));
    assert.ok(capture.requests[0].includes('%E5%86%85%E9%83%A8%E9%94%99%E8%AF%AF%E6%B6%88%E6%81%AF'));
  } finally {
    await capture.close();
  }
});

/**
 * 验证历史基线中的旧完成事件不会在首次纳管时被重放成新通知。
 * 这个场景对应分支创建或服务中途接管已有会话文件时的历史内容。
 */
test('新文件首次发现时，已有历史完成事件不会触发通知', async () => {
  const sessionsDir = await createTempDir();
  const runtimeDir = await createTempDir();
  const capture = await startCaptureServer();

  try {
    const config = buildConfig({ sessionsDir, runtimeDir, port: capture.port });
    config.service.staleTurnTimeoutMs = 10 * 24 * 60 * 60 * 1000;
    const service = new CodexNotiaService(config);
    await service.stateStore.initialize();
    service.stateStore.getState().bootstrapComplete = true;

    const filePath = await writeSessionFile(sessionsDir, 'branch-history.jsonl', [
      JSON.stringify({
        timestamp: '2026-04-13T10:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'session-branch',
          originator: 'Codex Desktop',
          source: 'vscode'
        }
      }),
      JSON.stringify({
        timestamp: '2026-04-13T10:00:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_started',
          turn_id: 'turn-history-1'
        }
      }),
      JSON.stringify({
        timestamp: '2026-04-13T10:00:02.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          phase: 'final_answer',
          content: [
            { type: 'output_text', text: '历史回答一。' }
          ]
        }
      }),
      JSON.stringify({
        timestamp: '2026-04-13T10:00:03.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: 'turn-history-1',
          last_agent_message: '历史回答一。'
        }
      }),
      JSON.stringify({
        timestamp: '2026-04-13T10:00:04.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_started',
          turn_id: 'turn-history-2'
        }
      }),
      JSON.stringify({
        timestamp: '2026-04-13T10:00:05.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          phase: 'final_answer',
          content: [
            { type: 'output_text', text: '历史回答二。' }
          ]
        }
      }),
      JSON.stringify({
        timestamp: '2026-04-13T10:00:06.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: 'turn-history-2',
          last_agent_message: '历史回答二。'
        }
      })
    ]);

    await service.scanOnce();
    assert.equal(capture.requests.length, 0);

    await fs.appendFile(filePath, [
      JSON.stringify({
        timestamp: '2026-04-13T10:01:00.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_started',
          turn_id: 'turn-live-1'
        }
      }),
      JSON.stringify({
        timestamp: '2026-04-13T10:01:01.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          phase: 'final_answer',
          content: [
            { type: 'output_text', text: '分支后的新回答。' }
          ]
        }
      }),
      JSON.stringify({
        timestamp: '2026-04-13T10:01:02.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: 'turn-live-1',
          last_agent_message: '分支后的新回答。'
        }
      }),
      ''
    ].join('\n'), 'utf8');

    await service.scanOnce();

    assert.equal(capture.requests.length, 1);
    assert.ok(capture.requests[0].includes('%E5%88%86%E6%94%AF%E5%90%8E%E7%9A%84%E6%96%B0%E5%9B%9E%E7%AD%94'));
  } finally {
    await capture.close();
  }
});

/**
 * 验证历史基线里已经开始但尚未结束的活动 turn，
 * 在后续真实完成时仍然能正常补齐成功通知。
 * 这个测试确保“忽略历史通知”和“继续跟踪活动 turn”可以同时成立。
 */
test('历史基线中的活动 turn 可以被后续真实完成事件继续跟踪', async () => {
  const sessionsDir = await createTempDir();
  const runtimeDir = await createTempDir();
  const capture = await startCaptureServer();

  try {
    const config = buildConfig({ sessionsDir, runtimeDir, port: capture.port });
    config.service.staleTurnTimeoutMs = 10 * 24 * 60 * 60 * 1000;
    const service = new CodexNotiaService(config);
    await service.stateStore.initialize();
    service.stateStore.getState().bootstrapComplete = true;

    const filePath = await writeSessionFile(sessionsDir, 'active-turn.jsonl', [
      JSON.stringify({
        timestamp: '2026-04-13T11:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'session-active',
          originator: 'Codex Desktop',
          source: 'vscode'
        }
      }),
      JSON.stringify({
        timestamp: '2026-04-13T11:00:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_started',
          turn_id: 'turn-active-1'
        }
      })
    ]);

    await service.scanOnce();
    assert.equal(capture.requests.length, 0);

    await fs.appendFile(filePath, [
      JSON.stringify({
        timestamp: '2026-04-13T11:00:10.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          phase: 'final_answer',
          content: [
            { type: 'output_text', text: '活动 turn 完成。' }
          ]
        }
      }),
      JSON.stringify({
        timestamp: '2026-04-13T11:00:11.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: 'turn-active-1',
          last_agent_message: '活动 turn 完成。'
        }
      }),
      ''
    ].join('\n'), 'utf8');

    await service.scanOnce();

    assert.equal(capture.requests.length, 1);
    assert.ok(capture.requests[0].includes('%E6%B4%BB%E5%8A%A8+turn+%E5%AE%8C%E6%88%90'));
  } finally {
    await capture.close();
  }
});

/**
 * 验证历史基线中的旧错误结束事件不会在首次纳管时被重放。
 * 后续真正写入的新错误结束事件仍然必须正常触发一次错误通知。
 */
test('新文件首次发现时，已有历史错误结束事件不会触发通知', async () => {
  const sessionsDir = await createTempDir();
  const runtimeDir = await createTempDir();
  const capture = await startCaptureServer();

  try {
    const config = buildConfig({ sessionsDir, runtimeDir, port: capture.port });
    const service = new CodexNotiaService(config);
    await service.stateStore.initialize();
    service.stateStore.getState().bootstrapComplete = true;

    const filePath = await writeSessionFile(sessionsDir, 'branch-error-history.jsonl', [
      JSON.stringify({
        timestamp: '2026-04-13T12:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'session-error-branch',
          originator: 'Codex Desktop',
          source: 'vscode'
        }
      }),
      JSON.stringify({
        timestamp: '2026-04-13T12:00:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_started',
          turn_id: 'turn-error-history'
        }
      }),
      JSON.stringify({
        timestamp: '2026-04-13T12:00:02.000Z',
        type: 'event_msg',
        payload: {
          type: 'turn_aborted',
          turn_id: 'turn-error-history',
          reason: 'interrupted'
        }
      })
    ]);

    await service.scanOnce();
    assert.equal(capture.requests.length, 0);

    await fs.appendFile(filePath, [
      JSON.stringify({
        timestamp: '2026-04-13T12:01:00.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_started',
          turn_id: 'turn-error-live'
        }
      }),
      JSON.stringify({
        timestamp: '2026-04-13T12:01:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'turn_aborted',
          turn_id: 'turn-error-live',
          reason: 'interrupted'
        }
      }),
      ''
    ].join('\n'), 'utf8');

    await service.scanOnce();

    assert.equal(capture.requests.length, 1);
    assert.ok(capture.requests[0].includes('title=Codex%E5%87%BA%E7%8E%B0%E9%94%99%E8%AF%AF'));
  } finally {
    await capture.close();
  }
});

/**
 * 验证已经读过的文件后续如果插入旧时间戳分支历史，不会把这些旧结束事件重新当成新通知。
 * 这个场景覆盖的是在已有会话上从很久以前的节点重新分支，客户端把旧历史重新写入当前文件尾部。
 */
test('已纳管文件追加旧分支历史时，不会重放旧通知', async () => {
  const sessionsDir = await createTempDir();
  const runtimeDir = await createTempDir();
  const capture = await startCaptureServer();

  try {
    const config = buildConfig({ sessionsDir, runtimeDir, port: capture.port });
    config.service.notifiedTurnRetentionMs = 0;
    config.service.branchReplayTimeDriftMs = 1000;
    const service = new CodexNotiaService(config);
    await service.stateStore.initialize();

    const filePath = await writeSessionFile(sessionsDir, 'branch-replay-live.jsonl', [
      JSON.stringify({
        timestamp: '2026-04-13T13:10:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'session-branch-replay-live',
          originator: 'Codex Desktop',
          source: 'vscode'
        }
      }),
      JSON.stringify({
        timestamp: '2026-04-13T13:10:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_started',
          turn_id: 'turn-live-initial'
        }
      }),
      JSON.stringify({
        timestamp: '2026-04-13T13:10:02.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          phase: 'final_answer',
          content: [
            { type: 'output_text', text: '当前时间线的首次回答。' }
          ]
        }
      }),
      JSON.stringify({
        timestamp: '2026-04-13T13:10:03.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: 'turn-live-initial',
          last_agent_message: '当前时间线的首次回答。'
        }
      })
    ]);

    await service.scanOnce();
    assert.equal(capture.requests.length, 1);
    service.stateStore.getState().notifiedTurnKeys = {};

    await fs.appendFile(filePath, [
      JSON.stringify({
        timestamp: '2026-04-13T12:00:00.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_started',
          turn_id: 'turn-branch-history'
        }
      }),
      JSON.stringify({
        timestamp: '2026-04-13T12:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          phase: 'final_answer',
          content: [
            { type: 'output_text', text: '旧分支历史回答。' }
          ]
        }
      }),
      JSON.stringify({
        timestamp: '2026-04-13T12:00:02.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: 'turn-branch-history',
          last_agent_message: '旧分支历史回答。'
        }
      }),
      JSON.stringify({
        timestamp: '2026-04-13T13:12:00.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_started',
          turn_id: 'turn-live-after-branch'
        }
      }),
      JSON.stringify({
        timestamp: '2026-04-13T13:12:01.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          phase: 'final_answer',
          content: [
            { type: 'output_text', text: '分支后的真正新回答。' }
          ]
        }
      }),
      JSON.stringify({
        timestamp: '2026-04-13T13:12:02.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: 'turn-live-after-branch',
          last_agent_message: '分支后的真正新回答。'
        }
      }),
      ''
    ].join('\n'), 'utf8');

    await service.scanOnce();

    assert.equal(capture.requests.length, 2);
    const requestBody = parseRequestBody(capture.requests[1]);
    assert.equal(requestBody.get('markdown'), '分支后的真正新回答。');
  } finally {
    await capture.close();
  }
});

/**
 * 验证永久去重配置不会清掉旧通知键。
 * 这个能力用来避免很久以前已经通知过的 turn 在未来被再次补发。
 */
test('notifiedTurnRetentionMs 设为 permanent 时不会清理已通知键', async () => {
  const sessionsDir = await createTempDir();
  const runtimeDir = await createTempDir();
  const capture = await startCaptureServer();

  try {
    const config = buildConfig({ sessionsDir, runtimeDir, port: capture.port });
    config.service.notifiedTurnRetentionMs = 'permanent';
    const service = new CodexNotiaService(config);
    await service.stateStore.initialize();
    service.stateStore.getState().notifiedTurnKeys['session-1:turn-1:success'] = '2020-01-01T00:00:00.000Z';

    service.pruneNotifiedTurnKeys();

    assert.deepEqual(service.stateStore.getState().notifiedTurnKeys, {
      'session-1:turn-1:success': '2020-01-01T00:00:00.000Z'
    });
  } finally {
    await capture.close();
  }
});
