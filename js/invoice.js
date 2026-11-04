// 請求書を作る：docs/請求書テンプレート.csv と同じ並びで、画面で確かめて PDF（印刷）か CSV で保存する
// 作り方は 2 通り：クライアント別（請求月の案件をまとめて・月末請求）と、案件別（単発の案件 1 件だけ）
// 宛名・自分の名前・住所・電話番号・振込先・備考は設定として保存し、同期する
// 保存した請求書は「控え」としてそのままの中身を残し、あとから見られる
//   クライアント別は請求状態のレコード（invoices）の snapshot、案件別は案件の invoiceSnapshot に入れる（どちらも同期される）

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
  const cur = state.settings ?? { myName: '', bankInfo: {}, myAddressInfo: {}, note: '', addressees: {} };
  saveSettingsLocal({ ...cur, ...patch, updatedAt: nowIso() });
  scheduleSync();
}

// ---------- 中身 ----------

// 開いている請求書。mode は 'month'（クライアント別）か 'project'（案件別）。snapshot があるときは控えを見ている
const inv = { mode: null, month: null, client: null, projectId: null, snapshot: null };

const projectLabel = (p) => p.title || `${KIND_LABEL[p.kind]}動画編集`;
const KIND_NAME = { month: 'クライアント別（月末まとめ）', project: '案件別（単発）' };

// "2026-04-30" → "2026年04月30日"（テンプレートの書き方）
const jpDate = (s) => (s ? `${s.slice(0, 4)}年${s.slice(5, 7)}月${s.slice(8, 10)}日` : '');

function monthEnd(ym) {
  const d = parseDate(`${shiftMonth(ym, 1)}-01`);
  d.setDate(0);
  return fmtDate(d);
}

function invoiceProjects() {
  if (inv.mode === 'project') {
    const p = byId(inv.projectId);
    return p ? [p] : [];
  }
  return state.projects
    .filter((p) => p.billingMonth === inv.month && p.client === inv.client)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}

function invoiceItems() {
  return invoiceProjects()
    .map((p, i) => ({
      no: i + 1,
      name: p.title ? `${p.title}（${KIND_LABEL[p.kind]}）` : projectLabel(p),
      qty: p.count,
      price: p.unitPrice,
      amount: amountOf(p),
    }));
}

// 入力欄と案件から、請求書に載せる中身を作る（住所・振込先は行に分けた配列）
function invoiceData() {
  const items = invoiceItems();
  return {
    to: $('iv-to').value.trim(),
    myName: $('iv-myname').value.trim(),
    address: addressLines(readGroup('iv-addr', 'addr')),
    tel: $('iv-tel').value.trim(),
    issue: $('iv-issue').value,
    due: $('iv-due').value,
    bank: bankLines(readGroup('iv-bank', 'bank')),
    note: $('iv-note').value.trim(),
    items,
    total: items.reduce((s, it) => s + it.amount, 0),
  };
}

// 見ている中身（控えならそのまま、作っている途中なら入力欄から）
const currentData = () => inv.snapshot?.data ?? invoiceData();

// ---------- 項目に分けた入力（住所・お振込先） ----------

// data-addr / data-bank の付いた欄をまとめて読み書きする
function readGroup(groupId, key) {
  const v = {};
  for (const el of $(groupId).querySelectorAll(`[data-${key}]`)) v[el.dataset[key]] = el.value.trim();
  return v;
}

function writeGroup(groupId, key, values) {
  for (const el of $(groupId).querySelectorAll(`[data-${key}]`)) {
    el.value = values[el.dataset[key]] ?? (el.tagName === 'SELECT' ? el.options[0].value : '');
  }
}

// 請求書に載せる住所：「〒000-0000」「東京都〇〇市〇〇 1-2-3」「〇〇マンション 101」（空の項目は詰める）
function addressLines(a) {
  return [a.zip ? `〒${a.zip}` : '', `${a.pref ?? ''}${a.city ?? ''}`, a.building ?? ''].filter(Boolean);
}

// 請求書に載せる振込先 2 行：「〇〇銀行 〇〇支店　普通 1234567」「口座名義：〇〇」（空の項目は詰める）
function bankLines(b) {
  const line1 = [[b.bank, b.branch].filter(Boolean).join(' '), b.number ? `${b.type} ${b.number}` : ''].filter(Boolean).join('　');
  const line2 = b.holder ? `口座名義：${b.holder}` : '';
  return [line1, line2].filter(Boolean);
}

