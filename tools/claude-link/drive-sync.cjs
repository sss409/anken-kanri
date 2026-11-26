// Claude から「同期 1 回分」をする（アプリを開かなくても、受け箱を取り込み・写しを新しくする）
//   node drive-sync.cjs login   … 最初に 1 回。ブラウザで Google にログインして許可する
//   node drive-sync.cjs sync    … 同期 1 回分（anken.py company / sync が呼ぶ）
//   node drive-sync.cjs status  … ログイン済みか
// 仕組み: アプリと同じ Google Cloud プロジェクトの「デスクトップ アプリ」用の OAuth クライアントでログインし、
//   アプリ専用の領域（appDataFolder）の anken-kanri.json を読む → 受け箱（ローカルの G:\ の claude-inbox.json）を当てる
//   → 変わっていれば appDataFolder に書き戻す → 写し（マイドライブの anken-kanri.json）を書く。
//   当て方・写しの形は本物の js/claude-link.js（applyClaudePatches・claudeExchange）と js/sync.js（mergeData・sameData）をそのまま使う。
// 秘密（クライアントの秘密・ログインの印）はリポジトリの外（%APPDATA%\anken-kanri-claude）に置く。
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const http = require('http');
const crypto = require('crypto');
const { execFile } = require('child_process');

const ROOT = path.join(__dirname, '../..');
const CONF_DIR = process.env.ANKEN_CLAUDE_CONF || path.join(process.env.APPDATA || require('os').homedir(), 'anken-kanri-claude');
const CLIENT_FILE = path.join(CONF_DIR, 'client.json');   // Google Cloud でダウンロードした「デスクトップ アプリ」の JSON
const TOKEN_FILE = path.join(CONF_DIR, 'token.json');
const LINK_DIR = process.env.ANKEN_LINK_DIR || 'G:\\マイドライブ\\案件管理（Claude連携）';
const COMPANY = process.env.ANKEN_COMPANY || 'E:\\個人フォルダ\\.company';
const CACHE = path.join(COMPANY, '.anken', 'mirror-cache.json'); // 書いた写しの控え（G:\ に届くまでの間 anken.py が読む）
const SCOPES = ['https://www.googleapis.com/auth/drive.appdata', 'https://www.googleapis.com/auth/drive.file'];

const die = (msg, code = 1) => { console.error(`✗ ${msg}`); process.exit(code); };
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '') || 'null');

function loadClient() {
  if (!fs.existsSync(CLIENT_FILE)) die(`OAuth クライアントの JSON がありません: ${CLIENT_FILE}（docs/Claude連携.md の「Claude から同期」を見て置いてください）`, 3);
  const j = readJson(CLIENT_FILE);
  const c = j.installed || j.web || j;
  if (!c.client_id || !c.client_secret) die(`${CLIENT_FILE} に client_id・client_secret がありません`, 3);
  return c;
}

async function tokenRequest(params) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google のログイン ${res.status} ${j.error ?? ''} ${j.error_description ?? ''}`.trim());
  return j;
}

// ---------- login（ループバックで 1 回だけ） ----------
async function login() {
  const c = loadClient();
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const state = crypto.randomBytes(16).toString('hex');
  const server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const redirect = `http://127.0.0.1:${server.address().port}`;
  const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: c.client_id, redirect_uri: redirect, response_type: 'code', scope: SCOPES.join(' '),
    access_type: 'offline', prompt: 'consent', code_challenge: challenge, code_challenge_method: 'S256', state,
  });
  console.log('ブラウザで Google のログイン画面を開きます。開かない時は次の URL を開いてください:\n' + url);
  if (!process.env.ANKEN_NO_OPEN) execFile('cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')], () => {});
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('5 分待ちましたがログインが終わりませんでした')), 300000);
    server.on('request', (req, res) => {
      const q = new URL(req.url, redirect).searchParams;
      if (!q.get('code') && !q.get('error')) { res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(q.get('error') ? '<p>許可されませんでした。この画面は閉じてください。</p>' : '<p>ログインできました。この画面は閉じてください。</p>');
      clearTimeout(timer);
      if (q.get('error')) reject(new Error(`許可されませんでした（${q.get('error')}）`));
      else if (q.get('state') !== state) reject(new Error('state が合いません'));
      else resolve(q.get('code'));
    });
  }).finally(() => server.close());
  const t = await tokenRequest({ code, client_id: c.client_id, client_secret: c.client_secret, redirect_uri: redirect, grant_type: 'authorization_code', code_verifier: verifier });
  if (!t.refresh_token) die('refresh_token が返りませんでした。もう一度 login してください');
  const granted = (t.scope ?? '').split(' ');
  const missing = SCOPES.filter((s) => !granted.includes(s));
  fs.mkdirSync(CONF_DIR, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify({ refresh_token: t.refresh_token, scope: t.scope, savedAt: new Date().toISOString() }, null, 1));
  if (missing.length) die(`許可が足りません（${missing.join(' ')}）。login をやり直し、チェックを全部入れてください`);
  console.log(`✓ ログインしました（${TOKEN_FILE}）`);
}

