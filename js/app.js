// util.js・db.js・config.js・sync.js を先に読み込んでおくこと（index.html をダブルクリックで開けるよう、モジュールにしていない）

// 配布時のバージョン。上げたら CHANGELOG.md も更新する
const APP_VERSION = '0.4.1';

const $ = (id) => document.getElementById(id);

const state = {
  projects: [],
  invoices: new Map(), // "YYYY-MM|クライアント" → { invoicedAt, paidAt }
  deleted: new Map(),  // 削除した案件 id → { id, deletedAt }
  tab: 'list',
  clientFilter: '',    // クライアント別タブで絞り込むクライアント（空ならすべて）
  editingId: null,
  calMonth: monthOf(todayStr()),
  billMonth: monthOf(todayStr()),
  showDoneOnCal: false,
};

// ---------- 永続化まわり ----------

function prefGet(key, fallback) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function prefSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* 保存できなくても動作は続ける */ }
}

const nowIso = () => new Date().toISOString();

// 変更したレコードには updatedAt を付ける（同期で新しい方を残すため）
async function upsert(p) {
  p = { ...p, updatedAt: nowIso() };
  const i = state.projects.findIndex((x) => x.id === p.id);
  if (i >= 0) state.projects[i] = p; else state.projects.push(p);
  await saveProject(p);
  renderAll();
  scheduleSync();
}

async function remove(id) {
  const deletedAt = nowIso();
  state.projects = state.projects.filter((p) => p.id !== id);
  state.deleted.set(id, { id, deletedAt });
  await deleteProject(id, deletedAt);
  renderAll();
  scheduleSync();
}

// 同期用：今のデータ一式
function localData() {
  return { projects: state.projects, invoices: [...state.invoices.values()], deleted: [...state.deleted.values()] };
}

// 同期用：統合したデータで置き換える
async function applyData(data) {
  await replaceAll(data);
  state.projects = data.projects;
  state.invoices = new Map(data.invoices.map((r) => [r.key, r]));
  state.deleted = new Map(data.deleted.map((d) => [d.id, d]));
  if (state.editingId && !byId(state.editingId)) { resetForm(); closeSheet(); }
  renderAll();
}

const byId = (id) => state.projects.find((p) => p.id === id);
const clientNames = () => [...new Set(state.projects.map((p) => p.client))].sort((a, b) => a.localeCompare(b, 'ja'));
const clientStyle = (name) => `--hue:${clientHue(name)}`;

// ---------- タブ ----------

function setTab(tab) {
  state.tab = tab;
  prefSet('tab', tab);
  for (const b of $('tabs').querySelectorAll('button')) b.classList.toggle('active', b.dataset.tab === tab);
  for (const v of document.querySelectorAll('.view')) v.classList.toggle('active', v.id === `view-${tab}`);
  renderAll();
}

function renderAll() {
  renderClientOptions();
  if (state.tab === 'list') renderActiveList();
  if (state.tab === 'clients') renderClients();
  if (state.tab === 'calendar') renderCalendar();
  if (state.tab === 'billing') renderBilling();
  if (state.tab === 'done') renderDoneList();
}

// ---------- 入力フォーム ----------

const form = {
  kind: 'short',
  priceTouched: false,   // 単価を手で変えたら自動入力しない
  billingTouched: false, // 請求月を手で変えたら納期に追従しない
};

function setKind(kind) {
  form.kind = kind;
  for (const b of $('f-kind').querySelectorAll('button')) b.classList.toggle('active', b.dataset.kind === kind);
}

// 同じクライアント・種別で最後に登録した単価
function lastPrice(client, kind) {
  const hits = state.projects
    .filter((p) => p.client === client && p.kind === kind)
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  return hits[0]?.unitPrice;
}

function autoFillPrice() {
  if (form.priceTouched && $('f-price').value !== '') return;
  const price = lastPrice($('f-client').value.trim(), form.kind);
  if (price != null) $('f-price').value = price;
  updateAmount();
}

function updateAmount() {
  const price = Number($('f-price').value) || 0;
  const count = Number($('f-count').value) || 0;
  $('f-amount').textContent = yen(price * count);
}

