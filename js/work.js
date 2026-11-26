// 作業枠タブ（0.21.0）：枠の始めと終わりを押して、その日に何分使ったかを残す
// 記録 1 件 = { id, date: "YYYY-MM-DD", label: "枠1", projectId, planMin, startAt, endAt, deletedAt, updatedAt, changedBy }
// app.js より先に読み込む（中の関数は呼ばれた時に app.js の state などを使う）

const work = { date: null, tick: null };

const workAll = () => [...state.worklogs.values()].filter((r) => !r.deletedAt);
const workOfDay = (date) => workAll().filter((r) => r.date === date).sort((a, b) => (a.startAt ?? '').localeCompare(b.startAt ?? ''));
const workRunning = () => workAll().filter((r) => !r.endAt).sort((a, b) => (b.startAt ?? '').localeCompare(a.startAt ?? ''))[0] ?? null;

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

// 「枠1」「枠2」…（その日の数＋1）
function nextWorkLabel(date) {
  const used = workOfDay(date).map((r) => Number((/^枠\s*(\d+)/.exec(r.label ?? '') ?? [])[1])).filter(Number.isFinite);
  return `枠${used.length ? Math.max(...used) + 1 : 1}`;
}

async function putWork(r) {
  r = { ...r, updatedAt: nowIso(), changedBy: 'アプリ' };
  state.worklogs.set(r.id, r);
  await saveWorklog(r);
  renderAll(); // タブの「走っている」印も合わせる
  scheduleSync();
  return r;
}

async function startWork() {
  const date = todayStr();
  const label = $('work-label').value.trim() || nextWorkLabel(date);
  const plan = Number($('work-plan').value);
  const projectId = $('work-project').value || null;
  const cur = workRunning();
  // 走っている枠があれば、先に終える（同時に 2 つは走らせない）
  if (cur) await putWork({ ...cur, endAt: nowIso() });
  work.date = date;
  await putWork({
    id: newId(), date, label, projectId, planMin: plan > 0 ? Math.round(plan) : null,
    startAt: nowIso(), endAt: null, deletedAt: null,
  });
  $('work-label').value = '';
  $('work-plan').value = '';
  $('work-project').value = '';
  showToast(`${label} を始めました`, null);
}

async function endWork() {
  const cur = workRunning();
  if (!cur) return;
  const r = await putWork({ ...cur, endAt: nowIso() });
  showToast(`${r.label} を終えました（${minText(workMinutes(r))}）`, null);
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
  } else if (field === 'label') next.label = value.trim() || r.label;
  else if (field === 'plan') next.planMin = Number(value) > 0 ? Math.round(Number(value)) : null;
  else if (field === 'project') next.projectId = value || null;
  await putWork(next);
}

async function deleteWork(id) {
  const r = state.worklogs.get(id);
  if (!r) return;
  await putWork({ ...r, deletedAt: nowIso() });
  showToast(`${r.label} を消しました`, async () => { await putWork({ ...state.worklogs.get(id), deletedAt: null }); });
}

function workProjectOptions(selected) {
  const active = state.projects.filter((p) => p.status !== 'done' || p.id === selected)
    .sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999'));
  return ['<option value="">（案件なし）</option>']
    .concat(active.map((p) => `<option value="${esc(p.id)}"${p.id === selected ? ' selected' : ''}>${esc(p.client)}｜${esc(p.title || '（無題）')}</option>`))
    .join('');
}

const workProjectLabel = (id) => {
  const p = id ? byId(id) : null;
  return p ? `${p.client}｜${p.title || '（無題）'}` : '';
};

