// 請求書を作る：docs/請求書テンプレート.csv と同じ並びで、画面で確かめて PDF（印刷）か CSV で保存する
// 中身は「請求月 × クライアント」の案件から作る。宛名・自分の名前・振込先・備考は設定として保存し、同期する

const INVOICE_ROWS = 20; // テンプレートの明細の行数（多いときは行を足す）

// ---------- 設定 ----------

function loadSettingsLocal() {
  try { return JSON.parse(localStorage.getItem('invoiceSettings') || 'null'); } catch { return null; }
}

function saveSettingsLocal(s) {
  state.settings = s;
  try { localStorage.setItem('invoiceSettings', JSON.stringify(s)); } catch { /* 保存できなくても同期側には残る */ }
}

function updateSettings(patch) {
  const cur = state.settings ?? { myName: '', bank: '', note: '', addressees: {} };
  saveSettingsLocal({ ...cur, ...patch, updatedAt: nowIso() });
  scheduleSync();
}

// ---------- 中身 ----------

const inv = { month: null, client: null }; // 開いている請求書

// "2026-04-30" → "2026年04月30日"（テンプレートの書き方）
const jpDate = (s) => (s ? `${s.slice(0, 4)}年${s.slice(5, 7)}月${s.slice(8, 10)}日` : '');

function monthEnd(ym) {
  const d = parseDate(`${shiftMonth(ym, 1)}-01`);
  d.setDate(0);
  return fmtDate(d);
}

function invoiceItems(month, client) {
  return state.projects
    .filter((p) => p.billingMonth === month && p.client === client)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
    .map((p, i) => ({
      no: i + 1,
      name: p.title ? `${p.title}（${KIND_LABEL[p.kind]}）` : `${KIND_LABEL[p.kind]}動画編集`,
      qty: p.count,
      price: p.unitPrice,
      amount: amountOf(p),
    }));
}

function invoiceData() {
  const items = invoiceItems(inv.month, inv.client);
  return {
    to: $('iv-to').value.trim(),
    myName: $('iv-myname').value.trim(),
    issue: $('iv-issue').value,
    due: $('iv-due').value,
    bank: $('iv-bank').value.trim(),
    note: $('iv-note').value.trim(),
    items,
    total: items.reduce((s, it) => s + it.amount, 0),
  };
}

