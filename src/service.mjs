import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildErrorNotification, buildSuccessNotification, pushToBark } from './bark.mjs';
import { Logger } from './logger.mjs';
import { StateStore } from './state-store.mjs';
import {
  ensureDirectory,
  fileExists,
  formatLocalDateTime,
  getCharacterLength,
  listJsonlFiles,
  normalizeNewlines,
  nowIsoString,
  parseJsonLine,
  sleep,
  toSingleLineLogText,
  trimField,
  writeJsonFile
} from './utils.mjs';

/**
 * 统一限制错误上下文的最长保留长度。
 * 这里既保护状态文件和日志体积，也避免把超长错误文本直接塞进通知正文。
 */
const ERROR_CONTEXT_MAX_LENGTH = 4800;

/**
 * 包装进程自恢复的冷却时间。
 * 冷却期内不会重复拉起，避免包装进程短时间连续缺失时反复创建后台实例。
 */
const WRAPPER_RECOVERY_COOLDOWN_MS = 30000;
const INTERNAL_ERROR_HISTORY_RETENTION_MULTIPLIER = 4;
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/**
 * CodexApp 日志补抓的时间窗口和文件过滤规则。
 * 这里只在会话文件没有真实错误正文时启用，用来补抓 Electron 侧落盘的失败信息。
 */
const APP_LOG_PRETURN_BUFFER_MS = 120000;
const APP_LOG_POST_EVENT_BUFFER_MS = 120000;
const APP_LOG_FALLBACK_LOOKBACK_MS = 1800000;
const APP_LOG_FILE_PREFIX = 'codex-desktop-';
const APP_LOG_FILE_SUFFIX = '.log';

/**
 * 失败文本识别关键字。
 * 这些词会同时用于两类场景。
 * 1. 处理中间工具和命令输出时，提取最近错误上下文。
 * 2. 最终只收到 `task_complete` 时，判断这次结束到底是成功还是失败。
 */
const FAILURE_TEXT_PATTERNS = Object.freeze([
  'execution error:',
  'command timed out after',
  'tool call error:',
  'transport send error',
  'unexpected status ',
  'service unavailable',
  'temporarily unavailable',
  'network error',
  'connection error',
  'request id:',
  'cf-ray:',
  'fetch failed',
  'socket hang up',
  'timed out',
  'access is denied',
  'permission denied',
  'not found',
  'cannot find',
  'no such file or directory',
  'enoent',
  'eacces',
  'exception calling',
  'assertionerror',
  'failing tests:'
]);
const TOOL_OUTPUT_FAILURE_PATTERNS = Object.freeze([
  'error:',
  'failed',
  'failure',
  'exception',
  'traceback',
  'categoryinfo',
  'fullyqualifiederrorid',
  'unauthorized',
  'forbidden',
  'refused',
  'exit code: 1',
  'exit code: 2',
  'exit code: 3',
  'exit code: 4',
  'exit code: 5',
  'exit code: 6',
  'exit code: 7',
  'exit code: 8',
  'exit code: 9',
  'exit code: 10',
  'cannot overwrite variable',
  'sessionstateunauthorizedaccessexception',
  'methodinvocationexception',
  'assertionerror',
  'failing tests:',
  '✖'
]);
const TOOL_OUTPUT_HEADER_PATTERNS = Object.freeze([
  /^exit code:\s*-?\d+\s*$/i,
  /^wall time:\s*/i,
  /^total output lines:\s*/i,
  /^output:\s*$/i
]);
const TOOL_OUTPUT_CONTEXT_PATTERNS = Object.freeze([
  /^at line:/i,
  /^at .+:\d+/i,
  /^\s*\+\s+/,
  /^\s*~+\s*$/,
  /^\s*\+\s+categoryinfo/i,
  /^\s*\+\s+fullyqualifiederrorid/i,
  /^\s*categoryinfo/i,
  /^\s*fullyqualifiederrorid/i
]);
/**
 * CodexApp Electron 日志里的失败信号。
 * 这里除了沿用通用失败关键字，也补上桌面端常见的字段名和错误前缀。
 */
const APP_LOG_FAILURE_PATTERNS = Object.freeze([
  ...FAILURE_TEXT_PATTERNS,
  'request failed',
  'failed to ',
  'error=',
  'errormessage=',
  'errorcode=',
  'invalid request:',
  'sqlite state db unavailable'
]);
/**
 * CodexApp 日志正文里的结构化字段名。
 * 这些字段会被剥离，用来还原更短、更准确的错误正文。
 */
const APP_LOG_METADATA_FIELDS = Object.freeze([
  'conversationId',
  'threadId',
  'durationMs',
  'error',
  'errorCode',
  'errorMessage',
  'errorName',
  'errorStack',
  'id',
  'method',
  'pendingCountAfter',
  'timeoutMs',
  'requestId',
  'originWebcontentsId',
  'targetDestroyed',
  'broadcastFallback',
  'hadInternalHandler',
  'hadPending',
  'hostId',
  'params'
]);
/**
 * 结束事件里常见的失败状态值。
 * 只要 `task_complete` 自带这些状态，系统就直接按错误场景收尾。
 */
const TERMINAL_FAILURE_STATUSES = new Set([
  'aborted',
  'cancelled',
  'canceled',
  'error',
  'failed',
  'interrupted',
  'terminated',
  'timeout',
  'timed_out',
  'unavailable'
]);
/**
 * 结束事件里常见的失败原因值。
 * 这里和状态值分开维护，避免不同客户端把失败信息写进不同字段时漏判。
 */
const TERMINAL_FAILURE_REASONS = new Set([
  'aborted',
  'cancelled',
  'canceled',
  'error',
  'failed',
  'interrupted',
  'terminated',
  'timeout',
  'timed_out',
  'unavailable',
  'network_error'
]);

/**
 * CodexNotia 后台监听服务。
 * 负责扫描会话文件、维护 turn 状态、发送通知、写日志和刷新健康状态。
 */
export class CodexNotiaService {
  constructor(config) {
    this.config = config;
    this.logFilePath = path.join(
      config.runtime.logDir,
      `codexnotia-${formatLocalDateTime(new Date()).slice(0, 10)}.log`
    );
    this.logger = new Logger(this.logFilePath);
    this.stateStore = new StateStore(config.runtime.stateDir);
    this.isStopping = false;
    this.internalErrorHistory = new Map();
    this.internalErrorSending = false;
    this.wrapperCheckCooldownUntil = 0;
    this.sessionDirectoryMissingLoggedAt = 0;
    this.handleStopSignal = () => {
      this.isStopping = true;
    };
  }

  /**
   * 服务主循环。
   * 准备目录、状态和锁后持续扫描，直到收到停止信号。
   */
  async run() {
    await ensureDirectory(this.config.runtime.logDir);
    await ensureDirectory(this.config.runtime.stateDir);
    await this.stateStore.initialize();
    await this.acquireLock();

    try {
      await this.runStartupRecovery();
      await this.logger.info('服务启动成功', {
        pid: process.pid,
        sessionsDir: this.config.codex.sessionsDir
      });
      process.on('SIGINT', this.handleStopSignal);
      process.on('SIGTERM', this.handleStopSignal);

      while (!this.isStopping) {
        try {
          await this.scanOnce();
          await this.flushHealth();
        } catch (error) {
          await this.reportInternalError('主循环执行失败', error);
        }

        await sleep(this.config.service.pollIntervalMs);
      }

      await this.logger.info('服务收到停止信号，准备退出');
    } finally {
      process.off('SIGINT', this.handleStopSignal);
      process.off('SIGTERM', this.handleStopSignal);
      await this.releaseLock().catch(async (error) => {
        await this.reportInternalError('释放服务锁失败', error);
      });
      await this.stateStore.save().catch(async (error) => {
        await this.reportInternalError('保存最终状态失败', error);
      });
    }
  }

  /**
   * 扫描一次会话目录。
   * 文件级错误会被隔离，不会拖垮整轮扫描。
   */
  async scanOnce() {
    const state = this.stateStore.getState();
    const sessionsDirExists = await fileExists(this.config.codex.sessionsDir);

    if (!sessionsDirExists) {
      await this.reportMissingSessionsDirectory();
      await this.checkStaleTurns();
      this.pruneNotifiedTurnKeys();
      this.pruneInternalErrorHistory();
      await this.stateStore.save();
      return;
    }

    const sessionFiles = await listJsonlFiles(this.config.codex.sessionsDir);
    const sessionFileSet = new Set(sessionFiles);

    for (const filePath of sessionFiles) {
      try {
        await this.processSessionFile(state, filePath);
      } catch (error) {
        await this.reportInternalError('处理会话文件失败', error, {
          filePath
        });
      }
    }

    if (!state.bootstrapComplete) {
      state.bootstrapComplete = true;
      await this.logger.info('首次启动已完成历史会话跳过');
    }

    this.pruneMissingFileStates(sessionFileSet);
    await this.checkStaleTurns();
    this.pruneNotifiedTurnKeys();
    this.pruneInternalErrorHistory();
    await this.stateStore.save();
  }

