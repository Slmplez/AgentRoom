import React, { useEffect, useState } from 'react';
import type { SyntaxHighlighterProps } from '@assistant-ui/react-markdown';

let nextId = 0;
// Mermaid owns global configuration; serialize theme setup and rendering together.
let rendering: Promise<unknown> = Promise.resolve();
export function MermaidDiagram({ code }: SyntaxHighlighterProps) {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme || 'light');
  const [result, setResult] = useState<{ code: string; theme: string; svg?: string; failed?: boolean }>();
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(document.documentElement.dataset.theme || 'light'));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let active = true;
    // Debounce incomplete streaming fences; obsolete queued renders are skipped.
    const timer = setTimeout(() => {
      rendering = rendering.catch(() => {}).then(async () => {
        if (!active) return;
        try {
          if (code.length > 30000) throw new Error('Diagram too large');
          const { default: mermaid } = await import('mermaid');
          if (!active) return;
          mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true,
            theme: theme === 'dark' ? 'dark' : 'default', htmlLabels: false, maxTextSize: 30000, maxEdges: 300,
            secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges', 'suppressErrorRendering', 'htmlLabels', 'theme', 'dompurifyConfig'] });
          const { svg } = await mermaid.render(`chat-mermaid-${++nextId}`, code);
          if (active) setResult({ code, theme, svg });
        } catch {
          if (active) setResult({ code, theme, failed: true });
        }
      });
    }, 180);
    return () => { active = false; clearTimeout(timer); };
  }, [code, theme]);
  const current = result?.code === code && result.theme === theme ? result : undefined;
  return <div className="mermaid-block">
    {current?.svg ? <>
      <div className="mermaid-diagram" data-theme={theme} role="img" aria-label="Mermaid 图表" dangerouslySetInnerHTML={{ __html: current.svg }} />
      <details><summary>查看图表源码</summary><pre><code>{code}</code></pre></details>
    </> : <div className={current?.failed ? 'mermaid-fallback' : 'mermaid-pending'}>
      <p role="status">{current?.failed ? '图表暂时无法显示，请检查源码是否完整。' : '正在绘制图表…'}</p>
      <pre><code>{code}</code></pre>
    </div>}
  </div>;
}