// 例：5月分請求書_自分の名前_〇〇様（これまでの請求書のファイル名にそろえる）
function invoiceFileName(d) {
  return `${Number(inv.month.slice(5))}月分請求書_${d.myName || '自分の名前'}_${d.to}様`.replace(/[\\/:*?"<>|]/g, '_');
}

// ---------- 画面 ----------

function openInvoice(month, client) {
  inv.month = month;
  inv.client = client;
  const s = state.settings ?? {};
  $('iv-to').value = s.addressees?.[client] ?? client;
  $('iv-myname').value = s.myName ?? '';
  $('iv-issue').value = monthEnd(month);                 // 発効日：請求月の末日
  $('iv-due').value = monthEnd(shiftMonth(month, 1));    // お支払期限：翌月の末日
  $('iv-bank').value = s.bank ?? '';
  $('iv-note').value = s.note ?? '';
  $('invoice-title').textContent = `${monthLabel(month)}分　${client}`;
  document.body.classList.add('invoice-open');
  $('invoice-view').scrollTop = 0;
  renderInvoicePaper();
}

function closeInvoice() {
  document.body.classList.remove('invoice-open');
  inv.month = null;
}

function renderInvoicePaper() {
  const d = invoiceData();
  const rows = [...d.items];
  while (rows.length < INVOICE_ROWS) rows.push(null);
  const lines = (s) => esc(s).replace(/\n/g, '<br>');
  $('invoice-paper').innerHTML = `
    <h1 class="ip-title">請求書</h1>
    <div class="ip-issue">発効日: ${jpDate(d.issue)}</div>
    <div class="ip-parties">
      <div class="ip-to">${esc(d.to)}<span>様</span></div>
      <div class="ip-from">${esc(d.myName)}</div>
    </div>
    <div class="ip-amount"><span>今回御請求額</span><b>${yen(d.total)}</b></div>
    <table class="ip-table">
      <thead><tr><th>No.</th><th>品名・作業内容</th><th>数量</th><th>単価</th><th>金額</th></tr></thead>
      <tbody>${rows.map((r) => (r
        ? `<tr><td class="c">${r.no}</td><td>${esc(r.name)}</td><td class="n">${r.qty}</td><td class="n">${yen(r.price)}</td><td class="n">${yen(r.amount)}</td></tr>`
        : '<tr><td></td><td></td><td></td><td></td><td></td></tr>')).join('')}</tbody>
      <tfoot><tr><td colspan="4">合計金額</td><td class="n">${yen(d.total)}</td></tr></tfoot>
    </table>
    <div class="ip-block"><h3>お振込先</h3><p>${lines(d.bank)}</p></div>
    <div class="ip-due">お支払期限: ${jpDate(d.due)}</div>
    <div class="ip-block"><h3>備考</h3><p>${lines(d.note)}</p></div>`;
}

// 保存したら、その月のそのクライアントを「請求書 発行済」にする
function markIssued() {
  if (!invoiceOf(inv.month, inv.client).invoicedAt) {
    toggleInvoice(inv.month, inv.client, 'invoicedAt');
    showToast(`${monthLabel(inv.month)}分の${inv.client}を「請求書 発行済」にしました`, null);
  }
}

function checkInvoice(d) {
  if (!d.items.length) { alert('この月・このクライアントの案件がありません'); return false; }
  if (!d.to) { alert('宛名を入れてください'); $('iv-to').focus(); return false; }
  return true;
}

// ---------- 保存 ----------

function printInvoice() {
  const d = invoiceData();
  if (!checkInvoice(d)) return;
  // 印刷画面で「PDFに保存」にしたときのファイル名はページのタイトルになる
  const prev = document.title;
  document.title = invoiceFileName(d);
  window.addEventListener('afterprint', () => { document.title = prev; }, { once: true });
  markIssued();
  window.print();
}

const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// テンプレートと同じ 6 列・同じ行の位置に入れる（A 列は空き）。宛名と自分の名前はテンプレートの空き行（6 行目）に置く
function invoiceCsv(d) {
  const row = (cells = {}) => {
    const r = Array(6).fill('');
    for (const [col, v] of Object.entries(cells)) r[col] = v;
    return r;
  };
  const out = [
    row(), row({ 1: '請求書' }), row(), row({ 4: '発効日:', 5: jpDate(d.issue) }), row(),
    row({ 1: `${d.to} 様`, 4: d.myName }), row(),
    row({ 1: '今回御請求額' }), row({ 1: yen(d.total) }), row(), row(),
    row({ 1: 'No.', 2: '品名・作業内容', 3: '数量', 4: '単価', 5: '金額' }),
  ];
  const items = [...d.items];
  while (items.length < INVOICE_ROWS) items.push(null);
  for (const it of items) out.push(it ? row({ 1: it.no, 2: it.name, 3: it.qty, 4: it.price, 5: it.amount }) : row());
  out.push(row({ 1: '合計金額', 5: d.total }), row(), row({ 1: 'お振込先' }));
  const bank = d.bank ? d.bank.split('\n') : [];
  while (bank.length < 2) bank.push('');
  for (const b of bank) out.push(row({ 1: b }));
  out.push(row({ 1: 'お支払期限:', 2: jpDate(d.due) }), row(), row({ 1: '備考', 2: d.note.replace(/\n/g, ' ') }));
  return out.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

function downloadFile(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function saveInvoiceCsv() {
  const d = invoiceData();
  if (!checkInvoice(d)) return;
  // 先頭の BOM で Excel でも文字化けしない
  downloadFile(`${invoiceFileName(d)}.csv`, new Blob(['﻿' + invoiceCsv(d)], { type: 'text/csv' }));
  markIssued();
}

// ---------- 操作 ----------

function bindInvoice() {
  $('iv-close').addEventListener('click', closeInvoice);
  $('iv-pdf').addEventListener('click', printInvoice);
  $('iv-csv').addEventListener('click', saveInvoiceCsv);
  $('iv-form').addEventListener('submit', (e) => e.preventDefault());
  $('iv-form').addEventListener('input', (e) => {
    const id = e.target.id;
    if (id === 'iv-to') {
      const addressees = { ...(state.settings?.addressees ?? {}), [inv.client]: e.target.value.trim() };
      updateSettings({ addressees });
    } else if (id === 'iv-myname') updateSettings({ myName: e.target.value.trim() });
    else if (id === 'iv-bank') updateSettings({ bank: e.target.value });
    else if (id === 'iv-note') updateSettings({ note: e.target.value });
    renderInvoicePaper();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.body.classList.contains('invoice-open')) closeInvoice();
  });
}
