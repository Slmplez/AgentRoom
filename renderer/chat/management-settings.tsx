import React, { useEffect, useRef, useState } from 'react';
import type { ChatClient, Command, Snapshot, QueryResult, PlatformClient } from './types';
import { PathField } from './path-field';
import { Field, QueryState } from './connection-settings';
import { LaunchModelPicker } from './model-picker';
import { formText, requestKey, useSettingsQuery, type SettingsActions } from './settings-data';

export type ManagementProps = { client: ChatClient; platform: PlatformClient; active: boolean; actions: SettingsActions; state: Snapshot; workspaceId: string };
export function WorkspaceSettings({ actions, platform, active, state, workspaceId, selectWorkspace, editMembers }: ManagementProps & { selectWorkspace(id: string): void; editMembers(id: string): void }) {
  return <><div className="settings-list">{state.workspaces.map(w => <button className="settings-row" key={w.id} disabled={actions.busy} onClick={() => selectWorkspace(w.id)}><span><strong>{w.title}</strong><small>{w.directory}</small></span><span>切换</span></button>)}</div>
    <form className="settings-form" onSubmit={async e => { e.preventDefault(); const form = e.currentTarget, f = new FormData(form); const receipt = await actions.run('workspace:new', { type: 'createWorkspace', key: requestKey(), title: formText(f, 'title'), directory: formText(f, 'directory') }); if (receipt) { form.reset(); if (receipt.entityId) selectWorkspace(receipt.entityId); } }}>
      <h3>添加工作区</h3><fieldset disabled={actions.blocked('workspace:new')}><Field label="工作区名称"><input name="title" required maxLength={40} /></Field><PathField platform={platform} active={active} label="项目目录" name="directory" required /><button className="button primary">添加工作区</button></fieldset>
    </form><h3>当前工作区的群聊</h3><div className="settings-list">{state.rooms.filter(r => r.workspaceId === workspaceId && r.type === 'group').map(r => <div key={r.id} className="settings-row"><span><strong>{r.title}</strong><small>{r.memberIds.length} 位成员</small></span>{r.pinned ? <span className="settings-note">随工作区管理</span> : <button className="button" disabled={actions.busy} onClick={() => editMembers(r.id)}>编辑成员</button>}</div>)}</div></>;
}

