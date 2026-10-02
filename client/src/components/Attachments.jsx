import { useRef, useState } from 'react';
import { api, download } from '../lib/api.js';
import { useSession } from '../lib/session.jsx';
import { Card, Button, useAction, Icon } from './ui.jsx';

export function Attachments({ linkedType, linkedId, initial = [] }) {
  const { can } = useSession();
  const [docs, setDocs] = useState(initial || []);
  const [run, busy] = useAction();
  const input = useRef(null);
  const upload = async (file) => {
    const d = await run(() => api.upload('/documents', file, { linked_type: linkedType, linked_id: linkedId, category: linkedType === 'expense' ? 'receipt' : 'general' }), 'Document attached.');
    if (d) setDocs((x) => [...x, d]);
  };
  return <Card title="Supporting documents" actions={can('upload_documents') && <><input ref={input} type="file" hidden accept="image/png,image/jpeg,image/webp,application/pdf" onChange={(e) => e.target.files[0] && upload(e.target.files[0])} />
    <Button size="sm" icon="upload" busy={busy} onClick={() => input.current?.click()}>Attach file</Button></>}>
    {docs.length ? <ul className="stack-sm" style={{ listStyle: 'none', padding: 0, margin: 0 }}>{docs.map((d) => <li key={d.id} className="row-gap"><Icon name="file" size={16} />
      <button className="linkish" onClick={() => run(() => download(`/documents/${d.id}/file`, { open: true }))}>{d.original_name}</button></li>)}</ul>
      : <p className="muted" style={{ margin: 0 }}>No documents attached. Attach receipts or invoices (PDF, JPG, PNG) as audit evidence.</p>}
  </Card>;
}
