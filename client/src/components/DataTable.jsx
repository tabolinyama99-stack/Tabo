import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { fmtK, fmtDate, fmtDateTime, isNeg } from '../lib/format.js';
import { StatusBadge, Input, Button, Empty } from './ui.jsx';

/**
 * columns: [{ key, label, type: 'money'|'date'|'datetime'|'status'|'number'|'percent'|'text', render?, sortable?: true, align? }]
 * Client-side search, sorting and pagination. Pass `serverPaging` to delegate paging.
 */
export function DataTable({ columns, rows, rowKey = 'id', onRowClick, rowLink, searchable = true, pageSize = 25, empty, toolbar, footer, rowClass, initialSort, compact }) {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState(initialSort || null);
  const [page, setPage] = useState(1);
  const nav = useNavigate();
  const filtered = useMemo(() => {
    let r = rows || [];
    if (q.trim()) {
      const t = q.toLowerCase();
      r = r.filter((row) => columns.some((c) => { const v = row[c.key]; return v != null && String(c.type === 'date' ? fmtDate(v) : v).toLowerCase().includes(t); }));
    }
    if (sort) {
      const c = columns.find((x) => x.key === sort.key);
      const num = ['money', 'number', 'percent'].includes(c?.type);
      r = [...r].sort((a, b) => {
        const x = a[sort.key], y = b[sort.key];
        if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1;
        const d = num ? Number(x) - Number(y) : String(x).localeCompare(String(y), 'en', { numeric: true });
        return sort.dir === 'asc' ? d : -d;
      });
    }
    return r;
  }, [rows, q, sort, columns]);
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const cur = Math.min(page, pages);
  const shown = filtered.slice((cur - 1) * pageSize, cur * pageSize);
  const toggle = (c) => { if (c.sortable === false) return; setSort((s) => (s?.key === c.key ? { key: c.key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key: c.key, dir: ['money', 'number', 'date'].includes(c.type) ? 'desc' : 'asc' })); };
  const click = (row) => { if (onRowClick) onRowClick(row); else if (rowLink) { const to = rowLink(row); if (to) nav(to); } };
  return <div className="dt">
    {(searchable || toolbar) && <div className="dt-toolbar">{searchable && <Input type="search" placeholder="Search…" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} aria-label="Search table" className="dt-search" />}{toolbar}</div>}
    <div className="table-wrap">
      <table className={`table ${compact ? 'table-compact' : ''}`}>
        <thead><tr>{columns.map((c) => <th key={c.key} className={`${['money', 'number', 'percent'].includes(c.type) || c.align === 'right' ? 'r' : ''} ${c.sortable === false ? '' : 'sortable'}`} onClick={() => toggle(c)} aria-sort={sort?.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
          {c.label}{sort?.key === c.key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}</th>)}</tr></thead>
        <tbody>
          {shown.map((row, i) => <tr key={row[rowKey] ?? i} className={`${onRowClick || rowLink ? 'clickable' : ''} ${rowClass?.(row) || ''}`} onClick={onRowClick || rowLink ? () => click(row) : undefined}
            tabIndex={onRowClick || rowLink ? 0 : undefined} onKeyDown={(e) => { if (e.key === 'Enter' && (onRowClick || rowLink)) click(row); }}>
            {columns.map((c) => <td key={c.key} className={['money', 'number', 'percent'].includes(c.type) || c.align === 'right' ? 'r' : ''}>{cell(c, row)}</td>)}
          </tr>)}
          {!shown.length && <tr><td colSpan={columns.length}><Empty title={q ? 'No matches' : empty?.title || 'No records yet'}>{q ? 'Try a different search.' : empty?.text}</Empty></td></tr>}
        </tbody>
        {footer && <tfoot>{footer}</tfoot>}
      </table>
    </div>
    {pages > 1 && <div className="dt-pager"><span className="t-small">{(cur - 1) * pageSize + 1}–{Math.min(cur * pageSize, filtered.length)} of {filtered.length}</span>
      <div className="row-gap"><Button size="sm" disabled={cur <= 1} onClick={() => setPage(cur - 1)}>Previous</Button><Button size="sm" disabled={cur >= pages} onClick={() => setPage(cur + 1)}>Next</Button></div></div>}
  </div>;
}

export function cell(c, row) {
  const v = row[c.key];
  if (c.render) return c.render(v, row);
  if (v === null || v === undefined || v === '') return '';
  switch (c.type) {
    case 'money': return <span className={`num ${isNeg(v) ? 'neg' : ''}`}>{fmtK(v)}</span>;
    case 'date': return fmtDate(v);
    case 'datetime': return fmtDateTime(v);
    case 'status': return <StatusBadge status={v} />;
    case 'percent': return <span className="num">{v}%</span>;
    case 'number': return <span className="num">{v}</span>;
    default: return String(v);
  }
}