function resetForm({ keepClient = false } = {}) {
  const keep = keepClient ? { client: $('f-client').value, kind: form.kind, price: $('f-price').value } : null;
  state.editingId = null;
  $('project-form').reset();
  $('form-title').textContent = '案件を追加';
  $('btn-submit').textContent = '追加';
  $('btn-cancel').hidden = true;
  $('btn-delete').hidden = true;
  $('form-error').textContent = '';
  $('project-form').classList.remove('editing');
  form.priceTouched = false;
  form.billingTouched = false;
  $('f-count').value = 1;
  $('f-start').value = todayStr();
  $('f-billing').value = monthOf(todayStr());
  if (keep) {
    $('f-client').value = keep.client;
    setKind(keep.kind);
    $('f-price').value = keep.price;
  } else {
    setKind('short');
  }
  updateAmount();
}

function startEdit(id) {
  const p = byId(id);
  if (!p) return;
  if (state.tab !== 'list') setTab('list');
  state.editingId = id;
  $('form-title').textContent = p.status === 'done' ? '案件を編集（完了済み）' : '案件を編集';
  $('btn-submit').textContent = '更新';
  $('btn-cancel').hidden = false;
  $('btn-delete').hidden = false;
  $('form-error').textContent = '';
  $('project-form').classList.add('editing');
  $('f-client').value = p.client;
  $('f-title').value = p.title;
  setKind(p.kind);
  $('f-price').value = p.unitPrice;
  $('f-count').value = p.count;
  $('f-start').value = p.startDate;
  $('f-due').value = p.dueDate;
  $('f-billing').value = p.billingMonth;
  $('f-memo').value = p.memo ?? '';
  form.priceTouched = true;
  form.billingTouched = p.billingMonth !== monthOf(p.dueDate);
  updateAmount();
  renderActiveList();
  if (isNarrow()) openSheet();
  else {
    $('project-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('f-client').focus();
  }
}

// スマホ幅では入力フォームを下から出るシートにする
const isNarrow = () => matchMedia('(max-width: 860px)').matches;

function openSheet() {
  document.body.classList.add('sheet-open');
  $('project-form').scrollTop = 0;
}

function closeSheet() {
  document.body.classList.remove('sheet-open');
}

function readForm() {
  const v = {
    client: $('f-client').value.trim(),
    title: $('f-title').value.trim(),
    kind: form.kind,
    unitPrice: Number($('f-price').value),
    count: Number($('f-count').value),
    startDate: $('f-start').value,
    dueDate: $('f-due').value,
    billingMonth: $('f-billing').value,
    memo: $('f-memo').value.trim(),
  };
  if (!v.client) return { error: 'クライアント名を入れてください' };
  if ($('f-price').value === '' || !(v.unitPrice >= 0)) return { error: '単価を入れてください' };
  if (!Number.isInteger(v.count) || v.count < 1) return { error: '本数は1以上の整数で入れてください' };
  if (!v.startDate || !v.dueDate) return { error: '着手日と納期を入れてください' };
  if (v.dueDate < v.startDate) return { error: '納期が着手日より前になっています' };
  if (!v.billingMonth) return { error: '請求月を入れてください' };
  return { value: v };
}

async function onSubmit(e) {
  e.preventDefault();
  const { value, error } = readForm();
  if (error) { $('form-error').textContent = error; return; }
  if (state.editingId) {
    await upsert({ ...byId(state.editingId), ...value });
    resetForm();
    closeSheet();
  } else {
    await upsert({ id: newId(), ...value, status: 'active', completedAt: null, createdAt: nowIso() });
    resetForm({ keepClient: true });
    if (isNarrow()) {
      closeSheet();
      showToast(`「${value.title || value.client}」を追加しました`, null);
    } else {
      $('f-title').focus();
    }
  }
}

function openNewForm() {
  if (state.editingId) resetForm();
  if (state.tab !== 'list') setTab('list');
  openSheet();
}

function bindForm() {
  $('project-form').addEventListener('submit', onSubmit);
  $('f-kind').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-kind]');
    if (!b) return;
    setKind(b.dataset.kind);
    if (!state.editingId) { form.priceTouched = false; autoFillPrice(); }
  });
  $('f-client').addEventListener('change', () => { if (!state.editingId) autoFillPrice(); });
  $('f-price').addEventListener('input', () => { form.priceTouched = true; updateAmount(); });
  $('f-count').addEventListener('input', updateAmount);
  $('f-due').addEventListener('change', () => {
    if (!form.billingTouched && $('f-due').value) $('f-billing').value = monthOf($('f-due').value);
  });
  $('f-billing').addEventListener('input', () => { form.billingTouched = true; });
  $('btn-cancel').addEventListener('click', () => { resetForm(); renderActiveList(); closeSheet(); });
  $('btn-sheet-close').addEventListener('click', () => {
    if (state.editingId) { resetForm(); renderActiveList(); }
    closeSheet();
  });
  $('btn-delete').addEventListener('click', async () => {
    const p = byId(state.editingId);
    if (!p || !confirm(`「${p.title || p.client}」を削除します。元に戻せません。`)) return;
    await remove(p.id);
    resetForm();
    closeSheet();
  });
  $('fab-add').addEventListener('click', openNewForm);
}

