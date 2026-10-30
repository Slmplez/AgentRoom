import React, { useRef, useState } from 'react';
import type { ChatClient, QueryResult } from './types';
import { QueryState } from './connection-settings';
import { useSettingsQuery } from './settings-data';

const number = (value: number) => value.toLocaleString('zh-CN');
export function UsageSettings({ client, active }: { client: ChatClient; active: boolean }) {
  const query = useSettingsQuery(client, 'usage', active);
  const totals = query.data?.totals;
  return <><QueryState {...query} />{query.data && totals && <>
    <p className="settings-note">{query.data.period.from} — {query.data.period.to} · {query.data.timezone}{query.data.simulated ? ' · 演示数据' : ''}</p>
    {query.data.error && <p role="alert">{query.data.error}</p>}
    <dl className="usage-summary"><div><dt>已知 tokens</dt><dd>{number(totals.total)}</dd></div><div><dt>请求</dt><dd>{number(totals.requests)}</dd></div><div><dt>用量未知</dt><dd>{number(totals.unknown)}</dd></div></dl>
    <dl className="settings-usage-breakdown">{([['输入', totals.input], ['输出', totals.output], ['缓存命中', totals.cached], ['缓存写入', totals.cacheWrite], ['已报告用量', totals.known], ['异常请求', totals.errors]] as const).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{number(value)}</dd></div>)}</dl>
    <p className="settings-note">输入包含缓存命中与写入，缓存不会重复计入总量。</p>
    <UsageCalendar days={query.data.days} />
    <h3>按模型分布</h3><div className="settings-list">{query.data.models.map(m => <div className="settings-usage-model" key={m.label}><div className="settings-row"><span><strong>{m.label}</strong><small>{m.requests} 次请求 · {m.unknown} 次用量未知</small></span><span>{number(m.total)} tokens · {(m.total / Math.max(1, totals.total) * 100).toFixed(1)}%</span></div><div className="settings-usage-track"><span style={{ width: `${Math.min(100, m.total / Math.max(1, totals.total) * 100)}%` }} /></div></div>)}</div>
    {!query.data.models.length && <p className="settings-empty">暂无模型用量记录</p>}
    <h3>按引擎分布</h3><div className="settings-table-scroll"><table className="settings-usage-table"><thead><tr>{['引擎', '请求', '输入', '输出', '缓存命中', '用量未知'].map(label => <th key={label}>{label}</th>)}</tr></thead><tbody>{query.data.engines.map(e => <tr key={e.label}><th scope="row">{e.label}</th>{[e.requests, e.input, e.output, e.cached, e.unknown].map((v, i) => <td key={i}>{number(v)}</td>)}</tr>)}</tbody></table></div>
    {!query.data.engines.length && <p className="settings-empty">暂无引擎用量记录</p>}
    <p className="settings-note">仅统计经应用连接方案转发的请求，CLI 原配置不在此统计中；未知用量不按 0 计入。仅保存计数、模型、引擎与时间，不保存对话和密钥。</p>
    <button className="button" onClick={query.refresh}>刷新用量</button>
  </>}</>;
}
function UsageCalendar({ days }: { days: QueryResult<'usage'>['days'] }) {
  const [selected, setSelected] = useState<string>(), calendar = useRef<HTMLDivElement>(null);
  const current = days.find(d => d.date === selected) || days.at(-1), max = Math.max(1, ...days.map(d => d.total));
  return <><h3>每日用量 · 过去 52 周</h3><div className="settings-table-scroll"><div ref={calendar} className="settings-usage-calendar" role="group" aria-label="每日 Token 用量，方向键移动，回车查看日期详情">{days.map((day, index) => {
    const level = day.total ? Math.min(4, Math.max(1, Math.ceil(Math.log1p(day.total) / Math.log1p(max) * 4))) : 0;
    const title = `${day.date} · ${number(day.total)} tokens · ${day.requests} 次请求 · ${day.unknown} 次用量未知`;
    return <button type="button" key={day.date} className={`usage-day level-${level} ${day.unknown ? 'has-unknown' : ''}`} title={title} aria-label={title} aria-pressed={current?.date === day.date} tabIndex={current?.date === day.date ? 0 : -1} onClick={() => setSelected(day.date)} onKeyDown={e => {
      const next = ({ ArrowLeft: index - 7, ArrowRight: index + 7, ArrowUp: index - 1, ArrowDown: index + 1, Home: 0, End: days.length - 1 } as Record<string, number>)[e.key];
      if (next === undefined) return; e.preventDefault(); const at = Math.max(0, Math.min(days.length - 1, next)); setSelected(days[at].date); calendar.current?.querySelectorAll<HTMLButtonElement>('button')[at]?.focus();
    }} />;
  })}</div></div><p className="settings-note" role="status">{current ? `${current.date} · ${number(current.total)} tokens · ${current.requests} 次请求 · ${current.unknown} 次用量未知` : '暂无每日用量'}</p><p className="settings-note">颜色越深，用量越高；虚线表示存在未知用量。</p></>;
}
