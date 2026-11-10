// util.js・db.js・config.js・sync.js を先に読み込んでおくこと（index.html をダブルクリックで開けるよう、モジュールにしていない）

// 配布時のバージョン。上げたら CHANGELOG.md も更新する
const APP_VERSION = '0.12.0';

const $ = (id) => document.getElementById(id);

const state = {
  projects: [],
  invoices: new Map(), // "YYYY-MM|クライアント" → { invoicedAt, paidAt }
  deleted: new Map(),  // 削除した案件 id → { id, deletedAt }
  settings: null,      // 請求書の設定 { myName, bank, note, addressees: { クライアント: 宛名 }, updatedAt }
  tab: 'list',
  clientFilter: '',    // クライアント別タブで絞り込むクライアント（空ならすべて）
  editorFilter: null,  // 案件タブで絞り込む編集者（null＝すべて、''＝自分で編集する案件）
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
  return {
    projects: state.projects, invoices: [...state.invoices.values()], deleted: [...state.deleted.values()],
    settings: state.settings,
  };
}

// 同期用：統合したデータで置き換える
async function applyData(data) {
  await replaceAll(data);
  state.projects = data.projects;
  state.invoices = new Map(data.invoices.map((r) => [r.key, r]));
  state.deleted = new Map(data.deleted.map((d) => [d.id, d]));
  if (data.settings !== undefined) saveSettingsLocal(data.settings);
  if (state.editingId && !byId(state.editingId)) { resetForm(); closeSheet(); }
  renderAll();
}

const byId = (id) => state.projects.find((p) => p.id === id);
const clientNames = () => [...new Set(state.projects.map((p) => p.client))].sort((a, b) => a.localeCompare(b, 'ja'));
const clientStyle = (name) => `--hue:${clientHue(name)}`;

// ---------- ディレクター機能（担当編集者・委託費・純利益） ----------