function renderClientOptions() {
  $('client-options').innerHTML = clientNames().map((n) => `<option value="${esc(n)}">`).join('');
}

// ---------- 進行中の一覧 ----------

function dueBadge(p) {
  const left = diffDays(todayStr(), p.dueDate);
  if (left < 0) return { cls: 'overdue', text: `${-left}日超過` };
  if (left === 0) return { cls: 'soon', text: '今日' };
  if (left <= 2) return { cls: 'soon', text: `あと${left}日` };
  return { cls: '', text: `あと${left}日` };
}

function projectRow(p, { mode }) {
  const badge = mode === 'active' ? dueBadge(p) : null;
  const left = mode === 'active'
    ? `<div class="due ${badge.cls}">${shortDate(p.dueDate)}<small>${badge.text}</small></div>`
    : `<div class="due done">${shortDate(p.completedAt)}<small>完了</small></div>`;
  const actions = mode === 'active'
    ? `<button class="btn-done" data-done="${p.id}" title="完了済みに移す">完了</button>`
    : `<button class="ghost small" data-undone="${p.id}" title="進行中に戻す">戻す</button>`;
  return `
    <div class="project-row ${state.editingId === p.id ? 'is-editing' : ''}" style="${clientStyle(p.client)}">
      ${left}
      <div class="main">
        <div class="tags">
          <span class="client-chip">${esc(p.client)}</span>
          <span class="kind-tag ${p.kind}">${KIND_LABEL[p.kind]}</span>
        </div>
        <div class="title">${esc(p.title) || '<span class="muted">（案件名なし）</span>'}</div>
        <div class="sub">${shortDate(p.startDate)} 〜 ${shortDate(p.dueDate)} ・ 請求 ${monthLabel(p.billingMonth)}${p.memo ? ` ・ ${esc(p.memo)}` : ''}</div>
      </div>
      <div class="money">
        <small>${yen(p.unitPrice)} × ${p.count}本</small>
        <b>${yen(amountOf(p))}</b>
      </div>
      <div class="actions">
        ${actions}
        <button class="ghost small" data-edit="${p.id}">編集</button>
      </div>
    </div>`;
}

function renderActiveList() {
  const active = state.projects
    .filter((p) => p.status === 'active')
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.startDate.localeCompare(b.startDate));
  const overdue = active.filter((p) => p.dueDate < todayStr()).length;
  $('active-summary').textContent = active.length
    ? `${active.length}件${overdue ? `（納期切れ ${overdue}件）` : ''}`
    : '';
  $('active-list').innerHTML = active.length
    ? active.map((p) => projectRow(p, { mode: 'active' })).join('')
    : `<p class="empty">進行中の案件はありません。${isNarrow() ? '右下の「＋」' : '左のフォーム'}から追加してください。</p>`;
}

// ---------- 完了（ワンボタンで仕分け） ----------

let toastTimer = null;
let undoAction = null;

function showToast(message, undo) {
  $('toast-msg').textContent = message;
  undoAction = undo;
  $('toast-undo').hidden = !undo;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 8000);
}

function hideToast() {
  $('toast').hidden = true;
  undoAction = null;
}

async function markDone(id) {
  const p = byId(id);
  if (!p) return;
  const before = { status: p.status, completedAt: p.completedAt };
  await upsert({ ...p, status: 'done', completedAt: todayStr() });
  if (state.editingId === id) resetForm();
  showToast(`「${p.title || p.client}」を完了済みに移しました`, () => upsert({ ...byId(id), ...before }));
}

async function markUndone(id) {
  const p = byId(id);
  if (p) await upsert({ ...p, status: 'active', completedAt: null });
}

// ---------- クライアント別 ----------

