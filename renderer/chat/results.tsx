import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { defineCatalog, type Spec } from '@json-render/core';
import { schema } from '@json-render/react/schema';
import { defineRegistry, JSONUIProvider, Renderer } from '@json-render/react';
import { z } from 'zod';
import { PreviewMode, ReportSummary } from './preview-mode';
import { useEntrance } from './motion';

// Local UI examples only. No transport, model output or application command is accepted here.
const catalog = defineCatalog(schema, {
  components: {
    Section: { props: z.object({ title: z.string(), description: z.string() }), description: 'A result section' },
    Metrics: { props: z.object({ items: z.array(z.object({ label: z.string(), value: z.string(), detail: z.string() })) }), description: 'Summary values' },
    Bars: { props: z.object({ title: z.string(), items: z.array(z.object({ label: z.string(), value: z.number().min(0).max(100) })) }), description: 'Progress with text equivalents' },
    Table: { props: z.object({ columns: z.array(z.string()), rows: z.array(z.array(z.string())) }), description: 'Result table' },
    Field: { props: z.object({ name: z.enum(['title', 'priority', 'notes']), label: z.string(), multiline: z.boolean(), required: z.boolean(), options: z.array(z.string()) }), description: 'Local draft field' },
  }, actions: {},
});
type Values = { title: string; priority: string; notes: string };
const DraftContext = createContext<{ values: Values; change(name: keyof Values, value: string): void }>({ values: { title: '', priority: '普通', notes: '' }, change: () => {} });
const { registry } = defineRegistry(catalog, {
  components: {
    Section: ({ props, children }) => <section className="result-section"><h3>{props.title}</h3><p className="result-description">{props.description}</p>{children}</section>,
    Metrics: ({ props }) => <dl className="result-metrics">{props.items.map(item => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd><small>{item.detail}</small></div>)}</dl>,
    Bars: ({ props }) => <figure className="result-chart"><figcaption>{props.title}</figcaption>{props.items.map(item => <div className="result-bar" key={item.label}><div><span>{item.label}</span><span>{item.value}%</span></div><div className="result-bar-track" aria-hidden="true"><span style={{ width: `${item.value}%` }} /></div></div>)}</figure>,
    Table: ({ props }) => <div className="result-table-wrap" tabIndex={0} role="region" aria-label="结果明细"><table><thead><tr>{props.columns.map(c => <th key={c} scope="col">{c}</th>)}</tr></thead><tbody>{props.rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}</tbody></table></div>,
    Field: ({ props }) => {
      const { values, change } = useContext(DraftContext);
      const shared = { value: values[props.name], required: props.required, onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => change(props.name, e.target.value) };
      return <label className="result-field"><span>{props.label}{props.required && <small>必填</small>}</span>{props.options.length ? <select {...shared}>{props.options.map(o => <option key={o}>{o}</option>)}</select> : props.multiline ? <textarea {...shared} rows={4} maxLength={4000} /> : <input {...shared} maxLength={160} />}</label>;
    },
  },
});
const examples: Record<string, Spec> = {
  dashboard: { root: 'root', elements: {
    root: { type: 'Section', props: { title: '改版进展', description: '示例数据 · 汇总关键指标，详细过程仍在对话中。' }, children: ['metrics', 'chart', 'table'] },
    metrics: { type: 'Metrics', props: { items: [{ label: '待检查', value: '3', detail: '交互场景' }, { label: '已整理', value: '8', detail: '界面组件' }, { label: '待决定', value: '1', detail: '设计问题' }] } },
    chart: { type: 'Bars', props: { title: '示例进度', items: [{ label: '消息阅读', value: 85 }, { label: '输入体验', value: 70 }, { label: '结果展示', value: 45 }] } },
    table: { type: 'Table', props: { columns: ['事项', '状态'], rows: [['群聊与单 Agent', '检查中'], ['工具活动', '已整理'], ['结果面板', '待讨论']] } },
  } },
  table: { root: 'root', elements: {
    root: { type: 'Section', props: { title: '界面检查清单', description: '示例表格 · 用结构化内容承载明细，减少对话中的长篇罗列。' }, children: ['table'] },
    table: { type: 'Table', props: { columns: ['场景', '检查点', '建议'], rows: [['群聊', '连续选择多个成员', '显示已选成员'], ['单 Agent', '保持独立草稿', '隐藏多成员选择'], ['权限确认', '显示来源与作用域', '明确允许和拒绝'], ['长对话', '阅读历史时有新回复', '保留滚动位置']] } },
  } },
  form: { root: 'root', elements: {
    root: { type: 'Section', props: { title: '补充交付要求', description: '填写并保存本会话的本地示例草稿。不会发送给 Agent。' }, children: ['title', 'priority', 'notes'] },
    title: { type: 'Field', props: { name: 'title', label: '目标', multiline: false, required: true, options: [] } },
    priority: { type: 'Field', props: { name: 'priority', label: '优先级', multiline: false, required: false, options: ['普通', '优先处理', '稍后处理'] } },
    notes: { type: 'Field', props: { name: 'notes', label: '验收说明', multiline: true, required: false, options: [] } },
  } },
};
// Validate the local examples with the same allowlisted catalog used to render them.
for (const spec of Object.values(examples)) {
  for (const element of Object.values(spec.elements)) element.children ??= [];
  if (!catalog.validate(spec).success) throw new Error('结果示例不符合组件目录。');
}
const tabs = [{ id: 'dashboard', label: '概览' }, { id: 'table', label: '表格' }, { id: 'form', label: '表单' }];
export default function ResultPanel({ roomId, roomTitle, open, close }: { roomId: string; roomTitle: string; open: boolean; close(): void }) {
  const [full, setFull] = useState(false);
  const [tab, setTab] = useState('dashboard'), [drafts, setDrafts] = useState<Record<string, Values>>({}), [saved, setSaved] = useState<Record<string, boolean>>({});
  const heading = useRef<HTMLHeadingElement>(null), previous = useRef<HTMLElement | null>(null);
  const panel = useRef<HTMLElement>(null);
  useEntrance(panel, open, 'panel');
  const values = drafts[roomId] || { title: '', priority: '普通', notes: '' };
  useEffect(() => { if (open) { previous.current = document.activeElement as HTMLElement; heading.current?.focus(); } else if (previous.current?.isConnected) { previous.current.focus(); previous.current = null; } }, [open]);
  const change = (name: keyof Values, value: string) => { setDrafts(old => ({ ...old, [roomId]: { ...values, [name]: value } })); setSaved(old => ({ ...old, [roomId]: false })); };
  return <aside ref={panel} id="result-preview-panel" className="result-panel" hidden={!open} aria-label="结果预览" onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } }}>
    <div className="result-heading"><div><h2 ref={heading} tabIndex={-1}>结果预览</h2><p>{roomTitle}</p></div><button className="button" aria-label="关闭结果面板" onClick={close}>关闭</button></div>
    <PreviewMode full={full} change={setFull} />
    <p className="result-preview-label">本地示例 · 不代表实际任务结果</p>
    <div className="result-tabs" role="tablist" aria-label="结果视图">{tabs.map((item, index) => <button key={item.id} role="tab" id={`result-tab-${item.id}`} aria-controls="result-content" aria-selected={tab === item.id} tabIndex={tab === item.id ? 0 : -1} onClick={() => setTab(item.id)} onKeyDown={e => {
      const next = e.key === 'ArrowRight' ? (index + 1) % tabs.length : e.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : -1;
      if (next >= 0) { e.preventDefault(); setTab(tabs[next].id); document.getElementById(`result-tab-${tabs[next].id}`)?.focus(); }
    }}>{item.label}</button>)}</div>
    <div className="result-content" id="result-content" role="tabpanel" aria-labelledby={`result-tab-${tab}`} tabIndex={0}>
      {!full && <ReportSummary spec={examples[tab]} />}
      <div hidden={!full}><DraftContext.Provider value={{ values, change }}><JSONUIProvider registry={registry}>
        <form onSubmit={e => { e.preventDefault(); if (values.title.trim()) setSaved(old => ({ ...old, [roomId]: true })); }}>
          <Renderer spec={examples[tab]} registry={registry} />
          {tab === 'form' && <div className="result-form-actions"><button className="button primary" disabled={!values.title.trim()} type="submit">保存本地草稿</button><span role="status">{saved[roomId] ? '已保存在本页，刷新后清除' : '尚未保存'}</span></div>}
        </form>
      </JSONUIProvider></DraftContext.Provider></div>
    </div>
  </aside>;
}