// これまでの請求書のファイル名にそろえる
// クライアント別：5月分請求書_自分の名前_〇〇様　／　案件別：請求書_案件名_自分の名前_〇〇様
function invoiceFileName(d) {
  if (inv.snapshot) return inv.snapshot.fileName;
  const head = inv.mode === 'project'
    ? `請求書_${projectLabel(byId(inv.projectId))}`
    : `${Number(inv.month.slice(5))}月分請求書`;
  return `${head}_${d.myName || '自分の名前'}_${d.to}様`.replace(/[\\/:*?"<>|]/g, '_');
}

// ---------- 控え（発行した請求書） ----------

function monthSnapshot(month, client) {
  const r = invoiceOf(month, client);
  return r.invoicedAt && r.snapshot ? r.snapshot : null;
}

const projectSnapshot = (p) => (p?.invoicedAt && p.invoiceSnapshot ? p.invoiceSnapshot : null);

// これまでに発行した請求書（新しい順）
function issuedInvoices() {
  const list = [];
  for (const r of state.invoices.values()) if (r.invoicedAt && r.snapshot) list.push(r.snapshot);
  for (const p of state.projects) if (projectSnapshot(p)) list.push(p.invoiceSnapshot);
  return list.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

async function saveMonthRecord(month, client, patch) {
  const r = { ...invoiceOf(month, client), ...patch, updatedAt: nowIso() };
  state.invoices.set(r.key, r);
  await saveInvoice(r);
  renderAll();
  scheduleSync();
}

// 保存したら控えを残し、「請求書 発行済」にする。クライアント別はその月のそのクライアント、案件別はその案件
function markIssued(d) {
  const today = todayStr();
  const snapshot = {
    mode: inv.mode, month: inv.month, client: inv.client, projectId: inv.projectId,
    title: $('invoice-title').textContent, fileName: invoiceFileName(d), savedAt: nowIso(), data: d,
  };
  if (inv.mode === 'project') {
    const p = byId(inv.projectId);
    if (!p) return;
    if (!p.invoicedAt) showToast(`「${projectLabel(p)}」を「請求書 発行済」にしました`, null);
    upsert({ ...p, invoicedAt: p.invoicedAt || today, invoiceSnapshot: snapshot });
  } else {
    const r = invoiceOf(inv.month, inv.client);
    if (!r.invoicedAt) showToast(`${monthLabel(inv.month)}分の${inv.client}を「請求書 発行済」にしました`, null);
    saveMonthRecord(inv.month, inv.client, { invoicedAt: r.invoicedAt || today, snapshot });
  }
}

// ---------- 画面 ----------

// クライアント別：発行済みなら控えを開く。まだなら作る（発効日は請求月の末日、お支払期限は翌月の末日）
function openInvoice(month, client, { remake = false } = {}) {
  const target = { mode: 'month', month, client, projectId: null };
  const snap = remake ? null : monthSnapshot(month, client);
  if (snap) { showSnapshot(target, snap); return; }
  showEditor(target, monthEnd(month), monthEnd(shiftMonth(month, 1)), `${monthLabel(month)}分　${client}`);
}

// 案件別（単発）：発行済みなら控えを開く。まだなら作る（発効日は今日、お支払期限は翌月の末日）
function openProjectInvoice(id, { remake = false } = {}) {
  const p = byId(id);
  if (!p) return;
  const target = { mode: 'project', month: p.billingMonth, client: p.client, projectId: id };
  const snap = remake ? null : projectSnapshot(p);
  if (snap) { showSnapshot(target, snap); return; }
  const today = todayStr();
  showEditor(target, today, monthEnd(shiftMonth(monthOf(today), 1)), `案件「${projectLabel(p)}」　${p.client}`);
}

function showEditor(target, issue, due, title) {
  Object.assign(inv, target, { snapshot: null });
  const s = state.settings ?? {};
  $('iv-to').value = s.addressees?.[inv.client] ?? inv.client;
  $('iv-myname').value = s.myName ?? '';
  // 0.7.0 の 1 つの欄で入れた住所は「市区町村・番地」に入れておく
  writeGroup('iv-addr', 'addr', s.myAddressInfo ?? (s.myAddress ? { city: s.myAddress.replace(/\s*\n\s*/g, ' ') } : {}));
  $('iv-tel').value = s.myTel ?? '';
  $('iv-issue').value = issue;
  $('iv-due').value = due;
  writeGroup('iv-bank', 'bank', s.bankInfo ?? {});
  $('iv-note').value = s.note ?? '';
  openView(title);
}

function showSnapshot(target, snap) {
  Object.assign(inv, target, { snapshot: snap });
  const saved = new Date(snap.savedAt);
  $('iv-v-saved').textContent = `${shortDate(fmtDate(saved))} ${saved.getHours()}:${String(saved.getMinutes()).padStart(2, '0')}`;
  $('iv-v-file').textContent = snap.fileName;
  $('iv-v-total').textContent = yen(snap.data.total);
  // 発行したあとに案件の内容（本数・単価・件数）が変わっていたら知らせる
  const now = invoiceItems();
  const changed = JSON.stringify(now) !== JSON.stringify(snap.data.items);
  $('iv-v-changed').hidden = !changed;
  $('iv-v-changed').textContent = changed
    ? `発行したあとに案件の内容が変わっています（いまの内容だと ${yen(now.reduce((s, it) => s + it.amount, 0))}）。直した請求書を出すときは「作り直す」から。`
    : '';
  openView(snap.title);
}

function openView(title) {
  const viewing = !!inv.snapshot;
  $('invoice-title').textContent = title;
  $('invoice-kind').textContent = viewing ? `発行済み・${KIND_NAME[inv.mode]}` : KIND_NAME[inv.mode];
  $('invoice-kind').dataset.mode = inv.mode;
  $('iv-issue-hint').textContent = inv.mode === 'project' ? 'この案件は' : 'この月のこのクライアントは';
  document.body.classList.toggle('invoice-viewing', viewing);
  document.body.classList.add('invoice-open');
  $('invoice-view').scrollTop = 0;
  renderInvoicePaper();
}

function closeInvoice() {
  document.body.classList.remove('invoice-open', 'invoice-viewing');
  inv.mode = null;
  inv.snapshot = null;
}

function renderInvoicePaper() {
  const d = currentData();
  const rows = [...d.items];
  while (rows.length < INVOICE_ROWS) rows.push(null);
  const lines = (s) => esc(s).replace(/\n/g, '<br>');
  $('invoice-paper').innerHTML = `
    <h1 class="ip-title">請求書</h1>
    <div class="ip-issue">発効日: ${jpDate(d.issue)}</div>
    <div class="ip-parties">
      <div class="ip-to">${esc(d.to)}<span>様</span></div>
      <div class="ip-from">
        <div class="ip-from-name">${esc(d.myName)}</div>
        ${d.address.map((l) => `<div>${esc(l)}</div>`).join('')}
        ${d.tel ? `<div>TEL：${esc(d.tel)}</div>` : ''}
      </div>
    </div>
    <div class="ip-amount"><span>今回御請求額</span><b>${yen(d.total)}</b></div>
    <table class="ip-table">
      <thead><tr><th>No.</th><th>品名・作業内容</th><th>数量</th><th>単価</th><th>金額</th></tr></thead>
      <tbody>${rows.map((r) => (r
        ? `<tr><td class="c">${r.no}</td><td>${esc(r.name)}</td><td class="n">${r.qty}</td><td class="n">${yen(r.price)}</td><td class="n">${yen(r.amount)}</td></tr>`
        : '<tr><td></td><td></td><td></td><td></td><td></td></tr>')).join('')}</tbody>
      <tfoot><tr><td colspan="4">合計金額</td><td class="n">${yen(d.total)}</td></tr></tfoot>
    </table>
    <div class="ip-block"><h3>お振込先</h3><p>${d.bank.map(esc).join('<br>')}</p></div>
    <div class="ip-due">お支払期限: ${jpDate(d.due)}</div>
    <div class="ip-block"><h3>備考</h3><p>${lines(d.note)}</p></div>`;
}

// 請求タブの下に出す「発行した請求書」の一覧
function issuedListHtml() {
  const list = issuedInvoices();
  const head = `<h3 class="section-title">発行した請求書 <span class="muted">${list.length}件</span></h3>`;
  if (!list.length) return head + '<p class="empty">まだありません。請求書を PDF か CSV で保存すると、ここから見直せます。</p>';
  return head + `<div class="card issued-list">${list.map((s) => {
    const open = s.mode === 'project'
      ? `data-project-invoice="${esc(s.projectId)}"`
      : `data-make-invoice="1" data-month="${esc(s.month)}" data-client="${esc(s.client)}"`;
    return `<button class="issued-item" ${open} style="${clientStyle(s.client)}">
      <span class="issued-date">${shortDate(fmtDate(new Date(s.savedAt)))}</span>
      <span class="invoice-kind" data-mode="${s.mode}">${s.mode === 'project' ? '案件別' : 'クライアント別'}</span>
      <span class="issued-name"><span class="client-chip">${esc(s.client)}</span> ${esc(s.title.split('　')[0])}</span>
      <b>${yen(s.data.total)}</b>
    </button>`;
  }).join('')}</div>`;
}

function checkInvoice(d) {
  if (!d.items.length) { alert('この月・このクライアントの案件がありません'); return false; }
  if (!d.to) { alert('宛名を入れてください'); $('iv-to').focus(); return false; }
  return true;
}

// ---------- 保存 ----------

// 作っている途中なら、確かめてから控えを残す。控えを見ているときはそのまま出す
function prepareSave() {
  const d = currentData();
  if (inv.snapshot) return d;
  if (!checkInvoice(d)) return null;
  markIssued(d);
  return d;
}

function printInvoice() {
  const name = invoiceFileName(currentData());
  if (!prepareSave()) return;
  // 印刷画面で「PDFに保存」にしたときのファイル名はページのタイトルになる
  const prev = document.title;
  document.title = name;
  window.addEventListener('afterprint', () => { document.title = prev; }, { once: true });
  window.print();
}

const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// テンプレートと同じ 6 列・同じ行の位置に入れる（A 列は空き）
// 宛名・自分の名前・住所・電話番号は、テンプレートの空き行（5〜7 行目）に置く
function invoiceCsv(d) {
  const row = (cells = {}) => {
    const r = Array(6).fill('');
    for (const [col, v] of Object.entries(cells)) r[col] = v;
    return r;
  };
  const out = [
    row(), row({ 1: '請求書' }), row(), row({ 4: '発効日:', 5: jpDate(d.issue) }),
    row({ 4: d.myName }),
    row({ 1: `${d.to} 様`, 4: d.address.join(' ') }),
    row({ 4: d.tel ? `TEL：${d.tel}` : '' }),
    row({ 1: '今回御請求額' }), row({ 1: yen(d.total) }), row(), row(),
    row({ 1: 'No.', 2: '品名・作業内容', 3: '数量', 4: '単価', 5: '金額' }),
  ];
  const items = [...d.items];
  while (items.length < INVOICE_ROWS) items.push(null);
  for (const it of items) out.push(it ? row({ 1: it.no, 2: it.name, 3: it.qty, 4: it.price, 5: it.amount }) : row());
  out.push(row({ 1: '合計金額', 5: d.total }), row(), row({ 1: 'お振込先' }));
  // テンプレートの振込先は 2 行（36・37 行目）
  for (const b of [...d.bank, '', ''].slice(0, 2)) out.push(row({ 1: b }));
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
  const name = invoiceFileName(currentData());
  const d = prepareSave();
  if (!d) return;
  // 先頭の BOM で Excel でも文字化けしない
  downloadFile(`${name}.csv`, new Blob(['﻿' + invoiceCsv(d)], { type: 'text/csv' }));
}

// ---------- 操作 ----------

function bindInvoice() {
  $('iv-close').addEventListener('click', closeInvoice);
  $('iv-pdf').addEventListener('click', printInvoice);
  $('iv-csv').addEventListener('click', saveInvoiceCsv);
  // 控えから作り直す（いまの案件・設定の内容で新しく作る）
  $('iv-remake').addEventListener('click', () => {
    if (inv.mode === 'project') openProjectInvoice(inv.projectId, { remake: true });
    else openInvoice(inv.month, inv.client, { remake: true });
  });
  $('iv-form').addEventListener('submit', (e) => e.preventDefault());
  $('iv-form').addEventListener('input', (e) => {
    const id = e.target.id;
    if (id === 'iv-to') {
      const addressees = { ...(state.settings?.addressees ?? {}), [inv.client]: e.target.value.trim() };
      updateSettings({ addressees });
    } else if (id === 'iv-myname') updateSettings({ myName: e.target.value.trim() });
    else if (e.target.dataset.addr) updateSettings({ myAddressInfo: readGroup('iv-addr', 'addr') });
    else if (id === 'iv-tel') updateSettings({ myTel: e.target.value.trim() });
    else if (e.target.dataset.bank) updateSettings({ bankInfo: readGroup('iv-bank', 'bank') });
    else if (id === 'iv-note') updateSettings({ note: e.target.value });
    renderInvoicePaper();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.body.classList.contains('invoice-open')) closeInvoice();
  });
}
