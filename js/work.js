// 作業枠タブ（0.21.0 → 0.23.0 で作り替え）：作業の種類・案件のボタンを押すと、前の作業が終わって次が始まる
// 記録 1 件 = { id, date: "YYYY-MM-DD", kind: "編集・演出" | null, projectId, isBreak, memo, startAt, endAt, deletedAt, updatedAt, changedBy }
//   0.21.0 の label（枠の名前）・planMin（予定の分）は書き換えずに残すが使わない。label は「枠1」のような自動の名前でなければ一言メモとして見せる
// app.js より先に読み込む（中の関数は呼ばれた時に app.js の state などを使う）

const work = { date: null, unit: 'day', tick: null };

const DEFAULT_WORK_KINDS = ['編集・演出', '確認・チェック', '連絡・返事', '事務・請求'];
const BREAK_LABEL = '休憩';
// 押してからこの分の間に別のボタンを押したら、押し直し（新しい記録にせず、今の記録の中身を変える）
const WORK_FIX_MIN = 2;

const workKinds = () => (Array.isArray(state.settings?.workKinds) && state.settings.workKinds.length ? state.settings.workKinds : DEFAULT_WORK_KINDS);

const workAll = () => [...state.worklogs.values()].filter((r) => !r.deletedAt && r.startAt);
const workOfDay = (date) => workAll().filter((r) => r.date === date).sort((a, b) => (a.startAt ?? '').localeCompare(b.startAt ?? ''));
const workRunning = () => workAll().filter((r) => !r.endAt).sort((a, b) => (b.startAt ?? '').localeCompare(a.startAt ?? ''))[0] ?? null;

const workMemoOf = (r) => r.memo ?? (r.label && !/^枠\s*\d+$/.test(r.label) ? r.label : '');
const workKindText = (r) => (r.isBreak ? BREAK_LABEL : r.kind || '');

function workMinutes(r, now = Date.now()) {
  const s = Date.parse(r.startAt);
  const e = r.endAt ? Date.parse(r.endAt) : now;
  return Number.isFinite(s) && Number.isFinite(e) ? Math.max(0, Math.round((e - s) / 60000)) : 0;
}

const hhmm = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function minText(n) {
  if (n < 60) return `${n}分`;
  return `${Math.floor(n / 60)}時間${n % 60 ? `${n % 60}分` : ''}`;
}

const workProjectLabel = (id) => {
  const p = id ? byId(id) : null;
  return p ? `${p.client}｜${p.title || '（無題）'}` : '';
};

// 休憩の前の作業（休憩から戻る時に、種類と案件を引き継ぐ）
function workBeforeBreak() {
  return workAll().filter((r) => !r.isBreak && r.date === todayStr()).sort((a, b) => (b.startAt ?? '').localeCompare(a.startAt ?? ''))[0] ?? null;
}

// quiet: 続けてもう 1 件書く時は、途中で描き直さない（上の帯が一瞬消えて画面がずれないように）
async function putWork(r, quiet = false) {
  r = { ...r, updatedAt: nowIso(), changedBy: 'アプリ' };
  state.worklogs.set(r.id, r);
  await saveWorklog(r);
  if (quiet) return r;
  renderAll(); // タブの印・上の帯も合わせる
  scheduleSync();
  return r;
}

// 今のを終えて、次を始める
async function switchWork(fields) {
  const cur = workRunning();
  const at = nowIso();
  if (cur) await putWork({ ...cur, endAt: at }, true);
  const r = await putWork({
    id: newId(), date: todayStr(), kind: null, projectId: null, isBreak: false, memo: '',
    ...fields, startAt: at, endAt: null, deletedAt: null,
  });
  work.date = r.date;
  return r;
}

const workYoung = (r) => workMinutes(r) < WORK_FIX_MIN;

