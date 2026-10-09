import { useEffect, useState, type ReactNode } from 'react';
import { get, post, patch, when } from '../api.ts';
import { Badge, Field, Notice, Panel, Table, useAction } from '../ui.tsx';
import type { Session } from '../App.tsx';

type Tab = 'stock' | 'receive' | 'issue' | 'adjust' | 'transfer' | 'ledger' | 'alerts' | 'items';

interface StockItem {
  id: number;
  code: string;
  name: string;
  unit: string;
  reorder_level: number;
  onHand: number;
  lowStock: boolean;
  lots: Array<{ lotId: number; lotNo: string; expiry: string; qty: number; expired: boolean; nearExpiry: boolean }>;
}

interface Master {
  id: number;
  name: string;
}

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'stock', label: 'Stock' },
  { id: 'receive', label: 'Receive' },
  { id: 'issue', label: 'Issue' },
  { id: 'adjust', label: 'Adjust / waste' },
  { id: 'transfer', label: 'Transfer' },
  { id: 'ledger', label: 'Ledger' },
  { id: 'alerts', label: 'Alerts' },
  { id: 'items', label: 'Items' },
];

export function Inventory({ s }: { s: Session }) {
  const [tab, setTab] = useState<Tab>('stock');
  const [items, setItems] = useState<StockItem[]>([]);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const loadStock = () => get<StockItem[]>(`/api/inventory/stock?branchId=${s.branchId}`).then(setItems).catch(() => setItems([]));
  useEffect(() => {
    void loadStock();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.branchId]);

  const done = (text: string) => {
    setMessage({ kind: 'ok', text });
    void loadStock();
  };

  return (
    <>
      <div className="toolbar">
        <h1>Inventory</h1>
      </div>
      <nav className="tabs" aria-label="Inventory sections">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? 'tab active' : 'tab'} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>
      {message ? <Notice kind={message.kind === 'ok' ? 'ok' : 'error'}>{message.text}</Notice> : null}
      {tab === 'stock' ? <StockView items={items} /> : null}
      {tab === 'receive' ? <Receive s={s} items={items} onDone={done} /> : null}
      {tab === 'issue' ? <Issue s={s} items={items} onDone={done} /> : null}
      {tab === 'adjust' ? <Adjust s={s} items={items} onDone={done} /> : null}
      {tab === 'transfer' ? <Transfer s={s} items={items} onDone={done} /> : null}
      {tab === 'ledger' ? <Ledger s={s} items={items} /> : null}
      {tab === 'alerts' ? <Alerts s={s} /> : null}
      {tab === 'items' ? <ItemMaster s={s} onChanged={loadStock} /> : null}
    </>
  );
}

function StockView({ items }: { items: StockItem[] }) {
  return (
    <Panel>
      <Table
        head={['Item', 'Code', 'On hand', 'Reorder at', 'Lots (expiry, qty)']}
        rows={items.map((i) => [
          i.name,
          <code key="c">{i.code}</code>,
          <span key="q" className={i.lowStock ? 'text-warn' : ''}>
            {i.onHand} {i.unit} {i.lowStock ? <Badge tone="warn">low</Badge> : null}
          </span>,
          i.reorder_level,
          i.lots.length === 0 ? <span className="muted small">none</span> : (
            <span className="small">
              {i.lots.map((l) => (
                <span key={l.lotId} className={`lot ${l.expired ? 'lot-expired' : l.nearExpiry ? 'lot-near' : ''}`}>
                  {l.lotNo}: {l.expiry} ({l.qty})
                </span>
              ))}
            </span>
          ),
        ])}
        empty="No items yet. Add them under Items."
      />
    </Panel>
  );
}