export function CreationSettings({ client, active, actions, state, workspaceId, kind, created }: ManagementProps & { kind: 'launch' | 'new-room'; created(id?: string): void }) {
  const catalog = useSettingsQuery(client, 'catalog', active && kind === 'launch'), connections = useSettingsQuery(client, 'connections', active && kind === 'launch');
  const capabilities = useSettingsQuery(client, 'capabilities', active && kind === 'launch');
  const [engineId, setEngine] = useState(''), [connectionId, setConnection] = useState(''), [validation, setValidation] = useState('');
  const [mode, setMode] = useState<'workspace' | 'custom' | 'off'>('workspace');
  const engines = catalog.data?.engines.filter(e => e.installed) || [], engine = engines.find(e => e.id === engineId)?.id || engines[0]?.id || '';
  const agents = state.agents.filter(a => a.workspaceId === workspaceId && a.status !== 'stopped'), operation = `${kind}:${workspaceId}`;
  const selected = connections.data?.profiles.find(p => p.id === connectionId && p.compatibleEngines.includes(engine));
  return <form className="settings-form" onSubmit={async e => {
    e.preventDefault(); setValidation(''); const f = new FormData(e.currentTarget), memberIds = f.getAll('member').map(String), tag = formText(f, 'tag');
    if (kind === 'new-room' && !memberIds.length) { setValidation('请至少选择一位成员。'); return; }
    if (tag && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/.test(tag)) { setValidation('Tag 请以英文字母或数字开头，仅使用英文字母、数字、下划线和短横线，最多 32 字符。'); return; }
    const command: Command = kind === 'new-room' ? { type: 'createRoom', key: requestKey(), workspaceId, title: formText(f, 'title'), memberIds }
      : { type: 'launchAgent', key: requestKey(), workspaceId, engineId: engine, tag, connectionId: selected?.id || '', ...(selected ? { model: formText(f, 'model') } : {}), capabilities: { mode, serverIds: mode === 'custom' ? f.getAll('launch-server').map(String) : [], skillIds: mode === 'custom' ? f.getAll('launch-skill').map(String) : [] } };
    const receipt = await actions.run(operation, command); if (receipt) created(receipt.entityId);
  }}>
    <p className="settings-note">工作区：{state.workspaces.find(w => w.id === workspaceId)?.title || '请先添加工作区'}</p>
    {kind === 'launch' && <><QueryState {...catalog} /><QueryState {...connections} />{catalog.data?.configurationError && <p role="alert">{catalog.data.configurationError}</p>}</>}
    <fieldset disabled={actions.blocked(operation) || !workspaceId}>
      {kind === 'new-room' ? <><Field label="群聊名称"><input name="title" required maxLength={40} /></Field><div className="settings-field"><span>选择成员</span>{agents.map(a => <label className="settings-check" key={a.id}><input type="checkbox" name="member" value={a.id} />{a.displayName}<small>{a.engine}</small></label>)}{!agents.length && <p className="settings-note">当前工作区没有可用 Agent，请先添加。</p>}</div></> : <>
        <Field label="Agent 引擎"><select value={engine} onChange={e => { setEngine(e.target.value); setConnection(''); }}>{!engines.length && <option value="">没有可用引擎</option>}{engines.map(e => <option key={e.id} value={e.id}>{e.label}</option>)}</select></Field>
        <Field label="Tag（可选）"><input name="tag" maxLength={32} pattern={'[a-zA-Z0-9][a-zA-Z0-9_\\-]{0,31}'} title="以英文字母或数字开头，仅使用英文、数字、下划线和短横线" placeholder="例如：frontend、review" onInvalid={() => setValidation('Tag 仅支持英文、数字、下划线和短横线，且以英文或数字开头。')} onChange={() => setValidation('')} /></Field>
        <Field label="连接方案"><select value={selected?.id || ''} onChange={e => setConnection(e.target.value)}><option value="">使用 CLI 原配置</option>{connections.data?.profiles.map(p => <option key={p.id} value={p.id} disabled={!p.compatibleEngines.includes(engine)}>{p.name}{p.compatibleEngines.includes(engine) ? '' : ' · 当前引擎不支持此协议'}</option>)}</select></Field>
        {selected && <LaunchModelPicker key={`${selected.id}:${engine}`} client={client} connectionId={selected.id} defaultModel={selected.model} engineId={engine} active={active} />}
        <Field label="工具与技能"><select name="capabilityMode" value={mode} onChange={e => setMode(e.target.value as typeof mode)}><option value="workspace">使用工作区配置</option><option value="custom">为此 Agent 单独选择</option><option value="off">不启用工具与技能</option></select></Field>
        {mode === 'custom' && <div className="settings-capability-picker"><QueryState {...capabilities} />{capabilities.data?.servers.map(s => <label className="settings-check" key={s.id}><input type="checkbox" name="launch-server" value={s.id} />{s.name}</label>)}{capabilities.data?.skills.map(s => <label className="settings-check" key={s.id}><input type="checkbox" name="launch-skill" value={s.id} />{s.name}</label>)}{capabilities.data && !capabilities.data.servers.length && !capabilities.data.skills.length && <p className="settings-note">工具库为空，可先在“工具与技能”中添加。</p>}</div>}
      </>}
      <button className="button primary" disabled={kind === 'launch' ? !engine || !connections.data || mode === 'custom' && !capabilities.data : !agents.length}>{kind === 'launch' ? '添加 Agent' : '创建群聊'}</button>
    </fieldset>
    {validation && <p role="alert">{validation}</p>}
  </form>;
}