// 種類のボタン
async function pressWorkKind(kind) {
  const cur = workRunning();
  if (cur && !cur.isBreak) {
    if (cur.kind === kind) return;
    if (workYoung(cur) || !cur.kind) { await putWork({ ...cur, kind }); return; }
    await switchWork({ kind, projectId: cur.projectId ?? null });
  } else {
    const prev = cur?.isBreak ? workBeforeBreak() : null;
    await switchWork({ kind, projectId: prev?.projectId ?? null });
  }
  showToast(`${kind} を始めました`, null);
}

// 案件のボタン（id が null なら「案件なし」）
async function pressWorkProject(projectId) {
  const cur = workRunning();
  if (cur && !cur.isBreak) {
    if ((cur.projectId ?? null) === projectId) return;
    if (workYoung(cur) || !cur.projectId) { await putWork({ ...cur, projectId }); return; }
    await switchWork({ kind: cur.kind ?? null, projectId });
  } else {
    const prev = cur?.isBreak ? workBeforeBreak() : null;
    await switchWork({ kind: prev?.kind ?? null, projectId });
  }
  showToast(`${workProjectLabel(projectId) || '案件なし'} を始めました`, null);
}

async function pressWorkBreak() {
  const cur = workRunning();
  if (cur?.isBreak) return;
  await switchWork({ isBreak: true });
  showToast('休憩を始めました', null);
}

// 休憩から戻る（休憩の前と同じ種類・案件で始める）
async function resumeWork() {
  const prev = workBeforeBreak();
  await switchWork({ kind: prev?.kind ?? null, projectId: prev?.projectId ?? null });
  showToast('作業に戻りました', null);
}

// 中身は後で決める
async function pressWorkBlank() {
  await switchWork({});
  showToast('始めました（種類・案件はあとで一覧から入れられます）', null);
}

async function endWork() {
  const cur = workRunning();
  if (!cur) return;
  const r = await putWork({ ...cur, endAt: nowIso() });
  showToast(`${workKindText(r) || '作業'} を終えました（${minText(workMinutes(r))}）`, null);
}

// 時刻の直し（"HH:MM" → その日の ISO）。終わりが始めより前なら翌日として扱う
function timeToIso(date, hm, after = null) {
  if (!/^\d{1,2}:\d{2}$/.test(hm)) return null;
  const [h, m] = hm.split(':').map(Number);
  const d = parseDate(date);
  d.setHours(h, m, 0, 0);
  if (after && d.getTime() < Date.parse(after)) d.setDate(d.getDate() + 1);
  return d.toISOString();
}

async function editWork(id, field, value) {
  const r = state.worklogs.get(id);
  if (!r) return;
  const next = { ...r };
  if (field === 'start') {
    const iso = timeToIso(r.date, value);
    if (!iso) return;
    next.startAt = iso;
  } else if (field === 'end') {
    if (!value) next.endAt = null;
    else {
      const iso = timeToIso(r.date, value, r.startAt);
      if (!iso) return;
      next.endAt = iso;
    }
  } else if (field === 'kind') {
    if (value === '\u0000break') { next.isBreak = true; next.kind = null; } else { next.isBreak = false; next.kind = value || null; }
  } else if (field === 'memo') next.memo = value.trim();
  else if (field === 'project') next.projectId = value || null;
  await putWork(next);
}

async function deleteWork(id) {
  const r = state.worklogs.get(id);
  if (!r) return;
  await putWork({ ...r, deletedAt: nowIso() });
  showToast(`${workKindText(r) || '作業'} ${hhmm(r.startAt)} の記録を消しました`, async () => { await putWork({ ...state.worklogs.get(id), deletedAt: null }); });
}

// 進行中の案件（納期の近い順）
const workActiveProjects = () => state.projects.filter((p) => p.status !== 'done')
  .sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999'));

function workProjectOptions(selected) {
  const active = state.projects.filter((p) => p.status !== 'done' || p.id === selected)
    .sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999'));
  return ['<option value="">（案件なし）</option>']
    .concat(active.map((p) => `<option value="${esc(p.id)}"${p.id === selected ? ' selected' : ''}>${esc(p.client)}｜${esc(p.title || '（無題）')}</option>`))
    .join('');
}