function Receive({ s, items, onDone }: { s: Session; items: StockItem[]; onDone: (t: string) => void }) {
  const [f, setF] = useState({ itemId: '', qty: '', lotNo: '', expiryDate: '', reference: '' });
  const [suppliers, setSuppliers] = useState<Master[]>([]);
  const [supplierId, setSupplierId] = useState('');
  const [locations, setLocations] = useState<Master[]>([]);
  const [locationId, setLocationId] = useState('');
  const act = useAction();
  useEffect(() => {
    get<Master[]>('/api/inventory/suppliers').then(setSuppliers).catch(() => setSuppliers([]));
    get<Master[]>(`/api/inventory/locations?branchId=${s.branchId}`).then(setLocations).catch(() => setLocations([]));
  }, []);

  async function submit() {
    const ok = await act.run(() => post('/api/inventory/receipts', {
      branchId: s.branchId,
      itemId: Number(f.itemId),
      qty: Number(f.qty),
      lotNo: f.lotNo,
      expiryDate: f.expiryDate,
      supplierId: supplierId ? Number(supplierId) : null,
      locationId: locationId ? Number(locationId) : null,
      reference: f.reference || undefined,
    }));
    if (ok) {
      onDone(`Received ${f.qty} of lot ${f.lotNo}`);
      setF({ itemId: '', qty: '', lotNo: '', expiryDate: '', reference: '' });
    }
  }

  return (
    <Panel title="Receive stock (goods received)">
      <div className="form-grid">
        <ItemSelect items={items} value={f.itemId} onChange={(v) => setF({ ...f, itemId: v })} />
        <Field label="Quantity"><input type="number" min={0} step="any" value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} /></Field>
        <Field label="Lot / batch number"><input value={f.lotNo} onChange={(e) => setF({ ...f, lotNo: e.target.value })} /></Field>
        <Field label="Expiry date"><input type="date" value={f.expiryDate} onChange={(e) => setF({ ...f, expiryDate: e.target.value })} /></Field>
        <Field label="Supplier">
          <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
            <option value="">-</option>
            {suppliers.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        </Field>
        <Field label="Storage location">
          <select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
            <option value="">-</option>
            {locations.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        </Field>
        <Field label="Invoice / delivery reference"><input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} /></Field>
      </div>
      {act.error ? <Notice kind="error">{act.error}</Notice> : null}
      <button className="primary" disabled={act.busy || !f.itemId || !f.qty || !f.lotNo || !f.expiryDate} onClick={() => void submit()}>Record receipt</button>
    </Panel>
  );
}

function Issue({ s, items, onDone }: { s: Session; items: StockItem[]; onDone: (t: string) => void }) {
  const [f, setF] = useState({ itemId: '', qty: '', reason: '' });
  const act = useAction();
  async function submit() {
    const ok = await act.run(() => post('/api/inventory/issues', { branchId: s.branchId, itemId: Number(f.itemId), qty: Number(f.qty), reason: f.reason }));
    if (ok) {
      onDone('Issued. Oldest-expiring lots were used first.');
      setF({ itemId: '', qty: '', reason: '' });
    }
  }
  return (
    <Panel title="Issue stock (first expiry, first out)">
      <div className="form-grid">
        <ItemSelect items={items} value={f.itemId} onChange={(v) => setF({ ...f, itemId: v })} />
        <Field label="Quantity"><input type="number" min={0} step="any" value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} /></Field>
        <Field label="Reason"><input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="e.g. bench use" /></Field>
      </div>
      {act.error ? <Notice kind="error">{act.error}</Notice> : null}
      <button className="primary" disabled={act.busy || !f.itemId || !f.qty || f.reason.length < 3} onClick={() => void submit()}>Issue</button>
    </Panel>
  );
}

