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

// 1 案件 1 行。1分あたりの案件は「数量＝尺の合計（分）・単価＝1分あたり」、追加料金はその下に 1 項目 1 行
function invoiceItems() {
  const items = [];
  for (const p of invoiceProjects()) {
    const kind = KIND_LABEL[p.kind];
    const perMin = isPerMinute(p);
    const what = perMin ? `${kind}・${minutesOf(p)}分${p.count > 1 ? `×${p.count}本` : ''}` : kind;
    items.push({
      name: p.title ? `${p.title}（${what}）` : perMin ? `${projectLabel(p)}（${minutesOf(p)}分${p.count > 1 ? `×${p.count}本` : ''}）` : projectLabel(p),
      qty: unitsOf(p),
      price: p.unitPrice,
      amount: baseAmountOf(p),
    });
    for (const x of extrasOf(p)) {
      items.push({
        name: p.title ? `${x.name}（${p.title}）` : x.name,
        qty: x.qty,
        price: x.price,
        amount: (Number(x.price) || 0) * (Number(x.qty) || 0),
      });
    }
  }
  return items.map((it, i) => ({ no: i + 1, ...it }));
}

// 入力欄と案件から、請求書に載せる中身を作る（住所・振込先は行に分けた配列）
function invoiceData() {
  const items = invoiceItems();
  return {
    to: $('iv-to').value.trim(),
    honorific: currentHonorific(),
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

// 宛名の敬称：個人あては「様」、会社・団体あては「御中」（クライアントごとに覚える。0.8.1 までの控えは「様」）
const honorificOf = (d) => d.honorific ?? '様';
const currentHonorific = () => $('iv-honorific').querySelector('.active')?.dataset.honorific ?? '様';

function setHonorific(h) {
  for (const b of $('iv-honorific').querySelectorAll('button')) b.classList.toggle('active', b.dataset.honorific === h);
}

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

// ---------- ファイル名の決まり（請求タブで変えられる） ----------
// {要素} を並べた文字列。元の決まりはこれまでの請求書の名前と同じ
// クライアント別：5月分請求書_自分の名前_〇〇様　／　案件別：請求書_案件名_自分の名前_〇〇様（会社あては〇〇御中）
const DEFAULT_NAME_RULES = {
  month: '{請求月}月分請求書_{自分の名前}_{宛名}',
  project: '請求書_{動画名}_{自分の名前}_{宛名}',
};
// 入れられる要素（ボタンの順）
const NAME_TOKENS = [
  ['クライアント', 'クライアント名'],
  ['宛名', '宛名＋様／御中'],
  ['自分の名前', '作業者名（請求書の自分の名前）'],
  ['活動名', '自分の活動名（屋号など）'],
  ['動画名', '案件名（月末まとめは並べる）'],
  ['請求月', '請求月の月（例：11）'],
  ['年', '請求月の年（例：2026）'],
  ['発効日', '発効日（例：20261130）'],
  ['種別', 'ショート・ロング'],
  ['担当編集者', '担当編集者（ディレクター機能）'],
];

const nameRules = () => ({ ...DEFAULT_NAME_RULES, ...(state.settings?.fileNameRules ?? {}) });

// 要素の中身を入れて、ファイル名に使えない文字を直す。空の要素で区切りが続いたら 1 つにまとめる
function applyNameRule(rule, values) {
  const name = rule.replace(/\{([^{}]+)\}/g, (m, k) => (k in values ? values[k] : m))
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/([_\-・ 　])\1+/g, '$1')
    .replace(/^[_\-・ 　]+|[_\-・ 　]+$/g, '');
  return name || '請求書';
}

// 動画名などは、月末まとめでは案件を並べる（多いときは「ほか〇件」）
function joinNames(list) {
  const u = [...new Set(list.filter(Boolean))];
  return u.length > 3 ? `${u.slice(0, 2).join('・')}ほか${u.length - 2}件` : u.join('・');
}

function nameValues(d) {
  const ps = invoiceProjects();
  return {
    クライアント: inv.client ?? '',
    宛名: `${d.to}${honorificOf(d)}`,
    自分の名前: d.myName || '自分の名前',
    活動名: state.settings?.activityName ?? '',
    動画名: inv.mode === 'project' ? projectLabel(byId(inv.projectId)) : joinNames(ps.map((p) => p.title)),
    請求月: String(Number(inv.month.slice(5))),
    年: inv.month.slice(0, 4),
    発効日: (d.issue ?? '').replaceAll('-', ''),
    種別: joinNames(ps.map((p) => KIND_LABEL[p.kind])),
    担当編集者: joinNames(ps.map((p) => p.editor)),
  };
}

function invoiceFileName(d) {
  if (inv.snapshot) return inv.snapshot.fileName;
  return applyNameRule(nameRules()[inv.mode === 'project' ? 'project' : 'month'], nameValues(d));
}

// 請求タブの一番上のボタン（いまの決まりで付く名前の例を出す）。押すとファイル名の画面へ
let lastRuleInput = 'rule-month';

function renderRulesLink() {
  $('rules-link-text').textContent = `例：${previewName('month')}.pdf（押すと決まり・自分の名前・活動名を変えられます）`;
}

function openRules() {
  $('rule-myname').value = state.settings?.myName ?? '';
  $('rule-activity').value = state.settings?.activityName ?? '';
  renderNameRules();
  openPage('rules-view');
}

function closeRules() {
  closePage('rules-view');
  renderAll();
}

function renderNameRules() {
  const rules = nameRules();
  for (const key of ['month', 'project']) {
    const input = $(`rule-${key}`);
    if (document.activeElement !== input) input.value = rules[key];
  }
  $('rule-tokens').innerHTML = NAME_TOKENS
    .map(([k, tip]) => `<button type="button" class="chip-btn" data-rule-token="${k}" title="${esc(tip)}">＋ ${k}</button>`).join('');
  renderRulePreviews();
}

function previewName(key, rule) {
  const m = state.billMonth;
  const sample = {
    クライアント: '〇〇チャンネル', 宛名: '〇〇チャンネル様', 自分の名前: state.settings?.myName || '自分の名前',
    活動名: state.settings?.activityName || '活動名',
    動画名: '#12 雑談ショート', 請求月: String(Number(m.slice(5))), 年: m.slice(0, 4),
    発効日: monthEnd(m).replaceAll('-', ''), 種別: 'ショート', 担当編集者: '田中',
  };
  return applyNameRule(rule || nameRules()[key], sample);
}

function renderRulePreviews() {
  for (const key of ['month', 'project']) {
    $(`rule-${key}-preview`).textContent = `${previewName(key, $(`rule-${key}`).value || DEFAULT_NAME_RULES[key])}.pdf`;
  }
}

function bindNameRules() {
  $('btn-open-rules').addEventListener('click', openRules);
  $('rules-close').addEventListener('click', closeRules);
  // 自分の名前（請求書と同じ）・活動名。入れたらその場で保存
  $('rule-myname').addEventListener('input', (e) => { updateSettings({ myName: e.target.value.trim() }); renderRulePreviews(); });
  $('rule-activity').addEventListener('input', (e) => { updateSettings({ activityName: e.target.value.trim() }); renderRulePreviews(); });
  for (const key of ['month', 'project']) {
    const input = $(`rule-${key}`);
    input.addEventListener('focus', () => { lastRuleInput = input.id; });
    input.addEventListener('input', renderRulePreviews);
    input.addEventListener('change', () => {
      const v = input.value.trim();
      updateSettings({ fileNameRules: { ...nameRules(), [key]: v || DEFAULT_NAME_RULES[key] } });
      if (!v) input.value = DEFAULT_NAME_RULES[key];
      renderRulePreviews();
      showToast('請求書のファイル名の決まりを保存しました', null);
    });
  }
  // 要素のボタン：最後に選んだ欄の、文字を打っている位置に入れる
  $('rule-tokens').addEventListener('mousedown', (e) => e.preventDefault()); // 欄から文字の位置を外さない
  $('rule-tokens').addEventListener('click', (e) => {
    const b = e.target.closest('[data-rule-token]');
    if (!b) return;
    const input = $(lastRuleInput);
    const at = document.activeElement === input ? input.selectionStart : input.value.length;
    const end = document.activeElement === input ? input.selectionEnd : at;
    // 前の文字が区切りでなければ「_」を挟む（{宛名}{発効日} のようにくっつかないように）
    const prev = input.value.slice(0, at).slice(-1);
    const token = `${prev && !/[_\-・ 　]/.test(prev) ? '_' : ''}{${b.dataset.ruleToken}}`;
    input.value = input.value.slice(0, at) + token + input.value.slice(end);
    input.focus();
    input.setSelectionRange(at + token.length, at + token.length);
    input.dispatchEvent(new Event('change'));
  });
  $('rule-reset').addEventListener('click', () => {
    if (!confirm('ファイル名の決まりを元に戻します')) return;
    updateSettings({ fileNameRules: { ...DEFAULT_NAME_RULES } });
    $('rule-month').value = DEFAULT_NAME_RULES.month;
    $('rule-project').value = DEFAULT_NAME_RULES.project;
    renderRulePreviews();
  });
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
  setHonorific(s.honorifics?.[inv.client] ?? '様');
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
      <div class="ip-to">${esc(d.to)}<span>${honorificOf(d)}</span></div>
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

// PDF を作る部品（html2canvas・jsPDF）は js/vendor に同梱。最初に PDF を保存するときに読み込む
const loadedScripts = new Map();
function loadScript(src) {
  if (!loadedScripts.has(src)) {
    loadedScripts.set(src, new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = src;
      el.onload = resolve;
      el.onerror = () => { loadedScripts.delete(src); reject(new Error(`${src} を読み込めませんでした`)); };
      document.head.appendChild(el);
    }));
  }
  return loadedScripts.get(src);
}