function renderClients() {
  const names = clientNames();
  if (state.clientFilter && !names.includes(state.clientFilter)) state.clientFilter = '';
  $('client-filter').innerHTML = [['', 'すべて'], ...names.map((n) => [n, n])].map(([v, label]) =>
    `<button class="filter-chip ${state.clientFilter === v ? 'active' : ''}" data-client-filter="${esc(v)}"
      ${v ? `style="${clientStyle(v)}"` : ''}>${esc(label)}</button>`).join('');

  if (!names.length) {
    $('client-groups').innerHTML = '<p class="empty">まだ案件がありません。案件タブから追加してください。</p>';
    return;
  }
  const today = todayStr();
  const bills = openBills();
  const shown = state.clientFilter ? [state.clientFilter] : names;

  $('client-groups').innerHTML = shown.map((client) => {
    const ps = state.projects.filter((p) => p.client === client);
    const byDue = (a, b) => a.dueDate.localeCompare(b.dueDate);
    const started = ps.filter((p) => p.status === 'active' && p.startDate <= today).sort(byDue);
    const upcoming = ps.filter((p) => p.status === 'active' && p.startDate > today).sort(byDue);
    const done = ps.filter((p) => p.status === 'done').sort((a, b) => b.completedAt.localeCompare(a.completedAt));
    const mine = bills.filter((b) => b.client === client);
    const waiting = mine.filter((b) => b.invoiced).reduce((s, b) => s + b.total, 0);
    const unbilled = mine.filter((b) => !b.invoiced).reduce((s, b) => s + b.total, 0);

    const section = (label, cls, list, mode, emptyText) => `
      <div class="client-section ${cls}">
        <h4>${label} <span class="muted">${list.length}件${list.length ? ` ・ ${yen(list.reduce((s, p) => s + amountOf(p), 0))}` : ''}</span></h4>
        ${list.length ? list.map((p) => projectRow(p, { mode })).join('') : `<p class="muted small-empty">${emptyText}</p>`}
      </div>`;

    return `
      <section class="card client-group" style="${clientStyle(client)}">
        <header class="client-group-head">
          <span class="client-chip big">${esc(client)}</span>
          <div class="client-stats">
            <span>着手中 <b>${started.length}</b></span>
            ${upcoming.length ? `<span>着手前 <b>${upcoming.length}</b></span>` : ''}
            <span>完了 <b>${done.length}</b></span>
            ${unbilled ? `<span class="bill-state none">未請求 ${yen(unbilled)}</span>` : ''}
            ${waiting ? `<span class="bill-state wait">入金待ち ${yen(waiting)}</span>` : ''}
          </div>
        </header>
        <div class="client-columns">
          <div>
            ${section('着手中', 'started', started, 'active', '着手中の案件はありません')}
            ${upcoming.length ? section('着手前', 'upcoming', upcoming, 'active', '') : ''}
          </div>
          ${section('完了', 'finished', done, 'done', '完了した案件はまだありません')}
        </div>
      </section>`;
  }).join('');
}

// ---------- 完了済み ----------

function renderDoneList() {
  const done = state.projects
    .filter((p) => p.status === 'done')
    .sort((a, b) => b.completedAt.localeCompare(a.completedAt) || a.client.localeCompare(b.client, 'ja'));
  if (!done.length) {
    $('done-list').innerHTML = '<p class="empty">完了した案件はまだありません。進行中の一覧で「完了」を押すとここに移ります。</p>';
    return;
  }
  // 完了した月 → クライアント の順にまとめる
  const months = new Map();
  for (const p of done) {
    const m = monthOf(p.completedAt);
    if (!months.has(m)) months.set(m, new Map());
    const clients = months.get(m);
    if (!clients.has(p.client)) clients.set(p.client, []);
    clients.get(p.client).push(p);
  }
  let html = '';
  for (const [m, clients] of months) {
    const all = [...clients.values()].flat();
    html += `<section class="done-month">
      <h3>${monthLabel(m)}に完了 <span class="muted">${all.length}件 ・ ${yen(all.reduce((s, p) => s + amountOf(p), 0))}</span></h3>`;
    for (const [client, list] of [...clients].sort((a, b) => a[0].localeCompare(b[0], 'ja'))) {
      html += `<div class="done-client" style="${clientStyle(client)}">
        <h4><span class="client-chip">${esc(client)}</span><span class="muted">${list.length}件</span></h4>
        ${list.map((p) => projectRow(p, { mode: 'done' })).join('')}
      </div>`;
    }
    html += '</section>';
  }
  $('done-list').innerHTML = html;
}

// ---------- 請求書・振込の状態 ----------

const invKey = (month, client) => `${month}|${client}`;

function invoiceOf(month, client) {
  return state.invoices.get(invKey(month, client)) ?? { key: invKey(month, client), month, client, invoicedAt: null, paidAt: null };
}

// 押すたびに 済 ⇔ 未 を切り替える（済にした日を記録）
async function toggleInvoice(month, client, field) {
  const r = { ...invoiceOf(month, client) };
  r[field] = r[field] ? null : todayStr();
  r.updatedAt = nowIso();
  state.invoices.set(r.key, r);
  await saveInvoice(r);
  renderAll();
  scheduleSync();
}

