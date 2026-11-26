// Claude 連携：マイドライブの「案件管理（Claude連携）」フォルダを通して、Claude（仮想カンパニー）とデータをやりとりする
//   anken-kanri.json  … アプリが同期のたびに書く「写し」（Claude は読むだけ）
//   claude-inbox.json … Claude が変更（パッチ）を書く「受け箱」（アプリは読むだけ。作るのだけアプリ）
// どちらのファイルも書く側が 1 つだけなので、同時に書いて壊れることがない。
// 受け箱のパッチは、項目ごとに「Claude が見た前の値（before）」と比べて当てる（3 方向の統合）：
//   いまの値 = before → 当てる ／ いまの値 = after → もう当たっている
//   どちらでもない（アプリ側でも変えた）→ 後から変えた方を残す（同じ時刻ならアプリ）
// 当てた結果は写しの claude.results に残し、Claude はそれを見て受け箱から消す。

const LINK_FOLDER = '案件管理（Claude連携）';
const LINK_MIRROR = 'anken-kanri.json';
const LINK_INBOX = 'claude-inbox.json';

// Claude が変えてよい項目（案件）
const LINK_FIELDS = ['client', 'title', 'kind', 'unitPrice', 'count', 'priceUnit', 'minutes', 'extras', 'startDate', 'dueDate',
  'billingMonth', 'memo', 'progress', 'request', 'stage', 'draftAt', 'revisionAt', 'status', 'completedAt', 'editor', 'feeUnit', 'outsources',
  'invoicedAt', 'invoiceSnapshot', 'deliveries'];
const LINK_REQUIRED = ['client', 'kind', 'unitPrice', 'count', 'startDate', 'dueDate', 'billingMonth'];
// 請求書・振込の状態（請求月 × クライアント）で Claude が変えてよい項目
const LINK_INVOICE_FIELDS = ['invoicedAt', 'paidAt', 'snapshot'];
// 設定で Claude が変えられない所（アイコンの画像はアプリが取る）
const LINK_SETTINGS_LOCKED = ['clientIcons', 'updatedAt'];

const Link = {
  ids: null,          // { folder, mirror, inbox }
  log: [],            // この端末でのできごと（新しい順、最大 100）
  lastAt: null,
  lastError: '',
  onChange: null,
  iconQueue: new Set(), // アイコンを取り直すクライアント
};

const linkEnabled = () => syncPref('claudeLink') === '1';

// この端末の見分け方：種類（スマホ・タブレット・PC）と OS・ブラウザ＋端末ごとの短い印（同じ種類の端末が 2 台でも分かる）
function deviceLabel(ua = navigator.userAgent, touch = navigator.maxTouchPoints || 0) {
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) || (/Macintosh/.test(ua) && touch > 1) ? 'iPad'
    : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '不明';
  const kind = os === 'iPhone' || (os === 'Android' && /Mobile/.test(ua)) ? 'スマホ'
    : os === 'iPad' || os === 'Android' ? 'タブレット' : 'PC';
  const browser = /Edg\//.test(ua) ? 'Edge' : /SamsungBrowser/.test(ua) ? 'Samsung' : /CriOS|Chrome\//.test(ua) ? 'Chrome'
    : /FxiOS|Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '';
  return `${kind}（${os}${browser ? `・${browser}` : ''}）`;
}

function deviceInfo() {
  let id = syncPref('claudeDeviceId');
  if (!id) { id = Math.random().toString(36).slice(2, 6); syncPref('claudeDeviceId', id); }
  return { id, label: deviceLabel() };
}
const deviceText = (d) => (d ? `${d.label} #${d.id}` : '不明な端末');

function linkLog(kind, text) {
  Link.log.unshift({ at: new Date().toISOString(), kind, text });
  Link.log.length = Math.min(Link.log.length, 100);
  try { localStorage.setItem('claudeLinkLog', JSON.stringify(Link.log)); } catch { /* 保存できなくても続ける */ }
  Link.onChange?.();
}

function loadLinkState() {
  try { Link.log = JSON.parse(localStorage.getItem('claudeLinkLog') || '[]'); } catch { Link.log = []; }
  try { Link.ids = JSON.parse(localStorage.getItem('claudeLinkIds') || 'null'); } catch { Link.ids = null; }
}

