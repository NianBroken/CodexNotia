import {
  formatLocalDateTime,
  getCharacterLength,
  limitLength,
  toSingleLineLogText,
  trimField
} from './utils.mjs';

const BARK_FIELD_MAX_LENGTH = 4901;
const DEFAULT_MAX_CONTENT_CHARACTERS = 4096;
const ELLIPSIS = '……';
const PROJECT_TITLE = 'CodexNotia';
const SUCCESS_TITLE = 'Codex回答完毕';
const ERROR_TITLE = 'Codex出现错误';
const SENTENCE_BREAKS = ['。', '.'];

const NOTIFICATION_SCENES = Object.freeze({
  CODEX: 'codex',
  PROJECT: 'project'
});

/**
 * 构造成功通知。
 * 标题会根据场景在项目标题和 Codex 成功标题之间切换。
 */
export function buildSuccessNotification(finalAnswerText, completedAt = new Date(), options = {}) {
  const maxContentCharacters = resolveContentCharacterLimit(options.maxContentCharacters);
  const markdown = buildMarkdownFromSource(
    finalAnswerText,
    'Codex 已完成最终回答。',
    maxContentCharacters
  );

  return buildPayload({
    title: resolveNotificationTitle('success', options),
    subtitle: formatLocalDateTime(completedAt),
    markdown
  });
}

/**
 * 构造错误通知。
 * 错误场景和成功场景共用同一套正文清理与截断规则。
 */
export function buildErrorNotification(errorMessage, failedAt = new Date(), options = {}) {
  const maxContentCharacters = resolveContentCharacterLimit(options.maxContentCharacters);
  const markdown = buildMarkdownFromSource(
    errorMessage,
    'Codex 在最终完成前发生错误。',
    maxContentCharacters
  );

  return buildPayload({
    title: resolveNotificationTitle('error', options),
    subtitle: formatLocalDateTime(failedAt),
    markdown
  });
}

function resolveNotificationTitle(kind, options) {
  const scene = normalizeNotificationScene(options.scene);

  if (scene === NOTIFICATION_SCENES.PROJECT) {
    return PROJECT_TITLE;
  }

  return kind === 'error'
    ? ERROR_TITLE
    : SUCCESS_TITLE;
}

function normalizeNotificationScene(scene) {
  return scene === NOTIFICATION_SCENES.PROJECT
    ? NOTIFICATION_SCENES.PROJECT
    : NOTIFICATION_SCENES.CODEX;
}

/**
 * 发送 Bark 通知。
 * 这里统一处理日志、超时、重试，以及请求体过大时的正文压缩。
 */
export async function pushToBark(config, notification, logger) {
  let lastError;
  let currentNotification = fitNotificationToEncodedBodyLimit(config, notification);
  const safeLogger = createSafeBarkLogger(logger);

  if (safeLogger) {
    await safeLogger.infoBlock(
      '通知实际发送内容',
      renderNotificationSingleLine(currentNotification),
      {
        titleLength: getCharacterLength(currentNotification.title),
        subtitleLength: getCharacterLength(currentNotification.subtitle),
        markdownLength: getCharacterLength(currentNotification.markdown),
        markdownLimit: resolveContentCharacterLimit(config.push.maxContentCharacters),
        barkFieldLimit: BARK_FIELD_MAX_LENGTH,
        requestBodyEncodedLength: buildRequestBody(config, currentNotification).toString().length
      }
    );
  }

  for (let attempt = 1; attempt <= config.push.maxAttempts; attempt += 1) {
    try {
      if (safeLogger) {
        await safeLogger.info('开始发送通知请求', {
          attempt,
          titleLength: getCharacterLength(currentNotification.title),
          subtitleLength: getCharacterLength(currentNotification.subtitle),
          markdownLength: getCharacterLength(currentNotification.markdown)
        });
      }

      const response = await sendRequest(config, currentNotification);
      const responseText = await response.text();

      if (safeLogger) {
        await safeLogger.infoBlock(
          '通知服务响应内容',
          responseText,
          {
            attempt,
            status: response.status
          }
        );
      }

      if (!response.ok) {
        if (response.status === 413) {
          currentNotification = shrinkNotificationForRetry(config, currentNotification);

          if (safeLogger) {
            await safeLogger.infoBlock(
              '通知内容因请求过大已自动缩短',
              renderNotificationSingleLine(currentNotification),
              {
                attempt,
                status: response.status,
                titleLength: getCharacterLength(currentNotification.title),
                subtitleLength: getCharacterLength(currentNotification.subtitle),
                markdownLength: getCharacterLength(currentNotification.markdown),
                requestBodyEncodedLength: buildRequestBody(config, currentNotification).toString().length
              }
            );
          }
        }

        throw new Error(`Bark 推送失败，HTTP ${response.status}，响应: ${responseText}`);
      }

      if (safeLogger) {
        await safeLogger.info('Bark 推送成功', {
          attempt,
          title: currentNotification.title
        });
      }

      return responseText;
    } catch (error) {
      lastError = error;

      if (attempt < config.push.maxAttempts) {
        if (safeLogger) {
          await safeLogger.infoBlock(
            '通知请求本次未成功，准备自动重试',
            error instanceof Error ? error.stack || error.message : String(error),
            {
              currentAttempt: attempt,
              nextAttempt: attempt + 1,
              maxAttempts: config.push.maxAttempts,
              retryDelayMs: config.push.retryDelayMs
            }
          );
        }

        await new Promise((resolve) => {
          setTimeout(resolve, config.push.retryDelayMs);
        });

        continue;
      }

      if (safeLogger) {
        await safeLogger.errorBlock(
          '通知请求失败',
          error instanceof Error ? error.stack || error.message : String(error),
          {
            attempt,
            maxAttempts: config.push.maxAttempts
          }
        );
      }
    }
  }

  throw lastError;
}

