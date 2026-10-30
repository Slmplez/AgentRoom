import React, { useEffect, useRef, useState } from 'react';
import type { ChatClient, QueryResult } from './types';

type Model = QueryResult<'modelCatalog'>['catalog'][number];
const status = { compatible: '声明匹配', incompatible: '不可用', unknown: '待验证' };
const flag = (value: boolean | null) => value === null ? '未知' : value ? '支持' : '不支持';
export function ModelDetails({ model, engineId }: { model?: Model; engineId?: string }) {
  if (!model) return <p className="settings-note">未读取到此模型的能力声明；可以手动填写，实际可用性待验证。</p>;
  const c = model.capabilities;
  return <div className="settings-note" data-model-details>
    <p>{model.source === 'manual' ? '手动模型，未在上游目录中列出' : `上游声明：${model.name}`} · 工具调用：{flag(c.tools)} · 图片：{flag(c.images)} · 流式：{flag(c.streaming)} · 推理：{flag(c.reasoning)}</p>
    <p>上下文：{c.contextWindow ?? '未知'} · 最大输出：{c.maxOutputTokens ?? '未知'}</p>
    {model.compatibility.filter(item => !engineId || item.engineId === engineId).map(item => <p key={item.engineId}>{item.engineId} · {status[item.status]}：{item.reason}</p>)}
  </div>;
}
export function LaunchModelPicker({ client, connectionId, defaultModel, engineId, active }: { client: ChatClient; connectionId: string; defaultModel: string; engineId: string; active: boolean }) {
  const [model, setModel] = useState(defaultModel), [data, setData] = useState<QueryResult<'modelCatalog'>>(), [error, setError] = useState(''), [loading, setLoading] = useState(false), [revision, refresh] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!active) return;
    let disposed = false; setLoading(true); setData(undefined); setError('');
    void client.query({ type: 'modelCatalog', connectionId }).then(value => { if (!disposed) setData(value); }).catch(error => { if (!disposed) setError(error.message); }).finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [client, connectionId, active, revision]);
  const selected = data?.catalog.find(item => item.id === model.trim()), compatibility = selected?.compatibility.find(item => item.engineId === engineId);
  useEffect(() => { input.current?.setCustomValidity(compatibility?.status === 'incompatible' ? compatibility.reason : ''); }, [compatibility]);
  return <div>
    <label className="settings-field"><span>本次使用的模型</span><input ref={input} name="model" required maxLength={200} value={model} onChange={e => setModel(e.target.value)} list="launch-models" /></label>
    <datalist id="launch-models">{data?.catalog.map(item => <option key={item.id} value={item.id}>{item.name} · {status[item.compatibility.find(c => c.engineId === engineId)?.status || 'unknown']}</option>)}</datalist>
    <button className="button" type="button" disabled={loading} onClick={() => refresh(value => value + 1)}>{loading ? '正在读取模型…' : '刷新模型目录'}</button>
    {error && <p role="alert">{error}</p>}{data && <p role="status">{data.message}</p>}
    <ModelDetails model={selected} engineId={engineId} />
  </div>;
}
