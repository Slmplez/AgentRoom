function validateTerminalInput(data) {
  if (typeof data !== 'string' || Buffer.byteLength(data, 'utf8') > 65536) throw new Error('终端输入必须是最多 64 KiB 的文本。');
  return data;
}
function validateTerminalSize({ cols, rows } = {}) {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || cols > 500 || rows < 2 || rows > 300) throw new Error('终端尺寸超出范围。');
  return { cols, rows };
}
module.exports = { validateTerminalInput, validateTerminalSize };