const linkEq = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// ---------- パッチを当てる（ドライブを使わない純粋な処理） ----------
// 操作（op）:
//   add      … 案件を足す（project）
//   update   … 案件の項目を変える（projectId・before・after）
//   delete   … 案件をゴミ箱に移す（projectId・seen＝Claude が見た updatedAt）。設定画面のゴミ箱から戻せる
//   restore  … ゴミ箱から戻す（projectId。ゴミ箱に中身が無い時は project）
//   invoice  … 請求書・振込の状態（key＝"YYYY-MM|クライアント"・before・after。invoicedAt・paidAt・snapshot）
//   settings … 設定（changes＝[{ path: [...], before, after, remove }]。単価タブ・委託先・請求書の設定・ファイル名の決まりなど）
//   import   … 読み込みと同じ置き換え（data）。消える案件はゴミ箱へ

const linkGet = (obj, path) => path.reduce((o, k) => (o == null ? undefined : o[k]), obj);

// path の所だけを書き換えた新しい物（途中の物は写してから変える）
function linkSet(obj, path, value, remove = false) {
  const root = { ...(obj ?? {}) };
  let cur = root;
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i];
    const next = cur[k];
    cur[k] = Array.isArray(next) ? [...next] : next && typeof next === 'object' ? { ...next } : {};
    cur = cur[k];
  }
  const last = path[path.length - 1];
  if (remove) {
    if (Array.isArray(cur)) cur.splice(Number(last), 1); else delete cur[last];
  } else cur[last] = value;
  return root;
}

// 作業枠で Claude が変えられる項目（0.21.0）
const LINK_WORKLOG_FIELDS = ['date', 'label', 'projectId', 'planMin', 'startAt', 'endAt', 'deletedAt'];
const pickWorkFields = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => LINK_WORKLOG_FIELDS.includes(k)));

