import React, { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import type { Spec } from '@json-render/core';
import { reportVersionSchema as artifactVersionSchema } from '../../contracts/artifacts.mjs';
import type { ChatClient } from './types';
import type { ArtifactSelection } from './artifact-view';
const ReportContent = lazy(() => import('./report-content'));

import { previewReport } from './report-preview';

export default function InlineArtifact({ client, selection, mock, open }: {
  client: ChatClient; selection: ArtifactSelection; mock: boolean; open(): void;
}) {
  const container = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false), [attempt, retry] = useState(0);
  const [result, setResult] = useState<{ key: string; spec?: Spec; error?: string }>();
  const key = JSON.stringify([selection.roomId, selection.artifactId, selection.version]);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { root: element.closest('.messages'), rootMargin: '160px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    let current = true; setResult(undefined);
    void client.query({ type: 'artifact', roomId: selection.roomId, artifactId: selection.artifactId, version: selection.version }).then(raw => {
      const parsed = artifactVersionSchema.safeParse(raw);
      if (!parsed.success || parsed.data.roomId !== selection.roomId || parsed.data.artifactId !== selection.artifactId || parsed.data.version !== selection.version) throw { code: 'invalid_response' };
      if (current) setResult({ key, spec: parsed.data.spec as Spec });
    }).catch(error => {
      const messages: Record<string, string> = {
        forbidden: '无权读取此报告。', not_found: '报告不存在或不可访问。',
        artifact_unavailable: '报告内容缺失或损坏。', unsupported_catalog: '此报告的组件版本尚不受支持。',
        invalid_response: '报告内容未通过校验。', stale_query: '会话已变化，请重新读取。',
      };
      if (current) setResult({ key, error: messages[error?.code] || '报告加载失败，请检查连接后重试。' });
    });
    return () => { current = false; };
  }, [client, key, visible, attempt]);
  const current = result?.key === key ? result : undefined;
  const view = useMemo(() => current?.spec ? previewReport(current.spec) : null, [current?.spec]);
  return <section ref={container} className="inline-artifact" aria-label={`${selection.title} · 版本 ${selection.version}`}>
    <header><strong>{selection.title}</strong><span>{mock ? '模拟报告' : '任务报告'} · 版本 {selection.version}</span></header>
    <div className="inline-artifact-content" tabIndex={0} role="region" aria-label="报告预览，可滚动">
      {view ? <Suspense fallback={<p role="status">正在显示报告…</p>}><ReportContent spec={view.spec} /></Suspense> : current?.error ? <div role="status"><p>{current.error}</p><button className="button" onClick={() => retry(n => n + 1)}>重新读取预览</button></div> : <p className="inline-artifact-note">{visible ? '正在读取报告…' : '报告将在阅读时加载。'}</p>}
    </div>
    <p className="inline-artifact-note">{view?.truncated ? '预览已节选，可打开完整报告。' : '可滚动阅读，或打开完整报告。'}</p>
    <button className="button" data-artifact-id={selection.artifactId} data-artifact-version={selection.version} onClick={open}>查看报告 · {selection.title} · 版本 {selection.version}</button>
  </section>;
}
