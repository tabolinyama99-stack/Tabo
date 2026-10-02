// Minimal, safe markdown renderer for AI answers (no HTML injection: builds React elements).
import { Link } from 'react-router-dom';

function inline(text, key = 0) {
  const out = []; let rest = text; let i = 0;
  const re = /(\*\*([^*]+)\*\*)|(\[([^\]]+)\]\(([^)\s]+)\))|(`([^`]+)`)/;
  while (rest) {
    const m = rest.match(re);
    if (!m) { out.push(rest); break; }
    if (m.index) out.push(rest.slice(0, m.index));
    if (m[1]) out.push(<strong key={`${key}-${i++}`}>{m[2]}</strong>);
    else if (m[3]) { const href = m[5]; out.push(href.startsWith('/') ? <Link key={`${key}-${i++}`} to={href}>{m[4]}</Link> : /^https:\/\//.test(href) ? <a key={`${key}-${i++}`} href={href} target="_blank" rel="noreferrer noopener">{m[4]}</a> : m[4]); }
    else if (m[6]) out.push(<code key={`${key}-${i++}`}>{m[7]}</code>);
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

export function Markdown({ text }) {
  const lines = String(text || '').split('\n');
  const blocks = []; let i = 0; let k = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (/^\s*\|/.test(l)) {
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(lines[i]); i++; }
      const cells = rows.filter((r) => !/^\s*\|?\s*:?-{2,}/.test(r)).map((r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
      const aligns = (rows[1] || '').trim().replace(/^\||\|$/g, '').split('|').map((c) => (/-+:$/.test(c.trim()) ? 'r' : ''));
      const [head, ...body] = cells;
      blocks.push(<div className="table-wrap md-table" key={k++}><table className="table table-compact"><thead><tr>{head.map((h, j) => <th key={j} className={aligns[j]}>{inline(h, j)}</th>)}</tr></thead>
        <tbody>{body.map((r, ri) => <tr key={ri}>{r.map((c, j) => <td key={j} className={aligns[j] === 'r' ? 'r num' : ''}>{inline(c, j)}</td>)}</tr>)}</tbody></table></div>);
      continue;
    }
    if (/^\s*[-*]\s+/.test(l)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*]\s+/, '')); i++; }
      blocks.push(<ul key={k++}>{items.map((t, j) => <li key={j}>{inline(t, j)}</li>)}</ul>);
      continue;
    }
    if (/^\s*\d+\.\s+/.test(l)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*\d+\.\s+/, '')); i++; }
      blocks.push(<ol key={k++}>{items.map((t, j) => <li key={j}>{inline(t, j)}</li>)}</ol>);
      continue;
    }
    const h = l.match(/^(#{1,4})\s+(.*)/);
    if (h) { blocks.push(<p key={k++} className="md-h"><strong>{inline(h[2])}</strong></p>); i++; continue; }
    if (!l.trim()) { i++; continue; }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^\s*(\||[-*]\s|\d+\.\s|#)/.test(lines[i])) { para.push(lines[i]); i++; }
    blocks.push(<p key={k++}>{para.map((p, j) => <span key={j}>{inline(p, j)}{j < para.length - 1 && <br />}</span>)}</p>);
  }
  return <div className="md">{blocks}</div>;
}