async function accessToken() {
  loadClient();
  if (!fs.existsSync(TOKEN_FILE)) die('まだログインしていません（node drive-sync.cjs login）', 3);
  const c = loadClient();
  const t = readJson(TOKEN_FILE);
  try {
    return (await tokenRequest({ refresh_token: t.refresh_token, client_id: c.client_id, client_secret: c.client_secret, grant_type: 'refresh_token' })).access_token;
  } catch (e) {
    if (/invalid_grant/.test(e.message)) die('ログインが切れました（node drive-sync.cjs login をもう一度）', 3);
    throw e;
  }
}

// ---------- sync ----------
async function sync() {
  const token = await accessToken();
  class AuthError extends Error {}
  const drive = async (url, opts = {}) => {
    const res = await fetch(url, { ...opts, headers: { ...opts.headers, Authorization: `Bearer ${token}` } });
    if (res.status === 401) throw new AuthError('Google ドライブ 401');
    if (!res.ok) throw new Error(`Google ドライブ ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res;
  };
  // アプリの本物のコードを読み込む（ブラウザの物は小さな代わりを置く）
  const store = new Map();
  const ctx = {
    console, fetch, URLSearchParams, setTimeout, clearTimeout,
    localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    navigator: { userAgent: 'Claude', maxTouchPoints: 0, onLine: true },
    document: { addEventListener() {}, createElement: () => ({}), head: { appendChild() {} } },
    window: {}, location: { protocol: 'https:' },
  };
  vm.createContext(ctx);
  const appVersion = /APP_VERSION = '([^']+)'/.exec(fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8'))[1];
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/sync.js'), 'utf8'), ctx, { filename: 'sync.js' });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/claude-link.js'), 'utf8'), ctx, { filename: 'claude-link.js' });
  vm.runInContext(`APP_VERSION = ${JSON.stringify(appVersion)};`, ctx);
  // const で宣言された物（Link など）は global の項目にならないので、中で評価して取る
  const Link = vm.runInContext('Link', ctx);
  ctx.drive = drive;
  ctx.deviceInfo = () => ({ id: 'clde', label: 'Claude（PC）' });
  ctx.syncPref = (k, v) => (v === undefined ? store.get(`pref:${k}`) ?? null : store.set(`pref:${k}`, v));
  ctx.syncPref('claudeLink', '1');
  // 受け箱は Claude が G:\ に書いた物がいちばん新しい（ドライブへのアップロードを待たない）
  const localInbox = path.join(LINK_DIR, 'claude-inbox.json');
  const origRead = ctx.linkReadJson;
  ctx.linkReadJson = async (id) => (id === Link.ids?.inbox && fs.existsSync(localInbox) ? readJson(localInbox) ?? { patches: [] } : origRead(id));

  // 1) アプリのデータ（appDataFolder）
  const q = encodeURIComponent("name='anken-kanri.json'");
  const fileId = (await (await drive(`https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${q}&fields=files(id,modifiedTime)`)).json()).files?.[0]?.id;
  if (!fileId) die('アプリのデータがドライブにありません（アプリで一度同期してください）');
  const EMPTY = { projects: [], invoices: [], deleted: [], worklogs: [], settings: null };
  const remote = { ...EMPTY, ...(await (await drive(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`)).json()) };
  const base = ctx.mergeData(EMPTY, remote);

  // 2) 受け箱を当てて写しを書く（アプリの claudeExchange そのもの）
  let ex;
  try {
    ex = await ctx.claudeExchange(base);
  } catch (e) {
    if (/ 403| 404/.test(e.message)) die(`連携フォルダを読めませんでした（${e.message}）。OAuth クライアントがアプリと同じ Google Cloud プロジェクトの物か確かめてください`);
    throw e;
  }
  const merged = ex.data;

  // 3) 変わっていればアプリのデータに書き戻す（ほかの端末は次の同期で取り込む）
  let wrote = false;
  if (!ctx.sameData(merged, remote)) {
    const payload = { app: 'anken-kanri', version: 3, savedAt: new Date().toISOString(), ...merged };
    await drive(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    wrote = true;
  }

  // 4) 書いた写しを読み直して控えに置く（G:\ に届くまで anken.py はこちらを読む）
  const mirror = await (await drive(`https://www.googleapis.com/drive/v3/files/${Link.ids.mirror}?alt=media`)).json();
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  fs.writeFileSync(CACHE, JSON.stringify(mirror, null, 1));

  const results = Link.log.filter((l) => !/写しを書きました/.test(l.text));
  for (const l of [...results].reverse()) console.log(`${l.kind === 'warn' ? '⚠' : '→'} ${l.text}`);
  console.log(`✓ 同期しました（受け箱 ${results.length} 件を当てた・アプリのデータ ${wrote ? '書き戻した' : '変わらず'}・写し ${mirror.savedAt}）`);
}

const cmd = process.argv[2];
(async () => {
  if (cmd === 'login') await login();
  else if (cmd === 'sync') await sync();
  else if (cmd === 'status') {
    console.log(fs.existsSync(CLIENT_FILE) ? `クライアント: あり（${CLIENT_FILE}）` : 'クライアント: なし');
    console.log(fs.existsSync(TOKEN_FILE) ? `ログイン: 済み（${readJson(TOKEN_FILE).savedAt}）` : 'ログイン: まだ');
  } else die('使い方: node drive-sync.cjs login | sync | status', 2);
})().catch((e) => die(e.message));