function renderWork() {
  if (state.tab !== 'work') return;
  work.date ??= todayStr();
  const today = todayStr();
  const cur = workRunning();
  // いま走っている枠
  const now = $('work-now');
  if (cur) {
    const m = workMinutes(cur);
    const over = cur.planMin && m > cur.planMin;
    now.innerHTML = `
      <div class="work-running">
        <div class="work-running-main">
          <span class="work-dot" aria-hidden="true"></span>
          <strong>${esc(cur.label)}</strong>
          ${cur.projectId ? `<span class="muted">${esc(workProjectLabel(cur.projectId))}</span>` : ''}
        </div>
        <div class="work-running-time${over ? ' over' : ''}">
          ${hhmm(cur.startAt)} から <b>${minText(m)}</b>${cur.planMin ? ` <span class="muted">／ 予定 ${minText(cur.planMin)}</span>` : ''}
        </div>
        <button class="primary work-end-btn" id="btn-work-end">終わる</button>
      </div>`;
    $('btn-work-end').addEventListener('click', endWork);
  } else now.innerHTML = '';
  $('work-start-form').hidden = false;
  $('work-label').placeholder = nextWorkLabel(today);
  $('btn-work-start').textContent = cur ? '終えて次を始める' : '始める';
  const sel = $('work-project');
  const keep = sel.value;
  sel.innerHTML = workProjectOptions(keep);
  sel.value = keep;

  // 日ごとの一覧
  $('work-date').textContent = `${work.date === today ? '今日 ' : ''}${work.date.slice(5).replace('-', '/')}（${'日月火水木金土'[parseDate(work.date).getDay()]}）`;
  $('btn-work-next').disabled = work.date >= today;
  const list = workOfDay(work.date);
  const total = list.reduce((s, r) => s + workMinutes(r), 0);
  const plan = list.reduce((s, r) => s + (r.planMin ?? 0), 0);
  $('work-summary').textContent = list.length
    ? `${list.length}枠 ・ 合計 ${minText(total)}${plan ? `（予定 ${minText(plan)}）` : ''}`
    : '';
  $('work-list').innerHTML = list.length ? list.map((r) => {
    const m = workMinutes(r);
    const diff = r.planMin ? m - r.planMin : null;
    return `
      <div class="card work-row${r.endAt ? '' : ' running'}" data-id="${esc(r.id)}">
        <input class="work-in-label" value="${esc(r.label)}" aria-label="枠の名前">
        <div class="work-times">
          <input type="time" class="work-in-start" value="${hhmm(r.startAt)}" aria-label="始め">
          <span>〜</span>
          <input type="time" class="work-in-end" value="${hhmm(r.endAt)}" aria-label="終わり">
        </div>
        <div class="work-min">${minText(m)}${diff !== null ? ` <small class="${diff > 0 ? 'over' : 'under'}">${diff > 0 ? '+' : ''}${diff}分</small>` : ''}</div>
        <select class="work-in-project" aria-label="案件">${workProjectOptions(r.projectId)}</select>
        <input type="number" class="work-in-plan" min="0" step="5" value="${r.planMin ?? ''}" placeholder="予定(分)" aria-label="予定の分">
        <button class="ghost work-del" aria-label="消す" title="消す">×</button>
      </div>`;
  }).join('') : '<div class="empty">この日の記録はありません</div>';

  // 走っている間は 1 分ごとに表示を進める
  clearInterval(work.tick);
  if (cur) work.tick = setInterval(() => { if (state.tab === 'work') renderWorkClock(); else clearInterval(work.tick); }, 30000);
}

// 入力中に消えないよう、時間の表示だけを書き換える
function renderWorkClock() {
  const cur = workRunning();
  const b = document.querySelector('.work-running-time b');
  if (cur && b) b.textContent = minText(workMinutes(cur));
  const row = cur && document.querySelector(`.work-row[data-id="${CSS.escape(cur.id)}"] .work-min`);
  if (row) row.firstChild.textContent = minText(workMinutes(cur));
}

function bindWork() {
  $('btn-work-start').addEventListener('click', startWork);
  $('work-label').addEventListener('keydown', (e) => { if (e.key === 'Enter') startWork(); });
  $('btn-work-prev').addEventListener('click', () => { work.date = fmtDate(new Date(parseDate(work.date).getTime() - 86400000)); renderWork(); });
  $('btn-work-next').addEventListener('click', () => {
    const d = fmtDate(new Date(parseDate(work.date).getTime() + 86400000));
    work.date = d > todayStr() ? todayStr() : d;
    renderWork();
  });
  $('btn-work-today').addEventListener('click', () => { work.date = todayStr(); renderWork(); });
  const list = $('work-list');
  list.addEventListener('change', (e) => {
    const id = e.target.closest('.work-row')?.dataset.id;
    if (!id) return;
    const f = e.target.classList;
    if (f.contains('work-in-start')) editWork(id, 'start', e.target.value);
    else if (f.contains('work-in-end')) editWork(id, 'end', e.target.value);
    else if (f.contains('work-in-label')) editWork(id, 'label', e.target.value);
    else if (f.contains('work-in-plan')) editWork(id, 'plan', e.target.value);
    else if (f.contains('work-in-project')) editWork(id, 'project', e.target.value);
  });
  list.addEventListener('click', (e) => {
    const b = e.target.closest('.work-del');
    if (b) deleteWork(b.closest('.work-row').dataset.id);
  });
  // ほかのタブ・アプリから戻った時に経過を合わせる
  document.addEventListener('visibilitychange', () => { if (!document.hidden && state.tab === 'work') renderWork(); });
}