// 用紙を A4 の幅（794px）で画像にして、A4 の PDF にする（日本語もそのまま出る）
async function makeInvoicePdf() {
  await Promise.all([loadScript('js/vendor/html2canvas.min.js'), loadScript('js/vendor/jspdf.umd.min.js')]);
  const clone = $('invoice-paper').cloneNode(true);
  clone.removeAttribute('id');
  clone.classList.add('pdf-render');
  // 請求書の画面の裏に置いて描く（見えない）
  const holder = document.createElement('div');
  holder.className = 'pdf-holder';
  holder.appendChild(clone);
  document.body.appendChild(holder);
  try {
    const canvas = await html2canvas(clone, { scale: 2, backgroundColor: '#ffffff', logging: false });
    const pdf = new window.jspdf.jsPDF({ orientation: 'p', unit: 'mm', format: 'a4' });
    const pageW = 210;
    const pageH = 297;
    let w = pageW;
    let h = (canvas.height * pageW) / canvas.width;
    if (h > pageH) { w = (w * pageH) / h; h = pageH; } // 1 枚に収める
    pdf.addImage(canvas.toDataURL('image/jpeg', 0.92), 'JPEG', (pageW - w) / 2, 0, w, h);
    return pdf.output('blob');
  } finally {
    holder.remove();
  }
}

