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

// 単価の数え方：1本あたり（今まで）か、1分あたり（横動画の尺で払う案件）
const isPerMinute = (p) => p.priceUnit === 'minute';
// 尺は分単位で数える（1分に満たない分は切り捨て：12分30秒 → 12分）
const minutesOf = (p) => Math.floor(Number(p.minutes) || 0);
// 単価に掛ける数：1本あたりなら本数、1分あたりなら「1本の尺（分）× 本数」
const unitsOf = (p) => (isPerMinute(p) ? minutesOf(p) * p.count : p.count);
// 追加料金（切り抜き選定料金など）：[{ name, price, qty }]
const extrasOf = (p) => (Array.isArray(p.extras) ? p.extras : []);
const extrasAmountOf = (p) => extrasOf(p).reduce((s, x) => s + (Number(x.price) || 0) * (Number(x.qty) || 0), 0);
// 編集代（単価 × 本数、または 単価 × 尺 × 本数）
const baseAmountOf = (p) => p.unitPrice * unitsOf(p);
// 請求する金額＝編集代＋追加料金
const amountOf = (p) => baseAmountOf(p) + extrasAmountOf(p);
// 編集者に払う委託費（委託単価 × 本数、1分あたりの案件は委託単価も 1分あたり）。委託単価が無い案件は 0
const feeOf = (p) => (Number(p.feeUnit) || 0) * unitsOf(p);
// 「¥5,000 × 3本」「¥1,000/分 × 12分」「¥1,000/分 × 12分 × 2本」
function priceFormula(p) {
  if (!isPerMinute(p)) return `${yen(p.unitPrice)} × ${p.count}本`;
  return `${yen(p.unitPrice)}/分 × ${minutesOf(p)}分${p.count > 1 ? ` × ${p.count}本` : ''}`;
}

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