function statusButtons(month, client) {
  const r = invoiceOf(month, client);
  const btn = (field, onLabel, offLabel) => {
    const on = !!r[field];
    return `<button class="status-btn ${field} ${on ? 'on' : ''}" data-inv="${field}" data-month="${month}" data-client="${esc(client)}"
      title="${on ? 'クリックで未に戻す' : 'クリックで済にする'}">${on ? `${onLabel} <small>${shortDate(r[field])}</small>` : offLabel}</button>`;
  };
  return btn('invoicedAt', '発行済', '請求書 未発行') + btn('paidAt', '入金済', '振込 未確認');
}

// 今月までで入金が済んでいない請求（クライアント × 請求月）
function openBills() {
  const cur = monthOf(todayStr());
  const months = [...new Set(state.projects.map((p) => p.billingMonth))].filter((m) => m <= cur).sort();
  const list = [];
  for (const m of months) {
    for (const r of billingRows(m)) {
      const inv = invoiceOf(m, r.client);
      if (!inv.paidAt) list.push({ month: m, client: r.client, total: r.total, pending: r.pending, invoiced: !!inv.invoicedAt });
    }
  }
  return list;
}

// ---------- 請求 ----------

function billingRows(ym) {
  const rows = new Map();
  for (const p of state.projects) {
    if (p.billingMonth !== ym) continue;
    if (!rows.has(p.client)) {
      rows.set(p.client, {
        client: p.client,
        short: { count: 0, amount: 0 },
        long: { count: 0, amount: 0 },
        total: 0,
        pending: 0,
        items: [],
      });
    }
    const r = rows.get(p.client);
    r[p.kind].count += p.count;
    r[p.kind].amount += amountOf(p);
    r.total += amountOf(p);
    if (p.status !== 'done') r.pending += 1;
    r.items.push(p);
  }
  return [...rows.values()].sort((a, b) => b.total - a.total);
}

function cell(x) {
  return x.count ? `<span class="cnt">${x.count}本</span>${yen(x.amount)}` : '<span class="muted">—</span>';
}

function renderBilling() {
  $('bill-label').textContent = monthLabel(state.billMonth);
  const rows = billingRows(state.billMonth);
  if (!rows.length) {
    $('billing').innerHTML = `<p class="empty">${monthLabel(state.billMonth)}が請求月の案件はありません。</p>` + openBillsHtml();
    return;
  }
  const sum = rows.reduce((s, r) => ({
    short: { count: s.short.count + r.short.count, amount: s.short.amount + r.short.amount },
    long: { count: s.long.count + r.long.count, amount: s.long.amount + r.long.amount },
    total: s.total + r.total,
  }), { short: { count: 0, amount: 0 }, long: { count: 0, amount: 0 }, total: 0 });

  $('billing').innerHTML = `
    <div class="card table-card">
      <table class="bill-table">
        <thead><tr><th>クライアント</th><th>ショート</th><th>ロング</th><th>請求額</th><th class="status-col">請求書・振込</th></tr></thead>
        <tbody>
          ${rows.map((r) => `
            <tr style="${clientStyle(r.client)}">
              <td class="name-col"><span class="client-chip">${esc(r.client)}</span>${r.pending ? `<span class="pending">未完了 ${r.pending}件</span>` : ''}</td>
              <td class="num" data-label="ショート">${cell(r.short)}</td>
              <td class="num" data-label="ロング">${cell(r.long)}</td>
              <td class="num total" data-label="請求額">${yen(r.total)}</td>
              <td class="status-col"><div class="status-pair">${statusButtons(state.billMonth, r.client)}</div></td>
            </tr>`).join('')}
        </tbody>
        <tfoot><tr>
          <td class="name-col">合計</td>
          <td class="num" data-label="ショート">${cell(sum.short)}</td>
          <td class="num" data-label="ロング">${cell(sum.long)}</td>
          <td class="num total" data-label="請求額">${yen(sum.total)}</td>
          <td class="status-col muted">${paidSummary(state.billMonth, rows)}</td>
        </tr></tfoot>
      </table>
    </div>
    <h3 class="section-title">内訳</h3>
    ${rows.map((r) => `
      <details class="card bill-detail" style="${clientStyle(r.client)}">
        <summary><span class="client-chip">${esc(r.client)}</span><span>${r.items.length}件</span><b>${yen(r.total)}</b></summary>
        <ul>
          ${r.items.sort((a, b) => a.dueDate.localeCompare(b.dueDate)).map((p) => `
            <li>
              <span class="kind-tag ${p.kind}">${KIND_LABEL[p.kind]}</span>
              <span class="grow">${esc(p.title) || '<span class="muted">（案件名なし）</span>'}</span>
              <span class="muted">${p.status === 'done' ? '完了' : `納期 ${shortDate(p.dueDate)}`}</span>
              <span class="num">${yen(p.unitPrice)} × ${p.count} = <b>${yen(amountOf(p))}</b></span>
            </li>`).join('')}
        </ul>
      </details>`).join('')}
    ${openBillsHtml()}`;
}