function workKindOptions(r) {
  const kinds = [...workKinds()];
  if (r.kind && !kinds.includes(r.kind)) kinds.push(r.kind); // 設定から外した種類も、記録にあれば選べる
  return [`<option value=""${!r.isBreak && !r.kind ? ' selected' : ''}>（種類なし）</option>`]
    .concat(kinds.map((k) => `<option value="${esc(k)}"${!r.isBreak && r.kind === k ? ' selected' : ''}>${esc(k)}</option>`))
    .concat(`<option value="\u0000break"${r.isBreak ? ' selected' : ''}>${BREAK_LABEL}</option>`)
    .join('');
}

// ---------- どのタブにも出る上の帯 ----------

function workStripText(cur) {
  if (cur.isBreak) return `${BREAK_LABEL}`;
  const p = workProjectLabel(cur.projectId);
  return [cur.kind || '（種類なし）', p].filter(Boolean).join('｜');
}

function renderWorkStrip() {
  const el = $('work-strip');
  if (!el) return;
  const cur = workRunning();
  el.hidden = !cur;
  if (!cur) { el.innerHTML = ''; return; }
  el.classList.toggle('is-break', !!cur.isBreak);
  el.innerHTML = `
    <button type="button" class="work-strip-main" data-strip="open" title="作業枠を開く">
      <span class="work-dot" aria-hidden="true"></span>
      <span class="work-strip-what">${esc(workStripText(cur))}</span>
      <span class="work-strip-time">${hhmm(cur.startAt)}〜 <b>${minText(workMinutes(cur))}</b></span>
    </button>
    ${cur.isBreak
      ? '<button type="button" class="ghost small" data-strip="resume">作業に戻る</button>'
      : '<button type="button" class="ghost small" data-strip="break">休憩</button>'}
    <button type="button" class="ghost small" data-strip="end">終わる</button>`;
}

// ---------- 作業枠タブ ----------

function renderWorkPad(cur) {
  const kinds = workKinds();
  const curKind = cur && !cur.isBreak ? cur.kind : null;
  const curProject = cur && !cur.isBreak ? (cur.projectId ?? null) : undefined;
  $('work-kind-btns').innerHTML = kinds.map((k) =>
    `<button type="button" class="work-btn${curKind === k ? ' on' : ''}" data-work-kind="${esc(k)}">${esc(k)}</button>`).join('')
    + `<button type="button" class="work-btn break${cur?.isBreak ? ' on' : ''}" data-work-break>${BREAK_LABEL}</button>`;
  const ps = workActiveProjects();
  $('work-project-btns').innerHTML = ps.map((p) =>
    `<button type="button" class="work-btn project${curProject === p.id ? ' on' : ''}" data-work-project="${esc(p.id)}" style="${clientStyle(p.client)}">
       <small>${esc(p.client)}</small>${esc(p.title || '（無題）')}</button>`).join('')
    + `<button type="button" class="work-btn project none${curProject === null ? ' on' : ''}" data-work-project="">案件なし</button>`;
  $('btn-work-blank').textContent = cur ? '終えて次を始める（中身はあとで）' : '始める（中身はあとで）';
  $('btn-work-end').hidden = !cur;
}

function renderWorkNow(cur) {
  const now = $('work-now');
  if (!cur) { now.innerHTML = '<div class="work-idle muted">いまは記録していません。下の種類・案件のボタンを押すと始まります</div>'; return; }
  const memo = workMemoOf(cur);
  now.innerHTML = `
    <div class="work-running${cur.isBreak ? ' is-break' : ''}">
      <div class="work-running-main">
        <span class="work-dot" aria-hidden="true"></span>
        <strong>${esc(cur.isBreak ? BREAK_LABEL : cur.kind || '（種類なし）')}</strong>
        ${cur.projectId ? `<span class="muted">${esc(workProjectLabel(cur.projectId))}</span>` : ''}
        ${memo ? `<span class="muted">・${esc(memo)}</span>` : ''}
      </div>
      <div class="work-running-time">${hhmm(cur.startAt)} から <b>${minText(workMinutes(cur))}</b></div>
    </div>`;
}