// Adjustments above the branch threshold need a second person with inventory.adjust_approve.
function Adjust({ s, items, onDone }: { s: Session; items: StockItem[]; onDone: (t: string) => void }) {
  const [itemId, setItemId] = useState('');
  const [lotId, setLotId] = useState('');
  const [f, setF] = useState({ qty: '', reason: '', txnType: 'adjustment', approverUser: '', approverPass: '' });

  const act = useAction();
  const item = items.find((i) => String(i.id) === itemId);
  const qtyNum = Number(f.qty);

  async function submit() {
    // Wastage and returns always reduce stock, so the user types a plain amount.
    const qty = f.txnType === 'adjustment' ? qtyNum : -Math.abs(qtyNum);
    const body: Record<string, unknown> = { branchId: s.branchId, lotId: Number(lotId), qty, reason: f.reason, txnType: f.txnType };
    if (f.approverUser) body.approver = { username: f.approverUser, password: f.approverPass };
    const out = await act.run(() => post('/api/inventory/adjustments', body));
    if (out) {
      onDone('Adjustment recorded in the ledger.');
      setF({ qty: '', reason: '', txnType: 'adjustment', approverUser: '', approverPass: '' });
    }
  }

  return (
    <Panel title="Adjust, waste or return stock">
      <div className="form-grid">
        <ItemSelect items={items} value={itemId} onChange={(v) => { setItemId(v); setLotId(''); }} />
        <Field label="Lot">
          <select value={lotId} onChange={(e) => setLotId(e.target.value)} disabled={!item}>
            <option value="">-</option>
            {item?.lots.map((l) => <option key={l.lotId} value={l.lotId}>{l.lotNo} (exp {l.expiry}, on hand {l.qty})</option>)}
          </select>
        </Field>
        <Field label="Type">
          <select value={f.txnType} onChange={(e) => setF({ ...f, txnType: e.target.value })}>
            <option value="adjustment">Stock count adjustment</option>
            <option value="wastage">Wastage / breakage / expired</option>
            <option value="return">Return to supplier</option>
          </select>
        </Field>
        <Field label="Quantity change" hint={f.txnType === 'adjustment' ? 'Use a minus sign to reduce stock' : 'Enter the amount removed from stock'}><input type="number" step="any" value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} /></Field>
        <Field label="Reason (required)"><input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
      </div>
      {Math.abs(qtyNum) > 0 ? (
        <div className="form-grid">
          <Field label="Approver username" hint="Needed only above the approval threshold set in Admin settings. Must be a different user."><input value={f.approverUser} onChange={(e) => setF({ ...f, approverUser: e.target.value })} /></Field>
          <Field label="Approver password"><input type="password" value={f.approverPass} onChange={(e) => setF({ ...f, approverPass: e.target.value })} autoComplete="off" /></Field>
        </div>
      ) : null}
      {act.error ? <Notice kind="error">{act.error}</Notice> : null}
      <button className="primary" disabled={act.busy || !lotId || !qtyNum || f.reason.length < 5} onClick={() => void submit()}>Record</button>
      {s.can('inventory.adjust_approve') ? <p className="muted small">You can approve large adjustments for others, but not your own.</p> : null}
    </Panel>
  );
}

function Transfer({ s, items, onDone }: { s: Session; items: StockItem[]; onDone: (t: string) => void }) {
  const [branches, setBranches] = useState<Master[]>([]);
  const [f, setF] = useState({ itemId: '', toBranchId: '', qty: '', reason: '' });
  const act = useAction();
  useEffect(() => {
    get<Array<{ id: number; name: string; code: string }>>('/api/branches').then((list) => setBranches(list.map((b) => ({ id: b.id, name: `${b.name} (${b.code})` })))).catch(() => setBranches([]));
  }, []);
  async function submit() {
    const ok = await act.run(() => post('/api/inventory/transfers', {
      fromBranchId: s.branchId,
      toBranchId: Number(f.toBranchId),
      itemId: Number(f.itemId),
      qty: Number(f.qty),
      reason: f.reason,
    }));
    if (ok) {
      onDone('Transfer recorded at both branches.');
      setF({ itemId: '', toBranchId: '', qty: '', reason: '' });
    }
  }
  return (
    <Panel title="Transfer to another branch">
      <div className="form-grid">
        <ItemSelect items={items} value={f.itemId} onChange={(v) => setF({ ...f, itemId: v })} />
        <Field label="Destination branch">
          <select value={f.toBranchId} onChange={(e) => setF({ ...f, toBranchId: e.target.value })}>
            <option value="">-</option>
            {branches.filter((b) => b.id !== s.branchId).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </Field>
        <Field label="Quantity"><input type="number" min={0} step="any" value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} /></Field>
        <Field label="Reason"><input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
      </div>
      {act.error ? <Notice kind="error">{act.error}</Notice> : null}
      <button className="primary" disabled={act.busy || !f.itemId || !f.toBranchId || !f.qty || f.reason.length < 3} onClick={() => void submit()}>Transfer</button>
    </Panel>
  );
}