// 設定に入れて同期する（PC で入れたらスマホでも出る）
const isDirector = () => !!state.settings?.director;
const editorNames = () => [...new Set(state.projects.map((p) => p.editor).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ja'));
const SELF_LABEL = '自分';
const editorLabel = (name) => name || SELF_LABEL;

function toggleDirector() {
  updateSettings({ director: !isDirector() });
  renderAll();
  if (pageOpen('prices-view')) renderPriceList(); // 担当編集者・委託単価の列を出し入れする
  showToast(isDirector() ? 'ディレクター機能をオンにしました（案件に担当編集者と委託単価を入れられます）' : 'ディレクター機能をオフにしました', null);
}

function applyDirectorMode() {
  const on = isDirector();
  document.body.classList.toggle('director', on);
  $('btn-director').classList.toggle('on', on);
  $('btn-director').setAttribute('aria-checked', String(on));
  $('director-state').textContent = on ? 'オン' : 'オフ';
  // ヘッダーのボタン：ライト・ダークと同じく押すたびに切り替え、オンの間は色が付く
  const quick = $('btn-director-quick');
  quick.classList.toggle('on', on);
  quick.setAttribute('aria-pressed', String(on));
  quick.title = on ? 'ディレクター機能：オン（押すとオフ）' : 'ディレクター機能：オフ（押すとオン。担当編集者・委託費・純利益を表示）';
  quick.setAttribute('aria-label', quick.title);
}

function editorTag(p) {
  return isDirector() && p.editor ? `<span class="editor-tag" title="担当編集者">担当 ${esc(p.editor)}</span>` : '';
}

// ---------- タブ ----------

function setTab(tab) {
  state.tab = tab;
  prefSet('tab', tab);
  for (const b of $('tabs').querySelectorAll('button')) b.classList.toggle('active', b.dataset.tab === tab);
  for (const v of document.querySelectorAll('.view')) v.classList.toggle('active', v.id === `view-${tab}`);
  renderAll();
}

function renderAll() {
  applyDirectorMode();
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
  feeTouched: false,     // 委託単価を手で変えたら自動入力しない
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

// クライアントの単価の設定（なければ undefined）
const clientPrice = (client) => state.settings?.clientPrices?.[client];
const FEE_KEY = { short: 'feeShort', long: 'feeLong' };

// 単価は「クライアントの単価」→「前回の単価」の順に入れる
function autoFillPrice() {
  if (form.priceTouched && $('f-price').value !== '') return;
  const client = $('f-client').value.trim();
  const set = clientPrice(client)?.[form.kind];
  const price = set ?? lastPrice(client, form.kind);
  if (price != null) $('f-price').value = price;
  $('f-price-src').textContent = set != null ? 'クライアントの単価' : price != null ? '前回の単価' : '';
  updateAmount();
}

// 同じ編集者・種別で最後に登録した委託単価
function lastFee(editor, kind) {
  if (!editor) return undefined;
  const hits = state.projects
    .filter((p) => p.editor === editor && p.kind === kind && p.feeUnit != null)
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  return hits[0]?.feeUnit;
}

// 委託単価は、クライアントの単価で決めた担当編集者のときはその委託単価、それ以外は前回の委託単価
function autoFillFee() {
  if (form.feeTouched && $('f-fee').value !== '') return;
  const editor = $('f-editor').value.trim();
  const cp = clientPrice($('f-client').value.trim());
  const set = cp && editor && cp.editor === editor ? cp[FEE_KEY[form.kind]] : null;
  $('f-fee').value = set ?? lastFee(editor, form.kind) ?? '';
  updateAmount();
}

// クライアントを選んだとき：決めてある担当編集者を入れてから、単価・委託単価を入れる
function onClientChosen() {
  if (state.editingId) return;
  const cp = clientPrice($('f-client').value.trim());
  if (cp?.editor) $('f-editor').value = cp.editor;
  form.priceTouched = false;
  autoFillPrice();
  form.feeTouched = false;
  autoFillFee();
}

function updateAmount() {
  const price = Number($('f-price').value) || 0;
  const count = Number($('f-count').value) || 0;
  const fee = (Number($('f-fee').value) || 0) * count;
  $('f-amount').textContent = yen(price * count);
  $('f-fee-amount').textContent = yen(fee);
  $('f-profit').textContent = yen(price * count - fee);
  $('f-profit').classList.toggle('minus', price * count - fee < 0);
}

function resetForm({ keepClient = false } = {}) {
  // 続けて追加するときは、クライアント・種別・単価・担当編集者・委託単価をそのまま残す
  const keep = keepClient ? {
    client: $('f-client').value, kind: form.kind, price: $('f-price').value, editor: $('f-editor').value, fee: $('f-fee').value,
  } : null;
  state.editingId = null;
  $('project-form').reset();
  $('form-title').textContent = '案件を追加';
  $('btn-submit').textContent = '追加';
  $('btn-delete').hidden = true;
  $('form-error').textContent = '';
  $('project-form').classList.remove('editing');
  form.priceTouched = false;
  form.billingTouched = false;
  form.feeTouched = false;
  $('f-price-src').textContent = '';
  $('f-count').value = 1;
  $('f-start').value = todayStr();
  $('f-billing').value = monthOf(todayStr());
  if (keep) {
    $('f-client').value = keep.client;
    setKind(keep.kind);
    $('f-price').value = keep.price;
    $('f-editor').value = keep.editor;
    $('f-fee').value = keep.fee;
  } else {
    setKind('short');
  }
  updateAmount();
}

function startEdit(id) {
  const p = byId(id);
  if (!p) return;
  state.editingId = id;
  $('form-title').textContent = p.status === 'done' ? '案件を編集（完了済み）' : '案件を編集';
  $('btn-submit').textContent = '更新';
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
  $('f-editor').value = p.editor ?? '';
  $('f-fee').value = p.feeUnit ?? '';
  form.priceTouched = true;
  form.feeTouched = true;
  form.billingTouched = p.billingMonth !== monthOf(p.dueDate);
  updateAmount();
  // 編集はいまのタブの上に入力画面を開く（閉じたら元のタブに戻る）
  openSheet();
}

const isNarrow = () => matchMedia('(max-width: 860px)').matches;

// 案件の追加・編集は、一覧とは別の画面（全面）で入力する
function openSheet() {
  document.body.classList.add('sheet-open');
  $('btn-add-more').hidden = !!state.editingId;
  $('project-form').scrollTop = 0;
  // PC ではすぐ打ち始められるようにする（スマホはキーボードが勝手に出ないように何もしない）
  if (!isNarrow()) (state.editingId || $('f-client').value ? $('f-title') : $('f-client')).focus();
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
  // ディレクター機能がオフの間は、担当編集者・委託単価に触らない（入っている値はそのまま残す）
  if (isDirector()) {
    v.editor = $('f-editor').value.trim();
    v.feeUnit = $('f-fee').value === '' ? null : Number($('f-fee').value);
    if (v.feeUnit != null && !(v.feeUnit >= 0)) return { error: '委託単価は0以上で入れてください' };
  }
  return { value: v };
}

// 「追加」は一覧に戻る。「続けて追加」は入力画面のまま、クライアントなどを残して次の案件を入れる
async function onSubmit(e, { more = false } = {}) {
  e.preventDefault();
  const { value, error } = readForm();
  if (error) { $('form-error').textContent = error; return; }
  if (state.editingId) {
    await upsert({ ...byId(state.editingId), ...value });
    resetForm();
    closeSheet();
    showToast(`「${value.title || value.client}」を更新しました`, null);
  } else {
    await upsert({ id: newId(), ...value, status: 'active', completedAt: null, createdAt: nowIso() });
    resetForm({ keepClient: true });
    showToast(`「${value.title || value.client}」を追加しました`, null);
    if (more) { $('project-form').scrollTop = 0; $('f-title').focus(); }
    else closeSheet();
  }
}

function openNewForm() {
  if (state.editingId) resetForm();
  openSheet();
}

function cancelForm() {
  if (state.editingId) resetForm();
  closeSheet();
  renderActiveList();
}

function bindForm() {
  $('project-form').addEventListener('submit', onSubmit);
  $('f-kind').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-kind]');
    if (!b) return;
    setKind(b.dataset.kind);
    if (!state.editingId) { form.priceTouched = false; autoFillPrice(); form.feeTouched = false; autoFillFee(); }
  });
  $('f-editor').addEventListener('change', () => { if (!state.editingId || $('f-fee').value === '') { form.feeTouched = false; autoFillFee(); } });
  $('f-fee').addEventListener('input', () => { form.feeTouched = true; updateAmount(); });
  $('f-client').addEventListener('change', onClientChosen);
  $('f-price').addEventListener('input', () => { form.priceTouched = true; $('f-price-src').textContent = ''; updateAmount(); });
  $('f-open-prices').addEventListener('click', () => openPrices($('f-client').value.trim()));
  $('f-count').addEventListener('input', updateAmount);
  $('f-due').addEventListener('change', () => {
    if (!form.billingTouched && $('f-due').value) $('f-billing').value = monthOf($('f-due').value);
  });
  $('f-billing').addEventListener('input', () => { form.billingTouched = true; });
  $('btn-sheet-close').addEventListener('click', cancelForm);
  $('btn-add-more').addEventListener('click', (e) => onSubmit(e, { more: true }));
  // 納期をワンタップで（着手日から数える。月末は着手日の月の末日）
  $('f-due-quick').addEventListener('click', (e) => {
    const b = e.target.closest('[data-due]');
    if (!b) return;
    const base = $('f-start').value || todayStr();
    const k = b.dataset.due;
    let due;
    if (k === 'fri') { const d = parseDate(base).getDay(); due = addDays(base, ((5 - d + 7) % 7) || 7); }
    else if (k === 'eom') { const d = parseDate(`${shiftMonth(monthOf(base), 1)}-01`); d.setDate(0); due = fmtDate(d); }
    else due = addDays(base, Number(k));
    $('f-due').value = due;
    $('f-due').dispatchEvent(new Event('change'));
  });
  $('btn-add-project').addEventListener('click', openNewForm);
  // Esc でも閉じる（単価の設定などのダイアログが開いているときはそちらが先に閉じる）
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || document.querySelector('dialog[open]')) return;
    if (pageOpen('prices-view')) closePrices();
    else if (settingsOpen()) closeSettings();
    else if (document.body.classList.contains('sheet-open')) cancelForm();
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
  $('editor-options').innerHTML = editorNames().map((n) => `<option value="${esc(n)}">`).join('');
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
  const stageBtn = (stage, label, tip) =>
    `<button class="stage-btn ${stage} ${p.stage === stage ? 'on' : ''}" data-stage="${stage}" data-id="${p.id}"
      title="${p.stage === stage ? 'もう一度押すと一つ前に戻す' : tip}">${label}</button>`;
  const actions = mode === 'active'
    ? `<div class="stage-btns">
        ${stageBtn('draft', '初稿', '初稿を出した')}
        ${stageBtn('revision', '修正', '修正の依頼が来た')}
        <button class="btn-done" data-done="${p.id}" title="完了済みに移す">完了</button>
      </div>`
    : `<button class="ghost small" data-undone="${p.id}" title="進行中に戻す">戻す</button>`;
  return `
    <div class="project-row ${state.editingId === p.id ? 'is-editing' : ''}" style="${clientStyle(p.client)}">
      ${left}
      <div class="main">
        <div class="tags">
          <span class="client-chip">${esc(p.client)}</span>
          <span class="kind-tag ${p.kind}">${KIND_LABEL[p.kind]}</span>
          ${mode === 'active' ? stageTag(p) : ''}
          ${editorTag(p)}
          ${p.invoicedAt ? `<span class="issued-tag" title="案件別の請求書を発行済み">請求書発行 ${shortDate(p.invoicedAt)}</span>` : ''}
        </div>
        <div class="title">${esc(p.title) || '<span class="muted">（案件名なし）</span>'}</div>
        <div class="sub">${shortDate(p.startDate)} 〜 ${shortDate(p.dueDate)} ・ 請求 ${monthLabel(p.billingMonth)}${p.memo ? ` ・ ${esc(p.memo)}` : ''}</div>
      </div>
      <div class="money">
        <small>${yen(p.unitPrice)} × ${p.count}本</small>
        <b>${yen(amountOf(p))}</b>
        ${isDirector() && (p.editor || p.feeUnit != null)
    ? `<small class="fee-line" title="委託費（${yen(p.feeUnit ?? 0)} × ${p.count}本）と利益">委託 ${yen(feeOf(p))}・利益 <span class="${amountOf(p) - feeOf(p) < 0 ? 'minus' : ''}">${yen(amountOf(p) - feeOf(p))}</span></small>`
    : ''}
      </div>
      <div class="actions">
        ${actions}
        <div class="row-sub-btns">
          ${projectSnapshot(p)
    ? `<button class="ghost small view-invoice" data-project-invoice="${p.id}" title="発行した請求書を見る">請求書を見る</button>`
    : `<button class="ghost small" data-project-invoice="${p.id}" title="この案件だけの請求書を作る（単発の案件用）">請求書</button>`}
          <button class="ghost small" data-edit="${p.id}">編集</button>
        </div>
      </div>
    </div>`;
}

