import React from 'react';
import { defineCatalog, type Spec } from '@json-render/core';
import { schema } from '@json-render/react/schema';
import { defineRegistry, JSONUIProvider, Renderer } from '@json-render/react';
import { z } from 'zod';

// Separate registry from the Mock form demo: no Field, actions or bindings.
const catalog = defineCatalog(schema, { components: {
  Section: { props: z.object({ title: z.string(), description: z.string() }), description: 'Read-only section' },
  Metrics: { props: z.object({ items: z.array(z.object({ label: z.string(), value: z.string(), detail: z.string() })) }), description: 'Text metrics' },
  Bars: { props: z.object({ title: z.string(), items: z.array(z.object({ label: z.string(), value: z.number() })) }), description: 'Bars with text values' },
  Table: { props: z.object({ columns: z.array(z.string()), rows: z.array(z.array(z.string())) }), description: 'Read-only table' },
}, actions: {} });
const { registry } = defineRegistry(catalog, { components: {
  Section: ({ props, children }) => <section className="result-section"><h3>{props.title}</h3><p className="result-description">{props.description}</p>{children}</section>,
  Metrics: ({ props }) => <dl className="result-metrics">{props.items.map((item, i) => <div key={i}><dt>{item.label}</dt><dd>{item.value}</dd><small>{item.detail}</small></div>)}</dl>,
  Bars: ({ props }) => <figure className="result-chart"><figcaption>{props.title}</figcaption>{props.items.map((item, i) => <div className="result-bar" key={i}><div><span>{item.label}</span><span>{item.value}%</span></div><div className="result-bar-track" aria-hidden="true"><span style={{ width: `${item.value}%` }} /></div></div>)}</figure>,
  Table: ({ props }) => <div className="result-table-wrap" tabIndex={0} role="region" aria-label="报告明细，可横向滚动"><table><thead><tr>{props.columns.map((c, i) => <th key={i} scope="col">{c}</th>)}</tr></thead><tbody>{props.rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}</tbody></table></div>,
} });

export function ReportContent({ spec }: { spec: Spec }) {
  return <JSONUIProvider registry={registry}><Renderer spec={spec} registry={registry} /></JSONUIProvider>;
}
export default ReportContent;