function paidSummary(month, rows) {
  const paid = rows.filter((r) => invoiceOf(month, r.client).paidAt).reduce((s, r) => s + r.total, 0);
  return `入金済 ${yen(paid)} / ${yen(rows.reduce((s, r) => s + r.total, 0))}`;
}

function openBillsHtml() {
  const list = openBills();
  if (!list.length) return '<h3 class="section-title">入金待ち・未請求（今月まで）</h3><p class="empty">入金待ちの請求はありません。</p>';
  const total = list.reduce((s, b) => s + b.total, 0);
  return `
    <h3 class="section-title">入金待ち・未請求（今月まで） <span class="muted">${list.length}件 ・ ${yen(total)}</span></h3>
    <div class="card table-card">
      <table class="bill-table open-bills">
        <tbody>
          ${list.map((b) => `
            <tr style="${clientStyle(b.client)}">
              <td><button class="link" data-bill-month="${b.month}">${monthLabel(b.month)}</button></td>
              <td><span class="client-chip">${esc(b.client)}</span>${b.pending ? `<span class="pending">未完了 ${b.pending}件</span>` : ''}</td>
              <td><span class="bill-state ${b.invoiced ? 'wait' : 'none'}">${b.invoiced ? '入金待ち' : '未請求'}</span></td>
              <td class="num total">${yen(b.total)}</td>
              <td class="status-col"><div class="status-pair">${statusButtons(b.month, b.client)}</div></td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

async function copyBilling() {
  const rows = billingRows(state.billMonth);
  const lines = [['クライアント', 'ショート本数', 'ショート金額', 'ロング本数', 'ロング金額', '請求額', '請求書発行日', '入金確認日'].join('\t')];
  for (const r of rows) {
    const inv = invoiceOf(state.billMonth, r.client);
    lines.push([r.client, r.short.count, r.short.amount, r.long.count, r.long.amount, r.total, inv.invoicedAt ?? '', inv.paidAt ?? ''].join('\t'));
  }
  try {
    await navigator.clipboard.writeText(lines.join('\n'));
    showToast(`${monthLabel(state.billMonth)}の請求表をコピーしました（Excelに貼り付けできます）`, null);
  } catch {
    showToast('コピーできませんでした', null);
  }
}

// ---------- カレンダー ----------

function renderCalendar() {
  $('cal-label').textContent = monthLabel(state.calMonth);
  $('cal-show-done').checked = state.showDoneOnCal;

  const first = parseDate(`${state.calMonth}-01`);
  const gridStart = addDays(fmtDate(first), -first.getDay()); // 日曜はじまり
  const last = parseDate(`${shiftMonth(state.calMonth, 1)}-01`);
  last.setDate(0);
  const weeks = Math.ceil((first.getDay() + last.getDate()) / 7);
  const today = todayStr();

  const items = state.projects
    .filter((p) => state.showDoneOnCal || p.status === 'active')
    .sort((a, b) => a.startDate.localeCompare(b.startDate) || a.dueDate.localeCompare(b.dueDate));

  let html = '<div class="cal-weekdays">' + ['日', '月', '火', '水', '木', '金', '土'].map((d) => `<div>${d}</div>`).join('') + '</div>';

  for (let w = 0; w < weeks; w++) {
    const ws = addDays(gridStart, w * 7);
    const we = addDays(ws, 6);
    const segs = items.filter((p) => p.startDate <= we && p.dueDate >= ws);

    // 重ならないように段を割り当てる
    const laneEnds = [];
    const placed = segs.map((p) => {
      const s = p.startDate < ws ? ws : p.startDate;
      const e = p.dueDate > we ? we : p.dueDate;
      let lane = laneEnds.findIndex((end) => end < s);
      if (lane < 0) { lane = laneEnds.length; laneEnds.push(e); } else laneEnds[lane] = e;
      return { p, lane, col: diffDays(ws, s) + 1, span: diffDays(s, e) + 1, contL: p.startDate < ws, contR: p.dueDate > we };
    });

    let cells = '';
    for (let i = 0; i < 7; i++) {
      const day = addDays(ws, i);
      const cls = [
        monthOf(day) !== state.calMonth ? 'other' : '',
        day === today ? 'today' : '',
        i === 0 ? 'sun' : i === 6 ? 'sat' : '',
      ].join(' ');
      cells += `<div class="cal-cell ${cls}" style="grid-column:${i + 1}"><span class="daynum">${parseDate(day).getDate()}</span></div>`;
    }

    const bars = placed.map(({ p, lane, col, span, contL, contR }) => {
      const overdue = p.status === 'active' && p.dueDate < today;
      const cls = ['cal-bar', p.status === 'done' ? 'done' : '', overdue ? 'overdue' : '', contL ? 'cont-l' : '', contR ? 'cont-r' : ''].join(' ');
      const tip = `${p.client} / ${p.title || '（案件名なし）'}\n${KIND_LABEL[p.kind]} ${yen(amountOf(p))}\n${shortDate(p.startDate)} 〜 ${shortDate(p.dueDate)}`;
      return `<button class="${cls}" data-edit="${p.id}" title="${esc(tip)}"
        style="grid-row:${lane + 2};grid-column:${col} / span ${span};${clientStyle(p.client)}">
        <span class="kind-mark ${p.kind}">${p.kind === 'short' ? 'S' : 'L'}</span>
        <span class="bar-text">${esc(p.client)}${p.title ? ` ${esc(p.title)}` : ''}</span>
        ${contR ? '' : '<span class="due-flag">納</span>'}
      </button>`;
    }).join('');

    html += `<div class="cal-week" style="grid-template-rows:26px repeat(${laneEnds.length}, 24px) minmax(10px, 1fr)">${cells}${bars}</div>`;
  }
  $('calendar').innerHTML = html;

  // スマホ幅では棒に文字が入らないので、この月にかかる案件を納期順に並べる
  const monthStart = `${state.calMonth}-01`;
  const monthEnd = fmtDate(last);
  const inMonth = items.filter((p) => p.startDate <= monthEnd && p.dueDate >= monthStart)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  $('cal-agenda').innerHTML = inMonth.length
    ? `<h3 class="section-title">${monthLabel(state.calMonth)}の案件（納期順）</h3>` + inMonth.map((p) => {
      const overdue = p.status === 'active' && p.dueDate < today;
      return `<button class="agenda-item ${p.status === 'done' ? 'done' : ''} ${overdue ? 'overdue' : ''}" data-edit="${p.id}" style="${clientStyle(p.client)}">
        <span class="agenda-due">${shortDate(p.dueDate)}<small>納期</small></span>
        <span class="kind-mark ${p.kind}">${p.kind === 'short' ? 'S' : 'L'}</span>
        <span class="agenda-main"><span class="client-chip">${esc(p.client)}</span> ${esc(p.title)}<small>${shortDate(p.startDate)} 着手</small></span>
      </button>`;
    }).join('')
    : '';
}

// ---------- 書き出し・読み込み ----------

function exportData() {
  const data = {
    app: 'anken-kanri', version: 3, exportedAt: nowIso(),
    projects: state.projects, invoices: [...state.invoices.values()],
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `案件管理_${todayStr().replaceAll('-', '')}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function importData(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    alert('JSONファイルとして読み込めませんでした');
    return;
  }
  const list = Array.isArray(data) ? data : data.projects;
  if (!Array.isArray(list)) { alert('案件データが見つかりませんでした'); return; }
  if (!confirm(`${list.length}件の案件で、今のデータ（${state.projects.length}件）を置き換えます。`)) return;
  // 同期先にも「置き換え」が伝わるよう、読み込んだものは今の日時で更新、無くなるものは削除として記録する
  const now = nowIso();
  const projects = list.map((p) => ({ ...p, updatedAt: now }));
  const keepIds = new Set(projects.map((p) => p.id));
  const deleted = new Map(state.deleted);
  for (const p of state.projects) if (!keepIds.has(p.id)) deleted.set(p.id, { id: p.id, deletedAt: now });
  for (const id of keepIds) deleted.delete(id);
  const invoices = new Map([...state.invoices.values()].map((r) => [r.key, { ...r, invoicedAt: null, paidAt: null, updatedAt: now }]));
  for (const r of Array.isArray(data.invoices) ? data.invoices : []) invoices.set(r.key, { ...r, updatedAt: now });
  resetForm();
  await applyData({ projects, invoices: [...invoices.values()], deleted: [...deleted.values()] });
  scheduleSync();
}

// ---------- 起動 ----------

function bindGlobal() {
  $('tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (b) setTab(b.dataset.tab);
  });
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-done],[data-undone],[data-edit],[data-inv],[data-bill-month],[data-client-filter]');
    if (!t) return;
    if (t.dataset.inv) toggleInvoice(t.dataset.month, t.dataset.client, t.dataset.inv);
    else if (t.dataset.billMonth) { state.billMonth = t.dataset.billMonth; renderBilling(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
    else if (t.dataset.clientFilter != null) { state.clientFilter = t.dataset.clientFilter; renderClients(); }
    else if (t.dataset.done) markDone(t.dataset.done);
    else if (t.dataset.undone) markUndone(t.dataset.undone);
    else if (t.dataset.edit) startEdit(t.dataset.edit);
  });
  document.querySelectorAll('[data-cal-shift]').forEach((b) => b.addEventListener('click', () => {
    state.calMonth = shiftMonth(state.calMonth, Number(b.dataset.calShift));
    renderCalendar();
  }));
  $('cal-today').addEventListener('click', () => { state.calMonth = monthOf(todayStr()); renderCalendar(); });
  $('cal-show-done').addEventListener('change', (e) => {
    state.showDoneOnCal = e.target.checked;
    prefSet('calShowDone', state.showDoneOnCal ? '1' : '0');
    renderCalendar();
  });
  document.querySelectorAll('[data-bill-shift]').forEach((b) => b.addEventListener('click', () => {
    state.billMonth = shiftMonth(state.billMonth, Number(b.dataset.billShift));
    renderBilling();
  }));
  $('bill-today').addEventListener('click', () => { state.billMonth = monthOf(todayStr()); renderBilling(); });
  $('btn-copy-billing').addEventListener('click', copyBilling);
  $('toast-undo').addEventListener('click', async () => {
    const undo = undoAction;
    hideToast();
    if (undo) await undo();
  });
  // メニュー（書き出し・読み込み・同期の解除）
  const closeMenu = () => { $('menu').hidden = true; };
  $('btn-menu').addEventListener('click', (e) => { e.stopPropagation(); $('menu').hidden = !$('menu').hidden; });
  document.addEventListener('click', (e) => { if (!e.target.closest('#menu')) closeMenu(); });
  $('btn-export').addEventListener('click', () => { closeMenu(); exportData(); });
  $('btn-import').addEventListener('click', () => { closeMenu(); $('import-file').click(); });
  $('import-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) await importData(file);
  });
  $('btn-sync').addEventListener('click', onSyncButton);
  $('btn-sync-stop').addEventListener('click', () => {
    closeMenu();
    if (confirm('この端末の同期をやめます（データはこの端末とGoogleドライブの両方に残ります）')) stopSync();
  });
}

const SYNC_LABEL = {
  off: '同期を設定',
  'needs-tap': 'タップして同期',
  syncing: '同期中…',
  error: '同期エラー',
};

function renderSyncStatus(status, detail) {
  const b = $('btn-sync');
  b.hidden = !Sync.available;
  b.dataset.status = status;
  const t = Sync.lastSyncAt;
  b.textContent = status === 'ok'
    ? (t ? `同期済み ${t.getHours()}:${String(t.getMinutes()).padStart(2, '0')}` : '同期済み')
    : SYNC_LABEL[status];
  b.title = detail || (status === 'off' ? 'Googleドライブを使って、PCとスマホのデータをそろえます' : '押すと今すぐ同期します');
  $('btn-sync-stop').hidden = status === 'off' || !Sync.available;
  if (status === 'error' && detail) showToast(`同期できませんでした：${detail}`, null);
}

async function init() {
  $('app-version').textContent = `v${APP_VERSION}`;
  state.showDoneOnCal = prefGet('calShowDone', '0') === '1';
  bindGlobal();
  bindForm();
  resetForm();
  state.projects = await loadAll();
  state.invoices = new Map((await loadInvoices()).map((r) => [r.key, r]));
  state.deleted = new Map((await loadDeleted()).map((d) => [d.id, d]));
  const tab = prefGet('tab', 'list');
  setTab(['list', 'clients', 'calendar', 'billing', 'done'].includes(tab) ? tab : 'list');
  initSync({ getLocal: localData, applyMerged: applyData, onStatus: renderSyncStatus });
  // ホーム画面に追加したとき、電波がなくても開けるようにする（https か localhost のときだけ）
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
