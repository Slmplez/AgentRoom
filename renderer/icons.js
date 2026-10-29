(() => {
  const paths = {
    'panel-left': '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/>',
    sliders: '<path d="M4 6h7m4 0h5M4 12h2m4 0h10M4 18h10m4 0h2"/><circle cx="13" cy="6" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="16" cy="18" r="2"/>',
    chart: '<path d="M4 4v16h17M8 15v-4M13 15V7M18 15v-6"/>',
    moon: '<path d="M20.5 13a8.5 8.5 0 0 1-9.5-9.5A8.5 8.5 0 1 0 20.5 13z"/>',
    'arrow-up': '<path d="M12 19V5m-6 6 6-6 6 6"/>',
    chat: '<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8A8.5 8.5 0 0 1 12.5 20a8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8A8.5 8.5 0 0 1 8.7 3.9a8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8z"/>',
    chats: '<path d="M3 3h13v10H9l-4 4v-4H3z" fill="currentColor" stroke="none"/><path d="M13 10h8v9h-3v3l-4-3h-3v-4" opacity=".45" fill="currentColor" stroke="none"/>',
    agents: '<circle cx="9" cy="8" r="3"/><path d="M3 21v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6M21 21v-2a6 6 0 0 0-4-5.65"/>',
    layers: '<rect x="4" y="4" width="12" height="12" rx="3"/><path d="M9 20h8a3 3 0 0 0 3-3V9M10 7v6M7 10h6"/>',
    settings: '<path d="m9 3-.7 2.1-2 .8-2-.4-1.8 3.1L4 10.2v2.3l-1.5 1.6 1.8 3.1 2-.4 2 .8L9 20h3.6l.8-2.4 2-.8 2 .4 1.8-3.1-1.6-1.6v-2.3L19.2 8l-1.8-3.1-2 .4-2-.8L12.6 3z"/><circle cx="10.8" cy="11.5" r="3"/>',
    workspace: '<rect x="3" y="5" width="18" height="15" rx="4"/><path d="M8 5V3h8v2M3 11h18M10 11v3h4v-3"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
    compose: '<path d="M12 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-7M16 3l5 5-9 9H7v-5z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>', minus: '<path d="M5 12h14"/>',
    square: '<rect x="5" y="5" width="14" height="14" rx="2"/>', close: '<path d="m6 6 12 12M6 18 18 6"/>',
    'chevron-down': '<path d="m7 10 5 5 5-5"/>', 'chevron-right': '<path d="m9 6 6 6-6 6"/>',
    refresh: '<path d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 11.5-1L20 9M4 15l2.5 3A7 7 0 0 0 18 17"/>',
    at: '<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/>',
    smile: '<circle cx="12" cy="12" r="9"/><path d="M8 14s1.5 3 4 3 4-3 4-3M8 9h.01M16 9h.01"/>',
    send: '<path d="m22 2-7 20-4-9-9-4zM22 2 11 13"/>',
    pin: '<path d="m16 3-1 6 4 4v2H5v-2l4-4-1-6zM12 15v7"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
    terminal: '<rect x="2" y="4" width="20" height="16" rx="3"/><path d="m6 9 3 3-3 3M13 15h4"/>',
    arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
    check: '<path d="m5 12 4 4L19 6"/>', checkdouble: '<path d="m2 12 4 4L16 6M10 15l2 2L22 7"/>',
    sparkles: '<path d="m12 3 2.3 6.7L21 12l-6.7 2.3L12 21l-2.3-6.7L3 12l6.7-2.3zM20 2v4M18 4h4"/>',
    code: '<path d="m8 7-5 5 5 5M16 7l5 5-5 5M14 4l-4 16"/>',
    sun: '<path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2"/><circle cx="12" cy="12" r="4"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    tag: '<path d="M3 3h8l10 10-8 8L3 11z"/><circle cx="7.5" cy="7.5" r="1"/>',
    copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M15 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h3"/>',
    globe: '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>',
    bolt: '<path d="m13 2-9 12h7l-1 8 10-12h-7z"/>',
  };
  window.icon = (name, className = '') => {
    if (name === 'room-mark' || name === 'brand') return `<span class="icon room-mark ${className}" aria-hidden="true"></span>`;
    return `<svg class="icon ${className}" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.chat}</svg>`;
  };
  document.querySelectorAll('[data-icon]').forEach(element => { element.innerHTML = window.icon(element.dataset.icon); });
})();