  /**
   * 处理单个会话文件。
   * 新文件首次发现时可按历史基线载入，避免分支复制出的旧消息立刻刷屏。
   */
  async processSessionFile(state, filePath) {
    const fileState = getOrCreateFileState(state, filePath);
    const stats = await fs.stat(filePath).catch((error) => {
      if (error && error.code === 'ENOENT') {
        return null;
      }

      throw error;
    });

    if (!stats) {
      delete state.files[filePath];
      return;
    }

    if (!fileState.primed) {
      const shouldPrimeAsHistorical = state.bootstrapComplete
        || this.config.service.ignoreHistoricalSessionsOnFirstRun;

      if (shouldPrimeAsHistorical) {
        await this.primeFileStateFromExistingContent(fileState, filePath, stats.size);
        return;
      }

      fileState.primed = true;
    }

    if (stats.size < fileState.offset) {
      await this.logger.warn('检测到会话文件被截断，偏移量已重置', {
        filePath,
        previousOffset: fileState.offset,
        currentSize: stats.size
      });
      resetFileState(fileState, filePath);
      const shouldPrimeAsHistorical = state.bootstrapComplete
        || this.config.service.ignoreHistoricalSessionsOnFirstRun;

      if (shouldPrimeAsHistorical) {
        await this.primeFileStateFromExistingContent(fileState, filePath, stats.size);
        return;
      }

      fileState.primed = true;
    }

    if (stats.size === fileState.offset) {
      return;
    }

    const appendedText = await readAppendedText(filePath, fileState.offset, stats.size);
    const textToProcess = `${fileState.remainder}${appendedText}`;
    const lines = normalizeNewlines(textToProcess).split('\n');
    const nextRemainder = lines.pop() ?? '';

    for (const line of lines) {
      try {
        const payload = parseJsonLine(line);

        if (!payload) {
          continue;
        }

        await this.handleEvent(fileState, payload, {
          allowNotifications: true,
          allowLogs: true
        });
      } catch (error) {
        await this.reportInternalError('解析或处理单行事件失败', error, {
          filePath,
          linePreview: toSingleLineLogText(line).slice(0, 400)
        });
      }
    }

    fileState.offset = stats.size;
    fileState.remainder = nextRemainder;
    fileState.primed = true;
  }

  /**
   * 会话目录缺失时按冷却时间记录一次警告。
   * 目录尚未出现属于正常场景，不应该把服务打成内部错误或刷屏。
   */
  async reportMissingSessionsDirectory() {
    const now = Date.now();

    if (
      now - this.sessionDirectoryMissingLoggedAt
      < this.config.service.sessionDirectoryMissingWarnCooldownMs
    ) {
      return;
    }

    this.sessionDirectoryMissingLoggedAt = now;
    await this.logger.warn('会话目录暂不可用，服务将继续等待', {
      sessionsDir: this.config.codex.sessionsDir
    });
  }

  /**
   * 清理已经不存在的会话文件状态，避免状态文件持续积累无效条目。
   */
  pruneMissingFileStates(existingFileSet) {
    const state = this.stateStore.getState();

    for (const [filePath, fileState] of Object.entries(state.files)) {
      if (existingFileSet.has(filePath)) {
        continue;
      }

      if (Object.keys(fileState.turns ?? {}).length > 0) {
        continue;
      }

      delete state.files[filePath];
    }
  }

  /**
   * 清理已经超过保留期的通知去重键，避免状态文件无限增长。
   */
  pruneNotifiedTurnKeys() {
    const state = this.stateStore.getState();
    const retentionMs = this.config.service.notifiedTurnRetentionMs;

    if (retentionMs === 'permanent') {
      return;
    }

    const now = Date.now();

    for (const [notificationKey, sentAt] of Object.entries(state.notifiedTurnKeys)) {
      const sentAtValue = Date.parse(sentAt);

      if (Number.isNaN(sentAtValue) || now - sentAtValue > retentionMs) {
        delete state.notifiedTurnKeys[notificationKey];
      }
    }
  }

  /**
   * 清理内部错误冷却缓存，避免长期运行时这张表无限增长。
   */
  pruneInternalErrorHistory() {
    const retentionMs = this.config.service.internalErrorNotifyCooldownMs
      * INTERNAL_ERROR_HISTORY_RETENTION_MULTIPLIER;
    const now = Date.now();

    for (const [fingerprint, sentAt] of this.internalErrorHistory.entries()) {
      if (now - sentAt > retentionMs) {
        this.internalErrorHistory.delete(fingerprint);
      }
    }
  }

  /**
   * 把文件现有内容载入为历史基线。
   * 这里只恢复内部状态，不写业务日志，也不发通知。
   */
  async primeFileStateFromExistingContent(fileState, filePath, fileSize) {
    fileState.primed = true;

    if (fileSize <= 0) {
      fileState.offset = 0;
      fileState.remainder = '';
      return;
    }

    const existingText = await fs.readFile(filePath, 'utf8');
    const lines = normalizeNewlines(existingText).split('\n');
    const nextRemainder = lines.pop() ?? '';

    for (const line of lines) {
      try {
        const payload = parseJsonLine(line);

        if (!payload) {
          continue;
        }

        await this.handleEvent(fileState, payload, {
          allowNotifications: false,
          allowLogs: false
        });
      } catch (error) {
        await this.reportInternalError('解析历史基线事件失败', error, {
          filePath,
          linePreview: toSingleLineLogText(line).slice(0, 400)
        });
      }
    }

    fileState.offset = fileSize;
    fileState.remainder = nextRemainder;
  }