// 進行中の案件を担当している編集者ごとに絞り込むボタン（ディレクター機能がオンで、担当編集者が入っている案件があるときだけ）
function renderEditorFilter(active) {
  const names = [...new Set(active.map((p) => p.editor).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ja'));
  const hasSelf = active.some((p) => !p.editor);
  if (!isDirector() || !names.length) {
    state.editorFilter = null;
    $('editor-filter').innerHTML = '';
    return;
  }
  if (state.editorFilter != null && !(names.includes(state.editorFilter) || (state.editorFilter === '' && hasSelf))) state.editorFilter = null;
  const count = (v) => active.filter((p) => v == null || (p.editor ?? '') === v).length;
  const chips = [[null, 'すべて'], ...names.map((n) => [n, n]), ...(hasSelf ? [['', SELF_LABEL]] : [])];
  $('editor-filter').innerHTML = '<span class="filter-label">担当</span>' + chips.map(([v, label]) =>
    `<button class="filter-chip ${state.editorFilter === v ? 'active' : ''}" data-editor-filter="${v == null ? '*' : esc(v)}">${esc(label)} <small>${count(v)}</small></button>`).join('');
}

function renderActiveList() {
  const allActive = state.projects.filter((p) => p.status === 'active');
  renderEditorFilter(allActive);
  const active = allActive
    .filter((p) => state.editorFilter == null || (p.editor ?? '') === state.editorFilter)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.startDate.localeCompare(b.startDate));
  const overdue = active.filter((p) => p.dueDate < todayStr()).length;
  const byStage = (s) => active.filter((p) => (p.stage ?? null) === s).length;
  const parts = [
    `作業中 ${byStage(null)}`,
    byStage('draft') ? `初稿提出 ${byStage('draft')}` : '',
    byStage('revision') ? `修正中 ${byStage('revision')}` : '',
    overdue ? `納期切れ ${overdue}` : '',
  ].filter(Boolean);
  $('active-summary').textContent = active.length ? `${active.length}件（${parts.join('・')}）` : '';
  $('active-list').innerHTML = active.length
    ? active.map((p) => projectRow(p, { mode: 'active' })).join('')
    : allActive.length ? `<p class="empty">${esc(editorLabel(state.editorFilter))}が担当している進行中の案件はありません。</p>`
    : `<p class="empty">進行中の案件はありません。${isNarrow() ? '右下の「＋」' : '上の「＋ 案件を追加」'}から追加してください。</p>`;
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

// ---------- 進み具合（初稿・修正） ----------

const STAGE_LABEL = { draft: '初稿提出', revision: '修正中' };

function stageTag(p) {
  if (!p.stage) return '';
  const at = p[`${p.stage}At`];
  return `<span class="stage-tag ${p.stage}">${STAGE_LABEL[p.stage]}${at ? ` ${shortDate(at)}` : ''}</span>`;
}

// 押した日を記録して進み具合を変える。同じボタンをもう一度押したら一つ前に戻す（修正中→初稿提出→作業中）
async function toggleStage(id, stage) {
  const p = byId(id);
  if (!p) return;
  if (p.stage === stage) await upsert({ ...p, stage: stage === 'revision' && p.draftAt ? 'draft' : null });
  else await upsert({ ...p, stage, [`${stage}At`]: todayStr() });
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
            ${isDirector() && started.concat(upcoming).some((p) => p.editor)
    ? `<span>担当 <b>${[...new Set(started.concat(upcoming).map((p) => editorLabel(p.editor ?? '')))].map(esc).join('・')}</b></span>` : ''}
            ${unbilled ? `<span class="bill-state none">未請求 ${yen(unbilled)}</span>` : ''}
            ${waiting ? `<span class="bill-state wait">入金待ち ${yen(waiting)}</span>` : ''}
          </div>
          ${priceButton(client)}
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

// クライアント別の見出しに出す単価（押すと単価の設定を開く）
function priceButton(client) {
  const cp = clientPrice(client) ?? {};
  const parts = [cp.short != null ? `ショート ${yen(cp.short)}` : '', cp.long != null ? `ロング ${yen(cp.long)}` : ''].filter(Boolean);
  return `<button class="ghost small price-btn" data-open-prices="${esc(client)}" title="このクライアントの単価を決める（案件を追加するときに自動で入る）">
    ${parts.length ? `単価 ${parts.join('・')}` : '単価を設定'}</button>`;
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

// その月のそのクライアントの案件に、全部「案件別の請求書」を出し終えているか
function issuedByProjects(month, client) {
  const ps = state.projects.filter((p) => p.billingMonth === month && p.client === client);
  return ps.length > 0 && ps.every((p) => p.invoicedAt);
}

function statusButtons(month, client) {
  const r = invoiceOf(month, client);
  const btn = (field, onLabel, offLabel) => {
    const on = !!r[field];
    return `<button class="status-btn ${field} ${on ? 'on' : ''}" data-inv="${field}" data-month="${month}" data-client="${esc(client)}"
      title="${on ? 'クリックで未に戻す' : 'クリックで済にする'}">${on ? `${onLabel} <small>${shortDate(r[field])}</small>` : offLabel}</button>`;
  };
  // 案件別の請求書を全部出し終えた月は、まとめての請求書がなくても「発行済（案件別）」と出す（押せない）
  let issued = btn('invoicedAt', '発行済', '請求書 未発行');
  if (!r.invoicedAt && issuedByProjects(month, client)) {
    const last = state.projects.filter((p) => p.billingMonth === month && p.client === client)
      .map((p) => p.invoicedAt).sort().at(-1);
    issued = `<button class="status-btn invoicedAt on" disabled title="案件ごとに請求書を発行済み">発行済（案件別） <small>${shortDate(last)}</small></button>`;
  }
  return `<button class="status-btn make-invoice" data-make-invoice="1" data-month="${month}" data-client="${esc(client)}"
      title="${monthSnapshot(month, client) ? '発行した請求書を見る' : 'この月のこのクライアントの案件をまとめた請求書を作る（月末請求用）'}">${monthSnapshot(month, client) ? '請求書を見る' : '請求書を作成'}</button>`
    + issued + btn('paidAt', '入金済', '振込 未確認');
}

// 今月までで入金が済んでいない請求（クライアント × 請求月）
function openBills() {
  const cur = monthOf(todayStr());
  const months = [...new Set(state.projects.map((p) => p.billingMonth))].filter((m) => m <= cur).sort();
  const list = [];
  for (const m of months) {
    for (const r of billingRows(m)) {
      const inv = invoiceOf(m, r.client);
      const invoiced = !!inv.invoicedAt || issuedByProjects(m, r.client);
      if (!inv.paidAt) list.push({ month: m, client: r.client, total: r.total, pending: r.pending, invoiced });
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
        fee: 0,
        pending: 0,
        items: [],
      });
    }
    const r = rows.get(p.client);
    r[p.kind].count += p.count;
    r[p.kind].amount += amountOf(p);
    r.total += amountOf(p);
    r.fee += feeOf(p);
    if (p.status !== 'done') r.pending += 1;
    r.items.push(p);
  }
  return [...rows.values()].sort((a, b) => b.total - a.total);
}

// 請求月の案件を担当編集者ごとにまとめる（委託費の多い順、自分で編集した分は最後）
function editorRows(ym) {
  const rows = new Map();
  for (const p of state.projects) {
    if (p.billingMonth !== ym) continue;
    const name = p.editor ?? '';
    if (!rows.has(name)) rows.set(name, { editor: name, count: 0, projects: 0, sales: 0, fee: 0, noFee: 0, clients: new Set() });
    const r = rows.get(name);
    r.count += p.count;
    r.projects += 1;
    r.sales += amountOf(p);
    r.fee += feeOf(p);
    if (name && p.feeUnit == null) r.noFee += 1;
    r.clients.add(p.client);
  }
  return [...rows.values()].sort((a, b) => (a.editor === '') - (b.editor === '') || b.fee - a.fee || a.editor.localeCompare(b.editor, 'ja'));
}

const profitCell = (n) => `<span class="${n < 0 ? 'minus' : ''}">${yen(n)}</span>`;
const rateOf = (profit, sales) => (sales ? `${Math.round((profit / sales) * 100)}%` : '—');

function editorTableHtml(ym) {
  const rows = editorRows(ym);
  if (!rows.some((r) => r.editor)) {
    return `<h3 class="section-title">編集者別（委託費・純利益）</h3>
      <p class="empty">${monthLabel(ym)}の案件に担当編集者が入っていません。案件の「編集」で担当編集者と委託単価を入れると、ここに編集者ごとの委託費と純利益が出ます。</p>`;
  }
  const sum = rows.reduce((s, r) => ({ count: s.count + r.count, sales: s.sales + r.sales, fee: s.fee + r.fee }), { count: 0, sales: 0, fee: 0 });
  return `
    <h3 class="section-title">編集者別（委託費・純利益）</h3>
    <div class="card table-card">
      <table class="bill-table editor-table">
        <thead><tr><th>編集者</th><th>本数</th><th>売上</th><th>委託費</th><th>純利益</th><th>利益率</th></tr></thead>
        <tbody>
          ${rows.map((r) => `
            <tr>
              <td class="name-col">
                <span class="editor-name ${r.editor ? '' : 'self'}">${esc(editorLabel(r.editor))}</span>
                <span class="muted small-note">${[...r.clients].map(esc).join('・')}</span>
                ${r.noFee ? `<span class="pending" title="委託単価が入っていない案件は委託費 0 円で計算しています">委託単価なし ${r.noFee}件</span>` : ''}
              </td>
              <td class="num" data-label="本数"><span class="cnt">${r.projects}件</span>${r.count}本</td>
              <td class="num" data-label="売上">${yen(r.sales)}</td>
              <td class="num" data-label="委託費">${r.editor ? yen(r.fee) : '<span class="muted">—</span>'}</td>
              <td class="num total" data-label="純利益">${profitCell(r.sales - r.fee)}</td>
              <td class="num" data-label="利益率">${rateOf(r.sales - r.fee, r.sales)}</td>
            </tr>`).join('')}
        </tbody>
        <tfoot><tr>
          <td class="name-col">合計</td>
          <td class="num" data-label="本数">${sum.count}本</td>
          <td class="num" data-label="売上">${yen(sum.sales)}</td>
          <td class="num" data-label="委託費">${yen(sum.fee)}</td>
          <td class="num total" data-label="純利益">${profitCell(sum.sales - sum.fee)}</td>
          <td class="num" data-label="利益率">${rateOf(sum.sales - sum.fee, sum.sales)}</td>
        </tr></tfoot>
      </table>
    </div>`;
}

function cell(x) {
  return x.count ? `<span class="cnt">${x.count}本</span>${yen(x.amount)}` : '<span class="muted">—</span>';
}

function renderBilling() {
  $('bill-label').textContent = monthLabel(state.billMonth);
  const rows = billingRows(state.billMonth);
  if (!rows.length) {
    $('billing').innerHTML = `<p class="empty">${monthLabel(state.billMonth)}が請求月の案件はありません。</p>` + openBillsHtml() + issuedListHtml();
    return;
  }
  const sum = rows.reduce((s, r) => ({
    short: { count: s.short.count + r.short.count, amount: s.short.amount + r.short.amount },
    long: { count: s.long.count + r.long.count, amount: s.long.amount + r.long.amount },
    total: s.total + r.total,
    fee: s.fee + r.fee,
  }), { short: { count: 0, amount: 0 }, long: { count: 0, amount: 0 }, total: 0, fee: 0 });

  // ディレクター機能がオンのときは、クライアントごとの委託費と純利益の列を足す
  const dir = isDirector();
  const dirCells = (r) => dir
    ? `<td class="num" data-label="委託費">${r.fee ? yen(r.fee) : '<span class="muted">—</span>'}</td>
       <td class="num profit" data-label="純利益">${profitCell(r.total - r.fee)}</td>`
    : '';

  $('billing').innerHTML = `
    <div class="card table-card">
      <table class="bill-table ${dir ? 'with-profit' : ''}">
        <thead><tr><th>クライアント</th><th>ショート</th><th>ロング</th><th>請求額</th>${dir ? '<th>委託費</th><th>純利益</th>' : ''}<th class="status-col">請求書・振込</th></tr></thead>
        <tbody>
          ${rows.map((r) => `
            <tr style="${clientStyle(r.client)}">
              <td class="name-col"><span class="client-chip">${esc(r.client)}</span>${r.pending ? `<span class="pending">未完了 ${r.pending}件</span>` : ''}</td>
              <td class="num" data-label="ショート">${cell(r.short)}</td>
              <td class="num" data-label="ロング">${cell(r.long)}</td>
              <td class="num total" data-label="請求額">${yen(r.total)}</td>
              ${dirCells(r)}
              <td class="status-col"><div class="status-pair">${statusButtons(state.billMonth, r.client)}</div></td>
            </tr>`).join('')}
        </tbody>
        <tfoot><tr>
          <td class="name-col">合計</td>
          <td class="num" data-label="ショート">${cell(sum.short)}</td>
          <td class="num" data-label="ロング">${cell(sum.long)}</td>
          <td class="num total" data-label="請求額">${yen(sum.total)}</td>
          ${dirCells(sum)}
          <td class="status-col muted">${paidSummary(state.billMonth, rows)}</td>
        </tr></tfoot>
      </table>
    </div>
    ${dir ? editorTableHtml(state.billMonth) : ''}
    <h3 class="section-title">内訳</h3>
    ${rows.map((r) => `
      <details class="card bill-detail" style="${clientStyle(r.client)}">
        <summary><span class="client-chip">${esc(r.client)}</span><span>${r.items.length}件</span><b>${yen(r.total)}</b></summary>
        <ul>
          ${r.items.sort((a, b) => a.dueDate.localeCompare(b.dueDate)).map((p) => `
            <li>
              <span class="kind-tag ${p.kind}">${KIND_LABEL[p.kind]}</span>
              <span class="grow">${esc(p.title) || '<span class="muted">（案件名なし）</span>'}</span>
              ${editorTag(p)}
              <span class="muted">${p.status === 'done' ? '完了' : `納期 ${shortDate(p.dueDate)}`}</span>
              <span class="num">${yen(p.unitPrice)} × ${p.count} = <b>${yen(amountOf(p))}</b></span>
              ${dir && feeOf(p) ? `<span class="num fee-line">委託 ${yen(feeOf(p))}</span>` : ''}
            </li>`).join('')}
        </ul>
      </details>`).join('')}
    ${openBillsHtml()}
    ${issuedListHtml()}`;
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
  const dir = isDirector();
  const lines = [['クライアント', 'ショート本数', 'ショート金額', 'ロング本数', 'ロング金額', '請求額', ...(dir ? ['委託費', '純利益'] : []), '請求書発行日', '入金確認日'].join('\t')];
  for (const r of rows) {
    const inv = invoiceOf(state.billMonth, r.client);
    lines.push([r.client, r.short.count, r.short.amount, r.long.count, r.long.amount, r.total, ...(dir ? [r.fee, r.total - r.fee] : []), inv.invoicedAt ?? '', inv.paidAt ?? ''].join('\t'));
  }
  // ディレクター機能がオンのときは、下に編集者別の表も付ける
  if (dir && editorRows(state.billMonth).some((r) => r.editor)) {
    lines.push('', ['編集者', '本数', '売上', '委託費', '純利益'].join('\t'));
    for (const r of editorRows(state.billMonth)) lines.push([editorLabel(r.editor), r.count, r.sales, r.fee, r.sales - r.fee].join('\t'));
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
      const tip = `${p.client} / ${p.title || '（案件名なし）'}\n${KIND_LABEL[p.kind]} ${yen(amountOf(p))}\n${shortDate(p.startDate)} 〜 ${shortDate(p.dueDate)}`
        + (isDirector() && p.editor ? `\n担当 ${p.editor}` : '');
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
        <span class="agenda-main"><span class="client-chip">${esc(p.client)}</span> ${esc(p.title)}<small>${shortDate(p.startDate)} 着手</small>${p.status === 'active' ? stageTag(p) : ''}${editorTag(p)}</span>
      </button>`;
    }).join('')
    : '';
}

// ---------- クライアントの単価 ----------
// settings.clientPrices = { クライアント: { short, long, editor, feeShort, feeLong } }（数値は空なら null）

function setClientPrice(client, patch) {
  const all = { ...(state.settings?.clientPrices ?? {}) };
  if (patch === null) delete all[client];
  else all[client] = { ...(all[client] ?? {}), ...patch };
  updateSettings({ clientPrices: all });
}

// 一覧に出すクライアント：単価を決めてあるもの＋案件のあるもの（名前順）
function priceClientNames() {
  return [...new Set([...Object.keys(state.settings?.clientPrices ?? {}), ...clientNames()])].sort((a, b) => a.localeCompare(b, 'ja'));
}

// 単価のページ：1 クライアント 1 行（PC は表、スマホはカード）
function renderPriceList() {
  const names = priceClientNames();
  const dir = isDirector();
  const yenInput = (cp, key, label, ph) => `
    <label class="pr-cell"><span class="pr-label">${label}</span>
      <span class="yen-input"><input type="number" min="0" step="100" inputmode="numeric" data-price-key="${key}" value="${cp[key] ?? ''}" placeholder="${ph ?? ''}"></span>
    </label>`;
  const head = `
    <div class="price-row price-head ${dir ? 'with-dir' : ''}">
      <span>クライアント</span><span>ショート単価</span><span>ロング単価</span>
      ${dir ? '<span>担当編集者</span><span>委託（ショート）</span><span>委託（ロング）</span>' : ''}<span></span>
    </div>`;
  $('price-list').innerHTML = names.length ? head + names.map((name) => {
    const cp = clientPrice(name) ?? {};
    const lastS = lastPrice(name, 'short');
    const lastL = lastPrice(name, 'long');
    const count = state.projects.filter((p) => p.client === name).length;
    const hasAny = ['short', 'long', 'editor', 'feeShort', 'feeLong'].some((k) => cp[k] != null && cp[k] !== '');
    return `
      <div class="price-row ${dir ? 'with-dir' : ''}" data-price-client="${esc(name)}" style="${clientStyle(name)}">
        <div class="pr-name"><span class="client-chip">${esc(name)}</span><small class="muted">${count ? `案件 ${count}件` : '案件なし'}</small></div>
        ${yenInput(cp, 'short', 'ショート単価', lastS != null ? `前回 ${lastS}` : '未設定')}
        ${yenInput(cp, 'long', 'ロング単価', lastL != null ? `前回 ${lastL}` : '未設定')}
        ${dir ? `
        <label class="pr-cell"><span class="pr-label">担当編集者</span>
          <input data-price-key="editor" list="editor-options" value="${esc(cp.editor ?? '')}" placeholder="決めない">
        </label>
        ${yenInput(cp, 'feeShort', '委託（ショート）')}
        ${yenInput(cp, 'feeLong', '委託（ロング）')}` : ''}
        <button type="button" class="ghost icon-btn pr-clear" data-price-clear ${hasAny ? '' : 'disabled'}
          title="このクライアントの単価の設定を消す（案件は消えません）" aria-label="${esc(name)}の単価の設定を消す">✕</button>
      </div>`;
  }).join('') : '<p class="empty">まだクライアントがありません。下の欄から追加してください。</p>';
}

// ---------- 全面のページ（設定・クライアントの単価） ----------
// 重ねて開ける（入力画面 → 単価、設定 → 単価 など）。閉じると下のページに戻る

const pageOpen = (id) => $(id).classList.contains('open');

function openPage(id) {
  if (pageOpen(id)) return;
  $(id).classList.add('open');
  $(id).scrollTop = 0;
  document.body.classList.add('page-open');
}

function closePage(id) {
  $(id).classList.remove('open');
  if (!document.querySelector('.page-view.open')) document.body.classList.remove('page-open');
}

// クライアントの単価のページを開く。focus を渡すと、そのクライアントの行に入れられる状態にする（まだ無ければ一覧に足す）
function openPrices(focus) {
  if (focus && !priceClientNames().includes(focus)) setClientPrice(focus, {});
  renderPriceList();
  openPage('prices-view');
  const row = focus && [...$('price-list').querySelectorAll('[data-price-client]')].find((c) => c.dataset.priceClient === focus);
  if (row) {
    row.scrollIntoView({ block: 'center' });
    row.classList.add('flash');
    row.querySelector('input')?.focus();
  }
}

function closePrices() {
  closePage('prices-view');
  renderAll();
  if (pageOpen('settings-view')) renderSettingsSummary();
  // 案件の入力中（追加のとき）に開いていたら、決め直した単価を入れ直す
  if (document.body.classList.contains('sheet-open') && !state.editingId && $('f-client').value.trim()) onClientChosen();
}

function bindPrices() {
  $('prices-close').addEventListener('click', closePrices);
  $('btn-open-prices').addEventListener('click', () => openPrices());
  // 入れたらその場で保存（保存したことは下のお知らせで出す）
  $('price-list').addEventListener('change', (e) => {
    const input = e.target.closest('[data-price-key]');
    if (!input) return;
    const client = input.closest('[data-price-client]').dataset.priceClient;
    const key = input.dataset.priceKey;
    const raw = input.value.trim();
    const value = key === 'editor' ? raw : (raw === '' || !(Number(raw) >= 0) ? null : Number(raw));
    setClientPrice(client, { [key]: value });
    if (key !== 'editor' && raw !== '' && value === null) input.value = '';
    input.closest('[data-price-client]').querySelector('[data-price-clear]').disabled = false;
    showToast(`「${client}」の単価を保存しました`, null);
  });
  $('price-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-price-clear]');
    if (!b) return;
    const client = b.closest('[data-price-client]').dataset.priceClient;
    if (!confirm(`「${client}」の単価の設定を消します（案件はそのまま残ります）`)) return;
    setClientPrice(client, null);
    renderPriceList();
  });
  $('price-add-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('price-add-name').value.trim();
    if (!name) return;
    $('price-add-name').value = '';
    openPrices(name);
  });
}

// ---------- 設定画面（ヘッダーの歯車から開く。入れたらその場で保存） ----------

const settingsOpen = () => pageOpen('settings-view');

function renderSettingsSummary() {
  const n = Object.values(state.settings?.clientPrices ?? {}).filter((cp) => cp.short != null || cp.long != null).length;
  $('set-prices-text').textContent = n
    ? `${n}件のクライアントで決めてあります。クライアントを選ぶだけで単価が入ります`
    : '決めておくと、クライアントを選ぶだけで単価が入ります';
}

function openSettings() {
  $('set-version').textContent = `v${APP_VERSION}`;
  renderSettingsSummary();
  openPage('settings-view');
}

function closeSettings() {
  closePage('settings-view');
  renderAll();
}

// ---------- 書き出し・読み込み ----------

function exportData() {
  const data = {
    app: 'anken-kanri', version: 3, exportedAt: nowIso(),
    projects: state.projects, invoices: [...state.invoices.values()], settings: state.settings,
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
  const settings = data.settings ? { ...data.settings, updatedAt: now } : state.settings;
  await applyData({ projects, invoices: [...invoices.values()], deleted: [...deleted.values()], settings });
  scheduleSync();
}

// ---------- 起動 ----------

function bindGlobal() {
  $('tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (b) setTab(b.dataset.tab);
  });
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-make-invoice],[data-project-invoice],[data-stage],[data-done],[data-undone],[data-edit],[data-inv],[data-bill-month],[data-client-filter],[data-editor-filter],[data-open-prices]');
    if (!t) return;
    if (t.dataset.openPrices != null) { openPrices(t.dataset.openPrices); return; }
    if (t.dataset.editorFilter != null) {
      state.editorFilter = t.dataset.editorFilter === '*' ? null : t.dataset.editorFilter;
      renderActiveList();
      return;
    }
    if (t.dataset.makeInvoice) openInvoice(t.dataset.month, t.dataset.client);
    else if (t.dataset.projectInvoice) openProjectInvoice(t.dataset.projectInvoice);
    else if (t.dataset.stage) toggleStage(t.dataset.id, t.dataset.stage);
    else if (t.dataset.inv) toggleInvoice(t.dataset.month, t.dataset.client, t.dataset.inv);
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
  // 設定画面
  $('btn-settings').addEventListener('click', () => openSettings());
  $('settings-close').addEventListener('click', closeSettings);
  $('btn-director').addEventListener('click', toggleDirector);
  $('btn-director-quick').addEventListener('click', toggleDirector);
  $('btn-export').addEventListener('click', exportData);
  $('btn-import').addEventListener('click', () => $('import-file').click());
  $('import-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) await importData(file);
  });
  $('btn-sync').addEventListener('click', onSyncButton);
  $('btn-data-info').addEventListener('click', () => $('data-info').showModal());
  $('data-info-close').addEventListener('click', () => $('data-info').close());
  // 外側（暗くなった所）を押しても閉じる
  $('data-info').addEventListener('click', (e) => { if (e.target === $('data-info')) $('data-info').close(); });
  $('btn-sync-stop').addEventListener('click', () => {
    if (confirm('この端末の同期をやめます（データはこの端末とGoogleドライブの両方に残ります）')) stopSync();
  });
  $('theme-seg').addEventListener('click', (e) => {
    const b = e.target.closest('[data-theme-pref]');
    if (b) { prefSet('theme', b.dataset.themePref); applyTheme(); }
  });
  // ヘッダーのボタンは押すたびにライト⇔ダーク（「自動」は設定画面で選ぶ）
  $('btn-theme').addEventListener('click', () => {
    prefSet('theme', document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
    applyTheme();
  });
  // 「自動」のときは、端末のライト／ダークの切り替えにその場で合わせる（裏にいた間に変わった分は、戻ってきたときに合わせる）
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') applyTheme(); });
}

// ---------- 表示の明るさ ----------

// 最初の決定は index.html の先頭でしている。ここでは切り替えと、ボタン・ブラウザのバーの色を合わせる
function applyTheme() {
  const pref = prefGet('theme', 'auto');
  const dark = pref === 'dark' || (pref === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]').content = dark ? '#1e2128' : '#2f6fde';
  for (const b of $('theme-seg').querySelectorAll('button')) b.classList.toggle('active', b.dataset.themePref === pref);
  // 押したらどうなるかを絵で出す（今ライトなら月、ダークなら太陽）
  const btn = $('btn-theme');
  btn.innerHTML = dark ? ICON_SUN : ICON_MOON;
  btn.title = dark ? 'ライト（白基調）にする' : 'ダークにする';
  btn.setAttribute('aria-label', btn.title);
}

const ICON_MOON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 14.6A8.5 8.5 0 0 1 9.4 3.5a8.5 8.5 0 1 0 11.1 11.1z" fill="currentColor"/></svg>';
const ICON_SUN = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.5" fill="currentColor"/>'
  + '<g stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2'
  + 'M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/></g></svg>';

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
  $('set-sync-text').textContent = !Sync.available ? 'この開き方では使えません（公開ページから開くと使えます）'
    : status === 'off' ? 'ヘッダーの「同期を設定」から始められます' : `同期しています（${b.textContent}）`;
  if (status === 'error' && detail) showToast(`同期できませんでした：${detail}`, null);
}

async function init() {
  $('app-version').textContent = `v${APP_VERSION}`;
  applyTheme();
  state.showDoneOnCal = prefGet('calShowDone', '0') === '1';
  bindGlobal();
  bindForm();
  bindInvoice();
  bindPrices();
  resetForm();
  state.settings = loadSettingsLocal();
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
