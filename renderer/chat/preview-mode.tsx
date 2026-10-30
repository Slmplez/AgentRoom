import React from 'react';
import type { Spec } from '@json-render/core';

export function PreviewMode({ full, change }: { full: boolean; change(value: boolean): void }) {
  return <div className="preview-mode" role="group" aria-label="预览详细程度">
    <button aria-pressed={!full} onClick={() => change(false)}>简短</button>
    <button aria-pressed={full} onClick={() => change(true)}>完整</button>
  </div>;
}

// Extract only published content. This is a compact view, not a generated conclusion.
export function ReportSummary({ spec }: { spec: Spec }) {
  const seen = new Set<string>(), nodes: typeof spec.elements[string][] = [];
  function visit(id: string) {
    if (seen.has(id)) return;
    seen.add(id);
    const node = spec.elements[id];
    if (!node) return;
    nodes.push(node);
    for (const child of node.children || []) visit(child);
  }
  visit(spec.root);
  const sections = nodes.filter(n => n.type === 'Section').slice(0, 3);
  const metrics = nodes.filter(n => n.type === 'Metrics').flatMap(n => Array.isArray(n.props.items) ? n.props.items : []).slice(0, 3);
  const rows = nodes.filter(n => n.type === 'Table').reduce((sum, n) => sum + (Array.isArray(n.props.rows) ? n.props.rows.length : 0), 0);
  const fields = nodes.filter(n => n.type === 'Field').length;
  return <div className="preview-summary">
    {sections.map((n, i) => <section key={i}><h3>{String(n.props.title || '')}</h3><p>{String(n.props.description || '暂无摘要说明。')}</p></section>)}
    {metrics.length > 0 && <dl className="result-metrics">{metrics.map((m, i) => <div key={i}><dt>{String(m.label)}</dt><dd>{String(m.value)}</dd><small>{String(m.detail || '')}</small></div>)}</dl>}
    {rows > 0 && <p>明细共 {rows} 行，可在完整视图中查看。</p>}
    {fields > 0 && <p>共 {fields} 个填写项，请切换完整视图填写。</p>}
  </div>;
}
