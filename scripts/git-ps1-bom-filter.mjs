import { Buffer } from 'node:buffer';

/**
 * Git 过滤器入口。
 * `clean` 会去掉工作区脚本前面的 BOM，`smudge` 会在签出到工作区时补回 BOM。
 * 这样 Git 比较的是规范化后的真实内容，PowerShell 读取到的仍然是带 BOM 的脚本。
 */
const UTF8_BOM = Buffer.from([0xEF, 0xBB, 0xBF]);
const mode = process.argv[2];
const inputBuffer = await readStdinBuffer();

if (mode === 'clean') {
  process.stdout.write(stripUtf8Bom(inputBuffer));
  process.exit(0);
}

if (mode === 'smudge') {
  process.stdout.write(ensureUtf8Bom(inputBuffer));
  process.exit(0);
}

console.error('用法: node ./scripts/git-ps1-bom-filter.mjs <clean|smudge>');
process.exit(1);

/**
 * 读取 Git 通过标准输入传入的完整文件内容。
 */
async function readStdinBuffer() {
  const chunks = [];

  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

/**
 * 去掉 UTF 8 BOM，供 Git 写入索引时使用。
 */
function stripUtf8Bom(buffer) {
  return hasUtf8Bom(buffer)
    ? buffer.subarray(UTF8_BOM.length)
    : buffer;
}

/**
 * 补回 UTF 8 BOM，供 Git 把脚本写回工作区时使用。
 */
function ensureUtf8Bom(buffer) {
  return hasUtf8Bom(buffer)
    ? buffer
    : Buffer.concat([UTF8_BOM, buffer]);
}

/**
 * 判断当前缓冲区是否已经带有 UTF 8 BOM。
 */
function hasUtf8Bom(buffer) {
  return buffer.length >= UTF8_BOM.length
    && buffer[0] === UTF8_BOM[0]
    && buffer[1] === UTF8_BOM[1]
    && buffer[2] === UTF8_BOM[2];
}