function Ledger({ s, items }: { s: Session; items: StockItem[] }) {
  const [itemId, setItemId] = useState('');
  const [rows, setRows] = useState<Array<Record<string, unknown>>>([]);
  useEffect(() => {
    const q = `branchId=${s.branchId}${itemId ? `&itemId=${itemId}` : ''}`;
    get<Array<Record<string, unknown>>>(`/api/inventory/ledger?${q}`).then(setRows).catch(() => setRows([]));
  }, [s.branchId, itemId]);
  return (
    <Panel title="Stock ledger (immutable)" actions={<select value={itemId} onChange={(e) => setItemId(e.target.value)} aria-label="Item">
      <option value="">All items</option>
      {items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
    </select>}>
      <Table
        head={['When', 'Item', 'Lot', 'Type', 'Qty', 'Reason / reference', 'By', 'Approved by']}
        rows={rows.map((r) => [
          when(String(r.created_at)),
          `${r.name}`,
          `${r.lot_no} (${r.expiry_date})`,
          String(r.txn_type),
          <span key="q" className={Number(r.qty) < 0 ? 'text-warn' : ''}>{Number(r.qty)}</span>,
          `${r.reason ?? ''} ${r.reference ? `| ${r.reference}` : ''}`,
          String(r.created_by ?? '-'),
          String(r.approved_by ?? '-'),
        ])}
        empty="No stock movements yet"
      />
    </Panel>
  );
}

function Alerts({ s }: { s: Session }) {
  const [data, setData] = useState<{ low: Array<Record<string, unknown>>; nearExpiry: Array<Record<string, unknown>>; expired: Array<Record<string, unknown>> } | null>(null);
  useEffect(() => {
    get(`/api/inventory/alerts?branchId=${s.branchId}`).then(setData).catch(() => setData(null));
  }, [s.branchId]);
  if (!data) return <p className="muted">Loading alerts...</p>;
  const block = (title: string, rows: Array<Record<string, unknown>>, render: (r: Record<string, unknown>) => ReactNode) => (
    <Panel title={`${title} (${rows.length})`}>
      {rows.length === 0 ? <p className="muted">None</p> : <ul className="plain">{rows.map((r, i) => <li key={i}>{render(r)}</li>)}</ul>}
    </Panel>
  );
  return (
    <div className="grid-2">
      {block('Low stock', data.low, (r) => `${r.name}: ${r.onHand} on hand, reorder at ${r.reorderLevel}`)}
      {block('Expired with stock', data.expired, (r) => `${r.name}, lot ${r.lotNo} expired ${r.expiry} (${r.qty} left)`)}
      {block('Expiring soon', data.nearExpiry, (r) => `${r.name}, lot ${r.lotNo} expires ${r.expiry} (${r.qty} left)`)}
    </div>
  );
}

function ItemSelect({ items, value, onChange }: { items: StockItem[]; value: string; onChange: (v: string) => void }) {
  return (
    <Field label="Item">
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">-</option>
        {items.map((i) => (
          <option key={i.id} value={i.id}>{i.name} ({i.code})</option>
        ))}
      </select>
    </Field>
  );
}

function ItemMaster({ s, onChanged }: { s: Session; onChanged: () => void }) {
  const [rows, setRows] = useState<Array<{ id: number; code: string; name: string; unit: string; reorder_level: number; near_expiry_days: number; is_active: number }>>([]);
  const [f, setF] = useState({ code: '', name: '', unit: 'pcs', reorderLevel: '0', nearExpiryDays: '60', categoryId: '' });
  const [categories, setCategories] = useState<Master[]>([]);
  useEffect(() => {
    get<Master[]>('/api/inventory/categories').then(setCategories).catch(() => setCategories([]));
  }, []);
  const act = useAction();
  const load = () => get(`/api/inventory/items`).then(setRows).catch(() => setRows([]));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function create() {
    const created = await act.run(() => post('/api/inventory/items', { code: f.code, name: f.name, unit: f.unit, reorderLevel: Number(f.reorderLevel), nearExpiryDays: Number(f.nearExpiryDays), categoryId: f.categoryId ? Number(f.categoryId) : null }), 'Item added');
    if (created) setF({ code: '', name: '', unit: 'pcs', reorderLevel: '0', nearExpiryDays: '60', categoryId: '' });
    await load();
    onChanged();
  }

  async function setReorder(id: number, value: string) {
    await act.run(() => patch(`/api/inventory/items/${id}`, { reorderLevel: Number(value) }), 'Reorder level updated');
    await load();
    onChanged();
  }

  return (
    <>
      {s.can('inventory.write') ? (
        <Panel title="Add an item">
          <div className="form-grid">
            <Field label="Code"><input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></Field>
            <Field label="Name"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="Unit"><input value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} /></Field>
            <Field label="Category">
              <select value={f.categoryId} onChange={(e) => setF({ ...f, categoryId: e.target.value })}>
                <option value="">-</option>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </Field>
            <Field label="Reorder level"><input type="number" min={0} value={f.reorderLevel} onChange={(e) => setF({ ...f, reorderLevel: e.target.value })} /></Field>
            <Field label="Near-expiry warning (days)"><input type="number" min={0} value={f.nearExpiryDays} onChange={(e) => setF({ ...f, nearExpiryDays: e.target.value })} /></Field>
          </div>
          {act.error ? <Notice kind="error">{act.error}</Notice> : null}
          <button className="primary" disabled={act.busy || !f.code || !f.name} onClick={() => void create()}>Add item</button>
        </Panel>
      ) : null}
      {s.can('inventory.write') ? <Masters s={s} onChanged={() => get<Master[]>('/api/inventory/categories').then(setCategories)} /> : null}
      <Panel title="Items">
        <Table
          head={['Code', 'Name', 'Unit', 'Reorder level', 'Near-expiry days', '']}
          rows={rows.map((r) => [
            <code key="c">{r.code}</code>,
            r.name,
            r.unit,
            s.can('inventory.write') ? (
              <input key="r" type="number" min={0} defaultValue={r.reorder_level} className="num" onBlur={(e) => e.target.value !== String(r.reorder_level) && void setReorder(r.id, e.target.value)} aria-label={`Reorder level for ${r.name}`} />
            ) : (
              r.reorder_level
            ),
            r.near_expiry_days,
            r.is_active ? '' : <Badge key="x">inactive</Badge>,
          ])}
        />
      </Panel>
    </>
  );
}