  /**
   * 处理单条会话事件。
   * 历史基线载入时会关闭日志和通知，只保留状态恢复。
   */
  async handleEvent(fileState, event, options = {}) {
    const {
      allowNotifications = true,
      allowLogs = true
    } = options;

    const previousLatestEventAt = fileState.lastEventAt;
    const eventTimestamp = event.timestamp ?? nowIsoString();
    fileState.lastEventAt = selectLatestTimestamp(previousLatestEventAt, eventTimestamp);

    if (event.type === 'session_meta') {
      fileState.sessionId = trimField(event.payload?.id) || fileState.sessionId;
      fileState.originator = trimField(event.payload?.originator) || fileState.originator;
      fileState.source = trimField(event.payload?.source) || fileState.source;

      if (allowLogs) {
        await this.logger.info('会话元信息已就绪', {
          sessionId: fileState.sessionId,
          originator: fileState.originator,
          source: fileState.source,
          eventTimestamp: event.timestamp ?? nowIsoString()
        });
      }
      return;
    }

    if (!event.payload || typeof event.payload.type !== 'string') {
      return;
    }

    const payloadType = event.payload.type;

    if (
      allowNotifications
      && isHistoricalReplayEvent(
        previousLatestEventAt,
        eventTimestamp,
        this.config.service.branchReplayTimeDriftMs
      )
    ) {
      if (allowLogs && shouldLogHistoricalReplayEvent(payloadType)) {
        await this.logger.info('检测到历史分支回放事件，已跳过通知路径', {
          sessionId: fileState.sessionId,
          turnId: trimField(event.payload.turn_id),
          payloadType,
          eventTimestamp,
          latestObservedEventAt: previousLatestEventAt
        });
      }
      return;
    }

    if (event.type === 'event_msg' && payloadType === 'user_message') {
      if (allowLogs) {
        const userMessage = extractUserMessage(event.payload);
        await this.logger.infoBlock('用户发送消息', toSingleLineLogText(userMessage), {
          sessionId: fileState.sessionId,
          eventTimestamp: event.timestamp ?? nowIsoString(),
          messageLength: getCharacterLength(userMessage)
        });
      }
      return;
    }

    if (event.type === 'event_msg' && payloadType === 'task_started') {
      const turnId = trimField(event.payload.turn_id);

      if (!turnId) {
        return;
      }

      fileState.currentTurnId = turnId;
      fileState.latestFinalAnswerText = '';
      fileState.latestErrorMessage = '';
      fileState.turns[turnId] = {
        startedAt: event.timestamp ?? nowIsoString(),
        lastEventAt: event.timestamp ?? nowIsoString(),
        finalAnswerText: '',
        lastErrorMessage: ''
      };

      if (allowLogs) {
        await this.logger.info('检测到新 turn', {
          sessionId: fileState.sessionId,
          turnId,
          eventTimestamp: event.timestamp ?? nowIsoString()
        });
        await this.logger.info('AI 开始处理', {
          sessionId: fileState.sessionId,
          turnId,
          eventTimestamp: event.timestamp ?? nowIsoString()
        });
      }
      return;
    }

    const targetTurnId = trimField(event.payload.turn_id);
    const currentTurn = getCurrentTurnState(fileState, targetTurnId);

    if (
      event.type === 'event_msg'
      && payloadType === 'agent_message'
      && event.payload.phase === 'final_answer'
    ) {
      const finalText = trimField(event.payload.message);

      if (currentTurn) {
        currentTurn.finalAnswerText = finalText;
        currentTurn.lastEventAt = event.timestamp ?? nowIsoString();
      } else {
        fileState.latestFinalAnswerText = finalText;
      }
      return;
    }

    if (
      event.type === 'response_item'
      && payloadType === 'message'
      && event.payload.role === 'assistant'
      && event.payload.phase === 'final_answer'
    ) {
      const finalText = extractAssistantMessage(event.payload);

      if (currentTurn) {
        currentTurn.finalAnswerText = finalText;
        currentTurn.lastEventAt = event.timestamp ?? nowIsoString();
      } else {
        fileState.latestFinalAnswerText = finalText;
      }
      return;
    }

    if (currentTurn) {
      currentTurn.lastEventAt = event.timestamp ?? nowIsoString();
    }

    if (event.type === 'event_msg' && payloadType === 'exec_command_end') {
      const aggregatedOutput = trimField(event.payload.aggregated_output);
      const commandFailureText = extractFailureTextFromToolOutput(aggregatedOutput);

      if (event.payload.status === 'failed' && aggregatedOutput) {
        if (currentTurn) {
          currentTurn.lastErrorMessage = limitFailureMessage(commandFailureText || aggregatedOutput);
        } else {
          fileState.latestErrorMessage = limitFailureMessage(commandFailureText || aggregatedOutput);
        }
      }
      return;
    }

    if (event.type === 'event_msg' && payloadType === 'mcp_tool_call_end') {
      const toolError = trimField(event.payload.result?.Err);

      if (toolError) {
        if (currentTurn) {
          currentTurn.lastErrorMessage = toolError.slice(0, ERROR_CONTEXT_MAX_LENGTH);
        } else {
          fileState.latestErrorMessage = toolError.slice(0, ERROR_CONTEXT_MAX_LENGTH);
        }
      }
      return;
    }

    if (event.type === 'event_msg' && payloadType === 'error') {
      const codexErrorMessage = extractCodexErrorMessage(event.payload);

      if (codexErrorMessage) {
        if (currentTurn) {
          currentTurn.lastErrorMessage = codexErrorMessage.slice(0, ERROR_CONTEXT_MAX_LENGTH);
        } else {
          fileState.latestErrorMessage = codexErrorMessage.slice(0, ERROR_CONTEXT_MAX_LENGTH);
        }
      }
      return;
    }

    if (
      event.type === 'response_item'
      && (payloadType === 'function_call_output' || payloadType === 'custom_tool_call_output')
    ) {
      const outputText = trimField(event.payload.output);
      const toolFailureText = extractFailureTextFromToolOutput(outputText);

      if (toolFailureText) {
        if (currentTurn) {
          currentTurn.lastErrorMessage = limitFailureMessage(toolFailureText);
        } else {
          fileState.latestErrorMessage = limitFailureMessage(toolFailureText);
        }
      }
      return;
    }

    if (event.type === 'event_msg' && payloadType === 'turn_aborted') {
      const turnId = targetTurnId || fileState.currentTurnId;
      const turnState = getCurrentTurnState(fileState, turnId);

      if (!turnId) {
        return;
      }

      if (!allowNotifications) {
        deleteTurn(fileState, turnId);
        clearTransientFileState(fileState);
        return;
      }

      const notificationKey = buildNotificationKey(fileState, turnId, 'error');

      if (this.stateStore.getState().notifiedTurnKeys[notificationKey]) {
        deleteTurn(fileState, turnId);
        clearTransientFileState(fileState);
        return;
      }

      const hydratedErrorMessage = await this.hydrateTurnErrorFromAppLogs(
        fileState,
        turnState,
        turnId,
        event.timestamp ?? nowIsoString()
      );
      const abortReason = buildAbortReasonMessage(
        event.payload.reason,
        hydratedErrorMessage
      );

      if (allowLogs) {
        await this.logger.warn('检测到最终错误结束事件', {
          sessionId: fileState.sessionId,
          turnId,
          reason: event.payload.reason,
          eventTimestamp: event.timestamp ?? nowIsoString()
        });
        await this.logger.warnBlock('AI 最终错误消息', toSingleLineLogText(abortReason), {
          sessionId: fileState.sessionId,
          turnId,
          reason: event.payload.reason,
          messageLength: getCharacterLength(abortReason),
          eventTimestamp: event.timestamp ?? nowIsoString()
        });
      }

      const notification = buildErrorNotification(
        abortReason,
        event.timestamp ?? nowIsoString(),
        buildCodexNotificationOptions(this.config)
      );

      if (allowLogs) {
        await this.logger.info('进入错误通知发送流程', {
          sessionId: fileState.sessionId,
          turnId,
          eventTimestamp: event.timestamp ?? nowIsoString()
        });
      }
      await pushToBark(this.config, notification, this.logger);
      this.stateStore.getState().notifiedTurnKeys[notificationKey] = nowIsoString();

      if (allowLogs) {
        await this.logger.info('错误通知发送成功', {
          sessionId: fileState.sessionId,
          turnId,
          eventTimestamp: event.timestamp ?? nowIsoString()
        });
      }

      deleteTurn(fileState, turnId);
      clearTransientFileState(fileState);
      return;
    }

    if (event.type === 'event_msg' && payloadType === 'task_complete') {
      const turnId = targetTurnId || fileState.currentTurnId;
      const turnState = getCurrentTurnState(fileState, turnId);

      if (!turnId) {
        return;
      }

      if (!allowNotifications) {
        deleteTurn(fileState, turnId);
        clearTransientFileState(fileState);
        return;
      }

      /**
       * `task_complete` 本身只表示这轮结束，并不天然等于成功。
       * 这里必须结合最终回答文本、显式失败字段和最近错误上下文统一分类。
       */
      await this.hydrateTurnErrorFromAppLogs(
        fileState,
        turnState,
        turnId,
        event.timestamp ?? nowIsoString()
      );
      const completionOutcome = resolveTaskCompleteOutcome(fileState, turnState, event.payload);
      const notificationKey = buildNotificationKey(fileState, turnId, completionOutcome.kind);

      if (this.stateStore.getState().notifiedTurnKeys[notificationKey]) {
        deleteTurn(fileState, turnId);
        clearTransientFileState(fileState);
        return;
      }

      if (completionOutcome.kind === 'error') {
        /**
         * 没有真实最终回答，或者结束载荷已经明确表达失败时，
         * 统一走错误通知路径，确保不会再把失败伪装成成功完成。
         */
        if (allowLogs) {
          await this.logger.warn('检测到完成事件携带失败结果', {
            sessionId: fileState.sessionId,
            turnId,
            eventTimestamp: event.timestamp ?? nowIsoString()
          });
          await this.logger.warnBlock('AI 最终错误消息', toSingleLineLogText(completionOutcome.message), {
            sessionId: fileState.sessionId,
            turnId,
            messageLength: getCharacterLength(completionOutcome.message),
            eventTimestamp: event.timestamp ?? nowIsoString()
          });
        }

        const notification = buildErrorNotification(
          completionOutcome.message,
          event.timestamp ?? nowIsoString(),
          buildCodexNotificationOptions(this.config)
        );

        if (allowLogs) {
          await this.logger.info('进入错误通知发送流程', {
            sessionId: fileState.sessionId,
            turnId,
            eventTimestamp: event.timestamp ?? nowIsoString()
          });
        }
        await pushToBark(this.config, notification, this.logger);
        this.stateStore.getState().notifiedTurnKeys[notificationKey] = nowIsoString();

        if (allowLogs) {
          await this.logger.info('错误通知发送成功', {
            sessionId: fileState.sessionId,
            turnId,
            eventTimestamp: event.timestamp ?? nowIsoString()
          });
        }
      } else {
        /**
         * 只有拿到真实最终回答文本时才会进入成功路径。
         * 这样可以把“结束了但没真正答完”的情况彻底排除在成功通知之外。
         */
        if (allowLogs) {
          await this.logger.info('检测到最终完成事件', {
            sessionId: fileState.sessionId,
            turnId,
            eventTimestamp: event.timestamp ?? nowIsoString()
          });
          await this.logger.infoBlock('AI 最终完整消息', toSingleLineLogText(completionOutcome.message), {
            sessionId: fileState.sessionId,
            turnId,
            messageLength: getCharacterLength(completionOutcome.message),
            eventTimestamp: event.timestamp ?? nowIsoString()
          });
        }

        const notification = buildSuccessNotification(
          completionOutcome.message,
          event.timestamp ?? nowIsoString(),
          buildCodexNotificationOptions(this.config)
        );

        if (allowLogs) {
          await this.logger.info('进入成功通知发送流程', {
            sessionId: fileState.sessionId,
            turnId,
            eventTimestamp: event.timestamp ?? nowIsoString()
          });
        }
        await pushToBark(this.config, notification, this.logger);
        this.stateStore.getState().notifiedTurnKeys[notificationKey] = nowIsoString();

        if (allowLogs) {
          await this.logger.info('成功通知发送成功', {
            sessionId: fileState.sessionId,
            turnId,
            eventTimestamp: event.timestamp ?? nowIsoString()
          });
        }
      }

      deleteTurn(fileState, turnId);
      clearTransientFileState(fileState);
    }
  }

