import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { fmtK, fmtDate } from '../lib/format.js';
import { useSession } from '../lib/session.jsx';
import { Button, Badge, Icon } from './ui.jsx';
import { Markdown } from './Markdown.jsx';

const SUGGESTIONS = ['What were our sales this month?', 'How much do customers owe us?', 'Which invoices are overdue?', 'Show me our biggest expenses.', 'Why did profit decrease this month?', 'How much did we spend on fuel?', 'Find duplicate transactions.', 'Explain our cash flow.', 'Record a K5,000 cash sale.'];

export function Chat({ compact }) {
  const { me } = useSession();
  const [msgs, setMsgs] = useState([]);
  const [conv, setConv] = useState(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(null);
  const end = useRef(null);
  useEffect(() => { api.get('/ai/status').then(setStatus).catch(() => {}); }, []);
  useEffect(() => { end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [msgs, busy]);
  const send = async (m) => {
    const q = (m ?? text).trim(); if (!q || busy) return;
    setText(''); setMsgs((x) => [...x, { role: 'user', content: q }]); setBusy(true);
    try {
      const r = await api.post('/ai/chat', { message: q, conversation_id: conv });
      setConv(r.conversation_id);
      setMsgs((x) => [...x, { role: 'assistant', content: r.answer, data: r }]);
    } catch (e) { setMsgs((x) => [...x, { role: 'assistant', content: e.message, error: true }]); } finally { setBusy(false); }
  };
  return <div className={`chat ${compact ? 'chat-compact' : ''}`}>
    <div className="chat-log" aria-live="polite">
      {!msgs.length && <div className="chat-intro">
        <p><strong>Ask about your books.</strong> Answers are built from {me.company.name}'s live ledger, with links to the records used. Instructions to record a transaction create a <strong>draft for approval</strong> — nothing is posted automatically.</p>
        {status && <p className="t-small">Mode: {status.mode === 'claude' ? `Claude (${status.model})` : 'built-in assistant (add an Anthropic API key in Admin Center → AI Settings for full natural-language answers)'}</p>}
        <div className="chips">{SUGGESTIONS.map((s) => <button key={s} className="chip" onClick={() => send(s)}>{s}</button>)}</div>
      </div>}
      {msgs.map((m, i) => <div key={i} className={`msg msg-${m.role} ${m.error ? 'msg-error' : ''}`}>
        {m.role === 'assistant' ? <Markdown text={m.content} /> : <p>{m.content}</p>}
        {m.data?.draft && <div className="draft-card"><Badge tone="accent">AI draft</Badge> <strong>{m.data.draft.number}</strong> — awaiting approval. <Link to={m.data.draft.link}>Review draft →</Link></div>}
        {m.data?.proposal && <div className="draft-card"><Badge tone="info">Form ready</Badge> <Link to={m.data.proposal.link}>Open the pre-filled form to review and record it →</Link></div>}
        {m.data?.notice && <p className="t-small">{m.data.notice}</p>}
        {m.data?.sources?.length > 0 && <details className="sources"><summary>Sources ({m.data.sources.length})</summary><ul>{m.data.sources.map((s, j) => <li key={j}>{s.link ? <Link to={s.link}>{s.label}</Link> : s.label}{s.amount ? <span className="num"> · {fmtK(s.amount)}</span> : ''}{s.date ? <span className="t-small"> · {fmtDate(s.date)}</span> : ''}</li>)}</ul></details>}
      </div>)}
      {busy && <div className="msg msg-assistant"><span className="typing" aria-label="Thinking"><i /><i /><i /></span></div>}
      <div ref={end} />
    </div>
    <form className="chat-input" onSubmit={(e) => { e.preventDefault(); send(); }}>
      <textarea className="textarea" rows={compact ? 2 : 3} placeholder="Ask a question or describe a transaction…" value={text} onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} aria-label="Message the assistant" />
      <Button type="submit" variant="primary" icon="send" disabled={busy || !text.trim()} aria-label="Send" />
    </form>
  </div>;
}

export function AIPanel({ onClose }) {
  const { me } = useSession();
  useEffect(() => { const k = (e) => { if (e.key === 'Escape') onClose(); }; document.addEventListener('keydown', k); return () => document.removeEventListener('keydown', k); }, [onClose]);
  return <>
    <div className="scrim show" onClick={onClose} />
    <aside className="ai-panel card" aria-label="AI assistant">
      <div className="card-head"><h2><Icon name="ai" size={17} /> {me.settings?.ai?.assistant_name || 'TAEL Assistant'}</h2><div className="row-gap"><Link to="/ai" className="t-small" onClick={onClose}>Open full page</Link><Button variant="ghost" size="sm" icon="x" aria-label="Close" onClick={onClose} /></div></div>
      <Chat compact />
    </aside>
  </>;
}
