// Only transport-provided unified patches become diffs. Never infer file contents.
function toolDiffs(event) {
  const entries = []; let remaining = 256000;
  const add = (patch, name) => {
    if (typeof patch !== 'string' || !patch.trim()) return;
    let normalized = patch.replace(/\r\n/g, '\n');
    if (name && /^@@ /m.test(normalized) && !/^--- /m.test(normalized)) {
      const path = String(name).replace(/[\r\n\t]/g, ' ');
      normalized = `--- a/${path}\n+++ b/${path}\n${normalized}`;
    }
    if (!/^--- .+\n\+\+\+ .+\n/m.test(normalized)) return;
    const fits = normalized.length <= remaining;
    if (fits) remaining -= normalized.length;
    entries.push(fits ? { name: name || '文件变更', patch: normalized } : { name: name || '文件变更', unavailable: '差异超过预览大小限制，请查看原始工具输出。' });
  };
  for (const change of Array.isArray(event.changes) ? event.changes : []) add(change.diff, change.path);
  add(event.patch);
  if (!entries.length) add(event.output);
  return entries.slice(0, 30);
}
module.exports = { toolDiffs };
