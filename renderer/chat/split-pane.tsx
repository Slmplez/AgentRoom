import React, { useEffect, useRef, useState, type CSSProperties } from 'react';

const minChat = 380, minResult = 360, handleWidth = 12;
export function useResultSplit(open: boolean, close: () => void, storageKey = 'ar-chat-result-width') {
  const host = useRef<HTMLDivElement>(null), handle = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState(0), [width, setWidth] = useState(() => {
    try { const saved = Number(localStorage.getItem(storageKey)); return Number.isFinite(saved) && saved >= minResult && saved <= 4000 ? saved : 440; } catch { return 440; }
  }), [dragging, setDragging] = useState(false);
  const drag = useRef<{ x: number; width: number; raw: number; pointer: number } | null>(null);
  const closeRef = useRef(close); closeRef.current = close;
  const bounds = useRef({ available, max: Math.max(minResult, available - minChat - handleWidth) });
  bounds.current = { available, max: Math.max(minResult, available - minChat - handleWidth) };
  const wide = available >= minChat + minResult + handleWidth;
  const clamp = (value: number) => Math.max(minResult, Math.min(bounds.current.max, value));
  const cancel = () => { const start = drag.current; drag.current = null; setDragging(false); if (start) setWidth(start.width); };
  useEffect(() => { if (!dragging) { try { localStorage.setItem(storageKey, String(width)); } catch { /* Preferences must not block reading. */ } } }, [width, dragging, storageKey]);
  useEffect(() => {
    const element = host.current; if (!element) return;
    const sidebar = element.querySelector<HTMLElement>('.sidebar');
    const measure = () => setAvailable(Math.max(0, element.clientWidth - (sidebar?.getBoundingClientRect().width || 0)));
    const observer = new ResizeObserver(measure); observer.observe(element); if (sidebar) observer.observe(sidebar); measure();
    return () => observer.disconnect();
  }, []);
  useEffect(() => { if (!open || !wide) cancel(); }, [open, wide]);
  useEffect(() => {
    if (!dragging) return;
    const move = (event: PointerEvent) => {
      const start = drag.current; if (!start || event.pointerId !== start.pointer) return;
      if (Math.abs(start.x - event.clientX) < 4 && start.raw === start.width) return;
      start.raw = start.width + start.x - event.clientX; setWidth(clamp(start.raw));
    };
    const finish = (event: PointerEvent) => {
      const start = drag.current; if (!start || event.pointerId !== start.pointer) return;
      drag.current = null; setDragging(false);
      if (start.raw < 120) { setWidth(start.width); closeRef.current(); }
    };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel(); } };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', cancel); window.addEventListener('blur', cancel); window.addEventListener('keydown', escape, true);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', finish); window.removeEventListener('pointercancel', cancel); window.removeEventListener('blur', cancel); window.removeEventListener('keydown', escape, true); };
  }, [dragging]);
  const actualWidth = clamp(width);
  const separator = open && wide ? <div ref={handle} className="result-separator" role="separator" tabIndex={0} aria-label="调整对话与结果宽度" aria-orientation="vertical" aria-controls="result-preview-panel" aria-valuemin={minResult} aria-valuemax={bounds.current.max} aria-valuenow={Math.round(actualWidth)} aria-valuetext={`结果区域 ${Math.round(actualWidth)} 像素`} title="拖动调整 · 双击均分 · 方向键微调 · Escape 撤销"
    onPointerDown={e => { if (e.button !== 0) return; e.preventDefault(); e.currentTarget.focus(); e.currentTarget.setPointerCapture(e.pointerId); drag.current = { x: e.clientX, width: actualWidth, raw: actualWidth, pointer: e.pointerId }; setDragging(true); }}
    onLostPointerCapture={() => { if (drag.current) cancel(); }}
    onDoubleClick={() => setWidth(clamp((available - handleWidth) / 2))}
    onKeyDown={e => { const step = e.shiftKey ? 40 : 16; const value = e.key === 'ArrowLeft' ? actualWidth + step : e.key === 'ArrowRight' ? actualWidth - step : e.key === 'Home' ? minResult : e.key === 'End' ? bounds.current.max : null; if (value !== null) { e.preventDefault(); setWidth(clamp(value)); } }}><span /></div> : null;
  return { host, separator, dragging, layout: wide ? 'split' : 'overlay', style: { '--result-width': `${actualWidth}px` } as CSSProperties };
}
