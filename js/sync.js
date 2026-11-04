// Google ドライブ（アプリ専用の見えない領域 appDataFolder）に 1 つの JSON を置いて、端末間で同期する
// 統合のルール：案件・請求状態はレコードごとに updatedAt が新しい方を残す。削除は削除日時が更新より後なら勝つ

const SYNC_FILE = 'anken-kanri.json';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';

// ---------- 統合 ----------

function newerWins(list, keyOf, stampOf) {
  const out = new Map();
  for (const r of list) {
    const cur = out.get(keyOf(r));
    if (!cur || (stampOf(r) ?? '') > (stampOf(cur) ?? '')) out.set(keyOf(r), r);
  }
  return out;
}

function mergeData(a, b) {
  const deleted = newerWins([...a.deleted, ...b.deleted], (d) => d.id, (d) => d.deletedAt);
  const projects = newerWins([...a.projects, ...b.projects], (p) => p.id, (p) => p.updatedAt);
  for (const [id, d] of deleted) {
    const p = projects.get(id);
    if (p && (p.updatedAt ?? '') <= d.deletedAt) projects.delete(id);
  }
  const invoices = newerWins([...a.invoices, ...b.invoices], (r) => r.key, (r) => r.updatedAt);
  // 請求書の設定（自分の名前・振込先など）は丸ごと 1 つ。新しく変えた方を残す
  const settings = (b.settings?.updatedAt ?? '') > (a.settings?.updatedAt ?? '') ? b.settings : (a.settings ?? b.settings ?? null);
  return { projects: [...projects.values()], invoices: [...invoices.values()], deleted: [...deleted.values()], settings };
}

// 中身が同じか（並び順は問わない）
function sameData(a, b) {
  const norm = (d) => JSON.stringify(['projects', 'invoices', 'deleted'].map((k) =>
    [...d[k]].map((r) => JSON.stringify(r)).sort()).concat(JSON.stringify(d.settings ?? null)));
  return norm(a) === norm(b);
}

// ---------- Google ログイン ----------

const Sync = {
  available: false,   // クライアント ID があり、https か localhost で開いている
  status: 'off',      // off | needs-tap | syncing | ok | error
  lastSyncAt: null,
  hooks: null,        // { getLocal, applyMerged, onStatus }
  tokenClient: null,
  fileId: null,
  running: false,
  again: false,
  timer: null,
};

function syncPref(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value);
  } catch { /* 保存できない環境でも動作は続ける */ }
  return null;
}

function savedToken() {
  try {
    const t = JSON.parse(syncPref('syncToken') || 'null');
    return t && t.expiresAt > Date.now() + 60_000 ? t.accessToken : null;
  } catch { return null; }
}

function setStatus(status, detail = '') {
  Sync.status = status;
  Sync.hooks?.onStatus(status, detail);
}

function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Google のログイン部品を読み込めませんでした（オフライン？）'));
    document.head.appendChild(s);
  });
}

function initTokenClient() {
  if (Sync.tokenClient || !window.google?.accounts?.oauth2) return;
  Sync.tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: DRIVE_SCOPE,
    callback: (resp) => {
      if (resp.error) { setStatus('error', 'ログインできませんでした'); return; }
      syncPref('syncToken', JSON.stringify({ accessToken: resp.access_token, expiresAt: Date.now() + resp.expires_in * 1000 }));
      syncPref('syncEnabled', '1');
      syncNow();
    },
    error_callback: (err) => {
      setStatus(syncPref('syncEnabled') ? 'needs-tap' : 'off', err?.type === 'popup_closed' ? '' : 'ログイン画面を開けませんでした');
    },
  });
}

