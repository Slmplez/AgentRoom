import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { z } from 'zod';
import type { ChatClient } from './types';
import type { ArtifactSelection } from './artifact-view';
import { formVersionSchema } from '../../contracts/artifacts.mjs';
import { formValuesSchema, formStateSchema, formResponseSchema, validateFormValues } from '../../contracts/forms.mjs';
import { AttachmentPicker, MessageAttachments } from './attachments';
import { useEntrance } from './motion';
import './form-view.css';

type Form = z.infer<typeof formVersionSchema>;
type State = z.infer<typeof formStateSchema>;
type Response = z.infer<typeof formResponseSchema>;
type Values = Record<string, string | number | boolean | string[]>;
type Draft = { values: Values; baseRevision: number };
const stable = (value: unknown): unknown => value && typeof value === 'object' ? Array.isArray(value) ? value.map(stable) : Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)])) : value;
const same = (a: unknown, b: unknown) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
const labels: Record<State['status'], string> = { waiting: '等待答复与明确继续', pending: '继续意图已记录，等待投递', attempting: '正在投递，尚未收到原工具确认', submitted: '原工具已确认收到答复', expired: '原等待已失效', unknown: '投递结果未知，不会自动重发' };
function initialDraft(key: string, form: Form, state: State): Draft {
  try {
    const raw = localStorage.getItem(key);
    if (raw && raw.length <= 256 * 1024) {
      const value = JSON.parse(raw);
      if (Number.isSafeInteger(value.baseRevision) && value.baseRevision >= 0 && formValuesSchema.safeParse(value.values).success) return value;
    }
  } catch { /* The initial server response remains available when no local draft can be read. */ }
  return { baseRevision: state.responseRevision, values: state.response?.values || Object.fromEntries(form.spec.groups.flatMap(group => group.fields).filter(field => field.default !== undefined).map(field => [field.id, field.default!])) };
}
function submittedValues(form: Form, values: Values): Values {
  const result: Values = { ...values };
  for (const field of form.spec.groups.flatMap(group => group.fields)) {
    const value = result[field.id];
    if ((field.type === 'number' || field.type === 'date' || field.type === 'select') && value === '') delete result[field.id];
    else if (field.type === 'number' && typeof value === 'string' && value.trim() !== '') result[field.id] = Number(value);
  }
  return result;
}

export default function FormView({ client, selection, close }: { client: ChatClient; selection: ArtifactSelection; close(): void }) {
  const snapshot = useSyncExternalStore(client.subscribe, client.read, client.read);
  const [version, setVersion] = useState(selection.version), [form, setForm] = useState<Form | null>(null), [state, setState] = useState<State | null>(null);
  const [definitionError,setDefinitionError]=useState('');
  const [error, setError] = useState(''), [attempt, retry] = useState(0);
  const panel = useRef<HTMLElement>(null), heading = useRef<HTMLHeadingElement>(null);
  useEntrance(panel, true, 'panel');
  useEffect(() => { const previous = document.activeElement as HTMLElement | null; heading.current?.focus(); return () => { if (previous?.isConnected) previous.focus(); }; }, []);
  useEffect(() => {
    let alive = true, reading = false, again = false; setForm(null); setState(null); setError('');setDefinitionError('');
    void client.query({ type: 'artifact', roomId: selection.roomId, artifactId: selection.artifactId, version }).then(value => {
      const parsed = formVersionSchema.parse(value); if (alive) setForm(parsed);
    }).catch(e => { if (alive) setDefinitionError(e.message || '表单读取失败。'); });
    async function refresh() {
      if (reading) { again = true; return; } reading = true;
      try { const value = await client.query({ type: 'formState', roomId: selection.roomId, artifactId: selection.artifactId, version }); if (alive) { setState(value); setError(''); } }
      catch (e) { if (alive) setError((e as Error).message); }
      finally { reading = false; if (again && alive) { again = false; void refresh(); } }
    }
    void refresh(); const unsubscribe = client.subscribe(() => { if (alive) void refresh(); });
    return () => { alive = false; unsubscribe(); };
  }, [client, selection.roomId, selection.artifactId, version, attempt]);
  const versionStart=Math.max(1,version-49), versionEnd=Math.min(state?.latestVersion || version,versionStart+99);
  const key = JSON.stringify([snapshot.backendId, snapshot.databaseId, snapshot.currentUserId, selection.roomId, selection.artifactId, version]);
  return <aside ref={panel} className="result-panel form-panel" id="result-preview-panel" aria-label="任务表单" onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } }}>
    <div className="result-heading"><div><h2 tabIndex={-1} ref={heading}>{form?.title || selection.title}</h2><p>任务表单 · 版本 {version}</p></div><button className="button" aria-label="返回表单原消息" onClick={close}>返回对话</button></div>
    <div className="form-toolbar"><label>查看版本 <select aria-label="表单版本" value={version} onChange={e => setVersion(Number(e.target.value))}>{Array.from({ length: versionEnd-versionStart+1 }, (_, i) => i + versionStart).map(value => <option key={value} value={value}>版本 {value}</option>)}</select></label><button className="button" onClick={() => retry(n => n + 1)}>重新读取</button></div>
    {state && state.latestVersion > version && <p className="form-notice">已有新版本 {state.latestVersion}，旧草稿仍保留。<button className="button" onClick={() => setVersion(state.latestVersion)}>打开新版本</button></p>}
    {(error || definitionError) && <p className="chat-inline-error" role="alert">{definitionError || error}</p>}
    <div className="result-content">{form && state && form.version === version && state.version === version && form.artifactId === selection.artifactId && state.artifactId === selection.artifactId ? <FormBody key={key} client={client} form={form} state={state} storageKey={`ar-form-draft:${key}`} /> : !error && !definitionError && <p role="status">正在读取表单…</p>}</div>
  </aside>;
}