// 合計の表（name → 分）。累計（all）があれば右に添える
function workTable(title, rows, total, all = null) {
  if (!rows.length) return '';
  return `
    <div class="work-sum-block">
      <h4>${esc(title)}</h4>
      ${rows.map(([name, m, key]) => `
        <div class="work-sum-row">
          <span class="work-sum-name">${esc(name)}</span>
          <span class="work-sum-bar"><i style="width:${total ? Math.round((m / total) * 100) : 0}%"></i></span>
          <span class="work-sum-min">${minText(m)}</span>
          ${all ? `<span class="work-sum-all muted" title="これまでの合計">${key && all.has(key) ? `累計 ${minText(all.get(key))}` : ''}</span>` : ''}
        </div>`).join('')}
    </div>`;
}

function sumBy(list, keyOf) {
  const m = new Map();
  for (const r of list) {
    const k = keyOf(r);
    m.set(k, (m.get(k) ?? 0) + workMinutes(r));
  }
  return [...m].sort((a, b) => b[1] - a[1]);
}

function workSummaryHtml(list) {
  const works = list.filter((r) => !r.isBreak);
  const breaks = list.filter((r) => r.isBreak);
  const total = works.reduce((s, r) => s + workMinutes(r), 0);
  const rest = breaks.reduce((s, r) => s + workMinutes(r), 0);
  if (!list.length) return '';
  const byKind = sumBy(works, (r) => r.kind || '').map(([k, m]) => [k || '（種類なし）', m, k]);
  const allByProject = new Map(sumBy(workAll().filter((r) => !r.isBreak && r.projectId), (r) => r.projectId));
  const byProject = sumBy(works, (r) => r.projectId || '').map(([id, m]) => [workProjectLabel(id) || '（案件なし）', m, id]);
  return `
    <div class="work-totals">
      <span>作業 <b>${minText(total)}</b></span>
      <span class="muted">休憩 ${minText(rest)}</span>
    </div>
    <div class="work-sum-grid">
      ${workTable('種類ごと', byKind, total)}
      ${workTable('案件ごと', byProject, total, allByProject)}
    </div>`;
}

// 週は月曜から日曜
function workPeriod(date, unit) {
  const d = parseDate(date);
  if (unit === 'week') {
    const s = new Date(d);
    s.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    const e = new Date(s);
    e.setDate(s.getDate() + 6);
    return [fmtDate(s), fmtDate(e)];
  }
  if (unit === 'month') return [fmtDate(new Date(d.getFullYear(), d.getMonth(), 1)), fmtDate(new Date(d.getFullYear(), d.getMonth() + 1, 0))];
  return [date, date];
}

const dayLabel = (date) => `${date.slice(5).replace('-', '/')}（${'日月火水木金土'[parseDate(date).getDay()]}）`;