// 起動時に呼ぶ
async function initSync(hooks) {
  Sync.hooks = hooks;
  Sync.available = !!GOOGLE_CLIENT_ID && location.protocol !== 'file:';
  if (!Sync.available) { setStatus('off'); return; }
  setStatus(syncPref('syncEnabled') ? (savedToken() ? 'ok' : 'needs-tap') : 'off');
  try {
    await loadGis();
    initTokenClient();
  } catch (e) {
    if (syncPref('syncEnabled')) setStatus('error', e.message);
  }
  if (syncPref('syncEnabled') && savedToken()) syncNow();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !syncPref('syncEnabled')) return;
    if (savedToken()) syncNow(); else setStatus('needs-tap');
  });
}

// 同期ボタン（クリックの中で呼ぶこと。ポップアップを出すため）
function onSyncButton() {
  if (savedToken()) { syncNow(); return; }
  if (!Sync.tokenClient) {
    setStatus('error', 'Google のログイン部品がまだ読み込まれていません。少し待ってからもう一度押してください');
    loadGis().then(initTokenClient).catch(() => {});
    return;
  }
  Sync.tokenClient.requestAccessToken({ prompt: syncPref('syncEnabled') ? '' : 'consent' });
}

function stopSync() {
  const token = savedToken();
  if (token && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(token, () => {});
  syncPref('syncToken', null);
  syncPref('syncEnabled', null);
  Sync.fileId = null;
  setStatus('off');
}

// データを変えたら呼ぶ（まとめて少し後に同期）
function scheduleSync() {
  if (!Sync.available || !syncPref('syncEnabled')) return;
  if (!savedToken()) { setStatus('needs-tap'); return; }
  clearTimeout(Sync.timer);
  Sync.timer = setTimeout(syncNow, 1500);
}

// ---------- ドライブとのやりとり ----------

class AuthError extends Error {}

async function drive(url, opts = {}) {
  const token = savedToken();
  if (!token) throw new AuthError();
  const res = await fetch(url, { ...opts, headers: { ...opts.headers, Authorization: `Bearer ${token}` } });
  if (res.status === 401) { syncPref('syncToken', null); throw new AuthError(); }
  if (!res.ok) throw new Error(`Google ドライブ ${res.status}`);
  return res;
}

async function findFile() {
  const q = encodeURIComponent(`name='${SYNC_FILE}'`);
  const res = await drive(`https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${q}&fields=files(id)`);
  return (await res.json()).files?.[0]?.id ?? null;
}

async function createFile(data) {
  const b = `anken${Date.now()}`;
  const body = `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`
    + JSON.stringify({ name: SYNC_FILE, parents: ['appDataFolder'] })
    + `\r\n--${b}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(data)}\r\n--${b}--`;
  const res = await drive('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
    method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${b}` }, body,
  });
  return (await res.json()).id;
}

const updateFile = (id, data) => drive(`https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media`, {
  method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
});

const EMPTY = { projects: [], invoices: [], deleted: [], settings: null };

async function syncNow() {
  if (Sync.running) { Sync.again = true; return; }
  Sync.running = true;
  setStatus('syncing');
  try {
    Sync.fileId ??= await findFile();
    const remote = Sync.fileId
      ? { ...EMPTY, ...(await (await drive(`https://www.googleapis.com/drive/v3/files/${Sync.fileId}?alt=media`)).json()) }
      : EMPTY;
    const local = Sync.hooks.getLocal();
    const merged = mergeData(local, remote);
    if (!sameData(merged, local)) await Sync.hooks.applyMerged(merged);
    const payload = { app: 'anken-kanri', version: 3, savedAt: new Date().toISOString(), ...merged };
    if (!Sync.fileId) Sync.fileId = await createFile(payload);
    else if (!sameData(merged, remote)) await updateFile(Sync.fileId, payload);
    Sync.lastSyncAt = new Date();
    setStatus('ok');
  } catch (e) {
    if (e instanceof AuthError) setStatus('needs-tap');
    else setStatus('error', navigator.onLine ? e.message : 'オフラインです');
  } finally {
    Sync.running = false;
    if (Sync.again) { Sync.again = false; scheduleSync(); }
  }
}
