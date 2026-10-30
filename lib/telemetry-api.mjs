export function createTelemetryApi(service) {
  return {
    query(input) {
      if (input.type === 'usage') return { ...service.usage.snapshot(), simulated: false };
      return { agents: service.snapshot().agents.map(a => ({ agentId: a.id, context: { ...a.context, reason: a.context?.reason || '', confidence: !Number.isFinite(a.context?.used) ? 'unknown' : ['gateway', 'pi-runtime'].includes(a.context.source) ? 'estimated' : 'observed' } })), simulated: false };
    },
  };
}
