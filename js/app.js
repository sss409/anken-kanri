// util.js・db.js・config.js・sync.js を先に読み込んでおくこと（index.html をダブルクリックで開けるよう、モジュールにしていない）

// 配布時のバージョン。上げたら CHANGELOG.md も更新する
const APP_VERSION = '0.15.1';

const $ = (id) => document.getElementById(id);

const state = {
  projects: [],
  invoices: new Map(), // "YYYY-MM|クライアント" → { invoicedAt, paidAt }
  deleted: new Map(),  // 削除した案件 id → { id, deletedAt }
  settings: null,      // 請求書の設定 { myName, bank, note, addressees: { クライアント: 宛名 }, updatedAt }
  tab: 'list',
  clientFilter: '',    // クライアント別タブで絞り込むクライアント（空ならすべて）
  // クライアント別タブの期間（請求月で数える）：all＝全期間、month＝1か月、range＝from〜to
  period: { mode: 'all', month: monthOf(todayStr()), from: shiftMonth(monthOf(todayStr()), -2), to: monthOf(todayStr()) },
  editorFilter: null,  // 案件タブで絞り込む編集者（null＝すべて、''＝自分で編集する案件）
  editingId: null,
  calMonth: monthOf(todayStr()),
  dirMonth: monthOf(todayStr()),
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
const clientNames = () => [...new Set(state.projects.map((p) => p.client))].sort(compareClients);
// 色は単価タブで変えられる（決めていなければ名前から作る色）
const clientHueOf = (name) => state.settings?.clientColors?.[name] ?? clientHue(name);
const clientStyle = (name) => `--hue:${clientHueOf(name)}`;
// 並びは単価タブで変えられる（決めていなければ名前順）
function compareClients(a, b) {
  const order = state.settings?.clientOrder ?? [];
  const ia = order.indexOf(a);
  const ib = order.indexOf(b);
  if (ia !== ib) return (ia < 0 ? Infinity : ia) - (ib < 0 ? Infinity : ib);
  return a.localeCompare(b, 'ja');
}
const hasClientOrder = () => (state.settings?.clientOrder ?? []).length > 0;

// ---------- クライアントのアイコン（YouTube・X のリンクから取る） ----------
// リンクは settings.clientLinks、取ったアイコンは小さくして settings.clientIcons に入れる（同期され、圏外でも出る）
const clientLinks = (name) => state.settings?.clientLinks?.[name] ?? {};
const clientIconSrc = (name) => state.settings?.clientIcons?.[name]?.src ?? '';
const clientIconHtml = (name, cls = '') => (clientIconSrc(name)
  ? `<img class="client-icon ${cls}" src="${clientIconSrc(name)}" alt="" loading="lazy">` : '');

// リンクからアカウントを読む。読めなければ null
// YouTube：youtube.com/@名前・/channel/UC…・/c/名前・/user/名前（「@名前」だけでも可）
// X：x.com/名前・twitter.com/名前（「@名前」だけは YouTube と区別できないので不可）
function parseSocial(type, raw) {
  const text = (raw ?? '').trim();
  if (!text) return null;
  if (type === 'youtube' && /^@[^\s/?#]+$/.test(text)) return text;
  let url;
  try { url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`); } catch { return null; }
  const host = url.hostname.replace(/^(www|m)\./, '');
  const parts = url.pathname.split('/').filter(Boolean);
  if (type === 'youtube' && /(^|\.)youtube\.com$/.test(host) && parts.length) {
    if (parts[0].startsWith('@')) return decodeURIComponent(parts[0]);
    if (['channel', 'c', 'user'].includes(parts[0]) && parts[1]) return decodeURIComponent(parts[1]);
  }
  if (type === 'x' && /^(x|twitter)\.com$/.test(host) && parts.length
    && !['home', 'i', 'intent', 'search', 'explore', 'hashtag', 'share'].includes(parts[0])) return parts[0].replace(/^@/, '');
  return null;
}

// unavatar.io でアイコンを取り、96px の四角に切り抜いて JPEG の文字列にする（見つからなければ例外）
async function fetchIcon(type, id) {
  const res = await fetch(`https://unavatar.io/${type}/${encodeURIComponent(id)}?fallback=false`);
  if (!res.ok) throw new Error(res.status === 404 ? 'アカウントが見つかりませんでした' : `取得できませんでした（${res.status}）`);
  const bitmap = await createImageBitmap(await res.blob());
  const size = 96;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const side = Math.min(bitmap.width, bitmap.height);
  canvas.getContext('2d').drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size);
  return canvas.toDataURL('image/jpeg', 0.85);
}

// リンクを保存して、アイコンを取り直す（YouTube を先に、取れなければ X）
async function updateClientIcon(name) {
  const links = clientLinks(name);
  const tries = [['youtube', parseSocial('youtube', links.youtube)], ['x', parseSocial('x', links.x)]].filter(([, id]) => id);
  const icons = { ...(state.settings?.clientIcons ?? {}) };
  if (!tries.length) {
    delete icons[name];
    updateSettings({ clientIcons: icons });
    return { ok: true, cleared: true };
  }
  let lastError = null;
  for (const [type, id] of tries) {
    try {
      const src = await fetchIcon(type, id);
      updateSettings({ clientIcons: { ...(state.settings?.clientIcons ?? {}), [name]: { src, from: type, at: nowIso() } } });
      return { ok: true, from: type };
    } catch (e) {
      lastError = e;
    }
  }
  return { ok: false, error: lastError?.message ?? '取得できませんでした' };
}

// ---------- ディレクター機能（担当編集者・委託費・純利益） ----------

// 設定に入れて同期する（PC で入れたらスマホでも出る）
// ディレクターモードは標準（常にオン）。担当編集者・委託単価は入力画面に、委託費・純利益はディレクタータブにまとめる
const isDirector = () => true;
// 委託先の編集者：設定画面で登録した人＋案件に入っている人
const registeredEditors = () => state.settings?.editors ?? [];
const editorNames = () => [...new Set([...registeredEditors(), ...state.projects.map((p) => p.editor).filter(Boolean)])]
  .sort((a, b) => a.localeCompare(b, 'ja'));
// 入力画面で選べるクライアント：単価タブで登録したもの＋案件のあるもの（よく使う順）
function pickClientNames() {
  const count = new Map();
  for (const p of state.projects) count.set(p.client, (count.get(p.client) ?? 0) + 1);
  for (const c of Object.keys(state.settings?.clientPrices ?? {})) if (!count.has(c)) count.set(c, 0);
  // 並びを決めてあればその順、なければよく使う順
  return [...count.keys()].sort(hasClientOrder() ? compareClients : (a, b) => count.get(b) - count.get(a) || a.localeCompare(b, 'ja'));
}
const SELF_LABEL = '自分';
const editorLabel = (name) => name || SELF_LABEL;

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
  renderClientOptions();
  if (state.tab === 'list') renderActiveList();
  if (state.tab === 'clients') renderClients();
  if (state.tab === 'calendar') renderCalendar();
  if (state.tab === 'billing') { renderBilling(); renderRulesLink(); }
  if (state.tab === 'done') renderDoneList();
  if (state.tab === 'prices') renderPricesTab();
  if (state.tab === 'director') renderDirector();
}

// ---------- 入力フォーム ----------

const form = {
  kind: 'short',
  unit: 'video',         // 単価の数え方：video＝1本あたり、minute＝1分あたり（ロングのときだけ選べる）
  extras: [],            // 追加料金 [{ name, price, qty }]
  priceTouched: false,   // 単価を手で変えたら自動入力しない
  billingTouched: false, // 請求月を手で変えたら納期に追従しない
  feeTouched: false,     // 委託単価を手で変えたら自動入力しない
};

function setKind(kind) {
  form.kind = kind;
  for (const b of $('f-kind').querySelectorAll('button')) b.classList.toggle('active', b.dataset.kind === kind);
  // 1分あたりはロング（横動画）だけ。ショートに戻したら 1本あたりにする
  if (kind !== 'long') setUnit('video');
  $('f-unit-field').hidden = kind !== 'long';
}

// 単価の数え方を切り替える（1分あたりのときは尺の欄を出し、単価・委託単価の見出しを「円/分」に）
function setUnit(unit) {
  form.unit = unit;
  for (const b of $('f-unit').querySelectorAll('button')) b.classList.toggle('active', b.dataset.unit === unit);
  const perMin = unit === 'minute';
  document.querySelector('#f-price-row .minutes-field').hidden = !perMin;
  $('f-price-row').classList.toggle('row3', perMin);
  $('f-price-label').textContent = perMin ? '単価（円/分）' : '単価（円）';
  $('f-fee-label').textContent = perMin ? '委託単価（円/分）' : '委託単価（円）';
  $('f-fee').placeholder = perMin ? '1分あたり' : '1本あたり';
  updateAmount();
}

// 同じクライアント・種別で最後に登録した案件
function lastProject(client, kind) {
  return state.projects
    .filter((p) => p.client === client && p.kind === kind)
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))[0];
}
const lastPrice = (client, kind) => lastProject(client, kind)?.unitPrice;