function FormBody({ client, form, state, storageKey }: { client: ChatClient; form: Form; state: State; storageKey: string }) {
  const snapshot = useSyncExternalStore(client.subscribe, client.read, client.read);
  const [draft, setDraft] = useState(() => initialDraft(storageKey, form, state)), [busy, setBusy] = useState(false), [uploading, setUploading] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [errors, setErrors] = useState<Record<string, string>>({});
  const [history, setHistory] = useState<Response[]>([]), [before, setBefore] = useState<number | null>(null);
  const alive = useRef(true), lock = useRef(false), current = useRef(draft); current.current = draft;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { try { localStorage.setItem(storageKey, JSON.stringify(draft)); } catch { setError('无法保存本地草稿，请检查浏览器存储。'); } }, [draft, storageKey]);
  const values = submittedValues(form, draft.values), validation = validateFormValues(form.spec, values);
  const operations = (snapshot.pendingOperations || []).filter(o => (o.type === 'submitForm' || o.type === 'continueForm') && o.artifactId === form.artifactId && o.version === form.version);
  const disabled = snapshot.connection !== 'live' || !snapshot.capabilities.forms || !state.canSubmit || busy || operations.length > 0;
  const savedMatches = Boolean(state.response && validation.ok && same(values, state.response.values) && draft.baseRevision === state.responseRevision);
  const workspaceId = snapshot.rooms.find(room => room.id === form.roomId)?.workspaceId || '';
  async function act(action: () => Promise<void>) {
    if (lock.current) return; lock.current = true; setBusy(true); setError(''); setNotice('');
    try { await action(); } catch (e) { if (alive.current) setError((e as Error).message); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  }
  async function submit() {
    if (disabled || uploading) return;
    if (!validation.ok) { setErrors(validation.errors); return; } setErrors({});
    await act(async () => {
      const receipt = await client.dispatch({ type: 'submitForm', key: crypto.randomUUID(), workspaceId, roomId: form.roomId, artifactId: form.artifactId, version: form.version, expectedResponseRevision: draft.baseRevision, values });
      if (alive.current && receipt.form) { setDraft(old => ({ ...old, baseRevision: receipt.form!.responseRevision })); setNotice(`答复已保存为修订 ${receipt.form.responseRevision}，任务仍在等待。`); }
    });
  }
  async function historyPage(older?: number) {
    await act(async () => { const page = await client.query({ type: 'formResponses', roomId: form.roomId, artifactId: form.artifactId, version: form.version, ...(older ? { beforeRevision: older } : {}) }); if (alive.current) { setHistory(old => older ? [...old, ...page.responses] : page.responses); setBefore(page.beforeRevision); } });
  }
  const edit = (id: string, value: Values[string]) => setDraft(old => ({ ...old, values: { ...old.values, [id]: value } }));
  return <div className="form-body">
    <p className="form-notice">任务：{state.goal}<br />负责人：{state.ownerAgentId}</p>
    <p role="status" data-form-status={state.status}>{labels[state.status]}{state.responseRevision > 0 && ` · 已保存修订 ${state.responseRevision}`}</p>
    {state.status === 'waiting' && state.response && !savedMatches && <p className="form-notice">当前编辑与已保存答复不同，或答复已被另一客户端更新。提交更正后才能继续。<button className="button" disabled={busy || uploading} onClick={() => { setDraft({ values: state.response!.values, baseRevision: state.responseRevision }); setErrors({}); }}>用最新已保存答复替换草稿</button></p>}
    {!snapshot.capabilities.forms && <p role="status">当前宿主未启用表单动作，历史仍可查看。</p>}
    <form onSubmit={e => { e.preventDefault(); void submit(); }} onKeyDownCapture={e => { if (e.key === 'Enter' && e.nativeEvent.isComposing) e.preventDefault(); }}>
      {form.spec.groups.map(group => <fieldset key={group.id} disabled={disabled}><legend>{group.title}</legend>{group.description && <p>{group.description}</p>}{group.fields.map(field => {
        const value = draft.values[field.id], fieldKey = `form-${form.artifactId}-${form.version}-${field.id}`, errorId = `${fieldKey}-error`;
        const common = { id: fieldKey, 'aria-label': field.label, 'aria-describedby': errors[field.id] ? errorId : undefined, 'aria-invalid': Boolean(errors[field.id]), 'aria-required': field.required };
        const list = Array.isArray(value) ? value : [];
        return <div className="form-field" key={field.id}><label htmlFor={fieldKey}>{field.label}{field.required && <span aria-hidden="true"> *</span>}</label>{field.description && <p className="form-field-hint">{field.description}</p>}
          {field.type === 'text' && <input {...common} type="text" maxLength={field.maxLength} value={typeof value === 'string' ? value : ''} onChange={e => edit(field.id, e.target.value)} />}
          {field.type === 'textarea' && <textarea {...common} rows={3} maxLength={field.maxLength} value={typeof value === 'string' ? value : ''} onChange={e => edit(field.id, e.target.value)} />}
          {field.type === 'number' && <input {...common} type="number" min={field.min} max={field.max} step={field.integer ? 1 : 'any'} value={typeof value === 'number' || typeof value === 'string' ? value : ''} onChange={e => edit(field.id, e.target.value)} />}
          {field.type === 'date' && <input {...common} type="date" min={field.min} max={field.max} value={typeof value === 'string' ? value : ''} onChange={e => edit(field.id, e.target.value)} />}
          {field.type === 'checkbox' && <input {...common} type="checkbox" checked={value === true} onChange={e => edit(field.id, e.target.checked)} />}
          {field.type === 'select' && <select {...common} value={typeof value === 'string' ? value : ''} onChange={e => edit(field.id, e.target.value)}><option value="">请选择</option>{field.options.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</select>}
          {field.type === 'multiselect' && <div id={fieldKey} role="group" aria-label={field.label}>{field.options.map(option => <label className="form-choice" key={option.id}><input type="checkbox" checked={list.includes(option.id)} onChange={e => edit(field.id, e.target.checked ? [...list, option.id] : list.filter(id => id !== option.id))} />{option.label}</label>)}</div>}
          {field.type === 'attachments' && <div id={fieldKey}><AttachmentPicker client={client} workspaceId={workspaceId} roomId={form.roomId} selected={list} change={ids => edit(field.id, ids)} disabled={disabled || uploading} busyChanged={setUploading} /></div>}
          {errors[field.id] && <p id={errorId} className="chat-inline-error" role="alert">{errors[field.id]}</p>}
        </div>;
      })}</fieldset>)}
      {errors._form && <p role="alert">{errors._form}</p>}
      <div className="form-actions"><button className="button" data-submit-form type="submit" disabled={disabled || uploading}>提交答复</button><button className="button" data-continue-form type="button" disabled={disabled || uploading || !savedMatches} onClick={() => void act(async () => { await client.dispatch({ type: 'continueForm', key: crypto.randomUUID(), workspaceId, roomId: form.roomId, artifactId: form.artifactId, version: form.version, responseRevision: state.responseRevision, expectedWaitRevision: state.waitRevision }); if (alive.current) setNotice('继续意图已记录，请查看原工具投递状态。'); })}>继续原任务</button></div>
    </form>
    <p className="form-field-hint">提交只保存答复。只有“继续原任务”会投递已保存的修订；接收确认不代表任务通过验收。</p>
    {operations.map(operation => <div className="form-notice" key={operation.key} role="status">{operation.type === 'submitForm' ? '保存答复' : '继续任务'}结果待核查。<button className="button" disabled={busy || snapshot.connection !== 'live'} onClick={() => void act(async () => { const receipt = await client.checkOperation?.(operation.key, operation.type); if (alive.current) setNotice(receipt ? '已找到原回执。请核对已保存内容；草稿保持不变。' : '原回执未找到，可以明确重试已保存的原请求。'); })}>核查原表单请求</button>{operation.outcome === 'not_found' && <button className="button" disabled={busy || snapshot.connection !== 'live'} onClick={() => void act(async () => { await client.retryOperation?.(operation.key); })}>重试原表单请求</button>}</div>)}
    {notice && <p role="status">{notice}</p>}{error && <p className="chat-inline-error" role="alert">{error}</p>}
    <details className="form-history"><summary>已保存答复历史</summary><button className="button" disabled={busy} onClick={() => void historyPage()}>读取答复修订</button>{history.map(response => <details key={response.revision}><summary>修订 {response.revision} · {new Date(response.createdAt).toLocaleString()}</summary><p>回答者：{response.authorId}</p><pre>{JSON.stringify(response.values, null, 2)}</pre><MessageAttachments client={client} files={response.attachmentRefs} /></details>)}{before && <button className="button" disabled={busy} onClick={() => void historyPage(before)}>更早修订</button>}</details>
  </div>;
}