/**
 * 包一层“不会把异常再抛回主流程”的日志接口。
 * 通知发送链路里的附加日志只用于排查，日志写入失败时不能反向打断 Bark 请求。
 */
function createSafeBarkLogger(logger) {
  if (!logger) {
    return null;
  }

  return {
    info: (...args) => callBarkLoggerSafely(logger, 'info', args),
    warn: (...args) => callBarkLoggerSafely(logger, 'warn', args),
    infoBlock: (...args) => callBarkLoggerSafely(logger, 'infoBlock', args),
    warnBlock: (...args) => callBarkLoggerSafely(logger, 'warnBlock', args),
    errorBlock: (...args) => callBarkLoggerSafely(logger, 'errorBlock', args)
  };
}

/**
 * 安全调用单个日志方法。
 * 这里只吞掉日志写入本身的异常，不改动真正的通知发送结果。
 */
async function callBarkLoggerSafely(logger, methodName, args) {
  const method = logger?.[methodName];

  if (typeof method !== 'function') {
    return;
  }

  try {
    await method.apply(logger, args);
  } catch {
  }
}

/**
 * 按项目规则裁切正文。
 * 优先停在最接近上限的中英文句号前，只有真的截断时才追加省略号。
 */
export function truncateMarkdownText(sourceText, maxLength = DEFAULT_MAX_CONTENT_CHARACTERS) {
  const cleanedText = trimField(sourceText);

  if (!cleanedText) {
    return '';
  }

  const characters = Array.from(cleanedText);

  if (characters.length <= maxLength) {
    return cleanedText;
  }

  const boundedText = characters.slice(0, maxLength).join('');
  const sentenceBreakIndex = findClosestSentenceBreakBeforeLimit(boundedText);

  if (sentenceBreakIndex >= 0) {
    const clippedText = trimField(boundedText.slice(0, sentenceBreakIndex));

    if (clippedText) {
      return `${clippedText}${ELLIPSIS}`;
    }
  }

  return `${trimField(boundedText)}${ELLIPSIS}`;
}

function buildMarkdownFromSource(sourceText, fallbackText, maxContentCharacters) {
  const cleanedSource = trimField(sourceText) || fallbackText;
  return truncateMarkdownText(cleanedSource, maxContentCharacters);
}

function buildPayload({ title, subtitle, markdown }) {
  return {
    title: limitLength(trimField(title), BARK_FIELD_MAX_LENGTH),
    subtitle: limitLength(trimField(subtitle), BARK_FIELD_MAX_LENGTH),
    markdown: limitLength(trimField(markdown), BARK_FIELD_MAX_LENGTH)
  };
}