// クライアントの単価の設定（なければ undefined）
// ロングは 1本あたり（long・feeLong）と 1分あたり（longMin・feeLongMin）の両方を持てる
// 0.13.0 までの「ロング単価＋/分」の設定（longUnit: 'minute'）は 1分あたりとして読む
function clientPrice(client) {
  const cp = state.settings?.clientPrices?.[client];
  if (!cp || cp.longUnit !== 'minute') return cp;
  const { longUnit, ...rest } = cp;
  return { ...rest, long: null, longMin: rest.longMin ?? cp.long, feeLong: null, feeLongMin: rest.feeLongMin ?? cp.feeLong };
}
const priceKeyOf = (kind, unit) => (kind === 'short' ? 'short' : unit === 'minute' ? 'longMin' : 'long');
const feeKeyOf = (kind, unit) => (kind === 'short' ? 'feeShort' : unit === 'minute' ? 'feeLongMin' : 'feeLong');
const unitOfProject = (p) => (p.kind === 'long' && p.priceUnit === 'minute' ? 'minute' : 'video');

// ロングの数え方の決め方：クライアントの単価が片方だけならそちら、両方・なしなら前回の案件と同じ（なければ 1本あたり）
function defaultLongUnit(client, cp) {
  const hasV = cp?.long != null;
  const hasM = cp?.longMin != null;
  if (hasV !== hasM) return hasM ? 'minute' : 'video';
  const last = lastProject(client, 'long');
  return last ? unitOfProject(last) : 'video';
}

// 単価は「クライアントの単価」→「前回の単価（同じ数え方）」の順に入れる
// chooseUnit：ロングの数え方もクライアントの単価・前回の案件から決める（クライアント・種別を選んだとき）
function autoFillPrice({ chooseUnit = false } = {}) {
  if (form.priceTouched && $('f-price').value !== '') return;
  const client = $('f-client').value.trim();
  const cp = clientPrice(client);
  if (form.kind === 'long' && chooseUnit) setUnit(defaultLongUnit(client, cp));
  const set = cp?.[priceKeyOf(form.kind, form.unit)];
  const last = state.projects
    .filter((p) => p.client === client && p.kind === form.kind && unitOfProject(p) === form.unit)
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))[0];
  const price = set ?? last?.unitPrice;
  if (price != null) $('f-price').value = price;
  $('f-price-src').textContent = set != null ? 'クライアントの単価' : price != null ? '前回の単価' : '';
  updateAmount();
}

