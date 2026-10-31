import type { Spec } from '@json-render/core';

// Input has already passed reportSchema. Preserve the sections that explain each
// selected block: identical metric labels can mean different things in each group.
export function previewReport(spec: Spec): { spec: Spec; truncated: boolean } {
  const elements: Spec['elements'] = {};
  let blocks = 0, truncated = false;
  function visit(id: string, root = false): boolean {
    const node = spec.elements[id], children = node.children || [];
    if (node.type === 'Section' && children.length) {
      const kept = children.filter(child => visit(child));
      if (!root && !kept.length) { truncated = true; return false; }
      elements[id] = { ...node, props: { ...node.props }, children: kept };
      return true;
    }
    if (blocks >= 3) { truncated = true; return false; }
    blocks++;
    const props = { ...node.props };
    if (node.type === 'Table') {
      const rows = props.rows as string[][], columns = props.columns as string[];
      truncated ||= rows.length > 5 || columns.length > 4;
      props.columns = columns.slice(0, 4); props.rows = rows.slice(0, 5).map(row => row.slice(0, 4));
    } else if (node.type === 'Metrics' || node.type === 'Bars') {
      const items = props.items as unknown[];
      truncated ||= items.length > 4; props.items = items.slice(0, 4);
    }
    elements[id] = { ...node, props, children: [] };
    return true;
  }
  visit(spec.root, true);
  return { spec: { root: spec.root, elements }, truncated };
}
