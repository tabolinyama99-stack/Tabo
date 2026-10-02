import { Routes, Route } from 'react-router-dom';
import { DocList, NewDoc, EditDoc, ViewDoc } from './Sales.jsx';
import Parties from './Parties.jsx';

export default function Purchases() {
  return <Routes>
    <Route path="bills" element={<DocList side="purchases" types={['BILL']} newType="BILL" title="Supplier bills" subtitle="Bills to pay and supplier balances" statuses={['DRAFT', 'PENDING_APPROVAL', 'POSTED', 'PARTIALLY_PAID', 'OVERDUE', 'PAID', 'CANCELLED']} />} />
    <Route path="orders" element={<DocList side="purchases" types={['PO']} newType="PO" title="Purchase orders" statuses={['DRAFT', 'OPEN', 'BILLED', 'CANCELLED']} />} />
    <Route path="debit-notes" element={<DocList side="purchases" types={['DEBIT_NOTE']} newType="DEBIT_NOTE" title="Debit notes (supplier credits)" subtitle="Tip: open a posted bill and choose Debit note to credit it directly." statuses={['DRAFT', 'POSTED', 'APPLIED', 'CANCELLED']} />} />
    <Route path="suppliers/*" element={<Parties kind="suppliers" />} />
    <Route path="documents/new" element={<NewDoc side="purchases" />} />
    <Route path="documents/:id/edit" element={<EditDoc side="purchases" />} />
    <Route path="documents/:id" element={<ViewDoc side="purchases" />} />
    <Route path="*" element={<DocList side="purchases" types={['BILL']} newType="BILL" title="Supplier bills" statuses={['DRAFT', 'POSTED', 'PARTIALLY_PAID', 'OVERDUE', 'PAID', 'CANCELLED']} />} />
  </Routes>;
}