// 同じ編集者・種別・数え方で最後に登録した委託単価
function lastFee(editor, kind) {
  if (!editor) return undefined;
  const hits = state.projects
    .filter((p) => p.editor === editor && p.kind === kind && p.feeUnit != null && unitOfProject(p) === (kind === 'long' ? form.unit : 'video'))
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  return hits[0]?.feeUnit;
}

// 委託単価は、クライアントの単価で決めた担当編集者のときはその委託単価、それ以外は前回の委託単価
function autoFillFee() {
  if (form.feeTouched && $('f-fee').value !== '') return;
  const editor = $('f-editor').value.trim();
  const cp = clientPrice($('f-client').value.trim());
  const set = cp && editor && cp.editor === editor ? cp[feeKeyOf(form.kind, form.unit)] : null;
  $('f-fee').value = set ?? lastFee(editor, form.kind) ?? '';
  updateAmount();
}

// クライアントを選んだとき：決めてある担当編集者を入れてから、単価・委託単価を入れる
function onClientChosen() {
  if (state.editingId) return;
  const cp = clientPrice($('f-client').value.trim());
  if (cp?.editor) $('f-editor').value = cp.editor;
  form.priceTouched = false;
  autoFillPrice({ chooseUnit: true });
  form.feeTouched = false;
  autoFillFee();
}

// 入力中の内容で金額を出す（計算は util.js の amountOf・feeOf と同じ）
function draftProject() {
  return {
    unitPrice: Number($('f-price').value) || 0,
    count: Number($('f-count').value) || 0,
    priceUnit: form.unit,
    minutes: Math.floor(Number($('f-minutes').value) || 0),
    feeUnit: Number($('f-fee').value) || 0,
    extras: form.extras,
  };
}

function updateAmount() {
  const d = draftProject();
  const total = amountOf(d);
  const fee = feeOf(d);
  const extra = extrasAmountOf(d);
  $('f-amount').textContent = yen(total);
  $('f-amount-breakdown').textContent = extra ? `編集 ${yen(baseAmountOf(d))} ＋ 追加 ${yen(extra)} ＝ ` : '';
  $('f-fee-amount').textContent = yen(fee);
  $('f-profit').textContent = yen(total - fee);
  $('f-profit').classList.toggle('minus', total - fee < 0);
}

// ---------- 追加料金（案件の入力画面） ----------

const extraItems = () => state.settings?.extraItems ?? [];

function renderExtras() {
  $('f-extras').innerHTML = form.extras.map((x, i) => `
    <div class="extra-line" data-extra-index="${i}">
      <input data-extra-key="name" value="${esc(x.name)}" placeholder="名前" aria-label="追加料金の名前">
      <span class="yen-input"><input data-extra-key="price" type="number" min="0" step="100" inputmode="numeric" value="${x.price ?? ''}" placeholder="単価" aria-label="単価"></span>
      <span class="qty-input"><input data-extra-key="qty" type="number" min="1" step="1" inputmode="numeric" value="${x.qty ?? 1}" aria-label="回数"></span>
      <button type="button" class="ghost icon-btn extra-remove" data-extra-remove aria-label="この追加料金を消す" title="消す">✕</button>
    </div>`).join('');
  const items = extraItems();
  $('f-extra-presets').innerHTML = items.map((it, i) =>
    `<button type="button" class="chip-btn" data-extra-preset="${i}">＋ ${esc(it.name)} <small>${yen(it.price ?? 0)}</small></button>`).join('')
    + '<button type="button" class="chip-btn other" data-extra-preset="other">＋ その他</button>';
  updateAmount();
}

function bindExtras() {
  $('f-extra-presets').addEventListener('click', (e) => {
    const b = e.target.closest('[data-extra-preset]');
    if (!b) return;
    const it = b.dataset.extraPreset === 'other' ? { name: '', price: null } : extraItems()[Number(b.dataset.extraPreset)];
    form.extras = [...form.extras, { name: it.name, price: it.price, qty: 1 }];
    renderExtras();
    const lines = $('f-extras').querySelectorAll('.extra-line');
    lines[lines.length - 1]?.querySelector(it.name ? '[data-extra-key="price"]' : '[data-extra-key="name"]')?.focus();
  });
  $('f-extras').addEventListener('input', (e) => {
    const input = e.target.closest('[data-extra-key]');
    if (!input) return;
    const i = Number(input.closest('[data-extra-index]').dataset.extraIndex);
    const key = input.dataset.extraKey;
    const raw = input.value;
    form.extras = form.extras.map((x, j) => (j === i ? { ...x, [key]: key === 'name' ? raw : (raw === '' ? null : Number(raw)) } : x));
    updateAmount();
  });
  $('f-extras').addEventListener('click', (e) => {
    const b = e.target.closest('[data-extra-remove]');
    if (!b) return;
    const i = Number(b.closest('[data-extra-index]').dataset.extraIndex);
    form.extras = form.extras.filter((_, j) => j !== i);
    renderExtras();
  });
}