// data: { projects, invoices, deleted, worklogs, settings }、patches: 受け箱の中身、doneIds: もう処理したパッチの id
// 返り値: { data, results, changed, iconClients }
function applyClaudePatches(data, patches, doneIds, now = new Date().toISOString()) {
  let projects = data.projects.map((p) => ({ ...p }));
  const invoices = new Map((data.invoices ?? []).map((r) => [r.key, { ...r }]));
  const deleted = new Map((data.deleted ?? []).map((d) => [d.id, { ...d }]));
  const worklogs = new Map((data.worklogs ?? []).map((r) => [r.id, { ...r }]));
  let settings = data.settings ?? null;
  const results = [];
  const iconClients = new Set();
  let changed = false;
  const sorted = [...patches].filter((x) => x && x.id && !doneIds.has(x.id)).sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''));
  for (const patch of sorted) {
    const by = patch.by ?? 'Claude';
    const res = { id: patch.id, at: now, by, op: patch.op, result: 'applied', detail: '' };
    // 3 方向の統合：いまの値が before のまま、または Claude の方が後なら当てる（同じ時刻ならアプリ）
    const decide = (cur, before, hasBefore, after, stamp) => {
      if (linkEq(cur, after)) return 'same';
      if ((hasBefore && linkEq(cur, before)) || (patch.at ?? '') > (stamp ?? '')) return 'set';
      return 'keep';
    };
    const finish = (set, kept) => {
      if (kept.length) {
        res.result = set.length ? 'partial' : 'conflict';
        res.detail = `アプリで後から変わっていたので、アプリの値を残した: ${kept.join('・')}`;
      } else if (!set.length) { res.result = 'already'; res.detail = 'もう同じ値'; }
      res.fields = set;
    };
    try {
      if (patch.op === 'add') {
        const p = patch.project ?? {};
        const missing = LINK_REQUIRED.filter((k) => p[k] == null || p[k] === '');
        if (!p.id) throw new Error('id がありません');
        if (missing.length) throw new Error(`足りない項目: ${missing.join('・')}`);
        res.projectId = p.id;
        res.title = p.title ?? '';
        if (projects.some((x) => x.id === p.id)) { res.result = 'already'; res.detail = 'もう追加済み'; }
        else if (deleted.has(p.id)) { res.result = 'skipped'; res.detail = 'アプリで削除済み'; }
        else {
          const rec = { title: '', priceUnit: 'video', minutes: null, extras: [], memo: '', stage: null, status: 'active', completedAt: null };
          for (const k of LINK_FIELDS) if (p[k] !== undefined) rec[k] = p[k];
          projects.push({ ...rec, id: p.id, createdAt: patch.at ?? now, updatedAt: now, changedBy: by });
          changed = true;
        }
      } else if (patch.op === 'update') {
        res.projectId = patch.projectId;
        const i = projects.findIndex((x) => x.id === patch.projectId);
        if (i < 0) {
          res.result = 'skipped';
          res.detail = deleted.has(patch.projectId) ? 'アプリで削除済み' : '案件が見つかりません';
        } else {
          const p = projects[i];
          res.title = p.title ?? '';
          const after = patch.after ?? {};
          const before = patch.before ?? {};
          const set = [];
          const kept = [];
          for (const k of Object.keys(after)) {
            if (!LINK_FIELDS.includes(k)) { kept.push(`${k}（変えられない項目）`); continue; }
            const d = decide(p[k], before[k], k in before, after[k], p.updatedAt);
            if (d === 'set') set.push(k); else if (d === 'keep') kept.push(k);
          }
          if (set.length) {
            const np = { ...p, updatedAt: now, changedBy: by };
            for (const k of set) np[k] = after[k];
            projects[i] = np;
            changed = true;
          }
          finish(set, kept);
        }
      } else if (patch.op === 'delete') {
        res.projectId = patch.projectId;
        const p = projects.find((x) => x.id === patch.projectId);
        if (!p) {
          const inTrash = deleted.has(patch.projectId);
          res.result = inTrash ? 'already' : 'skipped';
          res.detail = inTrash ? 'もうゴミ箱にある' : '案件が見つかりません';
        } else {
          res.title = p.title ?? '';
          // Claude が見た後にアプリで変えていたら消さない（変えた内容を確かめてからにする）
          if (patch.seen != null && (p.updatedAt ?? '') !== patch.seen && (p.updatedAt ?? '') > (patch.at ?? '')) {
            res.result = 'conflict';
            res.detail = 'Claude が見た後にアプリで変わっていたので、消さなかった';
          } else {
            projects = projects.filter((x) => x.id !== p.id);
            deleted.set(p.id, { id: p.id, deletedAt: now, by, project: p });
            changed = true;
            res.detail = 'ゴミ箱に移した（設定 › ゴミ箱から戻せる）';
          }
        }
      } else if (patch.op === 'restore') {
        res.projectId = patch.projectId;
        if (projects.some((x) => x.id === patch.projectId)) { res.result = 'already'; res.detail = 'もう戻っている'; }
        else {
          const snap = deleted.get(patch.projectId)?.project ?? patch.project;
          if (!snap) throw new Error('ゴミ箱に中身がありません');
          res.title = snap.title ?? '';
          projects.push({ ...snap, id: patch.projectId, updatedAt: now, changedBy: by });
          changed = true;
        }
      } else if (patch.op === 'invoice') {
        const key = patch.key ?? '';
        if (!/^\d{4}-\d{2}\|./.test(key)) throw new Error(`請求の key が変です: ${key}`);
        const [month, client] = [key.slice(0, 7), key.slice(8)];
        res.key = key;
        res.title = `${month} ${client}`;
        const r = invoices.get(key) ?? { key, month, client, invoicedAt: null, paidAt: null };
        const after = patch.after ?? {};
        const before = patch.before ?? {};
        const set = [];
        const kept = [];
        for (const k of Object.keys(after)) {
          if (!LINK_INVOICE_FIELDS.includes(k)) { kept.push(`${k}（変えられない項目）`); continue; }
          const d = decide(r[k] ?? null, before[k] ?? null, k in before, after[k], r.updatedAt);
          if (d === 'set') set.push(k); else if (d === 'keep') kept.push(k);
        }
        if (set.length) {
          const nr = { ...r, updatedAt: now, changedBy: by };
          for (const k of set) nr[k] = after[k];
          invoices.set(key, nr);
          changed = true;
        }
        finish(set, kept);
      } else if (patch.op === 'settings') {
        res.title = '設定';
        const set = [];
        const kept = [];
        let next = settings;
        for (const c of patch.changes ?? []) {
          const path = Array.isArray(c.path) ? c.path.map(String) : [];
          const name = path.join('.');
          if (!path.length || LINK_SETTINGS_LOCKED.includes(path[0])) { kept.push(`${name}（変えられない項目）`); continue; }
          const cur = linkGet(next, path);
          let d;
          if (c.remove) d = cur === undefined ? 'same' : (('before' in c && linkEq(cur, c.before)) || (patch.at ?? '') > (settings?.updatedAt ?? '')) ? 'set' : 'keep';
          else d = decide(cur, c.before, 'before' in c, c.after, settings?.updatedAt);
          if (d === 'set') {
            next = linkSet(next, path, c.after, !!c.remove);
            set.push(name);
            if (path[0] === 'clientLinks' && path[1]) iconClients.add(path[1]);
          } else if (d === 'keep') kept.push(name);
        }
        if (set.length) {
          settings = { ...next, updatedAt: now };
          changed = true;
        }
        finish(set, kept);
      } else if (patch.op === 'import') {
        // 設定画面の「読み込み」と同じ置き換え。消える案件はゴミ箱に入れる
        const d = patch.data ?? {};
        const list = Array.isArray(d) ? d : d.projects;
        if (!Array.isArray(list)) throw new Error('案件データがありません');
        res.title = `読み込み ${list.length}件`;
        const keepIds = new Set(list.map((p) => p.id));
        for (const p of projects) if (!keepIds.has(p.id)) deleted.set(p.id, { id: p.id, deletedAt: now, by, project: p });
        for (const id of keepIds) deleted.delete(id);
        projects = list.map((p) => ({ ...p, updatedAt: now, changedBy: by }));
        for (const [k, r] of invoices) invoices.set(k, { ...r, invoicedAt: null, paidAt: null, updatedAt: now });
        for (const r of Array.isArray(d.invoices) ? d.invoices : []) invoices.set(r.key, { ...r, updatedAt: now });
        if (d.settings) {
          const icons = settings?.clientIcons;
          settings = { ...d.settings, ...(icons && !d.settings.clientIcons ? { clientIcons: icons } : {}), updatedAt: now };
        }
        changed = true;
      } else if (patch.op === 'worklog') {
        // 作業枠の記録（0.21.0）：秘書が「枠1 始め」「枠1 終わり」を聞いて書く。項目ごとに 3 方向で当てる
        const after = patch.after ?? {};
        const before = patch.before ?? {};
        const id = patch.logId ?? '';
        if (!id) throw new Error('logId がありません');
        const cur = worklogs.get(id);
        res.title = `作業枠 ${after.label ?? cur?.label ?? ''}`.trim();
        if (!cur) {
          if (!after.startAt || !after.date) throw new Error('新しい作業枠には date と startAt が要ります');
          worklogs.set(id, { id, label: '', projectId: null, planMin: null, endAt: null, deletedAt: null, ...pickWorkFields(after), updatedAt: now, changedBy: by });
          res.fields = Object.keys(pickWorkFields(after));
          changed = true;
        } else {
          const set = [];
          const kept = [];
          for (const k of Object.keys(after)) {
            if (!LINK_WORKLOG_FIELDS.includes(k)) { kept.push(`${k}（変えられない項目）`); continue; }
            const d = decide(cur[k] ?? null, before[k] ?? null, k in before, after[k], cur.updatedAt);
            if (d === 'set') set.push(k); else if (d === 'keep') kept.push(k);
          }
          if (set.length) {
            const nr = { ...cur, updatedAt: now, changedBy: by };
            for (const k of set) nr[k] = after[k];
            worklogs.set(id, nr);
            changed = true;
          }
          finish(set, kept);
        }
      } else {
        throw new Error(`知らない操作: ${patch.op}`);
      }
    } catch (e) {
      res.result = 'error';
      res.detail = e.message;
    }
    results.push(res);
  }
  return {
    data: { ...data, projects, invoices: [...invoices.values()], deleted: [...deleted.values()], worklogs: [...worklogs.values()], settings },
    results, changed, iconClients: [...iconClients],
  };
}