function renderWork() {
  if (state.tab !== 'work') return;
  work.date ??= todayStr();
  const today = todayStr();
  const cur = workRunning();
  renderWorkNow(cur);
  renderWorkPad(cur);

  for (const b of $('work-unit').querySelectorAll('button')) b.classList.toggle('active', b.dataset.unit === work.unit);
  const [from, to] = workPeriod(work.date, work.unit);
  $('work-date').textContent = work.unit === 'day'
    ? `${work.date === today ? '今日 ' : ''}${dayLabel(work.date)}`
    : work.unit === 'week' ? `${dayLabel(from)} 〜 ${dayLabel(to)}` : `${from.slice(0, 4)}年${Number(from.slice(5, 7))}月`;
  $('btn-work-next').disabled = to >= today;
  const list = workAll().filter((r) => r.date >= from && r.date <= to).sort((a, b) => (a.startAt ?? '').localeCompare(b.startAt ?? ''));
  $('work-summary').innerHTML = workSummaryHtml(list);

  if (work.unit === 'day') {
    $('work-list').innerHTML = list.length ? list.map((r) => {
      const memo = workMemoOf(r);
      const empty = !r.isBreak && !r.kind;
      return `
      <div class="card work-row${r.endAt ? '' : ' running'}${r.isBreak ? ' is-break' : ''}${empty ? ' needs-fill' : ''}" data-id="${esc(r.id)}">
        <select class="work-in-kind" aria-label="作業の種類">${workKindOptions(r)}</select>
        <div class="work-times">
          <input type="time" class="work-in-start" value="${hhmm(r.startAt)}" aria-label="始め">
          <span>〜</span>
          <input type="time" class="work-in-end" value="${hhmm(r.endAt)}" aria-label="終わり">
        </div>
        <div class="work-min">${minText(workMinutes(r))}</div>
        <select class="work-in-project" aria-label="案件"${r.isBreak ? ' disabled' : ''}>${workProjectOptions(r.projectId)}</select>
        <input class="work-in-memo" value="${esc(memo)}" maxlength="120" placeholder="一言メモ" aria-label="一言メモ">
        <button class="ghost work-del" aria-label="消す" title="消す">×</button>
      </div>`;
    }).join('') : '<div class="empty">この日の記録はありません</div>';
  } else {
    // 週・月は日ごとの合計（押すとその日を開く）
    const days = new Map();
    for (const r of list) {
      const d = days.get(r.date) ?? { work: 0, rest: 0 };
      if (r.isBreak) d.rest += workMinutes(r); else d.work += workMinutes(r);
      days.set(r.date, d);
    }
    const max = Math.max(1, ...[...days.values()].map((d) => d.work));
    $('work-list').innerHTML = days.size ? [...days].map(([date, d]) => `
      <button type="button" class="card work-day-row" data-work-day="${esc(date)}">
        <span>${dayLabel(date)}</span>
        <span class="work-sum-bar"><i style="width:${Math.round((d.work / max) * 100)}%"></i></span>
        <span class="work-sum-min">${minText(d.work)}</span>
        <span class="muted">休憩 ${minText(d.rest)}</span>
      </button>`).join('') : '<div class="empty">この間の記録はありません</div>';
  }
}

// 入力中に消えないよう、時間の表示だけを書き換える（30 秒ごと）
function renderWorkClock() {
  const cur = workRunning();
  const strip = document.querySelector('.work-strip-time b');
  if (cur && strip) strip.textContent = minText(workMinutes(cur));
  if (state.tab !== 'work') return;
  const b = document.querySelector('.work-running-time b');
  if (cur && b) b.textContent = minText(workMinutes(cur));
  const row = cur && document.querySelector(`.work-row[data-id="${CSS.escape(cur.id)}"] .work-min`);
  if (row) row.textContent = minText(workMinutes(cur));
}

function moveWorkDate(step) {
  const d = parseDate(work.date);
  if (work.unit === 'day') d.setDate(d.getDate() + step);
  else if (work.unit === 'week') d.setDate(d.getDate() + step * 7);
  else { d.setDate(1); d.setMonth(d.getMonth() + step); }
  const s = fmtDate(d);
  work.date = s > todayStr() ? todayStr() : s;
  renderWork();
}

// 設定画面：作業の種類（足す・外す・並べ替え）
function renderWorkKindList() {
  const list = workKinds();
  $('work-kind-list').innerHTML = list.map((n, i) => `
    <span class="editor-pill">${esc(n)}
      ${i > 0 ? `<button type="button" data-kind-up="${i}" aria-label="${esc(n)}を前へ" title="前へ">‹</button>` : ''}
      <button type="button" data-kind-remove="${i}" aria-label="${esc(n)}を外す" title="外す（記録はそのまま）">✕</button>
    </span>`).join('');
}