  /**
   * 检查超时未结束的活动 turn，并按错误路径补发通知。
   */
  async checkStaleTurns() {
    const now = Date.now();
    const state = this.stateStore.getState();

    for (const [filePath, fileState] of Object.entries(state.files)) {
      for (const [turnId, turnState] of Object.entries(fileState.turns)) {
        const lastEventAt = Date.parse(turnState.lastEventAt || turnState.startedAt);

        if (Number.isNaN(lastEventAt)) {
          continue;
        }

        if (now - lastEventAt < this.config.service.staleTurnTimeoutMs) {
          continue;
        }

        const notificationKey = buildNotificationKey(fileState, turnId, 'error');

        if (state.notifiedTurnKeys[notificationKey]) {
          deleteTurn(fileState, turnId);
          clearTransientFileState(fileState);
          continue;
        }

        const hydratedErrorMessage = await this.hydrateTurnErrorFromAppLogs(
          fileState,
          turnState,
          turnId,
          turnState.lastEventAt || turnState.startedAt
        );
        const staleMessage = hydratedErrorMessage
          || 'Codex 在等待最终完成事件时停止更新，已超过配置的超时阈值。';
        const staleOccurredAt = new Date(lastEventAt + this.config.service.staleTurnTimeoutMs);

        await this.logger.warnBlock('AI 超时错误消息', toSingleLineLogText(staleMessage), {
          filePath,
          sessionId: fileState.sessionId,
          turnId,
          messageLength: getCharacterLength(staleMessage)
        });

        const notification = buildErrorNotification(
          staleMessage,
          staleOccurredAt,
          buildCodexNotificationOptions(this.config)
        );
        await this.logger.info('进入超时错误通知发送流程', {
          filePath,
          sessionId: fileState.sessionId,
          turnId
        });
        await pushToBark(this.config, notification, this.logger);
        state.notifiedTurnKeys[notificationKey] = nowIsoString();

        await this.logger.warn('超时错误通知发送成功', {
          filePath,
          sessionId: fileState.sessionId,
          turnId
        });

        deleteTurn(fileState, turnId);
        clearTransientFileState(fileState);
      }
    }
  }

  /**
   * 在会话文件缺少错误正文时，尝试从 CodexApp 本地日志补抓同一会话的真实失败信息。
   * 只会补抓当前 turn 仍为空的错误上下文，避免覆盖已经从会话文件拿到的更准确内容。
   */
  async hydrateTurnErrorFromAppLogs(fileState, turnState, turnId, eventTimestamp) {
    const existingErrorMessage = trimField(turnState?.lastErrorMessage || fileState.latestErrorMessage);

    if (existingErrorMessage) {
      return existingErrorMessage;
    }

    const appLogErrorMessage = await this.findCodexAppErrorMessage(
      fileState,
      turnState,
      eventTimestamp
    );

    if (!appLogErrorMessage) {
      return '';
    }

    if (turnState) {
      turnState.lastErrorMessage = appLogErrorMessage;
    } else {
      fileState.latestErrorMessage = appLogErrorMessage;
    }

    await this.logger.info('已从 CodexApp 日志补抓错误消息', {
      sessionId: fileState.sessionId,
      turnId,
      appLogsDir: resolveCodexAppLogsDir(this.config),
      messageLength: getCharacterLength(appLogErrorMessage),
      eventTimestamp: eventTimestamp || nowIsoString()
    });

    return appLogErrorMessage;
  }

