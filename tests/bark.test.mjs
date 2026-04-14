import http from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildErrorNotification,
  buildSuccessNotification,
  pushToBark,
  truncateMarkdownText
} from '../src/bark.mjs';
import { getCharacterLength } from '../src/utils.mjs';

/**
 * Bark 层回归测试。
 * 主要覆盖正文截断、标题场景切换和失败重试。
 */

test('短成功消息不截断，不追加省略号', () => {
  const input = '  第一段。第二段。  ';
  const payload = buildSuccessNotification(input, new Date('2026-04-13T01:02:03'));

  assert.equal(payload.title, 'Codex回答完毕');
  assert.equal(payload.subtitle, '2026-04-13 01:02:03');
  assert.equal(payload.markdown, '第一段。第二段。');
});

test('项目场景的成功通知标题使用项目名', () => {
  const payload = buildSuccessNotification(
    '手动测试成功消息。',
    new Date('2026-04-13T01:02:03'),
    {
      scene: 'project'
    }
  );

  assert.equal(payload.title, 'CodexNotia');
  assert.equal(payload.subtitle, '2026-04-13 01:02:03');
  assert.equal(payload.markdown, '手动测试成功消息。');
});

test('长成功消息按最接近上限的句号前截断，并且只在截断后追加省略号', () => {
  const source = `${'A'.repeat(4090)}。后半段仍然存在。`;
  const markdown = truncateMarkdownText(source, 4096);

  assert.equal(markdown.endsWith('……'), true);
  assert.equal(markdown.endsWith('。……'), false);
  assert.equal(getCharacterLength(markdown), 4092);
});

test('长错误消息也按相同规则截断', () => {
  const source = `${'B'.repeat(4088)}.more text follows.`;
  const payload = buildErrorNotification(source, new Date('2026-04-13T01:02:03'));

  assert.equal(payload.title, 'Codex出现错误');
  assert.equal(payload.markdown.endsWith('……'), true);
  assert.equal(payload.markdown.endsWith('.……'), false);
});

test('错误消息短于上限时保留原文，不追加省略号', () => {
  const payload = buildErrorNotification('网络错误。', new Date('2026-04-13T01:02:03'));

  assert.equal(payload.markdown, '网络错误。');
});

test('项目场景的错误通知标题使用项目名', () => {
  const payload = buildErrorNotification(
    '后台服务内部异常。',
    new Date('2026-04-13T01:02:03'),
    {
      scene: 'project'
    }
  );

  assert.equal(payload.title, 'CodexNotia');
  assert.equal(payload.subtitle, '2026-04-13 01:02:03');
  assert.equal(payload.markdown, '后台服务内部异常。');
});

test('Bark 字段仍然会清理空白并限制长度', () => {
  const payload = buildErrorNotification(`\n\n  ${'B'.repeat(6000)}  \n`);

  assert.equal(getCharacterLength(payload.markdown) <= 4098, true);
});

test('正文字符上限可以通过配置项传入并按字符数截断', () => {
  const payload = buildSuccessNotification(
    '🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂',
    new Date('2026-04-13T01:02:03'),
    {
      maxContentCharacters: 5
    }
  );

  assert.equal(payload.markdown, '🙂🙂🙂🙂🙂……');
  assert.equal(getCharacterLength(payload.markdown), 7);
});

/**
 * 用本地 HTTP 服务模拟 Bark，验证重试次数和最终结果。
 */
test('Bark 推送失败两次后第三次成功', async () => {
  let requestCount = 0;
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = '';

    request.on('data', (chunk) => {
      body += chunk.toString();
    });

    request.on('end', () => {
      requestCount += 1;
      requests.push(body);

      if (requestCount < 3) {
        response.writeHead(500, { 'content-type': 'text/plain' });
        response.end('failed');
        return;
      }

      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"code":200,"message":"success"}');
    });
  });

  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  const config = {
    push: {
      url: `http://127.0.0.1:${address.port}/push/`,
      deviceKey: 'test-device',
      level: 'timeSensitive',
      group: 'Codex通知',
      isArchive: '1',
      requestTimeoutMs: 500,
      maxContentCharacters: 4096,
      maxEncodedBodyLength: 7000,
      maxAttempts: 3,
      retryDelayMs: 20
    }
  };

  const result = await pushToBark(config, {
    title: 'Codex回答完毕',
    subtitle: '2026-04-13 01:02:03',
    markdown: 'Test'
  });

  assert.equal(result, '{"code":200,"message":"success"}');
  assert.equal(requestCount, 3);
  assert.ok(requests[0].includes('device_key=test-device'));

  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
});

/**
 * 验证 Bark 发送路径里的附加日志不会反向打断真正的通知请求。
 * 这里只模拟 logger 全部失败，目标是确保发送结果仍由 Bark 响应本身决定。
 */
test('Bark 日志写入失败时，通知发送仍然继续', async () => {
  let requestCount = 0;
  const server = http.createServer((request, response) => {
    requestCount += 1;
    request.resume();
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"code":200,"message":"success"}');
  });

  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  const config = {
    push: {
      url: `http://127.0.0.1:${address.port}/push/`,
      deviceKey: 'test-device',
      level: 'timeSensitive',
      group: 'Codex通知',
      isArchive: '1',
      requestTimeoutMs: 500,
      maxContentCharacters: 4096,
      maxEncodedBodyLength: 7000,
      maxAttempts: 1,
      retryDelayMs: 20
    }
  };
  const failingLogger = {
    async info() {
      throw new Error('logger info failed');
    },
    async warn() {
      throw new Error('logger warn failed');
    },
    async infoBlock() {
      throw new Error('logger infoBlock failed');
    },
    async warnBlock() {
      throw new Error('logger warnBlock failed');
    },
    async errorBlock() {
      throw new Error('logger errorBlock failed');
    }
  };

  try {
    const result = await pushToBark(config, {
      title: 'CodexNotia',
      subtitle: '2026-04-13 01:02:03',
      markdown: '内部错误通知'
    }, failingLogger);

    assert.equal(result, '{"code":200,"message":"success"}');
    assert.equal(requestCount, 1);
  } finally {
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
});
