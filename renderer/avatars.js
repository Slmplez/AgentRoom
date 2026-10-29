/* Stable random identities. Engine icons remain separate from agent portraits. */
((root, factory) => {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AgentAvatars = api;
})(typeof globalThis === 'object' ? globalThis : this, () => {
  const catalog = [
    ['violet', '紫团'], ['sprout', '芽芽'], ['orange', '小橘'], ['star', '星星'],
    ['teal', '青豆'], ['berry', '莓果'], ['cloud', '云朵'], ['pink', '桃桃'],
    ['mint', '薄荷'], ['aqua', '水芽'], ['lavender', '薰衣草'], ['coral', '珊瑚星'],
    ['indigo', '靛蓝'], ['jade', '玉露'], ['lilac', '丁香云'], ['peach', '蜜桃'],
  ].map(([id, name]) => Object.freeze({ id, name, src: `assets/avatars/${id}.webp` }));
  const byId = new Map(catalog.map(item => [item.id, item]));

  function create({ saved, random = Math.random } = {}) {
    const assignments = new Map(Object.entries(saved?.assignments || {}).map(([key, value]) => [key, value === 'caramel' ? 'jade' : value]).filter(([key, value]) => key && byId.has(value)));
    const aliases = new Map(Object.entries(saved?.aliases || {}).filter(([, id]) => assignments.has(id)));
    const keyOf = agent => String(agent?.id || agent?.baseName || agent?.name || '');
    const resolve = agent => { const key = keyOf(agent); return assignments.has(key) ? key : aliases.get(key) || key; };
    function sync(agents) {
      let changed = false;
      const live = new Set(agents.map(keyOf).filter(Boolean));
      const liveUsage = new Map(catalog.map(item => [item.id, 0]));
      const totalUsage = new Map(liveUsage);
      for (const [key, id] of assignments) {
        totalUsage.set(id, totalUsage.get(id) + 1);
        if (live.has(key)) liveUsage.set(id, liveUsage.get(id) + 1);
      }
      for (const agent of agents) {
        const key = keyOf(agent);
        if (!key) continue;
        if (!assignments.has(key)) {
          // Prefer unused among live agents, then among all remembered agents.
          const minimum = Math.min(...liveUsage.values());
          let pool = catalog.filter(item => liveUsage.get(item.id) === minimum);
          const rememberedMinimum = Math.min(...pool.map(item => totalUsage.get(item.id)));
          pool = pool.filter(item => totalUsage.get(item.id) === rememberedMinimum);
          const chosen = pool[Math.min(pool.length - 1, Math.max(0, Math.floor(random() * pool.length)))];
          assignments.set(key, chosen.id);
          liveUsage.set(chosen.id, liveUsage.get(chosen.id) + 1);
          totalUsage.set(chosen.id, totalUsage.get(chosen.id) + 1);
          changed = true;
        }
        for (const alias of [agent.name, agent.baseName]) if (alias && aliases.get(alias) !== key) {
          aliases.set(alias, key); changed = true;
        }
      }
      return changed;
    }
    return {
      sync,
      get: agent => byId.get(assignments.get(resolve(agent))),
      export: () => ({ version: 1, assignments: Object.fromEntries(assignments), aliases: Object.fromEntries(aliases) }),
    };
  }
  return { catalog: Object.freeze(catalog), create };
});