  /**
   * 从 CodexApp Electron 日志里查找同一会话在当前 turn 时间窗口内的失败正文。
   * 这里只把结果当成兜底来源，只有会话文件本身没有错误文本时才会真正介入。
   */
  async findCodexAppErrorMessage(fileState, turnState, eventTimestamp) {
    if (!isLikelyCodexAppSession(fileState) || !fileState.sessionId) {
      return '';
    }

    const appLogsDir = resolveCodexAppLogsDir(this.config);

    if (!appLogsDir || !(await fileExists(appLogsDir))) {
      return '';
    }

    const eventTimestampMs = Date.parse(eventTimestamp || '');

    if (Number.isNaN(eventTimestampMs)) {
      return '';
    }

    const turnStartedAtMs = Date.parse(turnState?.startedAt || '');
    const searchStartMs = Number.isNaN(turnStartedAtMs)
      ? eventTimestampMs - APP_LOG_FALLBACK_LOOKBACK_MS
      : turnStartedAtMs - APP_LOG_PRETURN_BUFFER_MS;
    const searchEndMs = eventTimestampMs + APP_LOG_POST_EVENT_BUFFER_MS;
    const appLogFiles = await listCodexAppLogFiles(appLogsDir, searchStartMs, searchEndMs);
    const candidateMap = new Map();

    for (const filePath of appLogFiles) {
      const fileContent = await fs.readFile(filePath, 'utf8').catch((error) => {
        if (error && (error.code === 'ENOENT' || error.code === 'EACCES' || error.code === 'EPERM')) {
          return '';
        }

        throw error;
      });

      if (!fileContent || !fileContent.includes(fileState.sessionId)) {
        continue;
      }

      const fileLines = normalizeNewlines(fileContent).split('\n');

      for (const line of fileLines) {
        const candidate = buildCodexAppLogCandidate(
          line,
          fileState.sessionId,
          searchStartMs,
          searchEndMs,
          eventTimestampMs
        );

        if (!candidate) {
          continue;
        }

        const previousCandidate = candidateMap.get(candidate.message);

        if (
          !previousCandidate
          || candidate.score > previousCandidate.score
          || (
            candidate.score === previousCandidate.score
            && candidate.timestampMs > previousCandidate.timestampMs
          )
        ) {
          candidateMap.set(candidate.message, candidate);
        }
      }
    }

    const sortedCandidates = [...candidateMap.values()].sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return right.timestampMs - left.timestampMs;
    });

    return sortedCandidates[0]?.message || '';
  }

  /**
   * 刷新健康文件，并顺带确认包装进程仍然存在。
   */
  async flushHealth() {
    const state = this.stateStore.getState();
    const activeTurnCount = Object.values(state.files).reduce((total, fileState) => {
      return total + Object.keys(fileState.turns).length;
    }, 0);

    await this.stateStore.writeHealth({
      serviceName: this.config.service.name,
      pid: process.pid,
      configPath: this.config.__meta.configPath,
      logFilePath: this.logFilePath,
      sessionsDir: this.config.codex.sessionsDir,
      activeTurnCount,
      monitoredFileCount: Object.keys(state.files).length,
      notifiedTurnCount: Object.keys(state.notifiedTurnKeys).length
    }, this.logger);

    await this.ensureWrapperProcess();
  }

  /**
   * 获取单实例锁，避免重复启动两个监听实例。
   */
  async acquireLock() {
    const lockFilePath = this.stateStore.lockFilePath;

    if (await fileExists(lockFilePath)) {
      const existingLock = await tryReadJsonObject(lockFilePath);
      const existingPid = Number(existingLock?.pid);

      if (Number.isInteger(existingPid) && isProcessAlive(existingPid)) {
        throw new Error(`CodexNotia 已在运行，PID: ${existingPid}`);
      }

      await fs.unlink(lockFilePath).catch((error) => {
        if (!error || error.code !== 'ENOENT') {
          throw error;
        }
      });
    }

    await writeJsonFile(lockFilePath, {
      pid: process.pid,
      startedAt: nowIsoString()
    });
  }

  /**
   * 释放单实例锁。
   */
  async releaseLock() {
    try {
      await fs.unlink(this.stateStore.lockFilePath);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  /**
   * 执行启动恢复流程。
   * 恢复失败不会阻止主服务继续运行。
   */
  async runStartupRecovery() {
    try {
      await this.recoverSkippedRecentFinalEvents();
    } catch (error) {
      await this.reportInternalError('启动恢复阶段失败，服务继续运行', error);
    }
  }

  /**
   * 当前保留的启动恢复入口。
   * 新文件基线逻辑已经覆盖了大多数历史文件场景，这里主要负责留出稳定扩展点。
   */
  async recoverSkippedRecentFinalEvents() {
    await this.stateStore.save();
  }

  /**
   * 统一记录内部错误，并按冷却时间决定是否发项目场景通知。
   */
  async reportInternalError(stage, error, context = {}) {
    const errorText = error instanceof Error
      ? error.stack || error.message
      : String(error);
    const fingerprint = `${stage}:${error instanceof Error ? error.message : String(error)}`;
    const now = Date.now();
    const lastSentAt = this.internalErrorHistory.get(fingerprint) ?? 0;

    await this.logger.errorBlock(stage, errorText, context);

    if (this.internalErrorSending) {
      return;
    }

    if (now - lastSentAt < this.config.service.internalErrorNotifyCooldownMs) {
      return;
    }

    this.internalErrorHistory.set(fingerprint, now);
    this.internalErrorSending = true;

    try {
      const notification = buildErrorNotification(
        `${stage}。${error instanceof Error ? error.message : String(error)}`,
        new Date(now),
        buildCodexNotificationOptions(this.config, {
          scene: 'project'
        })
      );
      await pushToBark(this.config, notification, this.logger);
      await this.logger.warn('内部错误通知已发送', {
        stage
      });
    } catch (pushError) {
      await this.logger.errorBlock(
        '内部错误通知发送失败',
        pushError instanceof Error ? pushError.stack || pushError.message : String(pushError),
        {
          stage
        }
      );
    } finally {
      this.internalErrorSending = false;
    }
  }

  /**
   * 反向检查包装进程是否存在。
   * 丢失时会通过隐藏启动链路尝试自动补建。
   */
  async ensureWrapperProcess() {
    const now = Date.now();

    if (now < this.wrapperCheckCooldownUntil) {
      return;
    }

    const wrapperLockPath = path.join(this.config.runtime.stateDir, 'wrapper.lock.json');

    if (await fileExists(wrapperLockPath)) {
      try {
        const wrapperLock = await tryReadJsonObject(wrapperLockPath);
        const wrapperPid = Number(wrapperLock?.pid);

        if (Number.isInteger(wrapperPid) && isProcessAlive(wrapperPid)) {
          return;
        }

        await fs.unlink(wrapperLockPath).catch((error) => {
          if (!error || error.code !== 'ENOENT') {
            throw error;
          }
        });
      } catch (error) {
        await this.logger.warnBlock(
          '读取后台包装进程锁文件失败，准备尝试恢复',
          error instanceof Error ? error.stack || error.message : String(error)
        );
      }
    }

    const hiddenLauncherPath = path.join(PROJECT_ROOT, 'scripts', 'invoke-hidden-powershell.vbs');
    const launchScriptPath = path.join(PROJECT_ROOT, 'scripts', 'launch-background.ps1');
    const effectivePowerShellPath = await resolveExistingExecutablePath(
      buildSystemExecutableCandidates([
        ['System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe']
      ]),
      'powershell.exe'
    );
    const effectiveWscriptPath = await resolveExistingExecutablePath(
      buildSystemExecutableCandidates([
        ['System32', 'wscript.exe']
      ]),
      'wscript.exe'
    );

    if (!(await fileExists(hiddenLauncherPath)) || !(await fileExists(launchScriptPath))) {
      return;
    }

    try {
      const child = spawn(
        effectiveWscriptPath,
        ['//B', '//Nologo', hiddenLauncherPath, effectivePowerShellPath, launchScriptPath, '-Silent'],
        {
          cwd: PROJECT_ROOT,
          detached: true,
          stdio: 'ignore',
          windowsHide: true
        }
      );
      child.unref();
      this.wrapperCheckCooldownUntil = now + WRAPPER_RECOVERY_COOLDOWN_MS;
      await this.logger.info('检测到后台包装进程缺失，已尝试自动恢复', {
        launchScriptPath
      });
    } catch (error) {
      this.wrapperCheckCooldownUntil = now + WRAPPER_RECOVERY_COOLDOWN_MS;
      await this.reportInternalError('自动恢复后台包装进程失败', error, {
        launchScriptPath
      });
    }
  }
}

/**
 * 获取或创建单个会话文件的状态对象，并补齐缺失字段。
 */
function getOrCreateFileState(state, filePath) {
  if (!state.files[filePath]) {
    state.files[filePath] = createFileState(filePath);
  }

  state.files[filePath].filePath ??= filePath;
  state.files[filePath].offset ??= 0;
  state.files[filePath].remainder ??= '';
  state.files[filePath].sessionId ??= '';
  state.files[filePath].originator ??= '';
  state.files[filePath].source ??= '';
  state.files[filePath].currentTurnId ??= '';
  state.files[filePath].lastEventAt ??= '';
  state.files[filePath].latestFinalAnswerText ??= '';
  state.files[filePath].latestErrorMessage ??= '';
  state.files[filePath].turns ??= {};
  state.files[filePath].primed ??= state.files[filePath].offset > 0;

  return state.files[filePath];
}

function createFileState(filePath) {
  return {
    filePath,
    offset: 0,
    remainder: '',
    sessionId: '',
    originator: '',
    source: '',
    currentTurnId: '',
    lastEventAt: '',
    latestFinalAnswerText: '',
    latestErrorMessage: '',
    turns: {},
    primed: false
  };
}

/**
 * 文件被截断或重建时重置这份状态对象。
 * 这里只替换字段，不改变外层引用。
 */
function resetFileState(fileState, filePath) {
  const freshState = createFileState(filePath);
  Object.assign(fileState, freshState);
}

/**
 * 尽量定位本次事件所属的活动 turn。
 * 优先使用显式 `turn_id`，其次回退当前 turn，再退回唯一未结束 turn。
 */
function getCurrentTurnState(fileState, preferredTurnId = '') {
  if (preferredTurnId && fileState.turns[preferredTurnId]) {
    return fileState.turns[preferredTurnId];
  }

  if (fileState.currentTurnId && fileState.turns[fileState.currentTurnId]) {
    return fileState.turns[fileState.currentTurnId];
  }

  const unresolvedTurns = Object.values(fileState.turns);

  if (unresolvedTurns.length === 1) {
    return unresolvedTurns[0];
  }

  return null;
}

function deleteTurn(fileState, turnId) {
  delete fileState.turns[turnId];

  if (fileState.currentTurnId === turnId) {
    fileState.currentTurnId = '';
  }
}

/**
 * 构造通知去重键。
 * 同一会话的同一 turn 与同一通知类型只允许发送一次。
 */
function buildNotificationKey(fileState, turnId, kind) {
  const sessionPart = fileState.sessionId || fileState.filePath || 'unknown-session';
  return `${sessionPart}:${turnId}:${kind}`;
}

function buildCodexNotificationOptions(config, overrides = {}) {
  return {
    maxContentCharacters: config.push.maxContentCharacters,
    ...overrides
  };
}

/**
 * 判断一条新读到的事件是否明显落在当前文件已经见过的时间线之前。
 * 只要回退幅度超过配置阈值，就把它当成旧分支复制进来的历史回放。
 */
function isHistoricalReplayEvent(previousLatestEventAt, currentEventAt, allowedTimeDriftMs) {
  const previousTimestampMs = Date.parse(previousLatestEventAt || '');
  const currentTimestampMs = Date.parse(currentEventAt || '');

  if (Number.isNaN(previousTimestampMs) || Number.isNaN(currentTimestampMs)) {
    return false;
  }

  return previousTimestampMs - currentTimestampMs > allowedTimeDriftMs;
}

function shouldLogHistoricalReplayEvent(payloadType) {
  return payloadType === 'task_started'
    || payloadType === 'task_complete'
    || payloadType === 'turn_aborted';
}

function selectLatestTimestamp(existingTimestamp, nextTimestamp) {
  const existingTimestampMs = Date.parse(existingTimestamp || '');
  const nextTimestampMs = Date.parse(nextTimestamp || '');

  if (Number.isNaN(existingTimestampMs)) {
    return nextTimestamp;
  }

  if (Number.isNaN(nextTimestampMs)) {
    return existingTimestamp;
  }

  return nextTimestampMs >= existingTimestampMs
    ? nextTimestamp
    : existingTimestamp;
}

/**
 * 识别原始文本里是否带有明确失败信号。
 * 这套判断既服务中间工具错误收集，也服务没有最终回答时的结束事件分类。
 * 这里只做宽松识别，不区分错误来源，目的是尽量把“已失败但未触发 turn_aborted”的结束拉回错误路径。
 */
function looksLikeFailureText(text) {
  if (!text) {
    return false;
  }

  const normalizedText = text.toLowerCase();

  return FAILURE_TEXT_PATTERNS.some((pattern) => normalizedText.includes(pattern));
}

/**
 * 统一构造错误正文，尽量把中断原因和最近错误上下文合并起来。
 */
function buildAbortReasonMessage(reason, previousError) {
  const cleanReason = normalizeFailureKeyword(reason) || trimField(reason);

  if (cleanReason === 'interrupted') {
    return previousError
      ? `Codex 在最终回答完成前被中断。最近错误: ${previousError}`
      : 'Codex 在最终回答完成前被中断。原因: interrupted';
  }

  if (previousError) {
    return `Codex 在最终回答完成前终止。原因: ${cleanReason || 'unknown'}。最近错误: ${previousError}`;
  }

  return `Codex 在最终回答完成前终止。原因: ${cleanReason || 'unknown'}`;
}

function extractUserMessage(payload) {
  return trimField(
    payload.message
    || payload.text
    || (Array.isArray(payload.text_elements) ? payload.text_elements.join(' ') : '')
  );
}

function extractAssistantMessage(payload) {
  if (typeof payload.message === 'string') {
    return trimField(payload.message);
  }

  if (typeof payload.text === 'string') {
    return trimField(payload.text);
  }

  return trimField(
    (payload.content ?? [])
      .map((item) => item.text ?? item.output_text ?? item.value ?? '')
      .join('')
  );
}

/**
 * 统一提取 Codex 原生错误事件里的正文。
 * 优先使用事件自带的完整错误消息，其次回退到更短的错误标记字段。
 */
function extractCodexErrorMessage(payload) {
  const directMessage = trimField(payload.message);

  if (directMessage) {
    return directMessage;
  }

  const errorInfo = trimField(payload.codex_error_info);

  if (errorInfo) {
    return `Codex 在最终回答完成前终止。错误类型: ${errorInfo}`;
  }

  return '';
}

/**
 * 统一分类 `task_complete` 的最终结果。
 * 处理顺序固定如下。
 * 1. 优先读取结束事件自带的显式失败字段。
 * 2. 再看结构化最终回答是否已经到位。
 * 3. 再看结束事件自带的最后消息是否本身就是失败文本。
 * 4. 最后回退到本轮累计的最近错误上下文。
 *    这里也包含从 CodexApp 本地日志补抓到的兜底错误正文。
 * 只有拿到真实最终回答文本时才进入成功通知，其余缺失回答或带失败信号的结束都走错误通知。
 */
function resolveTaskCompleteOutcome(fileState, turnState, payload) {
  const structuredFinalAnswer = trimField(turnState?.finalAnswerText || fileState.latestFinalAnswerText);
  const completionMessage = trimField(payload.last_agent_message);
  const previousError = trimField(turnState?.lastErrorMessage || fileState.latestErrorMessage);
  const explicitFailureMessage = extractTaskCompleteFailureMessage(payload);

  if (explicitFailureMessage) {
    return {
      kind: 'error',
      message: limitFailureMessage(explicitFailureMessage)
    };
  }

  if (structuredFinalAnswer) {
    return {
      kind: 'success',
      message: structuredFinalAnswer
    };
  }

  if (completionMessage) {
    if (looksLikeFailureText(completionMessage)) {
      return {
        kind: 'error',
        message: limitFailureMessage(completionMessage)
      };
    }

    return {
      kind: 'success',
      message: completionMessage
    };
  }

  if (previousError) {
    return {
      kind: 'error',
      message: limitFailureMessage(previousError)
    };
  }

  return {
    kind: 'error',
    message: 'Codex 在最终回答完成前终止。结束事件未携带最终回答内容。'
  };
}

/**
 * 从 `task_complete` 的载荷里提取显式失败信息。
 * 这里会同时兼容。
 * 1. 顶层字符串字段，例如 `error_message`、`failure_message`。
 * 2. 嵌套对象字段，例如 `error.message`、`result.Err`。
 * 3. 只给出状态或原因，没有给出错误正文的结束事件。
 * 只读取明确用于表达失败的字段，避免把正常回答文本误当成错误。
 */
function extractTaskCompleteFailureMessage(payload) {
  const candidateMessages = [
    trimField(payload.error_message),
    trimField(payload.error),
    trimField(payload.failure_message),
    trimField(payload.failure),
    trimField(payload.last_error),
    trimField(payload?.error?.message),
    trimField(payload?.failure?.message),
    trimField(payload?.result?.Err),
    trimField(payload?.result?.error),
    trimField(payload?.response?.error?.message),
    trimField(payload?.details?.error_message),
    trimField(payload?.details?.error)
  ].filter(Boolean);

  const directFailureMessage = candidateMessages.find((text) => looksLikeFailureText(text)) || candidateMessages[0];

  if (directFailureMessage) {
    return directFailureMessage;
  }

  const statusValue = normalizeFailureKeyword(payload.status);

  if (statusValue && TERMINAL_FAILURE_STATUSES.has(statusValue)) {
    return `Codex 在最终回答完成前终止。状态: ${statusValue}`;
  }

  const reasonValue = normalizeFailureKeyword(payload.reason);

  if (reasonValue && TERMINAL_FAILURE_REASONS.has(reasonValue)) {
    return `Codex 在最终回答完成前终止。原因: ${reasonValue}`;
  }

  return '';
}

/**
 * 把结束事件里的状态值和原因值规范成可比对的小写字符串。
 * 这样不同来源即使大小写不一致，也能落到同一套失败集合里。
 */
function normalizeFailureKeyword(value) {
  return trimField(value).toLowerCase();
}

/**
 * 限制错误正文长度，并统一做首尾清理。
 * 这里只负责保护错误上下文，不改写错误语义。
 */
function limitFailureMessage(message) {
  return trimField(message).slice(0, ERROR_CONTEXT_MAX_LENGTH);
}

/**
 * 从工具输出里尽量抽取真实失败正文。
 * 这里既兼容 CLI 常见网络错误，也兼容 CodexApp 下 shell 工具返回的 PowerShell 和测试失败文本。
 */
function extractFailureTextFromToolOutput(outputText) {
  const normalizedOutput = trimField(outputText);

  if (!normalizedOutput) {
    return '';
  }

  const parsedToolOutput = parseToolOutputEnvelope(normalizedOutput);
  const bodyText = parsedToolOutput.bodyText || normalizedOutput;
  const normalizedBodyText = bodyText.toLowerCase();

  if (
    parsedToolOutput.exitCode !== null
    && parsedToolOutput.exitCode !== 0
    && bodyText
  ) {
    return limitFailureMessage(bodyText);
  }

  if (looksLikeFailureText(bodyText)) {
    return limitFailureMessage(bodyText);
  }

  const hasToolFailureSignal = TOOL_OUTPUT_FAILURE_PATTERNS.some((pattern) => {
    return normalizedBodyText.includes(pattern);
  });

  if (!hasToolFailureSignal) {
    return '';
  }

  const meaningfulFailureText = compressToolFailureText(bodyText);
  return limitFailureMessage(meaningfulFailureText || bodyText);
}

/**
 * 解析常见工具输出包裹格式。
 * 例如 `Exit code`、`Wall time` 和 `Output` 这类头部会被剥离，只保留真正的正文。
 */
function parseToolOutputEnvelope(outputText) {
  const lines = normalizeNewlines(outputText).split('\n');
  let exitCode = null;
  let bodyStartIndex = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const currentLine = lines[index].trim();

    if (!currentLine) {
      continue;
    }

    if (currentLine.toLowerCase().startsWith('exit code:')) {
      const parsedExitCode = Number.parseInt(currentLine.slice('exit code:'.length).trim(), 10);

      if (Number.isInteger(parsedExitCode)) {
        exitCode = parsedExitCode;
      }

      bodyStartIndex = index + 1;
      continue;
    }

    if (TOOL_OUTPUT_HEADER_PATTERNS.some((pattern) => pattern.test(currentLine))) {
      bodyStartIndex = index + 1;
      continue;
    }

    bodyStartIndex = index;
    break;
  }

  return {
    exitCode,
    bodyText: trimField(lines.slice(bodyStartIndex).join('\n'))
  };
}