// 保存先を選べるブラウザ（PC の Chrome・Edge）は保存先を選ぶ画面を出す。それ以外はダウンロードとして保存
const canPickSave = () => typeof window.showSaveFilePicker === 'function' && !isNarrow();

async function pickSaveHandle(fileName, description, mime, ext) {
  if (!canPickSave()) return null;
  return window.showSaveFilePicker({ suggestedName: fileName, types: [{ description, accept: { [mime]: [ext] } }] });
}

async function writeFile(handle, fileName, blob) {
  if (!handle) { downloadFile(fileName, blob); return; }
  const w = await handle.createWritable();
  await w.write(blob);
  await w.close();
}

// 保存の流れ：確かめる → 保存先を選ぶ（選ぶ画面はボタンを押した直後に出す）→ 作る → 書く → 控えを残す
async function saveInvoiceFile({ ext, mime, description, build, button }) {
  const d = currentData();
  if (!inv.snapshot && !checkInvoice(d)) return;
  const fileName = `${invoiceFileName(d)}.${ext}`;
  let handle = null;
  try {
    handle = await pickSaveHandle(fileName, description, mime, `.${ext}`);
  } catch (e) {
    if (e?.name === 'AbortError') return; // 保存先を選ぶ画面を閉じた
  }
  const label = button.textContent;
  button.disabled = true;
  button.textContent = '作成中…';
  try {
    await writeFile(handle, fileName, await build(d));
    if (!inv.snapshot) markIssued(d);
    showToast(`「${fileName}」を保存しました`, null);
  } catch (e) {
    alert(`保存できませんでした：${e?.message ?? e}`);
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

const saveInvoicePdf = () => saveInvoiceFile({
  ext: 'pdf', mime: 'application/pdf', description: 'PDF', button: $('iv-pdf'), build: () => makeInvoicePdf(),
});

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
    row({ 1: `${d.to} ${honorificOf(d)}`, 4: d.address.join(' ') }),
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

// 先頭の BOM で Excel でも文字化けしない
const saveInvoiceCsv = () => saveInvoiceFile({
  ext: 'csv', mime: 'text/csv', description: 'CSV', button: $('iv-csv'),
  build: async (d) => new Blob(['\ufeff' + invoiceCsv(d)], { type: 'text/csv' }),
});

// ---------- 操作 ----------

function bindInvoice() {
  $('iv-close').addEventListener('click', closeInvoice);
  bindNameRules();
  $('iv-pdf').addEventListener('click', saveInvoicePdf);
  $('iv-csv').addEventListener('click', saveInvoiceCsv);
  // 控えから作り直す（いまの案件・設定の内容で新しく作る）
  $('iv-remake').addEventListener('click', () => {
    if (inv.mode === 'project') openProjectInvoice(inv.projectId, { remake: true });
    else openInvoice(inv.month, inv.client, { remake: true });
  });
  $('iv-form').addEventListener('submit', (e) => e.preventDefault());
  $('iv-honorific').addEventListener('click', (e) => {
    const b = e.target.closest('[data-honorific]');
    if (!b) return;
    setHonorific(b.dataset.honorific);
    updateSettings({ honorifics: { ...(state.settings?.honorifics ?? {}), [inv.client]: b.dataset.honorific } });
    renderInvoicePaper();
  });
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
