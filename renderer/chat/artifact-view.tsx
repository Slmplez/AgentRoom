import React, { useEffect, useRef, useState } from 'react';
import type { Spec } from '@json-render/core';
import type { z } from 'zod';
import { ReportContent } from './report-content';
import { reportVersionSchema as artifactVersionSchema, artifactVersionsSchema, reportSchema } from '../../contracts/artifacts.mjs';
import { useEntrance } from './motion';
import './artifact-view.css';
import { PreviewMode, ReportSummary } from './preview-mode';

type Report = z.infer<typeof artifactVersionSchema>;
type Version = z.infer<typeof artifactVersionsSchema>['versions'][number];
export type ArtifactSelection = { kind?: 'report' | 'form'; roomId: string; artifactId: string; version: number; title: string; messageId: string };
type Reader = { query(input: { type: 'artifact'; roomId: string; artifactId: string; version: number } | { type: 'artifactVersions'; roomId: string; artifactId: string; beforeVersion?: number; limit?: number }): Promise<unknown> };

function errorText(error: unknown) {
  const code = (error as { code?: string })?.code;
  return ({ not_found: '报告不存在，或你无权读取它。', forbidden: '当前身份无权读取此报告。', artifact_unavailable: '报告内容缺失或损坏，无法展示。', unsupported_catalog: '此报告的组件目录版本尚不受支持。', invalid_response: '报告内容未通过校验，已停止展示。', stale_query: '会话已变化，请重新打开报告。' } as Record<string, string>)[code || ''] || '读取报告失败，请检查连接后重试。';
}

export default function ArtifactView({ client, selection, latestVersion, mock = false, close }: { client: Reader; selection: ArtifactSelection; latestVersion: number; mock?: boolean; close(): void }) {
  const [full, setFull] = useState(false);
  const [version, setVersion] = useState(selection.version), [attempt, retry] = useState(0);
  const [body, setBody] = useState<{ version: number; report?: Report; error?: string } | null>(null);
  const [versions, setVersions] = useState<Version[]>([]), [before, setBefore] = useState<number | null>(null);
  const [listError, setListError] = useState(''), [listLoading, setListLoading] = useState(false);
  const panel = useRef<HTMLElement>(null), heading = useRef<HTMLHeadingElement>(null), listEpoch = useRef(0), alive = useRef(true);
  useEntrance(panel, true, 'panel');
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    heading.current?.focus(); alive.current = true;
    return () => { alive.current = false; listEpoch.current++; if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    let current = true; setBody(null);
    void client.query({ type: 'artifact', roomId: selection.roomId, artifactId: selection.artifactId, version }).then(raw => {
      const parsed = artifactVersionSchema.safeParse(raw);
      if (!parsed.success || parsed.data.roomId !== selection.roomId || parsed.data.artifactId !== selection.artifactId || parsed.data.version !== version) throw { code: 'invalid_response' };
      if (current) setBody({ version, report: parsed.data });
    }).catch(error => { if (current) setBody({ version, error: errorText(error) }); });
    return () => { current = false; };
  }, [client, selection.roomId, selection.artifactId, version, attempt]);
  async function loadVersions(older?: number) {
    const epoch = ++listEpoch.current; setListLoading(true); setListError('');
    try {
      const raw = await client.query({ type: 'artifactVersions', roomId: selection.roomId, artifactId: selection.artifactId, ...(older ? { beforeVersion: older } : {}), limit: 20 });
      const parsed = artifactVersionsSchema.safeParse(raw);
      if (!parsed.success || parsed.data.versions.some(v => v.roomId !== selection.roomId || v.artifactId !== selection.artifactId)) throw { code: 'invalid_response' };
      if (alive.current && epoch === listEpoch.current) { setVersions(old => [...new Map([...(older ? old : []), ...parsed.data.versions].map(v => [v.version, v])).values()].sort((a, b) => b.version - a.version)); setBefore(parsed.data.beforeVersion); }
    } catch (error) { if (alive.current && epoch === listEpoch.current) setListError(errorText(error)); }
    finally { if (alive.current && epoch === listEpoch.current) setListLoading(false); }
  }
  useEffect(() => { void loadVersions(); }, [client, selection.roomId, selection.artifactId, latestVersion]);
  const current = body?.version === version ? body : null, report = current?.report;
  const source = report || versions.find(v => v.version === version);
  const latest = Math.max(selection.version, latestVersion, versions[0]?.version || 0);
  // Validate before json-render sees any model-controlled structure.
  const spec = report && reportSchema.safeParse(report.spec).success ? report.spec as Spec : null;
  return <aside ref={panel} id="result-preview-panel" className="result-panel artifact-panel" aria-label="任务报告" onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } }}>
    <div className="result-heading"><div><h2 ref={heading} tabIndex={-1}>{source?.title || selection.title}</h2><p>{mock ? '模拟报告 · 演示数据' : '任务报告 · 只读'} · 版本 {version}</p></div><button className="button" onClick={close} aria-label="返回报告原消息">返回对话</button></div>
    <PreviewMode full={full} change={setFull} />
    <div className="artifact-version-controls"><label>查看版本 <select aria-label="报告版本" value={version} onChange={e => setVersion(Number(e.target.value))}>{!versions.some(v => v.version === version) && <option value={version}>版本 {version}</option>}{versions.map(v => <option key={v.version} value={v.version}>版本 {v.version} · {v.title}</option>)}</select></label><button className="button" disabled={listLoading} onClick={() => void loadVersions()}>刷新版本</button>{before !== null && <button className="button" disabled={listLoading} onClick={() => void loadVersions(before)}>更早版本</button>}
      {listLoading && <span role="status">正在读取版本…</span>}{listError && <p role="alert">{listError}</p>}
      {latest > version && <button className="button artifact-new-version" onClick={() => setVersion(latest)}>有新版本 {latest}，点击查看</button>}
    </div>
    <div className="result-content" aria-busy={!current}>
      {source && <details className="artifact-source"><summary>来源与发布时间</summary><dl><dt>任务</dt><dd>{source.taskId}</dd><dt>执行</dt><dd>{source.runId}</dd><dt>Agent</dt><dd>{source.producerAgentId}</dd><dt>发布时间</dt><dd><time dateTime={source.createdAt}>{new Date(source.createdAt).toLocaleString()}</time></dd></dl></details>}
      {!current && <p role="status">正在读取报告…</p>}
      {current?.error && <div role="alert"><p>{current.error}</p><button className="button" onClick={() => retry(n => n + 1)}>重新读取</button></div>}
      {spec && !full && <ReportSummary spec={spec} />}
      {spec && full && <ReportContent spec={spec} />}
    </div>
  </aside>;
}