/**
 * 压缩工具失败正文。
 * 优先保留首个核心失败行和紧随其后的上下文，避免把整个冗长输出原样塞进通知。
 */
function compressToolFailureText(bodyText) {
  const lines = normalizeNewlines(bodyText)
    .split('\n')
    .map((line) => line.trimEnd());
  const significantLineIndexes = [];

  for (let index = 0; index < lines.length; index += 1) {
    const trimmedLine = lines[index].trim();

    if (!trimmedLine) {
      continue;
    }

    const normalizedLine = trimmedLine.toLowerCase();
    const isFailureLine = TOOL_OUTPUT_FAILURE_PATTERNS.some((pattern) => {
      return normalizedLine.includes(pattern);
    });

    if (isFailureLine) {
      significantLineIndexes.push(index);
    }
  }

  if (significantLineIndexes.length === 0) {
    return trimField(bodyText);
  }

  const collectedLines = [];
  const recordedLineIndexes = new Set();

  for (const index of significantLineIndexes) {
    collectToolOutputLine(lines, index, collectedLines, recordedLineIndexes);

    for (let nextIndex = index + 1; nextIndex < lines.length; nextIndex += 1) {
      const nextLine = lines[nextIndex].trim();

      if (!nextLine) {
        break;
      }

      if (!TOOL_OUTPUT_CONTEXT_PATTERNS.some((pattern) => pattern.test(nextLine))) {
        break;
      }

      collectToolOutputLine(lines, nextIndex, collectedLines, recordedLineIndexes);
    }
  }

  return trimField(collectedLines.join('\n'));
}

