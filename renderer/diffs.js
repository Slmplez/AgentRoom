window.createDiffUI = ({ showModal, esc }) => {
  let library, views = [], generation = 0;
  const dispose = () => { generation++; for (const view of views) view.cleanUp(); views = []; };
  function options(style) {
    return { diffStyle: style, theme: { light: 'pierre-light', dark: 'pierre-dark' },
      themeType: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
      preferredHighlighter: 'shiki-js', overflow: 'scroll', disableErrorHandling: true,
      unsafeCSS: ':host { --diffs-font-family: var(--font-mono); --diffs-font-size: var(--font-size-code); }' };
  }
  new MutationObserver(() => { for (const view of views) view.setThemeType(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return {
    dispose,
    async open(tool) {
      showModal('文件变更', `${tool.kind} · 只读差异预览`, '<div class="diff-controls"><button class="button" data-diff-style="unified" aria-pressed="true">合并</button><button class="button" data-diff-style="split" aria-pressed="false">并排</button></div><p id="diff-feedback" role="status">正在加载差异…</p><div id="diff-content"></div>', '<button class="button" data-action="close-modal">关闭</button>', true);
      const token = ++generation, container = document.querySelector('#diff-content');
      let files;
      const render = style => {
        for (const view of views) view.cleanUp(); views = []; container.replaceChildren();
        for (const fileDiff of files) {
          const host = document.createElement('diffs-container'); host.className = 'diff-file'; container.append(host);
          const view = new library.FileDiff(options(style)); views.push(view); view.render({ fileDiff, fileContainer: host });
        }
      };
      try {
        library ||= await import('./vendor/diffs/diffs.js');
        if (generation !== token || !container.isConnected) return;
        files = (tool.diffs || []).flatMap(entry => entry.patch ? library.parsePatchFiles(entry.patch, undefined, true).flatMap(patch => patch.files) : []);
        if (!files.length) throw new Error('没有可解析的统一差异。');
        render('unified');
        document.querySelector('#diff-feedback').textContent = `${files.length} 个文件 · 只读预览` + ((tool.diffs || []).some(entry => entry.unavailable) ? ' · 部分差异超过预览限制' : '');
        for (const button of document.querySelectorAll('[data-diff-style]')) button.onclick = () => {
          try { render(button.dataset.diffStyle); document.querySelectorAll('[data-diff-style]').forEach(b => b.setAttribute('aria-pressed', String(b === button))); }
          catch (error) { document.querySelector('#diff-feedback').textContent = `差异显示失败：${error.message}`; }
        };
      } catch (error) {
        if (generation !== token || !container.isConnected) return;
        for (const view of views) view.cleanUp(); views = [];
        document.querySelector('#diff-feedback').textContent = `无法显示差异：${error.message}`;
        container.innerHTML = (tool.diffs || []).map(entry => `<pre class="diff-raw">${esc(entry.patch || entry.unavailable)}</pre>`).join('');
      }
    },
  };
};
