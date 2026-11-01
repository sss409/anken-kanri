// 日付は "YYYY-MM-DD"、月は "YYYY-MM" の文字列で扱う

const pad = (n) => String(n).padStart(2, '0');

function fmtDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

const todayStr = () => fmtDate(new Date());
const monthOf = (dateStr) => dateStr.slice(0, 7);

function addDays(dateStr, n) {
  const d = parseDate(dateStr);
  d.setDate(d.getDate() + n);
  return fmtDate(d);
}

// b - a（日数）
function diffDays(a, b) {
  return Math.round((parseDate(b) - parseDate(a)) / 86400000);
}

function shiftMonth(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

function monthLabel(ym) {
  const [y, m] = ym.split('-').map(Number);
  return `${y}年${m}月`;
}

const WEEK = ['日', '月', '火', '水', '木', '金', '土'];

function shortDate(dateStr) {
  const d = parseDate(dateStr);
  return `${d.getMonth() + 1}/${d.getDate()}(${WEEK[d.getDay()]})`;
}

const yen = (n) => '¥' + Math.round(n).toLocaleString('ja-JP');

const KIND_LABEL = { short: 'ショート', long: 'ロング' };

const amountOf = (p) => p.unitPrice * p.count;

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// クライアント名から毎回同じ色を作る
function clientHue(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return (h * 137) % 360;
}

const newId = () =>
  (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