function resetForm({ keepClient = false } = {}) {
  // 続けて追加するときは、クライアント・種別・単価・担当編集者・委託単価をそのまま残す
  const keep = keepClient ? {
    client: $('f-client').value, kind: form.kind, unit: form.unit, price: $('f-price').value, editor: $('f-editor').value, fee: $('f-fee').value,
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
  form.extras = [];
  if (keep) {
    $('f-client').value = keep.client;
    setKind(keep.kind);
    setUnit(keep.unit);
    $('f-price').value = keep.price;
    $('f-editor').value = keep.editor;
    $('f-fee').value = keep.fee;
  } else {
    setKind('short');
  }
  renderExtras();
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
  setUnit(isPerMinute(p) ? 'minute' : 'video');
  $('f-minutes').value = p.minutes != null ? Math.floor(p.minutes) : '';
  form.extras = extrasOf(p).map((x) => ({ ...x }));
  renderExtras();
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
  renderExtras(); // 単価タブで決めた追加料金の項目をボタンに出す（同期で変わった分も）
  renderPickChips();
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
    priceUnit: form.kind === 'long' ? form.unit : 'video',
    minutes: form.kind === 'long' && form.unit === 'minute' ? Math.floor(Number($('f-minutes').value) || 0) : null,
    // 名前も単価も空の行は捨てる。回数が空なら 1
    extras: form.extras
      .map((x) => ({ name: (x.name ?? '').trim(), price: x.price, qty: x.qty == null || x.qty === '' ? 1 : Number(x.qty) }))
      .filter((x) => x.name || x.price != null),
    startDate: $('f-start').value,
    dueDate: $('f-due').value,
    billingMonth: $('f-billing').value,
    memo: $('f-memo').value.trim(),
  };
  if (!v.client) return { error: 'クライアント名を入れてください' };
  if ($('f-price').value === '' || !(v.unitPrice >= 0)) return { error: '単価を入れてください' };
  if (!Number.isInteger(v.count) || v.count < 1) return { error: '本数は1以上の整数で入れてください' };
  if (v.priceUnit === 'minute' && !(v.minutes > 0)) return { error: '1分あたりの単価のときは、1本の尺（1分以上）を入れてください' };
  for (const x of v.extras) {
    if (!x.name) return { error: '追加料金の名前を入れてください' };
    if (x.price == null || !(x.price >= 0)) return { error: `追加料金「${x.name}」の単価を入れてください` };
    if (!Number.isInteger(x.qty) || x.qty < 1) return { error: `追加料金「${x.name}」の回数は1以上の整数で入れてください` };
  }
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
    if (!state.editingId) { form.priceTouched = false; autoFillPrice({ chooseUnit: true }); form.feeTouched = false; autoFillFee(); }
  });
  $('f-editor').addEventListener('change', () => { if (!state.editingId || $('f-fee').value === '') { form.feeTouched = false; autoFillFee(); } });
  $('f-fee').addEventListener('input', () => { form.feeTouched = true; updateAmount(); });
  $('f-unit').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-unit]');
    if (!b) return;
    setUnit(b.dataset.unit);
    if (!state.editingId) { form.priceTouched = false; autoFillPrice(); form.feeTouched = false; autoFillFee(); }
  });
  $('f-minutes').addEventListener('input', updateAmount);
  bindExtras();
  $('f-client').addEventListener('change', onClientChosen);
  $('f-price').addEventListener('input', () => { form.priceTouched = true; $('f-price-src').textContent = ''; updateAmount(); });
  // クライアント・編集者をボタンで選ぶ
  $('f-client-chips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-pick-client]');
    if (!b) return;
    $('f-client').value = b.dataset.pickClient;
    onClientChosen();
    renderPickChips();
    $('f-title').focus();
  });
  $('f-editor-chips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-pick-editor]');
    if (!b) return;
    $('f-editor').value = b.dataset.pickEditor;
    form.feeTouched = false;
    autoFillFee();
    renderPickChips();
  });
  $('f-client').addEventListener('input', renderPickChips);
  $('f-editor').addEventListener('input', renderPickChips);
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
    if (pageOpen('rules-view')) closeRules();
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

// 入力画面のクライアント・編集者のボタン（いま入っている名前は色が付く）
function renderPickChips() {
  const cur = $('f-client').value.trim();
  $('f-client-chips').innerHTML = pickClientNames().slice(0, 12).map((n) =>
    `<button type="button" class="chip-btn pick ${n === cur ? 'on' : ''}" data-pick-client="${esc(n)}" style="${clientStyle(n)}">${clientIconHtml(n, 'small')}${esc(n)}</button>`).join('');
  const ed = $('f-editor').value.trim();
  const eds = [...registeredEditors(), ...editorNames().filter((n) => !registeredEditors().includes(n))];
  $('f-editor-chips').innerHTML = eds.length
    ? [...eds.map((n) => `<button type="button" class="chip-btn pick ${n === ed ? 'on' : ''}" data-pick-editor="${esc(n)}">${esc(n)}</button>`),
      `<button type="button" class="chip-btn pick ${ed === '' ? 'on' : ''}" data-pick-editor="">${SELF_LABEL}</button>`].join('')
    : '';
}