function collectToolOutputLine(lines, index, collectedLines, recordedLineIndexes) {
  if (recordedLineIndexes.has(index)) {
    return;
  }

  const line = lines[index].trim();

  if (!line) {
    return;
  }

  recordedLineIndexes.add(index);
  collectedLines.push(line);
}

/**
 * 判断当前会话是否来自 CodexApp。
 * 这里只做宽松识别，既兼容桌面端旧字段，也兼容不同来源名的轻微变化。
 */
function isLikelyCodexAppSession(fileState) {
  const originator = normalizeFailureKeyword(fileState.originator);
  const source = normalizeFailureKeyword(fileState.source);

  return originator.includes('desktop')
    || source === 'vscode'
    || source === 'exec'
    || source === 'desktop'
    || source === 'app';
}

/**
 * 解析 CodexApp 日志目录。
 * 这条路径已经在配置加载阶段完成了解析，这里只负责读取最终结果。
 */
function resolveCodexAppLogsDir(config) {
  return trimField(config.codex?.appLogsDir);
}

function buildSystemExecutableCandidates(relativePathPartsList) {
  const systemRoots = [
    trimField(process.env.SystemRoot),
    trimField(process.env.windir)
  ].filter(Boolean);

  return relativePathPartsList.flatMap((relativePathParts) => {
    return systemRoots.map((systemRoot) => path.join(systemRoot, ...relativePathParts));
  });
}

async function resolveExistingExecutablePath(candidatePaths, fallbackExecutableName) {
  for (const candidatePath of candidatePaths) {
    if (candidatePath && await fileExists(candidatePath)) {
      return candidatePath;
    }
  }

  return fallbackExecutableName;
}

/**
 * 列出指定时间窗口可能涉及的 CodexApp 日志文件。
 * 目录按本机本地日期展开，避免跨午夜时漏掉相邻日期的日志。
 */
async function listCodexAppLogFiles(appLogsDir, startTimestampMs, endTimestampMs) {
  const filePaths = [];
  const dateDirectories = buildCodexAppLogDateDirectories(appLogsDir, startTimestampMs, endTimestampMs);

  for (const dateDirectory of dateDirectories) {
    const directoryEntries = await fs.readdir(dateDirectory, { withFileTypes: true }).catch((error) => {
      if (error && error.code === 'ENOENT') {
        return [];
      }

      throw error;
    });

    for (const entry of directoryEntries) {
      if (!entry.isFile()) {
        continue;
      }

      const normalizedEntryName = entry.name.toLowerCase();

      if (
        !normalizedEntryName.startsWith(APP_LOG_FILE_PREFIX)
        || !normalizedEntryName.endsWith(APP_LOG_FILE_SUFFIX)
      ) {
        continue;
      }

      filePaths.push(path.join(dateDirectory, entry.name));
    }
  }

  return filePaths;
}

/**
 * 构造 CodexApp 日志按日分目录的候选路径列表。
 */
function buildCodexAppLogDateDirectories(appLogsDir, startTimestampMs, endTimestampMs) {
  const startDate = new Date(startTimestampMs);
  const endDate = new Date(endTimestampMs);
  const currentDate = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
  const finalDate = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());
  const dateDirectories = [];

  while (currentDate <= finalDate) {
    dateDirectories.push(path.join(
      appLogsDir,
      String(currentDate.getFullYear()),
      String(currentDate.getMonth() + 1).padStart(2, '0'),
      String(currentDate.getDate()).padStart(2, '0')
    ));
    currentDate.setDate(currentDate.getDate() + 1);
  }

  return dateDirectories;
}

/**
 * 从单条 CodexApp 日志里提取可直接用于通知的错误正文。
 * 只接受命中同一会话、同一时间窗口且带明确失败信号的日志行。
 */
function buildCodexAppLogCandidate(
  line,
  sessionId,
  searchStartMs,
  searchEndMs,
  eventTimestampMs
) {
  if (!line || !line.includes(sessionId)) {
    return null;
  }

  const parsedLine = parseCodexAppLogLine(line);

  if (!parsedLine) {
    return null;
  }

  if (parsedLine.timestampMs < searchStartMs || parsedLine.timestampMs > searchEndMs) {
    return null;
  }

  if (!looksLikeCodexAppFailureLine(parsedLine.messageText, parsedLine.level)) {
    return null;
  }

  const failureMessage = extractCodexAppFailureMessage(parsedLine.messageText);

  if (!failureMessage) {
    return null;
  }

  return {
    message: limitFailureMessage(failureMessage),
    score: scoreCodexAppLogCandidate(parsedLine, eventTimestampMs),
    timestampMs: parsedLine.timestampMs
  };
}

/**
 * 解析单条 CodexApp 日志的时间、级别和正文部分。
 */
function parseCodexAppLogLine(line) {
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z)\s+(\w+)\s+\[[^\]]+\]\s+(.*)$/.exec(line);

  if (!match) {
    return null;
  }

  const timestampMs = Date.parse(match[1]);

  if (Number.isNaN(timestampMs)) {
    return null;
  }

  return {
    timestampMs,
    level: match[2].toLowerCase(),
    messageText: match[3]
  };
}

/**
 * 识别 CodexApp 日志行是否携带失败信号。
 * 这里除了日志级别，也会检查结构化错误字段和常见失败关键词。
 */
function looksLikeCodexAppFailureLine(messageText, level) {
  const normalizedMessageText = messageText.toLowerCase();

  if (APP_LOG_FAILURE_PATTERNS.some((pattern) => normalizedMessageText.includes(pattern))) {
    return true;
  }

  if (extractLogFieldValue(messageText, 'error')) {
    return true;
  }

  if (extractLogFieldValue(messageText, 'errorMessage')) {
    return true;
  }

  const errorCode = trimField(decodeLogFieldValue(extractLogFieldValue(messageText, 'errorCode')));
  return level === 'error' && Boolean(errorCode) && errorCode !== '0' && errorCode !== 'null';
}

/**
 * 提取 CodexApp 日志中的真实错误正文。
 * 优先使用结构化错误对象和显式错误字段，再回退到较短的失败前缀或错误码描述。
 */