// ---------- ドライブ（マイドライブのフォルダ） ----------

async function linkFind(name, parent, folder = false) {
  const q = [`name='${name.replaceAll("'", "\\'")}'`, 'trashed=false',
    folder ? "mimeType='application/vnd.google-apps.folder'" : "mimeType!='application/vnd.google-apps.folder'",
    parent ? `'${parent}' in parents` : null].filter(Boolean).join(' and ');
  const res = await drive(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,createdTime)&orderBy=createdTime`);
  return (await res.json()).files?.[0]?.id ?? null;
}

async function linkCreate(meta, content) {
  if (content === undefined) {
    const res = await drive('https://www.googleapis.com/drive/v3/files?fields=id', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(meta),
    });
    return (await res.json()).id;
  }
  const b = `anken${Date.now()}`;
  const body = `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}`
    + `\r\n--${b}\r\nContent-Type: application/json\r\n\r\n${content}\r\n--${b}--`;
  const res = await drive('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
    method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${b}` }, body,
  });
  return (await res.json()).id;
}

async function linkEnsureIds() {
  if (Link.ids?.folder && Link.ids?.mirror && Link.ids?.inbox) return Link.ids;
  const ids = {};
  ids.folder = await linkFind(LINK_FOLDER, null, true)
    ?? await linkCreate({ name: LINK_FOLDER, mimeType: 'application/vnd.google-apps.folder' });
  ids.mirror = await linkFind(LINK_MIRROR, ids.folder)
    ?? await linkCreate({ name: LINK_MIRROR, parents: [ids.folder] }, '{}');
  ids.inbox = await linkFind(LINK_INBOX, ids.folder)
    ?? await linkCreate({ name: LINK_INBOX, parents: [ids.folder] }, JSON.stringify({ app: 'anken-kanri-inbox', version: 1, patches: [] }, null, 2));
  Link.ids = ids;
  try { localStorage.setItem('claudeLinkIds', JSON.stringify(ids)); } catch { /* 次回また探す */ }
  return ids;
}

