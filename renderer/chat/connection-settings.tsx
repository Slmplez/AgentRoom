import React, { useEffect, useRef, useState } from 'react';
import type { ChatClient, PlatformClient, QueryResult } from './types';
import { PathField } from './path-field';
import { formText, requestKey, useSettingsQuery, type SettingsActions } from './settings-data';

type Profile = QueryResult<'connections'>['profiles'][number];
type Credential = { action: 'keep' | 'clear' } | { action: 'replace'; value: string };
type Write = { type: 'saveConnection'; key: string; id?: string; profile: Omit<Profile, 'id' | 'hasApiKey' | 'hasPassphrase' | 'compatibleEngines'>; credentials: { apiKey: Credential; passphrase: Credential } };
const protocols = { multi: '多协议网关', responses: 'OpenAI Responses', chat: 'OpenAI Chat Completions', anthropic: 'Anthropic Messages' };
export function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="settings-field"><span>{label}</span>{children}</label>; }
export function QueryState({ loading, error, refresh }: { loading: boolean; error: string; refresh(): void }) { return <>{loading && <p role="status" className="settings-note">正在读取…</p>}{error && <p role="alert">{error} <button className="button" onClick={refresh}>重试</button></p>}</>; }

export function ConnectionSettings({ client, platform, active, actions }: { client: ChatClient; platform: PlatformClient; active: boolean; actions: SettingsActions }) {
  const query = useSettingsQuery(client, 'connections', active), [editing, setEditing] = useState(''), [revision, setRevision] = useState(0);
  const selected = query.data?.profiles.find(p => p.id === editing);
  return <>
    <QueryState {...query} />
    {query.data && <><div className="settings-list">{query.data.profiles.map(p => <button className="settings-row" aria-pressed={editing === p.id} disabled={actions.busy} key={p.id} onClick={() => setEditing(p.id)}><span><strong>{p.name}</strong><small>{p.model} · {protocols[p.protocol]}</small></span><span>编辑</span></button>)}</div>
      <button className="button" disabled={actions.busy} onClick={() => { setEditing(''); setRevision(v => v + 1); }}>新建连接</button>
      <ConnectionEditor key={`${editing}:${revision}`} profile={selected} client={client} platform={platform} active={active} actions={actions} secure={query.data.secureStorageAvailable} saved={() => { query.refresh(); if (!editing) setRevision(v => v + 1); }} removed={() => { setEditing(''); query.refresh(); }} />
    </>}
  </>;
}
function ConnectionEditor({ profile, client, platform, active, secure, actions, saved, removed }: { profile?: Profile; client: ChatClient; platform: PlatformClient; active: boolean; secure: boolean; actions: SettingsActions; saved(): void; removed(): void }) {
  const form = useRef<HTMLFormElement>(null), epoch = useRef(0), testingRef = useRef(false);
  const [testing, setTesting] = useState(false), [result, setResult] = useState(''), [models, setModels] = useState<string[]>([]), [deleting, setDeleting] = useState(false);
  const operation = `connection:${profile?.id || 'new'}`, blocked = actions.blocked(operation) || testing;
  useEffect(() => { if (!active) { epoch.current++; testingRef.current = false; setTesting(false); setResult(''); form.current?.querySelectorAll<HTMLInputElement>('input[type=password]').forEach(input => { input.value = ''; }); } return () => { epoch.current++; }; }, [active]);
  function write(): Write {
    const f = new FormData(form.current!);
    const credential = (name: string): Write['credentials']['apiKey'] => f.has(`clear-${name}`) ? { action: 'clear' } : String(f.get(name) || '') ? { action: 'replace', value: String(f.get(name)) } : { action: 'keep' };
    return { type: 'saveConnection', key: requestKey(), id: profile?.id, profile: {
      name: formText(f, 'name'), protocol: formText(f, 'protocol') as Profile['protocol'], baseUrl: formText(f, 'baseUrl'), model: formText(f, 'model'), authMode: formText(f, 'authMode') as Profile['authMode'],
      contextWindow: Number(f.get('contextWindow')), maxTokens: Number(f.get('maxTokens')), reasoning: f.has('reasoning'), caPath: formText(f, 'caPath'), clientCertPath: formText(f, 'clientCertPath'), clientKeyPath: formText(f, 'clientKeyPath'),
    }, credentials: { apiKey: credential('apiKey'), passphrase: credential('passphrase') } };
  }
  async function test() {
    if (testingRef.current || blocked || !form.current?.reportValidity()) return;
    const current = ++epoch.current; testingRef.current = true; setTesting(true); setResult('');
    try { const value = await client.query({ ...write(), type: 'testConnection' }); if (current === epoch.current) { setResult(value.message); setModels(value.models); } }
    catch (error) { if (current === epoch.current) setResult((error as Error).message); }
    finally { if (current === epoch.current) { testingRef.current = false; setTesting(false); } }
  }
  return <form ref={form} className="settings-form" onSubmit={async e => { e.preventDefault(); if (await actions.run(operation, write())) { form.current?.querySelectorAll<HTMLInputElement>('input[type=password]').forEach(input => { input.value = ''; }); form.current?.querySelectorAll<HTMLInputElement>('input[name^="clear-"]').forEach(input => { input.checked = false; }); saved(); } }}>
    <h3>{profile ? '编辑连接' : '新建连接'}</h3>
    <fieldset disabled={blocked}>
      <Field label="方案名称"><input name="name" required maxLength={60} defaultValue={profile?.name} placeholder="例如：公司网关" /></Field>
      <Field label="API 协议"><select name="protocol" defaultValue={profile?.protocol || 'multi'}>{Object.entries(protocols).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
      <Field label="API Base URL"><input name="baseUrl" type="url" required defaultValue={profile?.baseUrl || 'http://127.0.0.1:3425/v1'} /></Field>
      <Field label="认证方式"><select name="authMode" defaultValue={profile?.authMode || 'bearer'}><option value="bearer">Bearer API Key</option><option value="api-key">x-api-key</option><option value="none">无认证（本地服务）</option></select></Field>
      <Field label={profile?.hasApiKey ? 'API Key · 已保存，留空保留' : 'API Key'}><input name="apiKey" type="password" autoComplete="new-password" maxLength={4096} disabled={!secure} /></Field>
      {profile?.hasApiKey && <label className="settings-check"><input name="clear-apiKey" type="checkbox" />清除已保存的 Key</label>}
      {!secure && <p className="settings-note">当前环境不能保存密钥，可使用桌面版配置。</p>}
      <Field label="默认模型 ID"><input name="model" required maxLength={200} defaultValue={profile?.model} list="settings-models" /><datalist id="settings-models">{models.map(m => <option key={m}>{m}</option>)}</datalist></Field>
      <details><summary>证书与模型参数</summary><div className="settings-advanced">
        {(['caPath', 'clientCertPath', 'clientKeyPath'] as const).map((name, i) => <PathField key={name} platform={platform} active={active} label={['CA 证书路径', '客户端证书路径', '客户端私钥路径'][i]} name={name} kind={i === 2 ? 'key' : 'cert'} value={profile?.[name]} />)}
        <Field label={profile?.hasPassphrase ? '私钥口令 · 留空保留' : '私钥口令'}><input name="passphrase" type="password" autoComplete="new-password" disabled={!secure} /></Field>
        {profile?.hasPassphrase && <label className="settings-check"><input type="checkbox" name="clear-passphrase" />清除已保存的口令</label>}
        <Field label="上下文 tokens"><input type="number" name="contextWindow" required min={1024} max={10000000} defaultValue={profile?.contextWindow || 128000} /></Field>
        <Field label="最大输出 tokens"><input type="number" name="maxTokens" required min={1} defaultValue={profile?.maxTokens || 8192} /></Field>
        <label className="settings-check"><input type="checkbox" name="reasoning" defaultChecked={profile?.reasoning} />模型支持 reasoning</label>
      </div></details>
    </fieldset>
    <div className="settings-actions"><button className="button" type="button" disabled={blocked} onClick={() => void test()}>{testing ? '测试中…' : '测试连接'}</button><button className="button primary" disabled={blocked}>保存连接</button>{profile && <button type="button" className="button danger" disabled={blocked} onClick={() => setDeleting(!deleting)}>删除连接</button>}</div>
    {result && <p role="status">{result}</p>}
    {deleting && <div className="settings-confirm"><p>删除「{profile?.name}」？已有 Agent 不会改用其他连接。</p><button type="button" className="button danger" disabled={blocked} onClick={async () => { if (await actions.run(operation, { type: 'removeConnection', key: requestKey(), id: profile!.id })) removed(); }}>确认删除</button><button type="button" className="button" onClick={() => setDeleting(false)}>保留</button></div>}
  </form>;
}
