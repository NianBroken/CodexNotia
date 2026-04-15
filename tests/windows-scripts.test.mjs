import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS_DIR = path.join(REPOSITORY_ROOT, 'scripts');
const execFileAsync = promisify(execFile);

/**
 * 这组断言专门防止 PowerShell 控制脚本再次把运行时中文写死在源码里。
 * 只要可执行代码仍依赖非 ASCII 中文字面量，用户把脚本改完再另存为无 BOM，
 * Windows PowerShell 5.1 就仍然可能在解析源码阶段直接读错。
 */
test('PowerShell 控制脚本的可执行代码不再依赖源码中的非 ASCII 中文', async () => {
  const scriptFiles = await collectFiles(SCRIPTS_DIR, '.ps1');

  assert.ok(scriptFiles.length > 0);

  for (const filePath of scriptFiles) {
    const scriptText = stripUtf8Bom(await fs.readFile(filePath, 'utf8'));
    const executableText = stripPowerShellComments(scriptText);

    assert.equal(
      /[^\x00-\x7F]/.test(executableText),
      false,
      `${path.relative(REPOSITORY_ROOT, filePath)} 的可执行代码仍含有非 ASCII 字符`
    );
  }
});

test('common.ps1 继续通过重定向读取 Node 输出，并提供 ASCII 安全的中文消息表', async () => {
  const commonScriptPath = path.join(SCRIPTS_DIR, 'common.ps1');
  const commonScriptText = stripUtf8Bom(await fs.readFile(commonScriptPath, 'utf8'));

  assert.match(commonScriptText, /RedirectStandardOutput \$stdoutPath/);
  assert.match(commonScriptText, /RedirectStandardError \$stderrPath/);
  assert.match(commonScriptText, /Read-CodexNotiaUtf8Text -Path \$stdoutPath/);
  assert.match(commonScriptText, /\$script:CodexNotiaMessages = @\{/);
  assert.match(commonScriptText, /function Convert-CodexNotiaEscapedUnicodeText/);
  assert.match(commonScriptText, /function Get-CodexNotiaText/);
});

test('run-service.ps1 达到重试上限后会退出，而不是把失败计数重新卷回', async () => {
  const runServiceScriptPath = path.join(SCRIPTS_DIR, 'run-service.ps1');
  const runServiceScriptText = stripUtf8Bom(await fs.readFile(runServiceScriptPath, 'utf8'));
  const commonScriptPath = path.join(SCRIPTS_DIR, 'common.ps1');
  const commonScriptText = stripUtf8Bom(await fs.readFile(commonScriptPath, 'utf8'));

  assert.match(commonScriptText, /'runService\.retryLimitReached'/);
  assert.doesNotMatch(runServiceScriptText, /\$failureStreak\s*=\s*1/);
  assert.match(
    runServiceScriptText,
    /if \(\$failureStreak -gt \$retryCount\) \{\s*Write-CodexNotiaConsoleMessage[\s\S]*?exit 1\s*\}/
  );
});

test('common.ps1 即使去掉 BOM，仍能正确还原中文输出和任务描述', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codexnotia-powershell-'));
  const commonScriptPath = path.join(SCRIPTS_DIR, 'common.ps1');
  const tempCommonScriptPath = path.join(tempDir, 'common.ps1');
  const smokeScriptPath = path.join(tempDir, 'smoke.ps1');

  try {
    const commonScriptText = stripUtf8Bom(await fs.readFile(commonScriptPath, 'utf8'));
    await fs.writeFile(tempCommonScriptPath, commonScriptText, 'utf8');
    await fs.writeFile(smokeScriptPath, [
      ". (Join-Path $PSScriptRoot 'common.ps1')",
      'Set-CodexNotiaConsoleEncoding',
      "Write-Output (Get-CodexNotiaText 'stop.completed' @('CodexNotia'))",
      "Write-Output (Get-CodexNotiaText 'task.description')"
    ].join('\r\n'), 'utf8');

    const { stdout } = await execFileAsync(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', smokeScriptPath],
      { encoding: 'utf8' }
    );

    assert.match(stdout, /已停止计划任务和后台服务: CodexNotia/);
    assert.match(stdout, /持续监听 Codex 会话并推送回答完成或异常通知/);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

async function collectFiles(rootDir, extension) {
  const collectedFiles = [];
  const entries = await fs.readdir(rootDir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);

    if (entry.isDirectory()) {
      collectedFiles.push(...await collectFiles(fullPath, extension));
      continue;
    }

    if (entry.isFile() && fullPath.toLowerCase().endsWith(extension)) {
      collectedFiles.push(fullPath);
    }
  }

  return collectedFiles.sort();
}

function stripUtf8Bom(text) {
  return text.charCodeAt(0) === 0xFEFF
    ? text.slice(1)
    : text;
}

function stripPowerShellComments(text) {
  let result = '';
  let insideSingleQuotedString = false;
  let insideDoubleQuotedString = false;
  let insideBlockComment = false;

  for (let index = 0; index < text.length; index += 1) {
    const currentCharacter = text[index];
    const nextCharacter = text[index + 1];

    if (insideBlockComment) {
      if (currentCharacter === '#' && nextCharacter === '>') {
        insideBlockComment = false;
        index += 1;
      }
      continue;
    }

    if (!insideSingleQuotedString && !insideDoubleQuotedString) {
      if (currentCharacter === '<' && nextCharacter === '#') {
        insideBlockComment = true;
        index += 1;
        continue;
      }

      if (currentCharacter === '#') {
        while (index < text.length && text[index] !== '\n') {
          index += 1;
        }

        if (index < text.length) {
          result += text[index];
        }
        continue;
      }
    }

    if (currentCharacter === "'" && !insideDoubleQuotedString) {
      const isEscapedSingleQuote = insideSingleQuotedString && nextCharacter === "'";
      result += currentCharacter;

      if (isEscapedSingleQuote) {
        result += nextCharacter;
        index += 1;
        continue;
      }

      insideSingleQuotedString = !insideSingleQuotedString;
      continue;
    }

    if (currentCharacter === '"' && !insideSingleQuotedString) {
      let backslashCount = 0;
      let lookbehindIndex = index - 1;

      while (lookbehindIndex >= 0 && text[lookbehindIndex] === '`') {
        backslashCount += 1;
        lookbehindIndex -= 1;
      }

      result += currentCharacter;

      if (backslashCount % 2 === 0) {
        insideDoubleQuotedString = !insideDoubleQuotedString;
      }
      continue;
    }

    result += currentCharacter;
  }

  return result;
}