async function linkReadJson(id) {
  const res = await drive(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`);
  const text = await res.text();
  try { return JSON.parse(text.replace(/^﻿/, '') || '{}'); } catch { throw new Error(`${id === Link.ids?.inbox ? LINK_INBOX : LINK_MIRROR} が JSON として読めません`); }
}

// 同期の中で呼ぶ：受け箱を読んで当て、写しを書く。merged を受け取り、当てた後のデータを返す
async function claudeExchange(merged) {
  let ids;
  try { ids = await linkEnsureIds(); } catch (e) {
    // 消されたフォルダ・ファイルを覚えていたら、次は探し直す
    if (/ 404/.test(e.message)) { Link.ids = null; try { localStorage.removeItem('claudeLinkIds'); } catch { /* */ } }
    throw e;
  }
  let mirror, inbox;
  try {
    [mirror, inbox] = await Promise.all([linkReadJson(ids.mirror), linkReadJson(ids.inbox)]);
  } catch (e) {
    if (/ 404/.test(e.message)) { Link.ids = null; try { localStorage.removeItem('claudeLinkIds'); } catch { /* */ } }
    throw e;
  }
  const prevResults = Array.isArray(mirror?.claude?.results) ? mirror.claude.results : [];
  const doneIds = new Set(prevResults.map((r) => r.id));
  const patches = Array.isArray(inbox?.patches) ? inbox.patches : [];
  const device = deviceInfo();
  const { data, results, changed, iconClients } = applyClaudePatches(merged, patches, doneIds);
  // YouTube・X のリンクを Claude が変えたクライアントは、取り込んだ後にアプリがアイコンを取り直す
  for (const c of iconClients) Link.iconQueue.add(c);
  for (const r of results) {
    r.device = device;
    const name = r.title ? `「${r.title}」` : '';
    const label = { applied: '取り込んだ', partial: '一部取り込んだ', already: '取り込み済み', conflict: '競合（アプリの値を残した）', skipped: '取り込まなかった', error: 'エラー' }[r.result];
    linkLog(r.result === 'error' || r.result === 'conflict' ? 'warn' : 'info',
      `${r.by}の変更${name}を${label}${r.fields?.length ? `（${r.fields.join('・')}）` : ''}${r.detail ? `：${r.detail}` : ''}`);
  }
  const { clientIcons, ...settingsLite } = data.settings ?? {};
  const savedAt = new Date().toISOString();
  // どの端末がいつ書いたか（新しい順に 50 回分）
  const writes = [{ at: savedAt, ...device }, ...(Array.isArray(mirror?.writes) ? mirror.writes : [])].slice(0, 50);
  const payload = {
    app: 'anken-kanri-mirror', version: 1, appVersion: typeof APP_VERSION === 'string' ? APP_VERSION : '',
    savedAt, device, writes,
    note: 'アプリが同期のたびに書く写し。Claude は読むだけで、変更は claude-inbox.json に書く',
    data: { projects: data.projects, invoices: data.invoices, deleted: data.deleted, worklogs: data.worklogs ?? [], settings: data.settings ? settingsLite : null },
    claude: { results: [...results, ...prevResults].slice(0, 300) },
  };
  await drive(`https://www.googleapis.com/upload/drive/v3/files/${ids.mirror}?uploadType=media`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload, null, 1),
  });
  Link.lastAt = new Date();
  Link.lastError = '';
  if (!prevResults.length && !results.length && !Link.log.length) linkLog('info', '連携フォルダに写しを書きました');
  Link.onChange?.();
  return { data, changed };
}
