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
const FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

// Claude が変えてよい項目
const LINK_FIELDS = ['client', 'title', 'kind', 'unitPrice', 'count', 'priceUnit', 'minutes', 'extras', 'startDate', 'dueDate',
  'billingMonth', 'memo', 'progress', 'stage', 'draftAt', 'revisionAt', 'status', 'completedAt', 'editor', 'feeUnit'];
const LINK_REQUIRED = ['client', 'kind', 'unitPrice', 'count', 'startDate', 'dueDate', 'billingMonth'];

const Link = {
  ids: null,          // { folder, mirror, inbox }
  log: [],            // この端末でのできごと（新しい順、最大 100）
  lastAt: null,
  lastError: '',
  onChange: null,
};

const linkEnabled = () => syncPref('claudeLink') === '1';

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

// data: { projects, invoices, deleted, settings }、patches: 受け箱の中身、doneIds: もう処理したパッチの id
// 返り値: { data, results, changed }
function applyClaudePatches(data, patches, doneIds, now = new Date().toISOString()) {
  const projects = data.projects.map((p) => ({ ...p }));
  const deletedIds = new Set(data.deleted.map((d) => d.id));
  const results = [];
  let changed = false;
  const sorted = [...patches].filter((x) => x && x.id && !doneIds.has(x.id)).sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''));
  for (const patch of sorted) {
    const res = { id: patch.id, at: now, by: patch.by ?? 'Claude', op: patch.op, result: 'applied', detail: '' };
    try {
      if (patch.op === 'add') {
        const p = patch.project ?? {};
        const missing = LINK_REQUIRED.filter((k) => p[k] == null || p[k] === '');
        if (!p.id) throw new Error('id がありません');
        if (missing.length) throw new Error(`足りない項目: ${missing.join('・')}`);
        res.projectId = p.id;
        res.title = p.title ?? '';
        if (projects.some((x) => x.id === p.id)) { res.result = 'already'; res.detail = 'もう追加済み'; }
        else if (deletedIds.has(p.id)) { res.result = 'skipped'; res.detail = 'アプリで削除済み'; }
        else {
          const rec = { title: '', priceUnit: 'video', minutes: null, extras: [], memo: '', stage: null, status: 'active', completedAt: null };
          for (const k of LINK_FIELDS) if (p[k] !== undefined) rec[k] = p[k];
          projects.push({ ...rec, id: p.id, createdAt: patch.at ?? now, updatedAt: now, changedBy: patch.by ?? 'Claude' });
          changed = true;
        }
      } else if (patch.op === 'update') {
        res.projectId = patch.projectId;
        const i = projects.findIndex((x) => x.id === patch.projectId);
        if (i < 0) {
          res.result = 'skipped';
          res.detail = deletedIds.has(patch.projectId) ? 'アプリで削除済み' : '案件が見つかりません';
        } else {
          const p = projects[i];
          res.title = p.title ?? '';
          const after = patch.after ?? {};
          const before = patch.before ?? {};
          const set = [];
          const kept = [];
          for (const k of Object.keys(after)) {
            if (!LINK_FIELDS.includes(k)) { kept.push(`${k}（変えられない項目）`); continue; }
            if (linkEq(p[k], after[k])) continue;
            const appUnchanged = k in before && linkEq(p[k], before[k]);
            // アプリ側でも変わっていたら、後から変えた方を残す（同じ時刻ならアプリ）
            if (appUnchanged || (patch.at ?? '') > (p.updatedAt ?? '')) set.push(k);
            else kept.push(k);
          }
          if (set.length) {
            const np = { ...p, updatedAt: now, changedBy: patch.by ?? 'Claude' };
            for (const k of set) np[k] = after[k];
            projects[i] = np;
            changed = true;
          }
          if (kept.length) {
            res.result = set.length ? 'partial' : 'conflict';
            res.detail = `アプリで後から変わっていたので、アプリの値を残した: ${kept.join('・')}`;
          } else if (!set.length) { res.result = 'already'; res.detail = 'もう同じ値'; }
          res.fields = set;
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
  return { data: { ...data, projects }, results, changed };
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
  const { data, results, changed } = applyClaudePatches(merged, patches, doneIds);
  for (const r of results) {
    const name = r.title ? `「${r.title}」` : '';
    const label = { applied: '取り込んだ', partial: '一部取り込んだ', already: '取り込み済み', conflict: '競合（アプリの値を残した）', skipped: '取り込まなかった', error: 'エラー' }[r.result];
    linkLog(r.result === 'error' || r.result === 'conflict' ? 'warn' : 'info',
      `${r.by}の変更${name}を${label}${r.fields?.length ? `（${r.fields.join('・')}）` : ''}${r.detail ? `：${r.detail}` : ''}`);
  }
  const { clientIcons, ...settingsLite } = data.settings ?? {};
  const payload = {
    app: 'anken-kanri-mirror', version: 1, appVersion: typeof APP_VERSION === 'string' ? APP_VERSION : '',
    savedAt: new Date().toISOString(),
    note: 'アプリが同期のたびに書く写し。Claude は読むだけで、変更は claude-inbox.json に書く',
    data: { projects: data.projects, invoices: data.invoices, deleted: data.deleted, settings: data.settings ? settingsLite : null },
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