function findClosestSentenceBreakBeforeLimit(text) {
  let latestIndex = -1;

  for (const mark of SENTENCE_BREAKS) {
    const index = text.lastIndexOf(mark);

    if (index > latestIndex) {
      latestIndex = index;
    }
  }

  return latestIndex;
}

function resolveContentCharacterLimit(value) {
  if (Number.isInteger(value) && value > 0) {
    return Math.min(value, BARK_FIELD_MAX_LENGTH);
  }

  return DEFAULT_MAX_CONTENT_CHARACTERS;
}

/**
 * 发起单次 HTTP 请求。
 * 这里只处理请求体和超时，不负责重试。
 */
async function sendRequest(config, notification) {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error('Bark 请求超时。'));
  }, config.push.requestTimeoutMs);

  try {
    const body = buildRequestBody(config, notification);

    return await fetch(config.push.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded;charset=UTF-8'
      },
      body,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * 让编码后的请求体尽量落在配置上限内。
 * 这里只缩短 `markdown`，不动标题和副标题。
 */
function fitNotificationToEncodedBodyLimit(config, notification) {
  if (!Number.isInteger(config.push.maxEncodedBodyLength) || config.push.maxEncodedBodyLength <= 0) {
    return notification;
  }

  const preparedNotification = { ...notification };

  if (buildRequestBody(config, preparedNotification).toString().length <= config.push.maxEncodedBodyLength) {
    return preparedNotification;
  }

  const sourceText = stripTrailingEllipsis(preparedNotification.markdown);
  const alreadyTruncated = preparedNotification.markdown.endsWith(ELLIPSIS);
  const sourceLength = getCharacterLength(sourceText);
  let low = 1;
  let high = sourceLength;
  let bestMarkdown = '';

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidateMarkdown = shrinkMarkdownToFit(sourceText, middle, alreadyTruncated);
    const candidateNotification = {
      ...preparedNotification,
      markdown: candidateMarkdown
    };

    if (buildRequestBody(config, candidateNotification).toString().length <= config.push.maxEncodedBodyLength) {
      bestMarkdown = candidateMarkdown;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  preparedNotification.markdown = bestMarkdown || shrinkMarkdownToFit(sourceText, 128, true);
  return preparedNotification;
}

/**
 * 处理 `413` 之后的进一步正文压缩。
 */
function shrinkNotificationForRetry(config, notification) {
  const sourceText = stripTrailingEllipsis(notification.markdown);
  const nextLength = Math.max(128, Math.floor(getCharacterLength(sourceText) * 0.6));
  const nextMarkdown = shrinkMarkdownToFit(sourceText, nextLength, true);
  return fitNotificationToEncodedBodyLimit(config, {
    ...notification,
    markdown: nextMarkdown
  });
}

function shrinkMarkdownToFit(sourceText, maxLength, forceEllipsis) {
  const truncated = truncateMarkdownText(sourceText, maxLength);

  if (forceEllipsis) {
    if (truncated.endsWith(ELLIPSIS)) {
      return truncated;
    }

    if (getCharacterLength(truncated) <= maxLength) {
      return `${stripTrailingPunctuation(truncated)}${ELLIPSIS}`;
    }
  }

  return truncated;
}

function stripTrailingEllipsis(text) {
  return text.endsWith(ELLIPSIS)
    ? text.slice(0, -ELLIPSIS.length)
    : text;
}

function stripTrailingPunctuation(text) {
  if (!text) {
    return text;
  }

  const lastCharacter = Array.from(text).at(-1);
  return SENTENCE_BREAKS.includes(lastCharacter)
    ? text.slice(0, -1)
    : text;
}

function buildRequestBody(config, notification) {
  return new URLSearchParams({
    device_key: config.push.deviceKey,
    title: notification.title,
    subtitle: notification.subtitle,
    markdown: notification.markdown,
    level: config.push.level,
    group: config.push.group,
    isArchive: String(config.push.isArchive)
  });
}

/**
 * 把通知对象压成单行文本，专供日志展示。
 */
function renderNotificationSingleLine(notification) {
  return [
    `title=${toSingleLineLogText(notification.title)}`,
    `subtitle=${toSingleLineLogText(notification.subtitle)}`,
    `markdown=${toSingleLineLogText(notification.markdown)}`
  ].join(' | ');
}
