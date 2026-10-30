/* Shared mention boundaries for the composer and the server-side recipient resolver. */
((root, factory) => {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AgentMentions = api;
})(typeof window === 'object' ? window : globalThis, () => {
  const boundary = char => !char || /[\s，。；：！？、（）【】「」《》,;:!?()[\]{}\p{Script=Han}]/u.test(char);
  function tokens(text) {
    const result = [];
    for (const match of text.matchAll(/@([a-zA-Z0-9][a-zA-Z0-9_-]*)/g)) {
      const start = match.index, end = start + match[0].length;
      if (!boundary(text[start - 1]) && result.at(-1)?.end !== start) continue;
      // Package names and domains are content, not recipients.
      if (/^(?:\/|\.[a-zA-Z0-9])/.test(text.slice(end))) continue;
      result.push({ name: match[1], start, end });
    }
    return result;
  }
  function context(text, cursor, selectionEnd = cursor) {
    if (cursor !== selectionEnd) return null;
    const before = text.slice(0, cursor), start = before.lastIndexOf('@');
    if (start < 0 || !/^[\p{L}\p{N}_-]*$/u.test(before.slice(start + 1))) return null;
    if (!boundary(text[start - 1]) && !tokens(text.slice(0, start)).some(token => token.end === start)) return null;
    const suffix = text.slice(cursor).match(/^[a-zA-Z0-9_-]*/)[0];
    if (/^(?:\/|\.[a-zA-Z0-9])/.test(text.slice(cursor + suffix.length))) return null;
    return { query: before.slice(start + 1), start, end: cursor + suffix.length };
  }
  function insert(text, position, name) {
    const prefix = text.slice(0, position.start), rest = text.slice(position.end);
    const suffix = /^\s/.test(rest) ? '' : ' ';
    return { text: `${prefix}@${name}${suffix}${rest}`, cursor: prefix.length + name.length + 1 + (suffix ? 1 : 0) };
  }
  return { tokens, context, insert };
});