// Suppliers, categories and storage locations used by items and receipts.
function Masters({ s, onChanged }: { s: Session; onChanged: () => void }) {
  const [lists, setLists] = useState<{ categories: Master[]; suppliers: Master[]; locations: Master[] }>({ categories: [], suppliers: [], locations: [] });
  const [names, setNames] = useState({ categories: '', suppliers: '', locations: '' });
  const act = useAction();
  const load = async () => {
    const [categories, suppliers, locations] = await Promise.all([
      get<Master[]>('/api/inventory/categories'),
      get<Master[]>('/api/inventory/suppliers'),
      get<Master[]>(`/api/inventory/locations?branchId=${s.branchId}`),
    ]);
    setLists({ categories, suppliers, locations });
  };
  useEffect(() => {
    load().catch((e: Error) => act.setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.branchId]);

  async function add(kind: 'categories' | 'suppliers' | 'locations') {
    const name = names[kind].trim();
    if (!name) return;
    const body = kind === 'locations' ? { name, branchId: s.branchId } : { name };
    const ok = await act.run(() => post(`/api/inventory/${kind}`, body), 'Added');
    if (ok) {
      setNames({ ...names, [kind]: '' });
      await load();
      onChanged();
    }
  }

  const block = (kind: 'categories' | 'suppliers' | 'locations', title: string) => (
    <div>
      <h3>{title}</h3>
      <ul className="plain">{lists[kind].map((m) => <li key={m.id}>{m.name}</li>)}</ul>
      <div className="row-actions">
        <input value={names[kind]} onChange={(e) => setNames({ ...names, [kind]: e.target.value })} aria-label={`New ${title.toLowerCase()}`} placeholder="Name" />
        <button disabled={act.busy || !names[kind].trim()} onClick={() => void add(kind)}>Add</button>
      </div>
    </div>
  );

  return (
    <Panel title="Suppliers, categories and storage locations">
      {act.error ? <Notice kind="error">{act.error}</Notice> : null}
      <div className="form-grid">
        {block('suppliers', 'Suppliers')}
        {block('categories', 'Categories')}
        {block('locations', 'Storage locations (this branch)')}
      </div>
    </Panel>
  );
}