function renderClientOptions() {
  $('client-options').innerHTML = pickClientNames().map((n) => `<option value="${esc(n)}">`).join('');
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
    : `<div class="due done">${p.completedAt ? shortDate(p.completedAt) : '—'}<small>完了</small></div>`;
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
        <small>${priceFormula(p)}</small>
        ${extrasOf(p).length ? `<small class="extra-line-sum" title="${esc(extrasOf(p).map((x) => `${x.name} ${yen(x.price)}×${x.qty}`).join('\n'))}">＋ 追加 ${yen(extrasAmountOf(p))}</small>` : ''}
        <b>${yen(amountOf(p))}</b>
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

function renderActiveList() {
  const allActive = state.projects.filter((p) => p.status === 'active');
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

// 期間に入る案件か（請求月で数える）
function inPeriod(p) {
  const pr = state.period;
  if (pr.mode === 'month') return p.billingMonth === pr.month;
  if (pr.mode === 'range') {
    const [from, to] = pr.from <= pr.to ? [pr.from, pr.to] : [pr.to, pr.from];
    return p.billingMonth >= from && p.billingMonth <= to;
  }
  return true;
}

function periodLabel() {
  const pr = state.period;
  if (pr.mode === 'month') return monthLabel(pr.month);
  if (pr.mode === 'range') return `${monthLabel(pr.from)}〜${monthLabel(pr.to)}`;
  return '全期間';
}

function renderPeriodBar() {
  const pr = state.period;
  for (const b of $('period-mode').querySelectorAll('button')) b.classList.toggle('active', b.dataset.period === pr.mode);
  $('period-month').hidden = pr.mode !== 'month';
  $('period-range').hidden = pr.mode !== 'range';
  $('period-label').textContent = monthLabel(pr.month);
  $('period-from').value = pr.from;
  $('period-to').value = pr.to;
}

function setPeriod(patch) {
  state.period = { ...state.period, ...patch };
  prefSet('clientPeriod', JSON.stringify(state.period));
  renderClients();
}

function bindPeriod() {
  try { Object.assign(state.period, JSON.parse(prefGet('clientPeriod', 'null')) ?? {}); } catch { /* 読めなければ全期間 */ }
  $('period-mode').addEventListener('click', (e) => {
    const b = e.target.closest('[data-period]');
    if (b) setPeriod({ mode: b.dataset.period });
  });
  document.querySelectorAll('[data-period-shift]').forEach((b) => b.addEventListener('click', () => {
    setPeriod({ month: shiftMonth(state.period.month, Number(b.dataset.periodShift)) });
  }));
  $('period-today').addEventListener('click', () => setPeriod({ month: monthOf(todayStr()) }));
  $('period-from').addEventListener('change', (e) => { if (e.target.value) setPeriod({ from: e.target.value }); });
  $('period-to').addEventListener('change', (e) => { if (e.target.value) setPeriod({ to: e.target.value }); });
}

function renderClients() {
  renderPeriodBar();
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
  const bills = openBills().filter((b) => inPeriod({ billingMonth: b.month }));
  // 期間に案件のないクライアントは出さない（クライアントを選んでいるときは出す）
  const shown = state.clientFilter ? [state.clientFilter]
    : names.filter((c) => state.projects.some((p) => p.client === c && inPeriod(p)));
  if (!shown.length) {
    $('client-groups').innerHTML = `<p class="empty">${periodLabel()}が請求月の案件はありません。</p>`;
    return;
  }

  $('client-groups').innerHTML = shown.map((client) => {
    const ps = state.projects.filter((p) => p.client === client && inPeriod(p));
    const total = ps.reduce((s, p) => s + amountOf(p), 0);
    const byDue = (a, b) => a.dueDate.localeCompare(b.dueDate);
    const started = ps.filter((p) => p.status === 'active' && p.startDate <= today).sort(byDue);
    const upcoming = ps.filter((p) => p.status === 'active' && p.startDate > today).sort(byDue);
    const done = ps.filter((p) => p.status === 'done').sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''));
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
          ${clientIconHtml(client, 'big')}<span class="client-chip big">${esc(client)}</span>
          <div class="client-stats">
            <span>着手中 <b>${started.length}</b></span>
            ${upcoming.length ? `<span>着手前 <b>${upcoming.length}</b></span>` : ''}
            <span>完了 <b>${done.length}</b></span>
            ${state.period.mode !== 'all' ? `<span>${periodLabel()} <b>${yen(total)}</b></span>` : ''}
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
    .sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? '') || compareClients(a.client, b.client));
  if (!done.length) {
    $('done-list').innerHTML = '<p class="empty">完了した案件はまだありません。進行中の一覧で「完了」を押すとここに移ります。</p>';
    return;
  }
  // 完了した月 → クライアント の順にまとめる
  const months = new Map();
  for (const p of done) {
    const m = monthOf(p.completedAt ?? p.dueDate); // 完了日のないデータ（読み込んだ古いデータなど）は納期の月に
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
    for (const [client, list] of [...clients].sort((a, b) => compareClients(a[0], b[0]))) {
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
  return [...rows.values()].sort(hasClientOrder() ? (a, b) => compareClients(a.client, b.client) : (a, b) => b.total - a.total);
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

// ディレクタータブ：その月の売上・委託費・純利益、編集者別・クライアント別、進行中の担当状況
function renderDirector() {
  const ym = state.dirMonth;
  $('dir-label').textContent = monthLabel(ym);
  renderEditorList();
  const rows = billingRows(ym);
  const sales = rows.reduce((s, r) => s + r.total, 0);
  const fee = rows.reduce((s, r) => s + r.fee, 0);
  const tiles = `
    <div class="stat-tiles">
      <div class="card stat-tile"><span>売上</span><b>${yen(sales)}</b></div>
      <div class="card stat-tile"><span>委託費</span><b>${yen(fee)}</b></div>
      <div class="card stat-tile profit"><span>純利益</span><b>${profitCell(sales - fee)}</b></div>
      <div class="card stat-tile"><span>利益率</span><b>${rateOf(sales - fee, sales)}</b></div>
    </div>`;
  const clientTable = rows.length ? `
    <h3 class="section-title">クライアント別（委託費・純利益）</h3>
    <div class="card table-card">
      <table class="bill-table">
        <thead><tr><th>クライアント</th><th>請求額</th><th>委託費</th><th>純利益</th><th>利益率</th></tr></thead>
        <tbody>
          ${rows.map((r) => `
            <tr style="${clientStyle(r.client)}">
              <td class="name-col"><span class="client-chip">${esc(r.client)}</span></td>
              <td class="num" data-label="請求額">${yen(r.total)}</td>
              <td class="num" data-label="委託費">${r.fee ? yen(r.fee) : '<span class="muted">—</span>'}</td>
              <td class="num total profit" data-label="純利益">${profitCell(r.total - r.fee)}</td>
              <td class="num" data-label="利益率">${rateOf(r.total - r.fee, r.total)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>` : '';
  $('director').innerHTML = (rows.length ? tiles + editorTableHtml(ym) + clientTable
    : `<p class="empty">${monthLabel(ym)}が請求月の案件はありません。</p>`) + assignmentHtml();
}

// 進行中の案件を担当編集者ごとに（自分で編集する分は最後）
function assignmentHtml() {
  const active = state.projects.filter((p) => p.status === 'active').sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const groups = new Map();
  for (const p of active) {
    const k = p.editor ?? '';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  }
  const names = [...groups.keys()].sort((a, b) => (a === '') - (b === '') || a.localeCompare(b, 'ja'));
  const head = `<h3 class="section-title">進行中の担当状況 <span class="muted">${active.length}件</span></h3>`;
  if (!active.length) return head + '<p class="empty">進行中の案件はありません。</p>';
  return head + `<div class="assign-grid">${names.map((n) => {
    const list = groups.get(n);
    return `
      <section class="card assign-card">
        <header><span class="editor-name ${n ? '' : 'self'}">${esc(editorLabel(n))}</span><span class="muted">${list.length}件</span></header>
        <ul>${list.map((p) => {
          const badge = dueBadge(p);
          return `<li><button class="assign-item" data-edit="${p.id}" style="${clientStyle(p.client)}">
            <span class="due ${badge.cls}">${shortDate(p.dueDate)}<small>${badge.text}</small></span>
            <span class="assign-main"><span class="client-chip">${esc(p.client)}</span> ${esc(p.title) || '<span class="muted">（案件名なし）</span>'}${stageTag(p)}</span>
            ${feeOf(p) ? `<span class="num muted">委託 ${yen(feeOf(p))}</span>` : ''}
          </button></li>`;
        }).join('')}</ul>
      </section>`;
  }).join('')}</div>`;
}

async function copyDirector() {
  const ym = state.dirMonth;
  const lines = [['クライアント', '請求額', '委託費', '純利益'].join('\t')];
  for (const r of billingRows(ym)) lines.push([r.client, r.total, r.fee, r.total - r.fee].join('\t'));
  lines.push('', ['編集者', '本数', '売上', '委託費', '純利益'].join('\t'));
  for (const r of editorRows(ym)) lines.push([editorLabel(r.editor), r.count, r.sales, r.fee, r.sales - r.fee].join('\t'));
  try {
    await navigator.clipboard.writeText(lines.join('\n'));
    showToast(`${monthLabel(ym)}の委託費・純利益の表をコピーしました（Excelに貼り付けできます）`, null);
  } catch {
    showToast('コピーできませんでした', null);
  }
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

  // 委託費・純利益はディレクタータブに出す
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
              ${editorTag(p)}
              <span class="muted">${p.status === 'done' ? '完了' : `納期 ${shortDate(p.dueDate)}`}</span>
              <span class="num">${priceFormula(p)}${extrasOf(p).length ? ` ＋ 追加 ${yen(extrasAmountOf(p))}` : ''} = <b>${yen(amountOf(p))}</b></span>
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
  // 委託費・純利益はディレクタータブの「表をコピー」で
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
  else all[client] = { ...(clientPrice(client) ?? {}), ...patch };
  updateSettings({ clientPrices: all });
}

// クライアントの色（色相 0〜359）。null で名前から作る色に戻す
function setClientColor(client, hue) {
  const colors = { ...(state.settings?.clientColors ?? {}) };
  if (hue == null) delete colors[client];
  else colors[client] = hue;
  updateSettings({ clientColors: colors });
}

// クライアントの並びを 1 つ上・下へ（いまの並び全体を保存する）
function moveClient(client, delta) {
  const list = priceClientNames();
  const i = list.indexOf(client);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  updateSettings({ clientOrder: list });
}

// 色相 ⇔ 色の欄（#rrggbb）。画面の明るさに合わせるので色相だけを使う
function hueToHex(h) {
  const f = (n) => {
    const k = (n + h / 30) % 12;
    const c = 0.55 - 0.6 * Math.min(0.55, 1 - 0.55) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}
function hexToHue(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (!d) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return Math.round((h * 60 + 360) % 360);
}

// 一覧に出すクライアント：単価を決めてあるもの＋案件のあるもの（名前順）
function priceClientNames() {
  return [...new Set([...Object.keys(state.settings?.clientPrices ?? {}), ...clientNames()])].sort(compareClients);
}

// 単価タブ：1 クライアント 1 枠。上の段が単価（ショート・ロング 1本・ロング 1分）、下の段が担当編集者と委託単価
// 左に色と並び（↑↓）
function renderPriceList() {
  const names = priceClientNames();
  const yenInput = (cp, key, label, ph) => `
    <label class="pr-cell"><span class="pr-label">${label}</span>
      <span class="yen-input"><input type="number" min="0" step="100" inputmode="numeric" data-price-key="${key}" value="${cp[key] ?? ''}" placeholder="${ph ?? ''}"></span>
    </label>`;
  const lastOf = (name, kind, unit) => state.projects
    .filter((p) => p.client === name && p.kind === kind && unitOfProject(p) === unit)
    .sort((x, y) => (y.createdAt ?? '').localeCompare(x.createdAt ?? ''))[0]?.unitPrice;
  const ph = (v) => (v != null ? `前回 ${v}` : '未設定');
  $('price-list').innerHTML = names.length ? names.map((name, i) => {
    const cp = clientPrice(name) ?? {};
    const count = state.projects.filter((p) => p.client === name).length;
    const hasAny = ['short', 'long', 'longMin', 'editor', 'feeShort', 'feeLong', 'feeLongMin'].some((k) => cp[k] != null && cp[k] !== '');
    const customColor = state.settings?.clientColors?.[name] != null;
    return `
      <div class="price-row" data-price-client="${esc(name)}" style="${clientStyle(name)}">
        <div class="pr-name">
          <span class="pr-title">${clientIconHtml(name) || `<span class="client-icon noimg" title="YouTube か X のリンクを入れるとアイコンが出ます">${esc([...name][0] ?? '')}</span>`}<span class="client-chip">${esc(name)}</span></span>
          <small class="muted">${count ? `案件 ${count}件` : '案件なし'}</small>
          <div class="pr-tools">
            <label class="color-pick" title="色を変える"><input type="color" data-client-color value="${hueToHex(clientHueOf(name))}" aria-label="${esc(name)}の色"></label>
            ${customColor ? '<button type="button" class="ghost tiny" data-color-reset title="元の色に戻す">元の色</button>' : ''}
            <button type="button" class="ghost tiny" data-move="-1" ${i === 0 ? 'disabled' : ''} aria-label="上へ" title="上へ">↑</button>
            <button type="button" class="ghost tiny" data-move="1" ${i === names.length - 1 ? 'disabled' : ''} aria-label="下へ" title="下へ">↓</button>
          </div>
        </div>
        <div class="pr-fields">
          ${yenInput(cp, 'short', 'ショート（円/本）', ph(lastOf(name, 'short', 'video')))}
          ${yenInput(cp, 'long', 'ロング（円/本）', ph(lastOf(name, 'long', 'video')))}
          ${yenInput(cp, 'longMin', 'ロング（円/分）', ph(lastOf(name, 'long', 'minute')))}
          <label class="pr-cell"><span class="pr-label">担当編集者</span>
            <input data-price-key="editor" list="editor-options" value="${esc(cp.editor ?? '')}" placeholder="決めない">
          </label>
          ${yenInput(cp, 'feeShort', '委託 ショート（円/本）')}
          ${yenInput(cp, 'feeLong', '委託 ロング（円/本）')}
          ${yenInput(cp, 'feeLongMin', '委託 ロング（円/分）')}
          <label class="pr-cell pr-link"><span class="pr-label">YouTube のリンク</span>
            <input type="url" inputmode="url" data-link-key="youtube" value="${esc(clientLinks(name).youtube ?? '')}" placeholder="https://www.youtube.com/@…">
          </label>
          <label class="pr-cell pr-link"><span class="pr-label">X のリンク</span>
            <input type="url" inputmode="url" data-link-key="x" value="${esc(clientLinks(name).x ?? '')}" placeholder="https://x.com/…">
          </label>
        </div>
        <button type="button" class="ghost icon-btn pr-clear" data-price-clear ${hasAny ? '' : 'disabled'}
          title="このクライアントの単価の設定を消す（案件は消えません）" aria-label="${esc(name)}の単価の設定を消す">✕</button>
      </div>`;
  }).join('') : '<p class="empty">まだクライアントがありません。下の欄から追加してください。</p>';
}

// 単価タブ：クライアントの単価と追加料金の項目
function renderPricesTab() {
  renderPriceList();
  renderExtraItems();
}

// ---------- 全面のページ（設定） ----------

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

// 単価タブで、そのクライアントの行に入れられる状態にする（まだ無ければ一覧に足す）
function focusPriceRow(name) {
  if (!priceClientNames().includes(name)) setClientPrice(name, {});
  renderPriceList();
  const row = [...$('price-list').querySelectorAll('[data-price-client]')].find((c) => c.dataset.priceClient === name);
  if (row) {
    row.scrollIntoView({ block: 'center' });
    row.classList.add('flash');
    row.querySelector('input')?.focus();
  }
}

function bindPrices() {
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
  // YouTube・X のリンク：入れたら保存して、アイコンを取り直す
  $('price-list').addEventListener('change', async (e) => {
    const input = e.target.closest('[data-link-key]');
    if (!input) return;
    const name = input.closest('[data-price-client]').dataset.priceClient;
    const key = input.dataset.linkKey;
    const value = input.value.trim();
    if (value && !parseSocial(key, value)) {
      showToast(key === 'youtube'
        ? 'YouTube のチャンネルのリンク（youtube.com/@… など）を入れてください'
        : 'X のアカウントのリンク（x.com/… など）を入れてください', null);
      return;
    }
    const links = { ...(state.settings?.clientLinks ?? {}) };
    links[name] = { ...(links[name] ?? {}), [key]: value };
    updateSettings({ clientLinks: links });
    showToast('アイコンを取得しています…', null);
    const r = await updateClientIcon(name);
    renderPriceList();
    showToast(r.cleared ? `「${name}」のアイコンを外しました`
      : r.ok ? `「${name}」のアイコンを${r.from === 'youtube' ? 'YouTube' : 'X'}から取得しました`
        : `「${name}」のアイコンを取得できませんでした：${r.error}`, null);
  });

  // 色：選んでいる間は枠の色だけ変え、決めたら保存して全体に反映
  $('price-list').addEventListener('input', (e) => {
    const c = e.target.closest('[data-client-color]');
    if (c) c.closest('[data-price-client]').style.setProperty('--hue', hexToHue(c.value));
  });
  $('price-list').addEventListener('change', (e) => {
    const c = e.target.closest('[data-client-color]');
    if (!c) return;
    const client = c.closest('[data-price-client]').dataset.priceClient;
    setClientColor(client, hexToHue(c.value));
    renderPriceList();
    showToast(`「${client}」の色を変えました`, null);
  });
  $('price-list').addEventListener('click', (e) => {
    const mv = e.target.closest('[data-move]');
    if (mv) {
      const client = mv.closest('[data-price-client]').dataset.priceClient;
      moveClient(client, Number(mv.dataset.move));
      renderPriceList();
      // 動かした行のボタンにそのまま続けて押せるように
      const row = [...$('price-list').querySelectorAll('[data-price-client]')].find((r) => r.dataset.priceClient === client);
      row?.querySelector(`[data-move="${mv.dataset.move}"]:not(:disabled)`)?.focus();
      return;
    }
    if (e.target.closest('[data-color-reset]')) {
      const client = e.target.closest('[data-price-client]').dataset.priceClient;
      setClientColor(client, null);
      renderPriceList();
      return;
    }
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
    focusPriceRow(name);
    renderClientOptions();
    showToast(`「${name}」を追加しました。案件の入力画面でボタンから選べます`, null);
  });
}

// ---------- 追加料金の項目（単価タブ。入れたらその場で保存） ----------

function renderExtraItems() {
  const items = extraItems();
  $('extra-items').innerHTML = items.length ? items.map((it, i) => `
    <div class="extra-item" data-extra-item="${i}">
      <input data-item-key="name" value="${esc(it.name)}" aria-label="名前">
      <span class="yen-input"><input data-item-key="price" type="number" min="0" step="100" inputmode="numeric" value="${it.price ?? ''}" aria-label="単価"></span>
      <button type="button" class="ghost icon-btn pr-clear" data-item-remove aria-label="「${esc(it.name)}」を消す" title="消す（案件に入れた追加料金はそのまま残ります）">✕</button>
    </div>`).join('') : '<p class="muted small-empty">まだありません。下の欄から追加してください。</p>';
}

function setExtraItems(items) {
  updateSettings({ extraItems: items });
  renderExtraItems();
  if (document.body.classList.contains('sheet-open')) renderExtras();
}

function bindExtraItems() {
  $('extra-add-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('extra-add-name').value.trim();
    const raw = $('extra-add-price').value;
    if (!name) { $('extra-add-name').focus(); return; }
    setExtraItems([...extraItems(), { name, price: raw === '' ? 0 : Math.max(0, Number(raw) || 0) }]);
    $('extra-add-name').value = '';
    $('extra-add-price').value = '';
    showToast(`追加料金「${name}」を追加しました`, null);
  });
  $('extra-items').addEventListener('change', (e) => {
    const input = e.target.closest('[data-item-key]');
    if (!input) return;
    const i = Number(input.closest('[data-extra-item]').dataset.extraItem);
    const key = input.dataset.itemKey;
    const value = key === 'name' ? input.value.trim() : Math.max(0, Number(input.value) || 0);
    if (key === 'name' && !value) { renderExtraItems(); return; } // 名前は空にしない
    setExtraItems(extraItems().map((it, j) => (j === i ? { ...it, [key]: value } : it)));
    showToast('追加料金の項目を保存しました', null);
  });
  $('extra-items').addEventListener('click', (e) => {
    const b = e.target.closest('[data-item-remove]');
    if (!b) return;
    const i = Number(b.closest('[data-extra-item]').dataset.extraItem);
    const it = extraItems()[i];
    if (!confirm(`追加料金の項目「${it.name}」を消します（案件に入れた追加料金はそのまま残ります）`)) return;
    setExtraItems(extraItems().filter((_, j) => j !== i));
  });
}

// ---------- 設定画面（ヘッダーの歯車から開く。入れたらその場で保存） ----------

const settingsOpen = () => pageOpen('settings-view');

// 委託先の編集者（ディレクタータブ）。登録すると入力画面の「担当編集者」でボタンから選べる
function renderEditorList() {
  const list = registeredEditors();
  $('editor-list').innerHTML = list.length
    ? list.map((n, i) => `<span class="editor-pill">${esc(n)}<button type="button" data-editor-remove="${i}" aria-label="${esc(n)}を外す" title="外す（案件に入っている担当はそのまま）">✕</button></span>`).join('')
    : '<span class="muted small-empty">まだ登録していません</span>';
}

function bindEditorList() {
  $('editor-add-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('editor-add-name').value.trim();
    if (!name) { $('editor-add-name').focus(); return; }
    if (!registeredEditors().includes(name)) updateSettings({ editors: [...registeredEditors(), name] });
    $('editor-add-name').value = '';
    renderEditorList();
    renderClientOptions();
    showToast(`委託先に「${name}」を登録しました`, null);
  });
  $('editor-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-editor-remove]');
    if (!b) return;
    const name = registeredEditors()[Number(b.dataset.editorRemove)];
    if (!confirm(`委託先から「${name}」を外します（案件に入っている担当はそのまま残ります）`)) return;
    updateSettings({ editors: registeredEditors().filter((n) => n !== name) });
    renderEditorList();
  });
}

function openSettings() {
  $('set-version').textContent = `v${APP_VERSION}`;
  openPage('settings-view');
}

function closeSettings() {
  closePage('settings-view');
  renderAll();
  if (document.body.classList.contains('sheet-open')) renderPickChips();
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
  // すぐ消すとブラウザによっては保存が始まらないので、少し待ってから消す
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
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
    const t = e.target.closest('[data-make-invoice],[data-project-invoice],[data-stage],[data-done],[data-undone],[data-edit],[data-inv],[data-bill-month],[data-client-filter],[data-editor-filter]');
    if (!t) return;
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
  document.querySelectorAll('[data-dir-shift]').forEach((b) => b.addEventListener('click', () => {
    state.dirMonth = shiftMonth(state.dirMonth, Number(b.dataset.dirShift));
    renderDirector();
  }));
  $('dir-today').addEventListener('click', () => { state.dirMonth = monthOf(todayStr()); renderDirector(); });
  $('btn-copy-director').addEventListener('click', copyDirector);
  $('btn-copy-billing').addEventListener('click', copyBilling);
  $('toast-undo').addEventListener('click', async () => {
    const undo = undoAction;
    hideToast();
    if (undo) await undo();
  });
  // 設定画面
  $('btn-settings').addEventListener('click', () => openSettings());
  $('settings-close').addEventListener('click', closeSettings);
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
  document.body.classList.add('director');
  $('app-version').textContent = `v${APP_VERSION}`;
  applyTheme();
  state.showDoneOnCal = prefGet('calShowDone', '0') === '1';
  bindGlobal();
  bindForm();
  bindInvoice();
  bindPrices();
  bindPeriod();
  bindExtraItems();
  bindEditorList();
  resetForm();
  state.settings = loadSettingsLocal();
  state.projects = await loadAll();
  state.invoices = new Map((await loadInvoices()).map((r) => [r.key, r]));
  state.deleted = new Map((await loadDeleted()).map((d) => [d.id, d]));
  const tab = prefGet('tab', 'list');
  setTab(['list', 'clients', 'calendar', 'billing', 'done', 'prices', 'director'].includes(tab) ? tab : 'list');
  initSync({ getLocal: localData, applyMerged: applyData, onStatus: renderSyncStatus });
  // ホーム画面に追加したとき、電波がなくても開けるようにする（https か localhost のときだけ）
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
