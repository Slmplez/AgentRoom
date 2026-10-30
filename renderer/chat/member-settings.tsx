import React, { useState } from 'react';
import type { Snapshot } from './types';
import { requestKey, type SettingsActions } from './settings-data';

export function MemberSettings({ state, roomId, actions }: { state: Snapshot; roomId: string; actions: SettingsActions }) {
  const room = state.rooms.find(r => r.id === roomId), [error, setError] = useState('');
  if (!room || room.type !== 'group' || room.pinned) return <p className="settings-note">默认大厅和私聊的成员由工作区管理。</p>;
  const agents = state.agents.filter(a => a.workspaceId === room.workspaceId);
  return <form key={`${room.id}:${room.memberIds.join(',')}`} className="settings-form" onSubmit={async e => {
    e.preventDefault(); setError(''); const memberIds = new FormData(e.currentTarget).getAll('member').map(String);
    if (!memberIds.length) { setError('请至少选择一位成员。'); return; }
    await actions.run(`members:${room.id}`, { type: 'setRoomMembers', key: requestKey(), roomId: room.id, memberIds });
  }}><h3>{room.title}</h3><p className="settings-note">移出群聊后，Agent 仍保留在工作区中。</p><fieldset disabled={actions.blocked(`members:${room.id}`)}>{agents.map(a => <label className="settings-check" key={a.id}><input type="checkbox" name="member" value={a.id} defaultChecked={room.memberIds.includes(a.id)} />{a.displayName}<small>{a.engine}</small></label>)}<button className="button primary" disabled={!agents.length}>保存成员</button></fieldset>{error && <p role="alert">{error}</p>}</form>;
}