function extractCodexAppFailureMessage(messageText) {
  const prefixText = extractCodexAppLogPrefix(messageText);
  const structuredErrorMessage = extractStructuredCodexAppErrorMessage(messageText);

  if (structuredErrorMessage) {
    if (prefixText === 'Request failed') {
      return structuredErrorMessage;
    }

    if (
      prefixText
      && !structuredErrorMessage.toLowerCase().includes(prefixText.toLowerCase())
      && prefixText.toLowerCase().includes('failed')
    ) {
      return `${prefixText}: ${structuredErrorMessage}`;
    }

    return structuredErrorMessage;
  }

  const errorCode = trimField(decodeLogFieldValue(extractLogFieldValue(messageText, 'errorCode')));
  const method = trimField(decodeLogFieldValue(extractLogFieldValue(messageText, 'method')));

  if (errorCode && errorCode !== '0' && errorCode !== 'null') {
    return method
      ? `CodexApp 请求失败。方法: ${method}。错误码: ${errorCode}`
      : `CodexApp 请求失败。错误码: ${errorCode}`;
  }

  if (prefixText && APP_LOG_FAILURE_PATTERNS.some((pattern) => prefixText.toLowerCase().includes(pattern))) {
    return prefixText;
  }

  return '';
}

/**
 * 组合解析 CodexApp 日志里最常见的结构化错误字段。
 */
function extractStructuredCodexAppErrorMessage(messageText) {
  const errorFieldMessage = extractCodexAppErrorFieldMessage(extractLogFieldValue(messageText, 'error'));

  if (errorFieldMessage) {
    return errorFieldMessage;
  }

  const errorMessageField = trimField(decodeLogFieldValue(extractLogFieldValue(messageText, 'errorMessage')));

  if (errorMessageField) {
    return errorMessageField;
  }

  const messageField = trimField(decodeLogFieldValue(extractLogFieldValue(messageText, 'message')));

  if (messageField && looksLikeFailureText(messageField)) {
    return messageField;
  }

  return '';
}

/**
 * 解析 `error=` 字段里的对象或字符串。
 * 这里只提取最有信息量的错误码和消息，避免把整段元数据原样塞进通知。
 */
function extractCodexAppErrorFieldMessage(rawFieldValue) {
  const decodedFieldValue = trimField(decodeLogFieldValue(rawFieldValue));

  if (!decodedFieldValue) {
    return '';
  }

  if (decodedFieldValue.startsWith('{') && decodedFieldValue.endsWith('}')) {
    try {
      const parsedError = JSON.parse(decodedFieldValue);
      const errorMessage = trimField(
        parsedError.message
        || parsedError.error
        || parsedError.details?.message
        || parsedError.cause?.message
      );
      const errorCode = trimField(String(parsedError.code ?? ''));

      if (errorMessage && errorCode && !errorMessage.includes(errorCode)) {
        return /^-?\d+$/.test(errorCode)
          ? `${errorMessage} [code: ${errorCode}]`
          : `${errorCode}: ${errorMessage}`;
      }

      return errorMessage || errorCode;
    } catch {
      const messageMatch = /"message":"([^"\\]*(?:\\.[^"\\]*)*)"/.exec(decodedFieldValue);
      const codeMatch = /"code":"?([^"\\},]+)"?/.exec(decodedFieldValue);
      const decodedMessage = messageMatch ? decodeJsonFragment(messageMatch[1]) : '';
      const decodedCode = codeMatch ? decodeJsonFragment(codeMatch[1]) : '';

      if (decodedMessage && decodedCode && !decodedMessage.includes(decodedCode)) {
        return /^-?\d+$/.test(decodedCode)
          ? `${decodedMessage} [code: ${decodedCode}]`
          : `${decodedCode}: ${decodedMessage}`;
      }

      return decodedMessage || decodedCode;
    }
  }

  return decodedFieldValue;
}

/**
 * 剥离 CodexApp 日志前缀后的自然语言描述部分。
 * 例如 `Request failed` 或 `Failed to resume thread for automation archive`。
 */
function extractCodexAppLogPrefix(messageText) {
  let prefixEndIndex = messageText.length;

  for (const fieldName of APP_LOG_METADATA_FIELDS) {
    const fieldIndex = messageText.indexOf(` ${fieldName}=`);

    if (fieldIndex >= 0 && fieldIndex < prefixEndIndex) {
      prefixEndIndex = fieldIndex;
    }
  }

  return trimField(messageText.slice(0, prefixEndIndex));
}

/**
 * 从形如 `field=value` 的日志正文里截取指定字段值。
 * 兼容裸值、带引号字符串和 JSON 对象三种形式。
 */
function extractLogFieldValue(messageText, fieldName) {
  const token = `${fieldName}=`;
  const fieldStartIndex = messageText.indexOf(token);

  if (fieldStartIndex < 0) {
    return '';
  }

  const valueStartIndex = fieldStartIndex + token.length;

  if (valueStartIndex >= messageText.length) {
    return '';
  }

  const firstCharacter = messageText[valueStartIndex];

  if (firstCharacter === '"') {
    let isEscaped = false;

    for (let index = valueStartIndex + 1; index < messageText.length; index += 1) {
      const currentCharacter = messageText[index];

      if (isEscaped) {
        isEscaped = false;
        continue;
      }

      if (currentCharacter === '\\') {
        isEscaped = true;
        continue;
      }

      if (currentCharacter === '"') {
        return messageText.slice(valueStartIndex, index + 1);
      }
    }

    return messageText.slice(valueStartIndex);
  }

  if (firstCharacter === '{') {
    let depth = 0;
    let insideString = false;
    let isEscaped = false;

    for (let index = valueStartIndex; index < messageText.length; index += 1) {
      const currentCharacter = messageText[index];

      if (insideString) {
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
        continue;
      }

      if (currentCharacter === '{') {
        depth += 1;
        continue;
      }

      if (currentCharacter === '}') {
        depth -= 1;

        if (depth === 0) {
          return messageText.slice(valueStartIndex, index + 1);
        }
      }
    }

    return messageText.slice(valueStartIndex);
  }

  let valueEndIndex = valueStartIndex;

  while (valueEndIndex < messageText.length && !/\s/.test(messageText[valueEndIndex])) {
    valueEndIndex += 1;
  }

  return messageText.slice(valueStartIndex, valueEndIndex);
}

/**
 * 还原日志字段值里的引号和转义。
 */
function decodeLogFieldValue(rawFieldValue) {
  const normalizedFieldValue = trimField(rawFieldValue);

  if (!normalizedFieldValue || normalizedFieldValue === 'null' || normalizedFieldValue === 'undefined') {
    return '';
  }

  if (normalizedFieldValue.startsWith('"') && normalizedFieldValue.endsWith('"')) {
    try {
      return JSON.parse(normalizedFieldValue);
    } catch {
      return normalizedFieldValue.slice(1, -1);
    }
  }

  return normalizedFieldValue;
}

/**
 * 还原 JSON 片段里的常见转义。
 */
function decodeJsonFragment(value) {
  if (!value) {
    return '';
  }

  try {
    return JSON.parse(`"${value}"`);
  } catch {
    return value;
  }
}

/**
 * 给 CodexApp 日志候选项打分。
 * 越接近当前结束时刻、越结构化、日志级别越高的错误会被优先采用。
 */
function scoreCodexAppLogCandidate(parsedLine, eventTimestampMs) {
  let score = 0;
  const timeDistanceMs = Math.abs(eventTimestampMs - parsedLine.timestampMs);
  const messageText = parsedLine.messageText;

  if (parsedLine.level === 'error') {
    score += 50;
  } else if (parsedLine.level === 'warning') {
    score += 30;
  }

  if (extractLogFieldValue(messageText, 'error')) {
    score += 35;
  }

  if (extractLogFieldValue(messageText, 'errorMessage')) {
    score += 30;
  }

  if (extractLogFieldValue(messageText, 'errorCode')) {
    score += 15;
  }

  if (timeDistanceMs <= 30000) {
    score += 40;
  } else if (timeDistanceMs <= APP_LOG_POST_EVENT_BUFFER_MS) {
    score += 25;
  } else if (timeDistanceMs <= 10 * 60 * 1000) {
    score += 10;
  }

  return score;
}

/**
 * 读取指定偏移区间内的新追加文本。
 */
async function readAppendedText(filePath, startOffset, endOffset) {
  const length = endOffset - startOffset;

  if (length <= 0) {
    return '';
  }

  const fileHandle = await fs.open(filePath, 'r');

  try {
    const buffer = Buffer.alloc(length);
    await fileHandle.read(buffer, 0, length, startOffset);
    return buffer.toString('utf8');
  } finally {
    await fileHandle.close();
  }
}

/**
 * 尝试读取 JSON 文件。
 * 锁文件这类辅助状态损坏时直接回退为空值，让上层按陈旧文件处理而不是中断主流程。
 */
async function tryReadJsonObject(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return null;
    }

    if (error instanceof SyntaxError) {
      return null;
    }

    throw error;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function clearTransientFileState(fileState) {
  fileState.latestFinalAnswerText = '';
  fileState.latestErrorMessage = '';
}
