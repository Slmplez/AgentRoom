import React, { useEffect, useId, useRef, useState } from 'react';
import type { PlatformClient } from './types';

export function PathField({ platform, active, name, label, value, kind = 'directory', required = false }: {
  platform: PlatformClient; active: boolean; name: string; label: string; value?: string; kind?: 'directory' | 'cert' | 'key'; required?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null), epoch = useRef(0), pending = useRef(false);
  const id = useId();
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const available = kind === 'directory' ? platform.capabilities?.chooseDirectory && platform.chooseDirectory : platform.capabilities?.chooseCertificate && platform.chooseCertificate;
  useEffect(() => { if (!active) { pending.current = false; setBusy(false); setError(''); } return () => { epoch.current++; }; }, [active]);
  async function choose() {
    if (pending.current || !available) return;
    pending.current = true; setBusy(true); setError(''); const current = ++epoch.current;
    try {
      const result = kind === 'directory' ? await platform.chooseDirectory!() : await platform.chooseCertificate!(kind);
      if (current === epoch.current && result && input.current) input.current.value = result;
    } catch (failure) { if (current === epoch.current) setError((failure as Error).message); }
    finally { if (current === epoch.current) { pending.current = false; setBusy(false); } }
  }
  return <div className="settings-path-field"><div className="settings-field"><label htmlFor={id}>{label}</label><span className="settings-path-input"><input id={id} ref={input} name={name} required={required} maxLength={2048} defaultValue={value} placeholder="后端可读取的完整路径" /><button type="button" className="button" disabled={!available || busy} onClick={() => void choose()} aria-label={`选择${label}`}>{busy ? '选择中…' : '选择'}</button></span></div>{!available && <p className="settings-note">浏览器无法选择本机路径，请手动填写。</p>}{error && <p role="alert">{error}</p>}</div>;
}