function bindWorkKinds() {
  $('work-kind-add-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('work-kind-add-name').value.trim();
    if (!name) { $('work-kind-add-name').focus(); return; }
    if (name === BREAK_LABEL) { showToast('「休憩」は初めからあります', null); return; }
    if (!workKinds().includes(name)) updateSettings({ workKinds: [...workKinds(), name] });
    $('work-kind-add-name').value = '';
    renderWorkKindList();
    renderAll();
  });
  $('work-kind-list').addEventListener('click', (e) => {
    const rm = e.target.closest('[data-kind-remove]');
    const up = e.target.closest('[data-kind-up]');
    const list = [...workKinds()];
    if (rm) {
      const i = Number(rm.dataset.kindRemove);
      if (list.length <= 1) { showToast('種類は 1 つは残してください', null); return; }
      if (!confirm(`作業の種類から「${list[i]}」を外します（今までの記録はそのまま残ります）`)) return;
      list.splice(i, 1);
    } else if (up) {
      const i = Number(up.dataset.kindUp);
      [list[i - 1], list[i]] = [list[i], list[i - 1]];
    } else return;
    updateSettings({ workKinds: list });
    renderWorkKindList();
    renderAll();
  });
}

function bindWork() {
  bindWorkKinds();
  $('work-kind-btns').addEventListener('click', (e) => {
    const k = e.target.closest('[data-work-kind]');
    if (k) pressWorkKind(k.dataset.workKind);
    else if (e.target.closest('[data-work-break]')) pressWorkBreak();
  });
  $('work-project-btns').addEventListener('click', (e) => {
    const b = e.target.closest('[data-work-project]');
    if (b) pressWorkProject(b.dataset.workProject || null);
  });
  $('btn-work-blank').addEventListener('click', pressWorkBlank);
  $('btn-work-end').addEventListener('click', endWork);
  $('work-strip').addEventListener('click', (e) => {
    const b = e.target.closest('[data-strip]');
    if (!b) return;
    const a = b.dataset.strip;
    if (a === 'open') { work.date = todayStr(); work.unit = 'day'; setTab('work'); }
    else if (a === 'break') pressWorkBreak();
    else if (a === 'resume') resumeWork();
    else if (a === 'end') endWork();
  });
  $('work-unit').addEventListener('click', (e) => {
    const b = e.target.closest('[data-unit]');
    if (!b) return;
    work.unit = b.dataset.unit;
    renderWork();
  });
  $('btn-work-prev').addEventListener('click', () => moveWorkDate(-1));
  $('btn-work-next').addEventListener('click', () => moveWorkDate(1));
  $('btn-work-today').addEventListener('click', () => { work.date = todayStr(); renderWork(); });
  const list = $('work-list');
  list.addEventListener('change', (e) => {
    const id = e.target.closest('.work-row')?.dataset.id;
    if (!id) return;
    const f = e.target.classList;
    if (f.contains('work-in-start')) editWork(id, 'start', e.target.value);
    else if (f.contains('work-in-end')) editWork(id, 'end', e.target.value);
    else if (f.contains('work-in-kind')) editWork(id, 'kind', e.target.value);
    else if (f.contains('work-in-memo')) editWork(id, 'memo', e.target.value);
    else if (f.contains('work-in-project')) editWork(id, 'project', e.target.value);
  });
  list.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.classList.contains('work-in-memo')) e.target.blur(); });
  list.addEventListener('click', (e) => {
    const b = e.target.closest('.work-del');
    if (b) { deleteWork(b.closest('.work-row').dataset.id); return; }
    const day = e.target.closest('[data-work-day]');
    if (day) { work.date = day.dataset.workDay; work.unit = 'day'; renderWork(); }
  });
  // 経過の分を進める（どのタブでも上の帯に出ているので、ずっと動かす）
  clearInterval(work.tick);
  work.tick = setInterval(renderWorkClock, 30000);
  // ほかのタブ・アプリから戻った時に経過を合わせる
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { renderWorkStrip(); if (state.tab === 'work') renderWork(); } });
}
