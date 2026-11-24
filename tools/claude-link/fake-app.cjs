// テスト用：アプリの「同期 1 回分」を Google ドライブなしで真似る
//   node fake-app.cjs <フォルダ> [アプリ側の変更 JSON]
// <フォルダ>/appdata.json（アプリのデータ）・anken-kanri.json（写し）・claude-inbox.json（受け箱）を使う。
// アプリ側の変更 JSON（{"<id>": {項目: 値}}）を渡すと、受け箱を読む前にアプリで手で変えたことにする。
// パッチの当て方は本物の js/claude-link.js の applyClaudePatches をそのまま使う。
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const dir = process.argv[2];
const edits = process.argv[3] ? JSON.parse(process.argv[3]) : null;
const ctx = { console, syncPref: () => null, drive: () => { throw new Error('no drive'); } };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../../js/claude-link.js'), 'utf8'), ctx);

const read = (n, d) => (fs.existsSync(path.join(dir, n)) ? JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8').replace(/^﻿/, '') || 'null') ?? d : d);
let data = read('appdata.json', { projects: [], invoices: [], deleted: [], settings: null });
if (edits) {
  const now = new Date().toISOString();
  data.projects = data.projects.map((p) => (edits[p.id] ? { ...p, ...edits[p.id], updatedAt: now, changedBy: 'アプリ' } : p));
}
const mirror = read('anken-kanri.json', {});
const inbox = read('claude-inbox.json', { patches: [] });
const prev = mirror?.claude?.results ?? [];
const { data: out, results } = ctx.applyClaudePatches(data, inbox.patches ?? [], new Set(prev.map((r) => r.id)));
fs.writeFileSync(path.join(dir, 'appdata.json'), JSON.stringify(out, null, 1));
fs.writeFileSync(path.join(dir, 'anken-kanri.json'), JSON.stringify({
  app: 'anken-kanri-mirror', version: 1, appVersion: process.env.FAKE_APP_VERSION ?? /APP_VERSION = '([^']+)'/.exec(fs.readFileSync(path.join(__dirname, '../../js/app.js'), 'utf8'))[1], savedAt: new Date().toISOString(),
  data: out, claude: { results: [...results, ...prev].slice(0, 300) },
}, null, 1));
for (const r of results) console.log(`${r.result} ${r.title ?? ''} ${(r.fields ?? []).join(',')} ${r.detail}`);