type Server = QueryResult<'capabilities'>['servers'][number];
export function CapabilitySettings({ client, platform, active, actions, state, workspaceId }: ManagementProps) {
  const query = useSettingsQuery(client, 'capabilities', active), [editing, setEditing] = useState<Server>(), [editorVersion, setEditorVersion] = useState(0), [remove, setRemove] = useState<{ kind: 'servers' | 'skills'; id: string; name: string }>();
  const binding = query.data?.bindings.find(b => b.workspaceId === workspaceId), bindingKey = `${workspaceId}:${JSON.stringify(binding)}`;
  return <><QueryState {...query} />{query.data?.error && <p role="alert">{query.data.error}</p>}{query.data && <>
    <h3>MCP 服务</h3><div className="settings-list">{query.data.servers.map(s => <div className="settings-row" key={s.id}><span><strong>{s.name}</strong><small>{s.transport} · {s.enabled ? '启用' : '停用'}</small></span><ServerTest client={client} active={active} id={s.id} workspaceId={workspaceId} /><button className="button" disabled={actions.busy} onClick={() => { setEditing(s); setEditorVersion(v => v + 1); }}>编辑</button><button className="button" disabled={actions.busy} onClick={() => setRemove({ kind: 'servers', id: s.id, name: s.name })}>移除</button></div>)}</div>
    <details className="settings-subsection" key={editorVersion} open={Boolean(editing)}><summary>{editing ? `编辑 ${editing.name}` : '添加 MCP 服务'}</summary><ServerEditor key={editorVersion} server={editing} active={active} secure={query.data.secureStorageAvailable} actions={actions} saved={() => { setEditing(undefined); setEditorVersion(v => v + 1); query.refresh(); }} /></details>
    {editing && <button className="button" disabled={actions.busy} onClick={() => { setEditing(undefined); setEditorVersion(v => v + 1); }}>取消编辑</button>}
    <h3>技能</h3><div className="settings-list">{query.data.skills.map(s => <div className="settings-row" key={s.id}><span><strong>{s.name}</strong><small>{s.description} · 版本 {s.revision}</small></span><button className="button" disabled={actions.blocked(`skill:${s.id}`)} onClick={async () => { if (await actions.run(`skill:${s.id}`, { type: 'importSkill', key: requestKey(), id: s.id, directory: s.source })) query.refresh(); }}>更新快照</button><button className="button" disabled={actions.busy} onClick={() => setRemove({ kind: 'skills', id: s.id, name: s.name })}>移除</button></div>)}</div>
    <form className="settings-form" onSubmit={async e => { e.preventDefault(); const form = e.currentTarget; if (await actions.run('skill:import', { type: 'importSkill', key: requestKey(), directory: formText(new FormData(form), 'directory') })) { form.reset(); query.refresh(); } }}><fieldset disabled={actions.blocked('skill:import')}><PathField platform={platform} active={active} label="技能目录" name="directory" required /><button className="button">导入技能</button></fieldset></form>
    {workspaceId && <form key={bindingKey} className="settings-form" onSubmit={async e => { e.preventDefault(); const f = new FormData(e.currentTarget); if (await actions.run(`bindings:${workspaceId}`, { type: 'bindCapabilities', key: requestKey(), workspaceId, serverIds: f.getAll('server').map(String), skillIds: f.getAll('skill').map(String) })) query.refresh(); }}><h3>用于 {state.workspaces.find(w => w.id === workspaceId)?.title}</h3><fieldset disabled={actions.blocked(`bindings:${workspaceId}`)}>{query.data.servers.map(s => <label className="settings-check" key={s.id}><input type="checkbox" name="server" value={s.id} defaultChecked={binding?.serverIds.includes(s.id)} />{s.name}</label>)}{query.data.skills.map(s => <label className="settings-check" key={s.id}><input type="checkbox" name="skill" value={s.id} defaultChecked={binding?.skillIds.includes(s.id)} />{s.name}</label>)}<button className="button primary">保存工作区配置</button></fieldset></form>}
    {remove && <div className="settings-confirm"><p>从工具库移除「{remove.name}」？</p><button className="button danger" disabled={actions.blocked(`remove:${remove.id}`)} onClick={async () => { if (await actions.run(`remove:${remove.id}`, { type: 'removeCapability', key: requestKey(), kind: remove.kind, id: remove.id })) { setRemove(undefined); query.refresh(); } }}>确认移除</button><button className="button" disabled={actions.busy} onClick={() => setRemove(undefined)}>保留</button></div>}
  </>}</>;
}
function ServerTest({ client, active, id, workspaceId }: { client: ChatClient; active: boolean; id: string; workspaceId: string }) {
  const epoch = useRef(0), pending = useRef(false), [busy, setBusy] = useState(false), [result, setResult] = useState('');
  useEffect(() => { if (!active) { pending.current = false; setBusy(false); setResult(''); } return () => { epoch.current++; }; }, [active]);
  return <span><button type="button" className="button" disabled={busy || !workspaceId} onClick={async () => {
    if (pending.current) return; pending.current = true; setBusy(true); const current = ++epoch.current;
    try { const response = await client.query({ type: 'testCapabilityServer', id, workspaceId }); if (current === epoch.current) setResult(response.message); }
    catch (error) { if (current === epoch.current) setResult((error as Error).message); }
    finally { if (current === epoch.current) { pending.current = false; setBusy(false); } }
  }}>{busy ? '测试中…' : '测试'}</button>{result && <small role="status">{result}</small>}</span>;
}
function ServerEditor({ server, active, secure, actions, saved }: { server?: Server; active: boolean; secure: boolean; actions: SettingsActions; saved(): void }) {
  const [transport, setTransport] = useState<Server['transport']>(server?.transport || 'stdio'), [error, setError] = useState('');
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => { if (!active) form.current?.querySelectorAll<HTMLInputElement>('input[type=password]').forEach(input => { input.value = ''; }); }, [active]);
  const operation = `server:${server?.id || 'new'}`;
  return <form ref={form} className="settings-form" onSubmit={async e => {
    e.preventDefault(); setError(''); const f = new FormData(e.currentTarget);
    try {
      const args: unknown = JSON.parse(formText(f, 'args') || '[]'), disabledTools: unknown = JSON.parse(formText(f, 'disabledTools') || '[]');
      if (!Array.isArray(args) || args.some(v => typeof v !== 'string')) throw new Error('参数需要填写 JSON 字符串数组。');
      if (!Array.isArray(disabledTools) || disabledTools.some(v => typeof v !== 'string')) throw new Error('禁用工具需要填写 JSON 名称数组。');
      const secretMap = (name: string): Record<string, string> | undefined => {
        if (!formText(f, name)) return;
        const value: unknown = JSON.parse(String(f.get(name)));
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.values(value).some(v => typeof v !== 'string')) throw new Error('环境变量和请求头需要填写 JSON 字符串对象。');
        return value as Record<string, string>;
      };
      const receipt = await actions.run(operation, { type: 'saveCapabilityServer', key: requestKey(), server: { id: server?.id, name: formText(f, 'name'), transport, command: transport === 'stdio' ? formText(f, 'command') : undefined, args, url: transport === 'stdio' ? undefined : formText(f, 'url'), enabled: f.has('enabled'), isolation: formText(f, 'isolation') as Server['isolation'], disabledTools, env: secretMap('env'), headers: secretMap('headers') } }); if (receipt) saved();
    } catch (failure) { setError((failure as Error).message); }
  }}><fieldset disabled={actions.blocked(operation)}>
    <Field label="服务名称"><input name="name" required maxLength={80} defaultValue={server?.name} /></Field><Field label="连接方式"><select value={transport} onChange={e => setTransport(e.target.value as Server['transport'])}><option value="stdio">本机命令</option><option value="http">HTTP</option><option value="sse">SSE</option></select></Field>
    {transport === 'stdio' ? <><Field label="启动命令"><input name="command" required defaultValue={server?.command} /></Field><Field label="参数（JSON 数组）"><input name="args" defaultValue={JSON.stringify(server?.args || [])} /></Field></> : <Field label="服务 URL"><input name="url" type="url" required defaultValue={server?.url} /></Field>}
    <Field label="隔离范围"><select name="isolation" defaultValue={server?.isolation || 'session'}><option value="session">每个会话</option><option value="workspace">工作区</option></select></Field><label className="settings-check"><input name="enabled" type="checkbox" defaultChecked={server?.enabled ?? true} />启用服务</label>
    <details><summary>环境变量、请求头与工具控制</summary><p className="settings-note">环境变量和请求头使用 JSON 字符串对象；留空保留，填写 {`{}`} 清除。密钥不会回显。</p><Field label="环境变量"><input type="password" name="env" autoComplete="new-password" disabled={!secure} /></Field><Field label="请求头"><input type="password" name="headers" autoComplete="new-password" disabled={!secure} /></Field>{!secure && <p className="settings-note">当前环境不能保存密钥。</p>}<Field label="禁用工具（JSON 名称数组）"><input name="disabledTools" defaultValue={JSON.stringify(server?.disabledTools || [])} placeholder={'["delete_file"]'} /></Field></details>
    {Boolean(server?.envKeys.length || server?.headerKeys.length) && <p className="settings-note">已保存的环境变量和请求头将保留。</p>}<button className="button primary">保存服务</button>
  </fieldset>{error && <p role="alert">{error}</p>}</form>;
}
