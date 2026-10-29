(() => {
  async function mount({ id, bridge, element, status, onError }) {
    const term = new window.Terminal({ cursorBlink: true, fontSize: 13, fontFamily: 'Cascadia Mono, Consolas, monospace', scrollback: 3000,
      theme: { background: '#18202c', foreground: '#e1e7ef', cursor: '#91c4f2' } });
    const fit = new window.FitAddon.FitAddon(); term.loadAddon(fit); term.open(element);
    let disposed = false, loading = true, sequence = 0; const pending = [];
    function receive(event) {
      if (disposed || event.id !== id) return;
      if (loading) { pending.push(event); if (pending.length > 512) pending.shift(); return; }
      if (event.data && event.sequence > sequence) {
        sequence = event.sequence;
        term.write(Uint8Array.from(atob(event.data), char => char.charCodeAt(0)));
      }
      if (event.type === 'exit') status.textContent = `会话已退出 · ${event.code ?? '未知退出码'}`;
      if (event.type === 'error') { status.textContent = event.message; onError(event.message); }
    }
    const unsubscribe = bridge.onTerminal(id, receive);
    const input = term.onData(data => bridge.terminalInput(id, data).catch(error => onError(error.message)));
    const observer = new ResizeObserver(() => {
      if (disposed) return;
      fit.fit();
      bridge.terminalResize(id, Math.min(500, Math.max(2, term.cols)), Math.min(300, Math.max(2, term.rows))).catch(() => {});
    }); observer.observe(element);
    const dispose = () => { disposed = true; unsubscribe(); input.dispose(); observer.disconnect(); term.dispose(); };
    try {
      const snapshot = await bridge.terminal(id);
      if (disposed) return dispose;
      loading = false;
      status.textContent = snapshot.alive ? '应用内终端 · 可直接输入，Ctrl+C 中断当前任务' : `会话已退出 · ${snapshot.exitCode ?? '未知退出码'}`;
      for (const chunk of snapshot.chunks) receive({ id, ...chunk });
      for (const event of pending) receive(event);
      pending.length = 0;
      fit.fit(); term.focus();
    } catch (error) { loading = false; pending.length = 0; if (!disposed) { status.textContent = error.message; onError(error.message); } }
    return dispose;
  }
  window.AgentRoomTerminal = { mount };
})();
