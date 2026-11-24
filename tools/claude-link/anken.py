"""案件管理アプリ ⇔ Claude（仮想カンパニー .company）の連携ツール

アプリは同期のたびに、マイドライブの「案件管理（Claude連携）」フォルダへ
  anken-kanri.json  … 写し（アプリだけが書く。ここでは読むだけ）
を書き、同じフォルダの
  claude-inbox.json … 受け箱（このツールだけが書く。アプリは読むだけ）
の変更（パッチ）を取り込む。取り込んだ結果は写しの claude.results に出る。

使い方（Python 3.10 以上・標準ライブラリだけ）。アプリの画面でできる操作はすべてここからできる（対応表は docs/Claude連携.md）:
  見る   status / list [--all|--done] / show <案件> / billing [月] / director [月] / calendar [月] / clients [--period]
         trash / price / extra-item / editor / setting（引数なしで今の値）
  案件   add / set <案件> ... / done <案件> / undone <案件> / delete <案件>（ゴミ箱へ）/ restore <案件>（ゴミ箱から）
  請求   bill <月> <クライアント> [--invoiced 日付|今日|なし] [--paid 日付|今日|なし]（請求書の発行・入金の済／未）
         invoice <月> <クライアント> | invoice --project <案件>（請求書の PDF・CSV を作って「発行済」にする）
  設定   price <クライアント> ... / extra-item add|set|remove / editor add|remove / setting --my-name ...
  データ export [--out] / import <ファイル> --yes
  .company  company [--dry-run] / link <jobファイル> <案件>
  提出   deliveries [--dry-run] [--all]（提出フォルダの動画を案件に入れる。company でも毎回する）
<案件> は id の先頭 6 文字以上か、案件名・クライアント名の一部。
書き込む前に、写し・受け箱・書き換える jobs のファイルを <.company>/.anken/backup/<日時>/ に必ずコピーする。
"""
from __future__ import annotations

import argparse
import copy
import datetime as dt
import html
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

LINK_DIR = Path(os.environ.get('ANKEN_LINK_DIR', r'G:\マイドライブ\案件管理（Claude連携）'))
COMPANY = Path(os.environ.get('ANKEN_COMPANY', r'E:\個人フォルダ\.company'))
MIRROR = LINK_DIR / 'anken-kanri.json'
INBOX = LINK_DIR / 'claude-inbox.json'
WORK = COMPANY / '.anken'
STATE = WORK / 'state.json'
BACKUP = WORK / 'backup'
LOG = WORK / 'log.txt'
BY = os.environ.get('ANKEN_BY', '秘書')

STAGES = {'作業中': None, '初稿提出': 'draft', '修正中': 'revision', '完了': 'done'}
STAGE_OF_APP = {None: '作業中', 'draft': '初稿提出', 'revision': '修正中'}
RESULT_LABEL = {'applied': '取り込み済み', 'partial': '一部取り込み', 'already': '取り込み済み（同じ値）',
                'conflict': '競合（アプリの値を残した）', 'skipped': '取り込まれず', 'error': 'エラー'}
KIND_LABEL = {'short': 'ショート', 'long': 'ロング'}
# delete・restore・invoice・settings・import の操作はアプリ 0.18.0 から取り込める（古い版は「知らない操作」で捨てる）
MIN_APP = (0, 18, 0)
DEL = object()  # 設定の項目を消す印

# Windows のコンソールでも日本語を出す
for s in (sys.stdout, sys.stderr):
    try:
        s.reconfigure(encoding='utf-8')
    except Exception:
        pass


class Stop(Exception):
    pass


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def today() -> str:
    return dt.date.today().isoformat()


def log(msg: str) -> None:
    WORK.mkdir(parents=True, exist_ok=True)
    with LOG.open('a', encoding='utf-8') as f:
        f.write(f'{dt.datetime.now().isoformat(timespec="seconds")} {msg}\n')


# ---------- 写し・受け箱 ----------

def read_json(path: Path) -> dict:
    try:
        text = path.read_text(encoding='utf-8-sig')
    except FileNotFoundError:
        raise Stop(f'{path} がありません。アプリの設定 →「Claude 連携」をオンにして、同期してください')
    try:
        return json.loads(text or '{}')
    except json.JSONDecodeError as e:
        raise Stop(f'{path.name} が JSON として読めません（{e}）')


def load_mirror() -> dict:
    m = read_json(MIRROR)
    if m.get('app') != 'anken-kanri-mirror':
        raise Stop(f'{MIRROR.name} がまだ空です。アプリを開いて同期してください')
    return m


def load_inbox() -> dict:
    ib = read_json(INBOX)
    ib.setdefault('patches', [])
    return ib


def device_text(d: dict | None) -> str:
    return f'{d.get("label", "不明")} #{d.get("id", "?")}' if d else '端末の記録なし（0.16.0 以前）'


def local_time(iso: str) -> str:
    try:
        return dt.datetime.fromisoformat(iso.replace('Z', '+00:00')).astimezone().strftime('%m/%d %H:%M:%S')
    except Exception:
        return iso or '?'


def mirror_age_note(m: dict) -> str:
    try:
        saved = dt.datetime.fromisoformat(m['savedAt'].replace('Z', '+00:00'))
    except Exception:
        return ''
    mins = (dt.datetime.now(dt.timezone.utc) - saved).total_seconds() / 60
    local = saved.astimezone().strftime('%m/%d %H:%M')
    by = f'・{device_text(m["device"])} が書いた' if m.get('device') else ''
    if mins > 24 * 60:
        return f'写しは {local} のもの{by}（1 日以上前。アプリを開いて同期すると新しくなる）'
    return f'写しは {local} のもの{by}'


def backup(*paths: Path) -> Path:
    stamp = dt.datetime.now().strftime('%Y%m%d-%H%M%S-%f')[:-3]
    dest = BACKUP / stamp
    dest.mkdir(parents=True, exist_ok=True)
    for p in paths:
        if p.exists():
            shutil.copy2(p, dest / p.name)
    # 古いバックアップは 60 個まで残す
    olds = sorted(d for d in BACKUP.iterdir() if d.is_dir())
    for d in olds[:-60]:
        shutil.rmtree(d, ignore_errors=True)
    return dest


def write_inplace(path: Path, text: str) -> None:
    """ファイルを置き換えずに中身だけ書き換える（Google ドライブ上のファイル ID を変えない＝アプリが読み続けられる）"""
    data = text.encode('utf-8')
    with path.open('r+b') as f:
        f.seek(0)
        f.write(data)
        f.truncate()
        f.flush()
        os.fsync(f.fileno())


def done_ids(m: dict) -> set[str]:
    return {r.get('id') for r in m.get('claude', {}).get('results', [])}


def pending(m: dict, ib: dict) -> list[dict]:
    d = done_ids(m)
    return [p for p in ib['patches'] if p.get('id') not in d]


def save_patches(new: list[dict], m: dict, ib: dict, extra_backup: tuple[Path, ...] = ()) -> None:
    """受け箱にパッチを足す（取り込み済みのものは消す）。書く前にバックアップ"""
    dest = backup(MIRROR, INBOX, *extra_backup)
    keep = pending(m, ib)
    out = {'app': 'anken-kanri-inbox', 'version': 1, 'updatedAt': now_iso(),
           'note': 'Claude が書く受け箱。アプリは同期のたびに読み、結果を anken-kanri.json の claude.results に出す',
           'patches': keep + new}
    write_inplace(INBOX, json.dumps(out, ensure_ascii=False, indent=1))
    for p in new:
        log(f'受け箱に追加 {p["op"]} {p.get("projectId") or p.get("project", {}).get("id")} '
            f'{json.dumps(p.get("after") or p.get("project"), ensure_ascii=False)} （バックアップ {dest.name}）')


# ---------- 案件 ----------

def get_path(obj, path):
    for k in path:
        if isinstance(obj, dict):
            obj = obj.get(k)
        elif isinstance(obj, list) and str(k).isdigit() and int(k) < len(obj):
            obj = obj[int(k)]
        else:
            return None
    return obj


def set_path(obj: dict, path: list, value, remove: bool = False) -> dict:
    root = copy.deepcopy(obj or {})
    cur = root
    for k in path[:-1]:
        nxt = cur[int(k)] if isinstance(cur, list) else cur.get(k)
        if not isinstance(nxt, (dict, list)):
            nxt = {}
            if isinstance(cur, list):
                cur[int(k)] = nxt
            else:
                cur[k] = nxt
        cur = nxt
    last = path[-1]
    if isinstance(cur, list):
        if remove:
            cur.pop(int(last))
        else:
            cur[int(last)] = value
    elif remove:
        cur.pop(last, None)
    else:
        cur[last] = value
    return root


def view(m: dict, ib: dict) -> dict:
    """写しのデータに、まだ取り込まれていない受け箱の変更を重ねたもの（案件・請求・ゴミ箱・設定。重ねた物は _pending に印）"""
    d = m['data']
    ps = {p['id']: dict(p) for p in d['projects']}
    inv = {r['key']: dict(r) for r in d.get('invoices') or []}
    trash = {x['id']: dict(x) for x in d.get('deleted') or []}
    st = copy.deepcopy(d.get('settings') or {})
    for patch in sorted(pending(m, ib), key=lambda x: x.get('at', '')):
        op, pid = patch.get('op'), patch.get('projectId')
        if op == 'add':
            p = dict(patch['project'])
            p.setdefault('status', 'active')
            p['_pending'] = True
            ps.setdefault(p['id'], p)
        elif op == 'update' and pid in ps:
            ps[pid].update(patch.get('after', {}))
            ps[pid]['_pending'] = True
        elif op == 'delete' and pid in ps:
            trash[pid] = {'id': pid, 'deletedAt': patch['at'], 'by': patch.get('by'), 'project': ps.pop(pid), '_pending': True}
        elif op == 'restore' and pid not in ps:
            snap = (trash.get(pid) or {}).get('project') or patch.get('project')
            if snap:
                ps[pid] = {**snap, '_pending': True}
        elif op == 'invoice':
            key = patch['key']
            r = inv.setdefault(key, {'key': key, 'month': key[:7], 'client': key[8:], 'invoicedAt': None, 'paidAt': None})
            r.update(patch.get('after', {}))
            r['_pending'] = True
        elif op == 'settings':
            for c in patch.get('changes', []):
                st = set_path(st, c['path'], c.get('after'), bool(c.get('remove')))
        elif op == 'import':
            data = patch.get('data') or {}
            keep = {p['id'] for p in data.get('projects', [])}
            for p in ps.values():
                if p['id'] not in keep:
                    trash[p['id']] = {'id': p['id'], 'deletedAt': patch['at'], 'by': patch.get('by'), 'project': p, '_pending': True}
            ps = {p['id']: {**p, '_pending': True} for p in data.get('projects', [])}
            if data.get('settings'):
                st = copy.deepcopy(data['settings'])
    return {'projects': ps, 'invoices': inv, 'trash': trash, 'settings': st}


def projects_view(m: dict, ib: dict) -> list[dict]:
    """写しの案件に、まだ取り込まれていない受け箱の変更を重ねたもの（_pending に印）"""
    return list(view(m, ib)['projects'].values())


def find_project(ps: list[dict], q: str) -> dict:
    hits = [p for p in ps if p['id'] == q] or [p for p in ps if len(q) >= 6 and p['id'].startswith(q)]
    if not hits:
        words = q.split()
        hits = [p for p in ps if all(w in f'{p.get("client", "")} {p.get("title", "")}' for w in words)]
        exact = [p for p in hits if p.get('title') == q]
        hits = exact or hits
    if len(hits) == 1:
        return hits[0]
    if not hits:
        raise Stop(f'「{q}」に当たる案件がありません')
    lines = '\n'.join(f'  {p["id"][:8]}  {p.get("client")}  {p.get("title")}  納期 {p.get("dueDate")}' for p in hits[:20])
    raise Stop(f'「{q}」に当たる案件が {len(hits)} 件あります。id の先頭で指定してください\n{lines}')


def stage_label(p: dict) -> str:
    if p.get('status') == 'done':
        return '完了'
    return STAGE_OF_APP.get(p.get('stage'), '作業中')


def units(p: dict) -> float:
    if p.get('priceUnit') == 'minute':
        return int(float(p.get('minutes') or 0)) * p.get('count', 0)
    return p.get('count', 0)


def amount(p: dict) -> float:
    extra = sum((x.get('price') or 0) * (x.get('qty') or 0) for x in p.get('extras') or [])
    return (p.get('unitPrice') or 0) * units(p) + extra


def base_amount(p: dict) -> float:
    return (p.get('unitPrice') or 0) * units(p)


def outsource_amount(p: dict) -> float:
    return sum(float(x.get('amount') or 0) for x in p.get('outsources') or [])


def fee(p: dict) -> float:
    """払うお金＝担当編集者の委託費（委託単価 × 本数・尺）＋外注費（アプリの feeOf と同じ）"""
    return float(p.get('feeUnit') or 0) * units(p) + outsource_amount(p)


def yen(n: float) -> str:
    return f'¥{int(round(n)):,}'


def row(p: dict) -> str:
    mark = ' ※アプリ取り込み待ち' if p.get('_pending') else ''
    prog = f' ・ {p["progress"]}' if p.get('progress') else ''
    kind = {'short': 'ショート', 'long': 'ロング'}.get(p.get('kind'), p.get('kind'))
    pay = []
    if p.get('feeUnit') is not None:
        pay.append(f'委託単価 {yen(p["feeUnit"])}{"/分" if p.get("priceUnit") == "minute" else ""}')
    for x in p.get('outsources') or []:
        pay.append(f'外注 {x.get("work") or "?"}→{x.get("to") or "?"} {yen(x.get("amount") or 0)}')
    paid = f'（{"・".join(pay)}）' if pay else ''
    return (f'{p.get("dueDate")}  {p["id"][:8]}  [{p.get("client")}] {p.get("title") or "（案件名なし）"}'
            f'（{kind}）  {stage_label(p)}{prog}  {yen(amount(p))}{paid}{mark}')


def stage_fields(label: str, p: dict | None) -> dict:
    if label not in STAGES:
        raise Stop(f'段階は {"・".join(STAGES)} のどれかで指定してください')
    if label == '完了':
        return {'status': 'done', 'completedAt': (p or {}).get('completedAt') or today()}
    st = STAGES[label]
    out = {'status': 'active', 'completedAt': None, 'stage': st}
    if st and not (p or {}).get(f'{st}At'):
        out[f'{st}At'] = today()
    return out


def make_update(m: dict, ib: dict, pid: str, after: dict, note: str = '') -> dict | None:
    """after のうち、いまの値と違うものだけのパッチ。before は写しの値（取り込み待ちのパッチがあればその after）"""
    base = next((p for p in m['data']['projects'] if p['id'] == pid), None)
    view = next(p for p in projects_view(m, ib) if p['id'] == pid)
    after = {k: v for k, v in after.items() if view.get(k) != v}
    if not after:
        return None
    before = {}
    for k in after:
        before[k] = (base or {}).get(k)
        for patch in sorted(pending(m, ib), key=lambda x: x.get('at', '')):
            if patch.get('op') == 'add' and patch.get('project', {}).get('id') == pid:
                before[k] = patch['project'].get(k)   # まだ取り込まれていない追加
            elif patch.get('projectId') == pid and k in patch.get('after', {}):
                before[k] = patch['after'][k]
    return {'id': f'c-{uuid.uuid4().hex[:12]}', 'at': now_iso(), 'by': BY, 'op': 'update',
            'projectId': pid, 'before': before, 'after': after, 'note': note}


def new_patch(op: str, note: str = '', **kw) -> dict:
    return {'id': f'c-{uuid.uuid4().hex[:12]}', 'at': now_iso(), 'by': BY, 'op': op, **kw, 'note': note}


def app_version(m: dict) -> tuple:
    nums = re.findall(r'\d+', m.get('appVersion') or '')
    return tuple(int(x) for x in nums[:3]) if len(nums) >= 3 else (0, 0, 0)


def need_app(m: dict, what: str) -> None:
    """新しい操作は、写しを書いたアプリが 0.18.0 以降の時だけ受け箱に書く（古い版は知らない操作として捨ててしまう）"""
    if app_version(m) < MIN_APP:
        raise Stop(f'{what}はアプリ v{".".join(map(str, MIN_APP))} 以降が取り込みます。写しは v{m.get("appVersion") or "?"} が書いたもの。'
                   '新しい版を公開して、アプリを開いて同期してから使ってください')


def invoice_patch(v: dict, month: str, client: str, after: dict, note: str = '') -> dict | None:
    key = f'{month}|{client}'
    cur = v['invoices'].get(key) or {}
    after = {k: x for k, x in after.items() if cur.get(k) != x}
    if not after:
        return None
    return new_patch('invoice', note, key=key, before={k: cur.get(k) for k in after}, after=after)


def settings_patch(v: dict, changes: list[tuple[list, object]], note: str = '') -> dict | None:
    """changes: [(path, 値 or DEL)]。いまの値と同じものは省く"""
    out = []
    st = v['settings']
    for path, val in changes:
        cur = get_path(st, path)
        if val is DEL:
            if cur is not None:
                out.append({'path': path, 'before': cur, 'remove': True})
                st = set_path(st, path, None, True)
        elif cur != val:
            out.append({'path': path, 'before': cur, 'after': val})
            st = set_path(st, path, val)
    return new_patch('settings', note, changes=out) if out else None


def save_and_say(patches: list, m: dict, ib: dict, say: str) -> None:
    patches = [p for p in patches if p]
    if not patches:
        print('変える所はありません（もう同じ値）')
        return
    save_patches(patches, m, ib)
    print(f'受け箱に追加しました（アプリが次に同期した時に取り込みます）: {say}')


# ---------- 提出した動画（deliveries） ----------
# クライアントごとの提出フォルダを見て、案件名と合う動画を案件の deliveries に入れる（アプリ 0.19.0 から出る）
# どのフォルダを見るかは <.company>/.anken/deliveries.json（無ければ E:\<クライアント>\提出 があればそこを見る形で作る。別の場所は手で書く）

DELIVERY_APP = (0, 19, 0)
DELIVERY_CONF = WORK / 'deliveries.json'
VIDEO_EXT = {'.mp4', '.mov', '.m4v'}
DELIVERY_SKIP_DIRS = ['frameio', '_frameio_手元に無い', 'サムネイル', 'test']
DELIVERY_KEEP = 12  # 1 案件に残す数（新しい方から）
DELIVERY_ROOT_ENV = os.environ.get('ANKEN_DELIVERY_ROOT')  # テスト用：<ここ>\<クライアント>\提出 を見る
VERSION_RE = re.compile(r'【\s*([初一二三四五六七八九十\d]+)\s*稿\s*】|【\s*((?:修正|完成|最終)[^】]*)\s*】')
CORE_DROP_RE = re.compile(r'【\s*(?:[初一二三四五六七八九十\d]+\s*稿|(?:修正|完成|最終)[^】]*)\s*】')
CORE_SYMBOL_RE = re.compile(r'[\s_\-－ー・･、。,.!！?？()（）「」『』\[\]［］~〜【】]+')


def delivery_conf(clients) -> dict:
    """{'roots': {クライアント: [フォルダ]}, 'skipDirs': [...]}。初めて出たクライアントは、いまあるフォルダで足す（あとで手で直せる）"""
    conf = json.loads(DELIVERY_CONF.read_text(encoding='utf-8')) if DELIVERY_CONF.exists() else {}
    roots = conf.get('roots') or {}
    added = False
    for c in sorted(set(clients)):
        if roots.get(c):   # 空のクライアントは、既定の場所ができていれば足す
            continue
        if DELIVERY_ROOT_ENV:
            cand = [str(Path(DELIVERY_ROOT_ENV) / c / '提出')]
        else:
            cand = [rf'E:\{c}\提出']
        found = [r for r in cand if Path(r).is_dir()]
        if found or c not in roots:
            roots[c] = found
            added = True
    if added or not DELIVERY_CONF.exists():
        conf = {'説明': 'クライアントごとに、提出した動画を置くフォルダ（下のフォルダも全部見る）。空なら見ない（E:/<クライアント>/提出 ができたら自動で足す）。skipDirs の名前のフォルダは見ない',
                'roots': roots, 'skipDirs': conf.get('skipDirs') or DELIVERY_SKIP_DIRS}
        WORK.mkdir(parents=True, exist_ok=True)
        DELIVERY_CONF.write_text(json.dumps(conf, ensure_ascii=False, indent=1), encoding='utf-8')
    conf.setdefault('skipDirs', DELIVERY_SKIP_DIRS)
    return conf


def name_core(s: str) -> str:
    """比べるための形：全角半角・大文字小文字をそろえ、稿の印・「コピー_」・日付の頭（1119_）・記号と空白を取る"""
    import unicodedata
    s = unicodedata.normalize('NFKC', s or '').lower()
    s = CORE_DROP_RE.sub('', s)
    s = re.sub(r'(?:コピー_)+', '', s)
    s = re.sub(r'^\s*\d{4}_', '', s)
    return CORE_SYMBOL_RE.sub('', s)


def version_label(name: str) -> str:
    """【初稿】→ 初稿、【二稿】→ 二稿、【修正版】→ 修正版。印が無ければ「提出」"""
    m = VERSION_RE.search(name)
    label = (f'{m.group(1)}稿' if m.group(1) else m.group(2).strip()) if m else ''
    extra = '・'.join(t for t in ('横動画', '縦動画') if f'【{t}】' in name)
    return '・'.join(x for x in (label, extra) if x) or '提出'


def stem_label(name: str) -> str:
    """フォルダ名で合った動画（吠瑠うにの「カット.mp4」など）は、ファイル名そのものを稿の名前にする"""
    return re.sub(r'\.[^.]+$', '', name).strip() or '提出'



def scan_videos(roots: list[str], skip: set[str]) -> list[dict]:
    out = []
    for r in roots:
        base = Path(r)
        if not base.is_dir():
            continue
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = [d for d in dirnames if d not in skip and not d.startswith('.')]
            for f in filenames:
                fp = Path(dirpath) / f
                if fp.suffix.lower() not in VIDEO_EXT:
                    continue
                try:
                    st = fp.stat()
                except OSError:
                    continue
                at = dt.datetime.fromtimestamp(st.st_mtime).strftime('%Y-%m-%dT%H:%M')
                out.append({'path': str(fp), 'name': fp.name, 'label': version_label(fp.name), 'size': st.st_size, 'at': at,
                            '_core': name_core(fp.stem), '_dir': name_core(fp.parent.name) if fp.parent != base else ''})
    return out


def delivery_window(p: dict) -> tuple[str, str]:
    """提出として数える日付の範囲：着手の 3 日前から、完了の 14 日後（進行中は今日の 14 日後）まで"""
    start = (dt.date.fromisoformat((p.get('startDate') or p.get('dueDate'))[:10]) - dt.timedelta(days=3)).isoformat()
    end_base = p.get('completedAt') if p.get('status') == 'done' and p.get('completedAt') else today()
    end = (dt.date.fromisoformat(end_base[:10]) + dt.timedelta(days=14)).isoformat()
    return start, end


def name_hit(c: str, tcore: str) -> int:
    return min(len(c), len(tcore)) if len(c) >= 3 and len(tcore) >= 3 and (c in tcore or tcore in c) else 0


def match_score(video: dict, tcore: str) -> int:
    """合えば、重なった文字の長さ（長いほど確か）。合わなければ 0。3 文字未満は数えない"""
    return max(name_hit(video['_core'], tcore), name_hit(video['_dir'], tcore))


def find_deliveries(v: dict, only_recent: bool = True) -> tuple[dict, list[str]]:
    """{案件id: [提出した動画]} と、気になる点（同じ動画が 2 件に同じくらい合う など）"""
    allps = [p for p in v['projects'].values() if p.get('client')]
    ps = allps
    if only_recent:
        limit = (dt.date.fromisoformat(today()) - dt.timedelta(days=60)).isoformat()
        ps = [p for p in ps if p.get('status') != 'done' or (p.get('completedAt') or p.get('dueDate') or '') >= limit]
    conf = delivery_conf(p['client'] for p in allps)
    skip = set(conf.get('skipDirs') or [])
    found, notes = {p['id']: [] for p in ps}, []
    by_client: dict[str, list[dict]] = {}
    for p in ps:
        by_client.setdefault(p['client'], []).append(p)
    for client, cps in by_client.items():
        roots = conf['roots'].get(client) or []
        if not roots:
            continue
        for vd in scan_videos(roots, skip):
            day = vd['at'][:10]
            hits = []
            for p in cps:
                lo, hi = delivery_window(p)
                if lo <= day <= hi:
                    sc = match_score(vd, name_core(p.get('title')))
                    if sc:
                        hits.append((sc, p))
            if not hits:
                continue
            hits.sort(key=lambda h: -h[0])
            if len(hits) > 1 and hits[0][0] == hits[1][0]:
                notes.append(f'⚠ {vd["name"]} は {len(hits)} 件の案件に同じくらい合うので入れなかった: '
                             + '・'.join(h[1].get('title') or '' for h in hits[:3]))
                continue
            best = hits[0][1]
            item = {k: x for k, x in vd.items() if not k.startswith('_')}
            if not name_hit(vd['_core'], name_core(best.get('title'))) and item['label'] == '提出':
                item['label'] = stem_label(vd['name'])
            found[best['id']].append(item)
    for pid in found:
        found[pid] = sorted(found[pid], key=lambda x: (x['at'], x['name']))[-DELIVERY_KEEP:]
    return found, notes


def delivery_patches(m: dict, ib: dict, only_recent: bool = True) -> tuple[list, list[str]]:
    v = view(m, ib)
    found, notes = find_deliveries(v, only_recent)
    patches, report = [], []
    for pid, items in found.items():
        p = v['projects'][pid]
        cur = p.get('deliveries') or []
        if items == cur:
            continue
        patch = make_update(m, ib, pid, {'deliveries': items}, '提出フォルダから')
        if patch:
            patches.append(patch)
            old = {c.get('path') for c in cur}
            new = [x for x in items if x['path'] not in old]
            report.append(f'→ 「{p.get("title")}」: 提出した動画 {len(items)} 本'
                          + (f'（新しく {len(new)}: ' + '・'.join(x['name'] for x in new[:3]) + (' ほか' if len(new) > 3 else '') + '）' if new else ''))
    return patches, report + notes


def cmd_deliveries(a) -> None:
    m, ib = load_mirror(), load_inbox()
    patches, report = delivery_patches(m, ib, not a.all)
    print('\n'.join(report) or '新しく提出した動画はありません')
    print(f'見るフォルダの設定: {DELIVERY_CONF}')
    if not patches:
        return
    if a.dry_run:
        print('（--dry-run なので書いていません）')
        return
    if app_version(m) < DELIVERY_APP:
        raise Stop(f'提出した動画はアプリ v{".".join(map(str, DELIVERY_APP))} 以降が取り込みます。写しは v{m.get("appVersion") or "?"} が書いたもの。'
                   '新しい版を公開して、アプリを開いて同期してから使ってください')
    save_patches(patches, m, ib)
    print('受け箱に追加しました（アプリが次に同期した時に取り込みます）')

# ---------- 日付・月 ----------

def parse_day(v: str | None, what: str):
    """「今日」「なし」「2026-11-19」「11/19」「2026/11/19」→ 'YYYY-MM-DD' / None。v が None なら DEL（指定なし）"""
    if v is None:
        return DEL
    t = v.strip()
    if t in ('今日', 'today'):
        return today()
    if t in ('なし', '未', 'none', '-', ''):
        return None
    mt = re.fullmatch(r'(?:(\d{4})[-/])?(\d{1,2})[-/](\d{1,2})', t)
    if not mt:
        raise Stop(f'{what} は「YYYY-MM-DD」「M/D」「今日」「なし」のどれか: {v}')
    y = int(mt.group(1) or dt.date.today().year)
    try:
        return dt.date(y, int(mt.group(2)), int(mt.group(3))).isoformat()
    except ValueError:
        raise Stop(f'{what} の日付がありません: {v}')


def parse_month(v: str | None) -> str:
    if not v:
        return today()[:7]
    t = v.strip()
    mt = re.fullmatch(r'(\d{4})[-/年]?(\d{1,2})月?', t)
    if not mt:
        raise Stop(f'月は「YYYY-MM」で: {v}')
    return f'{int(mt.group(1)):04d}-{int(mt.group(2)):02d}'


def shift_month(ym: str, n: int) -> str:
    y, mo = int(ym[:4]), int(ym[5:7]) - 1 + n
    return f'{y + mo // 12:04d}-{mo % 12 + 1:02d}'


def month_end(ym: str) -> str:
    return (dt.date.fromisoformat(shift_month(ym, 1) + '-01') - dt.timedelta(days=1)).isoformat()


def month_label(ym: str) -> str:
    return f'{int(ym[:4])}年{int(ym[5:7])}月'


def parse_yen(v, what: str, allow_none: bool = True):
    t = str(v).strip().replace(',', '').replace('円', '').replace('¥', '')
    if allow_none and t in ('', 'なし', 'none', '-'):
        return None
    try:
        f = float(t)
    except ValueError:
        raise Stop(f'{what} は数字（円）{"か「なし」" if allow_none else ""}: {v}')
    if f < 0:
        raise Stop(f'{what} は 0 以上: {v}')
    return int(f) if f.is_integer() else f


# ---------- コマンド ----------

def cmd_status(a) -> None:
    m, ib = load_mirror(), load_inbox()
    print(f'アプリ v{m.get("appVersion")}  {mirror_age_note(m)}')
    pend = pending(m, ib)
    print(f'受け箱の取り込み待ち: {len(pend)} 件')
    for p in pend:
        print(f'  {p["at"]} {p["op"]} {p.get("projectId") or p["project"]["id"]} {json.dumps(p.get("after") or {"title": p["project"].get("title")}, ensure_ascii=False)}')
    res = m.get('claude', {}).get('results', [])[:10]
    if res:
        print('最近の取り込み結果:')
        for r in res:
            dev = f'［{device_text(r["device"])}］' if r.get('device') else ''
            print(f'  {local_time(r.get("at", ""))} {RESULT_LABEL.get(r.get("result"), r.get("result"))} {r.get("title", "")}{dev} {r.get("detail", "")}')
    writes = m.get('writes', [])[:8]
    if writes:
        print('写しを書いた端末（新しい順）:')
        for w in writes:
            print(f'  {local_time(w.get("at", ""))} {device_text(w)}')


def cmd_list(a) -> None:
    m, ib = load_mirror(), load_inbox()
    ps = projects_view(m, ib)
    if a.done:
        ps = [p for p in ps if p.get('status') == 'done']
    elif not a.all:
        ps = [p for p in ps if p.get('status') != 'done']
    ps.sort(key=lambda p: (p.get('status') == 'done', p.get('dueDate') or ''))
    if a.json:
        print(json.dumps(ps, ensure_ascii=False, indent=1))
        return
    print(mirror_age_note(m))
    for p in ps:
        print(row(p))


def cmd_show(a) -> None:
    m, ib = load_mirror(), load_inbox()
    p = find_project(projects_view(m, ib), a.query)
    print(json.dumps(p, ensure_ascii=False, indent=1))


def parse_fee(v):
    """--fee の値。数字＝委託単価（1本あたり／1分あたりの案件は1分あたり。アプリと同じ）、なし・0・空＝委託単価を消す"""
    if v is None:
        return None
    t = str(v).strip().replace(',', '').replace('円', '').replace('¥', '')
    if t in ('', 'なし', '0', 'none', '-'):
        return ('clear',)
    try:
        f = float(t)
    except ValueError:
        raise Stop(f'--fee は数字（円）か「なし」: {v}')
    return int(f) if f.is_integer() else f


def apply_outsources(current, specs):
    """--outsource 業務:外注先:金額 を当てた新しい外注の一覧。同じ業務・外注先の行は金額を差し替え、金額が 0・なし なら消す"""
    out = [dict(x) for x in (current or [])]
    for spec in specs or []:
        parts = re.split(r'[:：]', spec)
        if len(parts) != 3:
            raise Stop(f'--outsource は「業務:外注先:金額」の形（例: テロップ:外注先A:4000）: {spec}')
        work, to, amt = (x.strip() for x in parts)
        amt = amt.replace(',', '').replace('円', '').replace('¥', '')
        idx = next((i for i, x in enumerate(out) if (x.get('work') or '') == work and (x.get('to') or '') == to), None)
        if amt in ('', '0', 'なし', '-'):
            if idx is not None:
                out.pop(idx)
            continue
        try:
            n = float(amt)
        except ValueError:
            raise Stop(f'--outsource の金額が数字ではありません: {spec}')
        n = int(n) if n.is_integer() else n
        if idx is None:
            out.append({'work': work, 'to': to, 'amount': n})
        else:
            out[idx] = {**out[idx], 'amount': n}
    return out


def cmd_add(a) -> None:
    m, ib = load_mirror(), load_inbox()
    kind = {'short': 'short', 'long': 'long', 'ショート': 'short', 'ロング': 'long', '横動画': 'long'}.get(a.kind)
    if not kind:
        raise Stop('--kind は short（ショート）か long（ロング・横動画）')
    unit = 'minute' if a.per_minute else 'video'
    price = a.price
    if price is None:
        cp = (m['data'].get('settings') or {}).get('clientPrices', {}).get(a.client) or {}
        key = 'short' if kind == 'short' else ('longMin' if unit == 'minute' else 'long')
        if cp.get('longUnit') == 'minute' and key == 'longMin':
            price = cp.get('longMin', cp.get('long'))
        else:
            price = cp.get(key)
        if price is None:
            last = [p for p in m['data']['projects'] if p.get('client') == a.client and p.get('kind') == kind
                    and p.get('priceUnit', 'video') == unit]
            last.sort(key=lambda p: p.get('createdAt') or '')
            price = last[-1]['unitPrice'] if last else None
        if price is None:
            raise Stop(f'{a.client} の単価がアプリにありません。--price で入れてください')
    for p in projects_view(m, ib):
        if p.get('client') == a.client and p.get('title') == a.title and p.get('status') != 'done':
            raise Stop(f'同じクライアント・案件名の進行中の案件がもうあります: {row(p)}')
    proj = {'id': str(uuid.uuid4()), 'client': a.client, 'title': a.title, 'kind': kind, 'unitPrice': price,
            'count': a.count, 'priceUnit': unit if kind == 'long' else 'video', 'minutes': a.minutes,
            'extras': [], 'startDate': a.start or today(), 'dueDate': a.due,
            'billingMonth': a.billing or a.due[:7], 'memo': a.memo or '', 'progress': a.progress or '',
            'status': 'active', 'completedAt': None, 'stage': None}
    if a.editor is not None:
        proj['editor'] = a.editor
    fee = parse_fee(a.fee)
    if fee is not None:
        proj['feeUnit'] = None if fee == ('clear',) else fee
    if a.outsource:
        proj['outsources'] = apply_outsources([], a.outsource)
    if a.extra:
        proj['extras'] = apply_extras([], a.extra)
    if unit == 'minute' and not a.minutes:
        raise Stop('1分あたりの単価の時は --minutes（1本の尺・分）を入れてください')
    if a.due < proj['startDate']:
        raise Stop(f'納期 {a.due} が着手日 {proj["startDate"]} より前になっています')
    if a.stage:
        proj.update(stage_fields(a.stage, None))
    patch = {'id': f'c-{uuid.uuid4().hex[:12]}', 'at': now_iso(), 'by': BY, 'op': 'add', 'project': proj, 'note': a.note or ''}
    save_patches([patch], m, ib)
    print(f'受け箱に追加しました（アプリが次に同期した時に取り込みます）\n{row({**proj, "_pending": True})}')


def cmd_set(a) -> None:
    m, ib = load_mirror(), load_inbox()
    p = find_project(projects_view(m, ib), a.query)
    after = {}
    for opt, key in (('due', 'dueDate'), ('start', 'startDate'), ('billing', 'billingMonth'), ('title', 'title'),
                     ('memo', 'memo'), ('progress', 'progress'), ('editor', 'editor')):
        v = getattr(a, opt)
        if v is not None:
            after[key] = v
    fee_v = parse_fee(a.fee)
    if fee_v is not None:
        after['feeUnit'] = None if fee_v == ('clear',) else fee_v
    if a.outsource:
        after['outsources'] = apply_outsources(p.get('outsources'), a.outsource)
    if a.stage:
        after.update(stage_fields(a.stage, p))
    # 単価・本数・種別・数え方・追加料金（入力画面の「単価」「追加料金」の節）
    if a.client is not None:
        if not a.client.strip():
            raise Stop('クライアント名は空にできません')
        after['client'] = a.client.strip()
    if a.price is not None:
        after['unitPrice'] = parse_yen(a.price, '--price', allow_none=False)
    if a.count is not None:
        if a.count < 1:
            raise Stop('--count は 1 以上')
        after['count'] = a.count
    kind = p.get('kind')
    if a.kind is not None:
        kind = {'short': 'short', 'long': 'long', 'ショート': 'short', 'ロング': 'long', '横動画': 'long'}.get(a.kind)
        if not kind:
            raise Stop('--kind は short（ショート）か long（ロング・横動画）')
        after['kind'] = kind
    unit = p.get('priceUnit') or 'video'
    if a.per_minute and kind != 'long':
        raise Stop('1分あたりの単価はロング（横動画）だけ')
    if a.per_minute:
        unit = 'minute'
    if a.per_video or kind == 'short':
        unit = 'video'
    if unit == 'minute' and kind != 'long':
        raise Stop('1分あたりの単価はロング（横動画）だけ')
    if unit != (p.get('priceUnit') or 'video'):
        after['priceUnit'] = unit
    if a.minutes is not None:
        after['minutes'] = int(float(a.minutes))
    if unit == 'video' and p.get('minutes') is not None and (a.per_video or a.kind):
        after['minutes'] = None
    if unit == 'minute' and not (after.get('minutes') or p.get('minutes')):
        raise Stop('1分あたりの単価の時は --minutes（1本の尺・分）を入れてください')
    if a.extra or a.extras_clear:
        after['extras'] = apply_extras([] if a.extras_clear else p.get('extras'), a.extra)
    if a.invoiced is not None:
        after['invoicedAt'] = parse_day(a.invoiced, '--invoiced')
        if after['invoicedAt'] is None:
            after['invoiceSnapshot'] = None  # 発行前に戻す時は控えも外す（アプリの「作り直す」と同じく、次に作る時に新しく作る）
        need_app(m, '案件別の請求書の発行済み')
    if 'dueDate' in after or 'startDate' in after:
        s, d = after.get('startDate', p.get('startDate')), after.get('dueDate', p.get('dueDate'))
        if s and d and d < s:
            raise Stop(f'納期 {d} が着手日 {s} より前になります')
    patch = make_update(m, ib, p['id'], after, a.note or '')
    if not patch:
        print('変える所はありません（もう同じ値）')
        return
    save_patches([patch], m, ib)
    print(f'受け箱に追加しました（アプリが次に同期した時に取り込みます）: {json.dumps(patch["after"], ensure_ascii=False)}')


def apply_extras(current, specs):
    """--extra 名前:単価[:回数] を当てた追加料金の一覧。同じ名前は差し替え、単価が なし・空 なら消す"""
    out = [dict(x) for x in (current or [])]
    for spec in specs or []:
        parts = re.split(r'[:：]', spec)
        if len(parts) not in (2, 3) or not parts[0].strip():
            raise Stop(f'--extra は「名前:単価[:回数]」の形（例: 切り抜き選定:2000:2）: {spec}')
        name = parts[0].strip()
        idx = next((i for i, x in enumerate(out) if (x.get('name') or '') == name), None)
        price = parse_yen(parts[1], f'--extra {name} の単価')
        if price is None:
            if idx is not None:
                out.pop(idx)
            continue
        qty = int(parts[2]) if len(parts) == 3 and parts[2].strip() else 1
        if qty < 1:
            raise Stop(f'--extra {name} の回数は 1 以上')
        item = {'name': name, 'price': price, 'qty': qty}
        if idx is None:
            out.append(item)
        else:
            out[idx] = item
    return out


def cmd_done(a) -> None:
    m, ib = load_mirror(), load_inbox()
    p = find_project(projects_view(m, ib), a.query)
    after = stage_fields('完了', p) if a.cmd == 'done' else {'status': 'active', 'completedAt': None}
    patch = make_update(m, ib, p['id'], after, a.note or '')
    save_and_say([patch], m, ib, f'{"完了" if a.cmd == "done" else "進行中に戻す"} {row(p)}')


def cmd_delete(a) -> None:
    m, ib = load_mirror(), load_inbox()
    need_app(m, '案件の削除（ゴミ箱）')
    p = find_project(projects_view(m, ib), a.query)
    patch = new_patch('delete', a.note or '', projectId=p['id'], seen=p.get('updatedAt'))
    save_patches([patch], m, ib)
    print(f'受け箱に追加しました。アプリが取り込むとゴミ箱に移ります（設定 › ゴミ箱、または `restore {p["id"][:8]}` で戻せます）\n{row(p)}')


def trash_list(v: dict) -> list[dict]:
    ps = v['projects']
    items = [d for d in v['trash'].values() if d.get('project') and d['id'] not in ps]
    return sorted(items, key=lambda d: d.get('deletedAt') or '', reverse=True)


def cmd_trash(a) -> None:
    m, ib = load_mirror(), load_inbox()
    items = trash_list(view(m, ib))
    if not items:
        print('ゴミ箱は空です（0.18.0 より前に消した案件は中身が残っていないので出ません）')
        return
    for d in items:
        by = f'{d["by"]}が' if d.get('by') and d['by'] != 'アプリ' else ''
        print(f'{local_time(d.get("deletedAt", ""))} に{by}削除  {row(d["project"])}{" ※アプリ取り込み待ち" if d.get("_pending") else ""}')


def cmd_restore(a) -> None:
    m, ib = load_mirror(), load_inbox()
    need_app(m, 'ゴミ箱から戻す操作')
    v = view(m, ib)
    items = trash_list(v)
    d = find_project([{**x['project'], '_trash': x} for x in items], a.query)['_trash']
    patch = new_patch('restore', a.note or '', projectId=d['id'], project=d['project'])
    save_patches([patch], m, ib)
    print(f'受け箱に追加しました（アプリが次に同期した時に戻ります）\n{row(d["project"])}')


# ---------- 請求・ディレクター・カレンダー・クライアント別（タブの中身を文字で） ----------

def client_order(v: dict, names) -> list[str]:
    order = v['settings'].get('clientOrder') or []
    return sorted(names, key=lambda n: (order.index(n) if n in order else len(order), n))


def billing_rows(v: dict, ym: str) -> list[dict]:
    rows = {}
    for p in v['projects'].values():
        if p.get('billingMonth') != ym:
            continue
        r = rows.setdefault(p['client'], {'client': p['client'], 'short': [0, 0], 'long': [0, 0], 'total': 0, 'fee': 0, 'pending': 0, 'items': []})
        r[p.get('kind', 'short')][0] += p.get('count', 0)
        r[p.get('kind', 'short')][1] += amount(p)
        r['total'] += amount(p)
        r['fee'] += fee(p)
        r['pending'] += p.get('status') != 'done'
        r['items'].append(p)
    if v['settings'].get('clientOrder'):
        return [rows[n] for n in client_order(v, rows)]
    return sorted(rows.values(), key=lambda r: -r['total'])


def issued_by_projects(v: dict, ym: str, client: str) -> bool:
    ps = [p for p in v['projects'].values() if p.get('billingMonth') == ym and p.get('client') == client]
    return bool(ps) and all(p.get('invoicedAt') for p in ps)


def bill_state(v: dict, ym: str, client: str) -> str:
    r = v['invoices'].get(f'{ym}|{client}') or {}
    inv = f'請求書 発行済 {r["invoicedAt"]}' if r.get('invoicedAt') else '請求書 発行済（案件別）' if issued_by_projects(v, ym, client) else '請求書 未発行'
    paid = f'入金済 {r["paidAt"]}' if r.get('paidAt') else '振込 未確認'
    return f'{inv} ・ {paid}{" ※アプリ取り込み待ち" if r.get("_pending") else ""}'


def open_bills(v: dict) -> list[dict]:
    cur = today()[:7]
    out = []
    for ym in sorted({p.get('billingMonth') for p in v['projects'].values() if p.get('billingMonth') and p['billingMonth'] <= cur}):
        for r in billing_rows(v, ym):
            rec = v['invoices'].get(f'{ym}|{r["client"]}') or {}
            if not rec.get('paidAt'):
                out.append({'month': ym, 'client': r['client'], 'total': r['total'], 'pending': r['pending'],
                            'invoiced': bool(rec.get('invoicedAt')) or issued_by_projects(v, ym, r['client'])})
    return out


def cmd_billing(a) -> None:
    m, ib = load_mirror(), load_inbox()
    v = view(m, ib)
    ym = parse_month(a.month)
    rows = billing_rows(v, ym)
    if a.tsv:   # 請求タブの「表をコピー」と同じ並び
        print('\t'.join(['クライアント', 'ショート本数', 'ショート金額', 'ロング本数', 'ロング金額', '請求額', '請求書発行日', '入金確認日']))
        for r in rows:
            rec = v['invoices'].get(f'{ym}|{r["client"]}') or {}
            print('\t'.join(str(x) for x in [r['client'], r['short'][0], int(r['short'][1]), r['long'][0], int(r['long'][1]), int(r['total']),
                                              rec.get('invoicedAt') or '', rec.get('paidAt') or '']))
        return
    print(f'{mirror_age_note(m)}\n# {month_label(ym)} の請求（請求月で数える）')
    if not rows:
        print('- 案件なし')
    for r in rows:
        undone = f'（未完了 {r["pending"]}件）' if r['pending'] else ''
        print(f'- {r["client"]}{undone}: ショート {r["short"][0]}本 {yen(r["short"][1])} / ロング {r["long"][0]}本 {yen(r["long"][1])} '
              f'＝ {yen(r["total"])} — {bill_state(v, ym, r["client"])}')
        for p in sorted(r['items'], key=lambda p: p.get('dueDate') or ''):
            print(f'    {p["id"][:8]} {KIND_LABEL.get(p.get("kind"), "")} {p.get("title") or "（案件名なし）"} '
                  f'{"完了" if p.get("status") == "done" else "納期 " + str(p.get("dueDate"))} {yen(amount(p))}'
                  f'{" 請求書発行 " + p["invoicedAt"] if p.get("invoicedAt") else ""}')
    if rows:
        paid = sum(r['total'] for r in rows if (v['invoices'].get(f'{ym}|{r["client"]}') or {}).get('paidAt'))
        print(f'- 合計 {yen(sum(r["total"] for r in rows))}（入金済 {yen(paid)}）')
    ob = open_bills(v)
    print(f'\n# 入金待ち・未請求（今月まで） {len(ob)}件 ・ {yen(sum(b["total"] for b in ob))}')
    for b in ob:
        print(f'- {b["month"]} {b["client"]}: {"入金待ち" if b["invoiced"] else "未請求"} {yen(b["total"])}'
              f'{"（未完了 " + str(b["pending"]) + "件）" if b["pending"] else ""}')
    issued = [r['snapshot'] for r in v['invoices'].values() if r.get('invoicedAt') and r.get('snapshot')]
    issued += [p['invoiceSnapshot'] for p in v['projects'].values() if p.get('invoicedAt') and p.get('invoiceSnapshot')]
    if issued:
        print(f'\n# 発行した請求書 {len(issued)}件（新しい順）')
        for s in sorted(issued, key=lambda s: s.get('savedAt') or '', reverse=True)[:20]:
            print(f'- {local_time(s.get("savedAt", ""))} {"案件別" if s.get("mode") == "project" else "クライアント別"} {s.get("fileName")} {yen(s["data"]["total"])}')


def cmd_bill(a) -> None:
    m, ib = load_mirror(), load_inbox()
    v = view(m, ib)
    ym = parse_month(a.month)
    clients = {p['client'] for p in v['projects'].values() if p.get('billingMonth') == ym}
    client = a.client if a.client in clients else next((c for c in clients if a.client in c), None)
    if not client:
        raise Stop(f'{month_label(ym)} が請求月の「{a.client}」の案件がありません（請求タブに出ないので付けられません）。'
                   f'この月のクライアント: {"・".join(sorted(clients)) or "なし"}')
    r = next(x for x in billing_rows(v, ym) if x['client'] == client)
    if a.invoiced is None and a.paid is None:
        print(f'{month_label(ym)} {client} {yen(r["total"])}（{len(r["items"])}件）— {bill_state(v, ym, client)}')
        return
    need_app(m, '請求書・入金の状態')
    after = {}
    for opt, key in (('invoiced', 'invoicedAt'), ('paid', 'paidAt')):
        val = parse_day(getattr(a, opt), f'--{opt}')
        if val is not DEL:
            after[key] = val
    if r['pending'] and after.get('paidAt'):
        print(f'⚠ この月の {client} には未完了の案件が {r["pending"]}件あります（入金済みにはします）')
    patch = invoice_patch(v, ym, client, after, a.note or '')
    save_and_say([patch], m, ib, f'{month_label(ym)} {client} {yen(r["total"])}（{len(r["items"])}件） {json.dumps(after, ensure_ascii=False)}')


def editor_label(name: str) -> str:
    return name or '自分'


def cmd_director(a) -> None:
    m, ib = load_mirror(), load_inbox()
    v = view(m, ib)
    ym = parse_month(a.month)
    rows = billing_rows(v, ym)
    eds, outs = {}, {}
    for p in v['projects'].values():
        if p.get('billingMonth') != ym:
            continue
        e = eds.setdefault(p.get('editor') or '', {'count': 0, 'sales': 0, 'fee': 0, 'out': 0, 'nofee': 0, 'clients': set()})
        e['count'] += p.get('count', 0)
        e['sales'] += amount(p)
        e['fee'] += fee(p)
        e['out'] += outsource_amount(p)
        e['nofee'] += bool(p.get('editor')) and p.get('feeUnit') is None
        e['clients'].add(p['client'])
        for x in p.get('outsources') or []:
            o = outs.setdefault(x.get('to') or '', {'count': 0, 'amount': 0, 'works': {}})
            o['count'] += 1
            o['amount'] += float(x.get('amount') or 0)
            o['works'][x.get('work') or '?'] = o['works'].get(x.get('work') or '?', 0) + 1
    ed_rows = sorted(eds.items(), key=lambda kv: (kv[0] == '', -kv[1]['fee'], kv[0]))
    out_rows = sorted(outs.items(), key=lambda kv: (kv[0] == '', -kv[1]['amount'], kv[0]))
    if a.tsv:   # ディレクタータブの「表をコピー」と同じ
        print('\t'.join(['クライアント', '請求額', '委託費', '純利益']))
        for r in rows:
            print('\t'.join(str(int(x)) if isinstance(x, float) else str(x) for x in [r['client'], r['total'], r['fee'], r['total'] - r['fee']]))
        print('\n' + '\t'.join(['編集者', '本数', '売上', '委託費', '純利益']))
        for n, e in ed_rows:
            print('\t'.join(str(x) for x in [editor_label(n), e['count'], int(e['sales']), int(e['fee']), int(e['sales'] - e['fee'])]))
        if out_rows:
            print('\n' + '\t'.join(['外注先', '業務', '件数', '外注費']))
            for n, o in out_rows:
                print('\t'.join(str(x) for x in [n or '（外注先なし）', '・'.join(o['works']), o['count'], int(o['amount'])]))
        return
    sales, fees = sum(r['total'] for r in rows), sum(r['fee'] for r in rows)
    rate = lambda pr, s: f'{round(pr / s * 100)}%' if s else '—'
    print(f'{mirror_age_note(m)}\n# {month_label(ym)} 売上 {yen(sales)} ・ 委託費 {yen(fees)} ・ 純利益 {yen(sales - fees)} ・ 利益率 {rate(sales - fees, sales)}')
    print('\n## 編集者別')
    for n, e in ed_rows:
        print(f'- {editor_label(n)}: {e["count"]}本 売上 {yen(e["sales"])} 委託費 {yen(e["fee"])}'
              f'{"（うち外注 " + yen(e["out"]) + "）" if e["out"] else ""} 純利益 {yen(e["sales"] - e["fee"])}'
              f'{" ※委託単価なし " + str(e["nofee"]) + "件" if e["nofee"] else ""}  [{"・".join(sorted(e["clients"]))}]')
    if out_rows:
        print('\n## 外注先別')
        for n, o in out_rows:
            print(f'- {n or "（外注先なし）"}: {"・".join(f"{w}×{c}" if c > 1 else w for w, c in o["works"].items())} {o["count"]}件 {yen(o["amount"])}')
    print('\n## クライアント別')
    for r in rows:
        print(f'- {r["client"]}: 請求 {yen(r["total"])} 委託費 {yen(r["fee"])} 純利益 {yen(r["total"] - r["fee"])} {rate(r["total"] - r["fee"], r["total"])}')
    active = sorted([p for p in v['projects'].values() if p.get('status') != 'done'], key=lambda p: p.get('dueDate') or '')
    print(f'\n## 進行中の担当状況 {len(active)}件')
    for n in sorted({p.get('editor') or '' for p in active}, key=lambda n: (n == '', n)):
        print(f'- {editor_label(n)}: ' + ' / '.join(f'{p.get("dueDate")} [{p["client"]}] {p.get("title") or "（案件名なし）"}'
                                                     for p in active if (p.get('editor') or '') == n))
    print(f'\n登録している委託先: {"・".join(v["settings"].get("editors") or []) or "なし"}')


def cmd_calendar(a) -> None:
    m, ib = load_mirror(), load_inbox()
    ym = parse_month(a.month)
    ps = [p for p in projects_view(m, ib) if (p.get('dueDate') or '')[:7] == ym and (a.done or p.get('status') != 'done')]
    print(f'{mirror_age_note(m)}\n# {month_label(ym)} の納期（{"完了も含む" if a.done else "進行中"}）')
    for p in sorted(ps, key=lambda p: p.get('dueDate') or ''):
        print(f'- {row(p)}  （着手 {p.get("startDate")}）')
    if not ps:
        print('- なし')


def cmd_clients(a) -> None:
    m, ib = load_mirror(), load_inbox()
    v = view(m, ib)
    per = (a.period or 'all').strip()
    if per in ('all', '全期間'):
        inside, label = (lambda bm: True), '全期間'
    elif '..' in per or '〜' in per:
        f, t = sorted(parse_month(x) for x in re.split(r'\.\.|〜', per))
        inside, label = (lambda bm: f <= (bm or '') <= t), f'{month_label(f)}〜{month_label(t)}'
    else:
        mo = parse_month(per)
        inside, label = (lambda bm: bm == mo), month_label(mo)
    ps = [p for p in v['projects'].values() if inside(p.get('billingMonth'))]
    names = client_order(v, {p['client'] for p in ps})
    if a.client:
        names = [n for n in names if a.client in n]
    print(f'{mirror_age_note(m)}\n# クライアント別（{label}・請求月で数える）')
    bills = [b for b in open_bills(v) if inside(b['month'])]
    t = today()
    for n in names:
        mine = [p for p in ps if p['client'] == n]
        started = [p for p in mine if p.get('status') != 'done' and (p.get('startDate') or '') <= t]
        upcoming = [p for p in mine if p.get('status') != 'done' and (p.get('startDate') or '') > t]
        done = [p for p in mine if p.get('status') == 'done']
        unbilled = sum(b['total'] for b in bills if b['client'] == n and not b['invoiced'])
        waiting = sum(b['total'] for b in bills if b['client'] == n and b['invoiced'])
        print(f'\n## {n}  着手中 {len(started)} ・ 着手前 {len(upcoming)} ・ 完了 {len(done)} ・ {yen(sum(amount(p) for p in mine))}'
              f'{" ・ 未請求 " + yen(unbilled) if unbilled else ""}{" ・ 入金待ち " + yen(waiting) if waiting else ""}')
        for label2, lst in (('着手中', started), ('着手前', upcoming), ('完了', done)):
            for p in sorted(lst, key=lambda p: p.get('dueDate') or ''):
                print(f'  {label2}  {row(p)}')


# ---------- 単価タブ・委託先・設定 ----------

PRICE_KEYS = {'short': 'short', 'long': 'long', 'long_min': 'longMin', 'editor': 'editor',
              'fee_short': 'feeShort', 'fee_long': 'feeLong', 'fee_long_min': 'feeLongMin'}


def client_price(v: dict, client: str) -> dict:
    """アプリの clientPrice と同じ（0.13.0 までの longUnit: minute は 1分あたりとして読む）"""
    cp = (v['settings'].get('clientPrices') or {}).get(client)
    if not cp or cp.get('longUnit') != 'minute':
        return cp
    rest = {k: x for k, x in cp.items() if k != 'longUnit'}
    return {**rest, 'long': None, 'longMin': rest.get('longMin', cp.get('long')), 'feeLong': None,
            'feeLongMin': rest.get('feeLongMin', cp.get('feeLong'))}


def price_clients(v: dict) -> list[str]:
    names = set((v['settings'].get('clientPrices') or {}).keys()) | {p['client'] for p in v['projects'].values()}
    return client_order(v, names)


def social_ok(kind: str, raw: str) -> bool:
    """アプリの parseSocial と同じ見分け方（読めるリンクか）"""
    t = raw.strip()
    if kind == 'youtube' and re.fullmatch(r'@[^\s/?#]+', t):
        return True
    t = t if re.match(r'https?://', t, re.I) else 'https://' + t
    mt = re.match(r'https?://(?:www\.|m\.)?([^/]+)(/[^?#]*)?', t, re.I)
    if not mt:
        return False
    host, parts = mt.group(1).lower(), [x for x in (mt.group(2) or '').split('/') if x]
    if kind == 'youtube':
        return host.endswith('youtube.com') and bool(parts) and (parts[0].startswith('@') or (parts[0] in ('channel', 'c', 'user') and len(parts) > 1))
    return host in ('x.com', 'twitter.com') and bool(parts) and parts[0] not in ('home', 'i', 'intent', 'search', 'explore', 'hashtag', 'share')


def cmd_price(a) -> None:
    m, ib = load_mirror(), load_inbox()
    v = view(m, ib)
    changes = []
    if a.client:
        name = a.client.strip()
        for opt, key in PRICE_KEYS.items():
            val = getattr(a, opt)
            if val is None:
                continue
            val = val.strip() if key == 'editor' else parse_yen(val, f'--{opt.replace("_", "-")}')
            changes.append((['clientPrices', name, key], val))
        if changes and (v['settings'].get('clientPrices') or {}).get(name, {}).get('longUnit') == 'minute':
            # 古い形の設定は、アプリと同じく今の形に直してから変える
            changes.insert(0, (['clientPrices', name], client_price(v, name)))
        if a.add and not changes and name not in (v['settings'].get('clientPrices') or {}):
            changes.append((['clientPrices', name], {}))
        if a.clear:
            changes = [(['clientPrices', name], DEL)]
        if a.color is not None:
            changes.append((['clientColors', name], DEL if a.color.strip() in ('なし', '元の色', '') else int(a.color) % 360))
        for kind in ('youtube', 'x'):
            val = getattr(a, kind)
            if val is not None:
                if val.strip() and not social_ok(kind, val):
                    raise Stop('YouTube のチャンネルのリンク（youtube.com/@… など）を入れてください' if kind == 'youtube'
                               else 'X のアカウントのリンク（x.com/… など）を入れてください')
                changes.append((['clientLinks', name, kind], val.strip()))
        if a.move:
            names = price_clients(v)
            if name not in names:
                raise Stop(f'「{name}」は単価タブにありません')
            i = names.index(name)
            j = {'up': i - 1, 'down': i + 1, 'top': 0, 'bottom': len(names) - 1}.get(a.move)
            if j is None:
                j = int(a.move) - 1
            names.insert(max(0, min(len(names) - 1, j)), names.pop(i))
            changes.append((['clientOrder'], names))
    if not changes:
        names = [n for n in price_clients(v) if not a.client or a.client in n]
        for n in names:
            cp = client_price(v, n) or {}
            parts = [f'{lab} {yen(cp[k])}' for k, lab in (('short', 'ショート'), ('long', 'ロング/本'), ('longMin', 'ロング/分')) if cp.get(k) is not None]
            fees = [f'{lab} {yen(cp[k])}' for k, lab in (('feeShort', 'ショート'), ('feeLong', 'ロング/本'), ('feeLongMin', 'ロング/分')) if cp.get(k) is not None]
            links = v['settings'].get('clientLinks', {}).get(n, {})
            color = v['settings'].get('clientColors', {}).get(n)
            print(f'- {n}: {" / ".join(parts) or "単価なし"}{" ・ 担当 " + cp["editor"] if cp.get("editor") else ""}'
                  f'{" ・ 委託 " + " / ".join(fees) if fees else ""}{" ・ 色 " + str(color) if color is not None else ""}'
                  f'{" ・ " + " ".join(x for x in links.values() if x) if any(links.values()) else ""}')
        items = v['settings'].get('extraItems') or []
        print('追加料金の項目: ' + (' / '.join(f'{x.get("name")} {yen(x.get("price") or 0)}' for x in items) or 'なし'))
        return
    need_app(m, '単価タブの変更')
    save_and_say([settings_patch(v, changes, a.note or '')], m, ib, f'{a.client} の単価タブ')


def cmd_extra_item(a) -> None:
    m, ib = load_mirror(), load_inbox()
    v = view(m, ib)
    items = [dict(x) for x in v['settings'].get('extraItems') or []]
    if a.action == 'list':
        for x in items:
            print(f'- {x.get("name")} {yen(x.get("price") or 0)}')
        if not items:
            print('追加料金の項目はありません')
        return
    if not a.name:
        raise Stop('名前を入れてください')
    idx = next((i for i, x in enumerate(items) if x.get('name') == a.name), None)
    if a.action == 'add':
        items.append({'name': a.name, 'price': parse_yen(a.price or 0, '単価', allow_none=False)})
    elif idx is None:
        raise Stop(f'追加料金の項目「{a.name}」がありません')
    elif a.action == 'remove':
        items.pop(idx)
    else:
        if a.price is not None:
            items[idx]['price'] = parse_yen(a.price, '単価', allow_none=False)
        if a.rename:
            items[idx]['name'] = a.rename.strip()
    need_app(m, '追加料金の項目の変更')
    save_and_say([settings_patch(v, [(['extraItems'], items)], a.note or '')], m, ib, f'追加料金の項目 {a.action} {a.name}')


def cmd_editor(a) -> None:
    m, ib = load_mirror(), load_inbox()
    v = view(m, ib)
    eds = list(v['settings'].get('editors') or [])
    if a.action == 'list' or not a.name:
        print(f'登録している委託先: {"・".join(eds) or "なし"}')
        return
    name = a.name.strip()
    if a.action == 'add' and name not in eds:
        eds.append(name)
    elif a.action == 'remove':
        if name not in eds:
            raise Stop(f'「{name}」は登録していません（登録: {"・".join(eds) or "なし"}）')
        eds.remove(name)
    need_app(m, '委託先の編集者の変更')
    save_and_say([settings_patch(v, [(['editors'], eds)], a.note or '')], m, ib, f'委託先 {a.action} {name}')


SETTING_OPTS = {  # オプション → 設定の場所（請求書の入力欄・ファイル名の画面と同じ）
    'my_name': ['myName'], 'activity': ['activityName'], 'tel': ['myTel'], 'note': ['note'],
    'zip': ['myAddressInfo', 'zip'], 'pref': ['myAddressInfo', 'pref'], 'city': ['myAddressInfo', 'city'], 'building': ['myAddressInfo', 'building'],
    'bank': ['bankInfo', 'bank'], 'branch': ['bankInfo', 'branch'], 'type': ['bankInfo', 'type'], 'number': ['bankInfo', 'number'], 'holder': ['bankInfo', 'holder'],
    'rule_month': ['fileNameRules', 'month'], 'rule_project': ['fileNameRules', 'project'],
}
DEFAULT_NAME_RULES = {'month': '{請求月}月分請求書_{自分の名前}_{宛名}', 'project': '請求書_{動画名}_{自分の名前}_{宛名}'}


def cmd_setting(a) -> None:
    m, ib = load_mirror(), load_inbox()
    v = view(m, ib)
    st = v['settings']
    changes = []
    for opt, path in SETTING_OPTS.items():
        val = getattr(a, opt)
        if val is None:
            continue
        val = val.replace('\\n', '\n') if opt == 'note' else val.strip()
        if opt == 'type' and val not in ('普通', '当座', '貯蓄'):
            raise Stop('--type は 普通・当座・貯蓄')
        if opt.startswith('rule_'):
            val = val or DEFAULT_NAME_RULES[path[1]]
            changes.append((['fileNameRules'], {**DEFAULT_NAME_RULES, **(st.get('fileNameRules') or {}), path[1]: val}))
            continue
        changes.append((path, val))
    if a.rule_reset:
        changes.append((['fileNameRules'], dict(DEFAULT_NAME_RULES)))
    for spec in a.addressee or []:
        c, _, to = spec.partition('=')
        changes.append((['addressees', c.strip()], to.strip()))
    for spec in a.honorific or []:
        c, _, h = spec.partition('=')
        if h.strip() not in ('様', '御中'):
            raise Stop('--honorific は「クライアント=様」か「クライアント=御中」')
        changes.append((['honorifics', c.strip()], h.strip()))
    if not changes:
        rules = {**DEFAULT_NAME_RULES, **(st.get('fileNameRules') or {})}
        print(f'自分の名前: {st.get("myName") or ""}\n活動名: {st.get("activityName") or ""}\n電話: {st.get("myTel") or ""}')
        print(f'住所: {" ".join(address_lines(my_address(st)))}\n振込先: {" / ".join(bank_lines(st.get("bankInfo") or {}))}')
        print(f'備考: {(st.get("note") or "").replace(chr(10), " / ")}')
        print(f'ファイル名の決まり: クライアント別 {rules["month"]} ／ 案件別 {rules["project"]}')
        for c, to in (st.get('addressees') or {}).items():
            print(f'宛名 {c}: {to} {(st.get("honorifics") or {}).get(c, "様")}')
        return
    need_app(m, '請求書の設定の変更')
    save_and_say([settings_patch(v, changes, a.note_text or '')], m, ib, '請求書の設定・ファイル名の決まり')


# ---------- 請求書（PDF・CSV。アプリの請求書の画面と同じ中身） ----------

def my_address(st: dict) -> dict:
    if st.get('myAddressInfo'):
        return st['myAddressInfo']
    return {'city': re.sub(r'\s*\n\s*', ' ', st['myAddress'])} if st.get('myAddress') else {}


def address_lines(a: dict) -> list[str]:
    return [x for x in [f'〒{a["zip"]}' if a.get('zip') else '', f'{a.get("pref") or ""}{a.get("city") or ""}', a.get('building') or ''] if x]


def bank_lines(b: dict) -> list[str]:
    b = {**b, 'type': b.get('type') or '普通'}
    line1 = '　'.join(x for x in [' '.join(x for x in [b.get('bank'), b.get('branch')] if x), f'{b["type"]} {b["number"]}' if b.get('number') else ''] if x)
    line2 = f'口座名義：{b["holder"]}' if b.get('holder') else ''
    return [x for x in (line1, line2) if x]


def project_label(p: dict) -> str:
    return p.get('title') or f'{KIND_LABEL.get(p.get("kind"), "")}動画編集'


def invoice_items(ps: list[dict]) -> list[dict]:
    items = []
    for p in ps:
        kind = KIND_LABEL.get(p.get('kind'), '')
        mins = int(float(p.get('minutes') or 0))
        per_min = p.get('priceUnit') == 'minute'
        times = f'×{p["count"]}本' if p.get('count', 1) > 1 else ''
        what = f'{kind}・{mins}分{times}' if per_min else kind
        name = (f'{p["title"]}（{what}）' if p.get('title') else f'{project_label(p)}（{mins}分{times}）' if per_min else project_label(p))
        items.append({'name': name, 'qty': units(p), 'price': p.get('unitPrice'), 'amount': base_amount(p)})
        for x in p.get('extras') or []:
            items.append({'name': f'{x.get("name")}（{p["title"]}）' if p.get('title') else x.get('name'), 'qty': x.get('qty'),
                          'price': x.get('price'), 'amount': (x.get('price') or 0) * (x.get('qty') or 0)})
    return [{'no': i + 1, **it} for i, it in enumerate(items)]


def join_names(lst) -> str:
    u = list(dict.fromkeys(x for x in lst if x))
    return f'{"・".join(u[:2])}ほか{len(u) - 2}件' if len(u) > 3 else '・'.join(u)


def apply_name_rule(rule: str, values: dict) -> str:
    name = re.sub(r'\{([^{}]+)\}', lambda mt: values.get(mt.group(1), mt.group(0)), rule)
    name = re.sub(r'[\\/:*?"<>|]', '_', name)
    name = re.sub(r'([_\-・ 　])\1+', r'\1', name)
    name = re.sub(r'^[_\-・ 　]+|[_\-・ 　]+$', '', name)
    return name or '請求書'


def jp_date(s: str) -> str:
    return f'{s[:4]}年{s[5:7]}月{s[8:10]}日' if s else ''


PAPER_CSS = '''
@page { size: A4; margin: 0; }
html, body { margin: 0; background: #fff; }
/* アプリの PDF と同じ：A4 の幅（794px）の用紙を描き、高さがはみ出す時は 1 枚に収まるよう縮める */
.invoice-paper { box-sizing: border-box; width: 794px; margin: 0 auto; padding: 48px 52px; background: #fff; color: #1a1a1a;
  font-size: 13px; line-height: 1.5; font-family: "Yu Gothic", "YuGothic", "Meiryo", sans-serif; }
.ip-title { text-align: center; font-size: 28px; letter-spacing: .4em; margin: 0 0 18px; font-weight: 700; }
.ip-issue { text-align: right; margin-bottom: 18px; }
.ip-parties { display: flex; justify-content: space-between; align-items: flex-end; gap: 24px; margin-bottom: 24px; }
.ip-to { font-size: 18px; font-weight: 700; border-bottom: 1px solid #1a1a1a; padding: 0 4px 4px; min-width: 50%; }
.ip-to span { margin-left: 12px; font-weight: normal; }
.ip-from { text-align: right; font-size: 12px; line-height: 1.6; }
.ip-from-name { font-size: 15px; font-weight: 600; margin-bottom: 2px; }
.ip-amount { display: inline-flex; align-items: baseline; gap: 24px; border-bottom: 2px solid #1a1a1a; padding: 0 4px 6px; margin-bottom: 24px; }
.ip-amount span { font-size: 14px; } .ip-amount b { font-size: 24px; }
.ip-table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
.ip-table th, .ip-table td { border: 1px solid #555; padding: 4px 8px; height: 26px; }
.ip-table th { background: #eef0f3; font-weight: 600; font-size: 12px; }
.ip-table th:nth-child(1) { width: 8%; } .ip-table th:nth-child(3) { width: 10%; }
.ip-table th:nth-child(4), .ip-table th:nth-child(5) { width: 16%; }
.ip-table .n { text-align: right; font-variant-numeric: tabular-nums; } .ip-table .c { text-align: center; }
.ip-table tfoot td { font-weight: 700; background: #f6f7f9; }
.ip-table tfoot td:first-child { text-align: center; letter-spacing: .3em; }
.ip-table th, .ip-table tfoot td { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.ip-block { margin-bottom: 14px; }
.ip-block h3 { font-size: 13px; margin: 0 0 4px; border-left: 3px solid #1a1a1a; padding-left: 6px; }
.ip-block p { margin: 0; min-height: 2.6em; padding-left: 9px; }
.ip-due { margin-bottom: 14px; font-weight: 600; }
'''
INVOICE_ROWS = 20


def paper_html(d: dict, title: str) -> str:
    e = html.escape
    rows = list(d['items']) + [None] * max(0, INVOICE_ROWS - len(d['items']))
    body = ''.join(
        f'<tr><td class="c">{r["no"]}</td><td>{e(str(r["name"]))}</td><td class="n">{fmt_num(r["qty"])}</td><td class="n">{yen(r["price"] or 0)}</td><td class="n">{yen(r["amount"])}</td></tr>'
        if r else '<tr><td></td><td></td><td></td><td></td><td></td></tr>' for r in rows)
    return f'''<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>{e(title)}</title><style>{PAPER_CSS}</style></head><body>
<div class="invoice-paper">
<h1 class="ip-title">請求書</h1>
<div class="ip-issue">発効日: {jp_date(d["issue"])}</div>
<div class="ip-parties"><div class="ip-to">{e(d["to"])}<span>{e(d.get("honorific") or "様")}</span></div>
<div class="ip-from"><div class="ip-from-name">{e(d["myName"])}</div>{"".join(f"<div>{e(x)}</div>" for x in d["address"])}{f"<div>TEL：{e(d['tel'])}</div>" if d.get("tel") else ""}</div></div>
<div class="ip-amount"><span>今回御請求額</span><b>{yen(d["total"])}</b></div>
<table class="ip-table"><thead><tr><th>No.</th><th>品名・作業内容</th><th>数量</th><th>単価</th><th>金額</th></tr></thead>
<tbody>{body}</tbody><tfoot><tr><td colspan="4">合計金額</td><td class="n">{yen(d["total"])}</td></tr></tfoot></table>
<div class="ip-block"><h3>お振込先</h3><p>{"<br>".join(e(x) for x in d["bank"])}</p></div>
<div class="ip-due">お支払期限: {jp_date(d["due"])}</div>
<div class="ip-block"><h3>備考</h3><p>{e(d.get("note") or "").replace(chr(10), "<br>")}</p></div>
</div>
<script>const p = document.querySelector('.invoice-paper'); const h = p.getBoundingClientRect().height;
if (h > 1120) p.style.zoom = String(1120 / h);</script>
</body></html>'''


def fmt_num(x) -> str:
    return str(int(x)) if isinstance(x, float) and x.is_integer() else str(x)


def invoice_csv(d: dict) -> str:
    """アプリの invoiceCsv と同じ（テンプレートと同じ 6 列・同じ行の位置）"""
    def row_(cells=None):
        r = [''] * 6
        for k, x in (cells or {}).items():
            r[k] = x
        return r

    def cell(x):
        s = '' if x is None else fmt_num(x) if isinstance(x, (int, float)) else str(x)
        return f'"{s.replace(chr(34), chr(34) * 2)}"' if re.search(r'[",\r\n]', s) else s
    out = [row_(), row_({1: '請求書'}), row_(), row_({4: '発効日:', 5: jp_date(d['issue'])}), row_({4: d['myName']}),
           row_({1: f'{d["to"]} {d.get("honorific") or "様"}', 4: ' '.join(d['address'])}),
           row_({4: f'TEL：{d["tel"]}' if d.get('tel') else ''}), row_({1: '今回御請求額'}), row_({1: yen(d['total'])}), row_(), row_(),
           row_({1: 'No.', 2: '品名・作業内容', 3: '数量', 4: '単価', 5: '金額'})]
    items = list(d['items']) + [None] * max(0, INVOICE_ROWS - len(d['items']))
    for it in items:
        out.append(row_({1: it['no'], 2: it['name'], 3: it['qty'], 4: it['price'], 5: it['amount']}) if it else row_())
    out += [row_({1: '合計金額', 5: d['total']}), row_(), row_({1: 'お振込先'})]
    for b in (list(d['bank']) + ['', ''])[:2]:
        out.append(row_({1: b}))
    out += [row_({1: 'お支払期限:', 2: jp_date(d['due'])}), row_(), row_({1: '備考', 2: (d.get('note') or '').replace('\n', ' ')})]
    return '\r\n'.join(','.join(cell(x) for x in r) for r in out) + '\r\n'


def find_browser() -> str | None:
    for p in (r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe', r'C:\Program Files\Microsoft\Edge\Application\msedge.exe',
              r'C:\Program Files\Google\Chrome\Application\chrome.exe', shutil.which('msedge') or '', shutil.which('chrome') or ''):
        if p and Path(p).exists():
            return p
    return None


def html_to_pdf(src: Path, dest: Path) -> None:
    exe = find_browser()
    if not exe:
        raise Stop('PDF を作るブラウザ（Edge・Chrome）が見つかりません。--html で作って、ブラウザで開いて PDF に保存してください')
    with tempfile.TemporaryDirectory() as prof:
        r = subprocess.run([exe, '--headless=new', '--disable-gpu', '--no-first-run', f'--user-data-dir={prof}', '--no-pdf-header-footer',
                            f'--print-to-pdf={dest}', src.resolve().as_uri()], capture_output=True, text=True, timeout=120)
    if not dest.exists() or dest.stat().st_size == 0:
        raise Stop(f'PDF を作れませんでした（{exe}）: {r.stderr[-500:]}')


def cmd_invoice(a) -> None:
    m, ib = load_mirror(), load_inbox()
    v = view(m, ib)
    st = v['settings']
    if a.project:
        p = find_project(list(v['projects'].values()), a.project)
        target = {'mode': 'project', 'month': p.get('billingMonth'), 'client': p['client'], 'projectId': p['id']}
        ps = [p]
        snap = p.get('invoiceSnapshot') if p.get('invoicedAt') else None
        issue, due = today(), month_end(shift_month(today()[:7], 1))
        title = f'案件「{project_label(p)}」　{p["client"]}'
    else:
        if not (a.month and a.client):
            raise Stop('invoice <月> <クライアント> か invoice --project <案件>')
        ym = parse_month(a.month)
        clients = {x['client'] for x in v['projects'].values() if x.get('billingMonth') == ym}
        client = a.client if a.client in clients else next((c for c in clients if a.client in c), None)
        if not client:
            raise Stop(f'{month_label(ym)} が請求月の「{a.client}」の案件がありません')
        target = {'mode': 'month', 'month': ym, 'client': client, 'projectId': None}
        ps = sorted([x for x in v['projects'].values() if x.get('billingMonth') == ym and x['client'] == client], key=lambda x: x.get('dueDate') or '')
        rec = v['invoices'].get(f'{ym}|{client}') or {}
        snap = rec.get('snapshot') if rec.get('invoicedAt') else None
        issue, due = month_end(ym), month_end(shift_month(ym, 1))
        title = f'{month_label(ym)}分　{client}'
    out_dir = Path(a.out) if a.out else Path.home() / 'Downloads'
    out_dir.mkdir(parents=True, exist_ok=True)
    if snap and not a.remake:   # 発行済み：控えをそのまま出す（アプリの「請求書を見る」）
        d, file_name, mark = snap['data'], snap['fileName'], False
        now_items = invoice_items(ps)
        if json.dumps(now_items, ensure_ascii=False) != json.dumps(snap['data']['items'], ensure_ascii=False):
            print(f'⚠ 発行した後に案件の内容が変わっています（いまの内容だと {yen(sum(x["amount"] for x in now_items))}）。直した請求書は --remake で')
        print(f'発行済みの控え（{local_time(snap.get("savedAt", ""))} 保存）を出します')
    else:
        items = invoice_items(ps)
        if not items:
            raise Stop('この月・このクライアントの案件がありません')
        to = (st.get('addressees') or {}).get(target['client']) or target['client']
        d = {'to': to, 'honorific': (st.get('honorifics') or {}).get(target['client'], '様'), 'myName': st.get('myName') or '',
             'address': address_lines(my_address(st)), 'tel': st.get('myTel') or '',
             'issue': parse_day(a.issue, '--issue') if a.issue else issue, 'due': parse_day(a.due, '--due') if a.due else due,
             'bank': bank_lines(st.get('bankInfo') or {}), 'note': (st.get('note') or '').strip(),
             'items': items, 'total': sum(x['amount'] for x in items)}
        ym = target['month']
        values = {'クライアント': target['client'], '宛名': f'{d["to"]}{d["honorific"]}', '自分の名前': d['myName'] or '自分の名前',
                  '活動名': st.get('activityName') or '',
                  '動画名': project_label(ps[0]) if target['mode'] == 'project' else join_names(x.get('title') for x in ps),
                  '請求月': str(int(ym[5:7])), '年': ym[:4], '発効日': (d['issue'] or '').replace('-', ''),
                  '種別': join_names(KIND_LABEL.get(x.get('kind')) for x in ps), '担当編集者': join_names(x.get('editor') for x in ps)}
        rules = {**DEFAULT_NAME_RULES, **(st.get('fileNameRules') or {})}
        file_name = apply_name_rule(rules['project' if target['mode'] == 'project' else 'month'], values)
        mark = not a.no_mark
    formats = [f for f in ('pdf', 'csv', 'html') if getattr(a, f)] or ['pdf']
    made = []
    for f in formats:
        dest = out_dir / f'{file_name}.{f}'
        page = paper_html(d, title)
        if f == 'csv':
            dest.write_text('\ufeff' + invoice_csv(d), encoding='utf-8', newline='')
        elif f == 'html':
            dest.write_text(page, encoding='utf-8')
        else:
            with tempfile.TemporaryDirectory() as tmp:
                src = Path(tmp) / 'invoice.html'
                src.write_text(page, encoding='utf-8')
                html_to_pdf(src, dest)
        made.append(dest)
    print('\n'.join(f'作りました: {x}' for x in made))
    print(f'{title}  {yen(d["total"])}（{len(d["items"])}行） 宛名 {d["to"]} {d.get("honorific") or "様"}  発効日 {d["issue"]}  お支払期限 {d["due"]}')
    if not mark:
        return
    # 保存したら控えを残し「請求書 発行済」にする（アプリの markIssued と同じ）
    need_app(m, '請求書の発行済み（控え）')
    snapshot = {**target, 'title': title, 'fileName': file_name, 'savedAt': now_iso(), 'data': d}
    if target['mode'] == 'project':
        p = ps[0]
        patch = make_update(m, ib, p['id'], {'invoicedAt': p.get('invoicedAt') or today(), 'invoiceSnapshot': snapshot}, a.note or '')
    else:
        rec = v['invoices'].get(f'{target["month"]}|{target["client"]}') or {}
        patch = invoice_patch(v, target['month'], target['client'], {'invoicedAt': rec.get('invoicedAt') or today(), 'snapshot': snapshot}, a.note or '')
    save_and_say([patch], m, ib, '請求書を「発行済」にして控えを残す')


# ---------- 書き出し・読み込み ----------

def cmd_export(a) -> None:
    m, ib = load_mirror(), load_inbox()
    v = view(m, ib)
    strip = lambda r: {k: x for k, x in r.items() if k != '_pending'}
    data = {'app': 'anken-kanri', 'version': 3, 'exportedAt': now_iso(),
            'projects': [strip(p) for p in v['projects'].values()], 'invoices': [strip(r) for r in v['invoices'].values()],
            'settings': v['settings'] or None}
    out = Path(a.out) if a.out else Path.home() / 'Downloads' / f'案件管理_{today().replace("-", "")}.json'
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f'書き出しました: {out}（{len(data["projects"])}件。アイコンの画像は写しに無いので入りません）')


def cmd_import(a) -> None:
    m, ib = load_mirror(), load_inbox()
    need_app(m, '読み込み（置き換え）')
    try:
        data = json.loads(Path(a.file).read_text(encoding='utf-8-sig'))
    except (OSError, json.JSONDecodeError) as e:
        raise Stop(f'JSON ファイルとして読めません: {e}')
    if isinstance(data, dict) and data.get('app') == 'anken-kanri-mirror' and data.get('data'):
        data = data['data']   # 写し（バックアップ）もそのまま読める
    lst = data if isinstance(data, list) else data.get('projects') if isinstance(data, dict) else None
    if not isinstance(lst, list):
        raise Stop('案件データが見つかりませんでした')
    data = {'projects': lst} if isinstance(data, list) else {k: data.get(k) for k in ('projects', 'invoices', 'settings') if data.get(k) is not None}
    if isinstance(data.get('settings'), dict):
        data['settings'] = {k: x for k, x in data['settings'].items() if k != 'clientIcons'}
    cur = projects_view(m, ib)
    gone = [p for p in cur if p['id'] not in {x['id'] for x in lst}]
    print(f'{len(lst)}件の案件で、今のデータ（{len(cur)}件）を置き換えます。消える {len(gone)}件はゴミ箱に入ります。'
          '請求書・入金の状態はファイルの中身で置き換わります（ファイルに無い月は「未」に戻る）')
    if not a.yes:
        print('（--yes を付けると受け箱に書きます）')
        return
    save_patches([new_patch('import', a.note or '', data=data)], m, ib)
    print('受け箱に追加しました（アプリが次に同期した時に置き換えます）')


# ---------- .company とそろえる ----------

FM_RE = re.compile(r'\A---\r?\n(.*?)\r?\n---\r?\n', re.S)


def read_fm(path: Path) -> tuple[str, dict]:
    text = path.read_text(encoding='utf-8')
    mt = FM_RE.match(text)
    fm = {}
    if mt:
        for line in mt.group(1).splitlines():
            mm = re.match(r'^([A-Za-z_][\w-]*):\s*(.*?)\s*(#.*)?$', line)
            if mm:
                v = mm.group(2)
                if len(v) >= 2 and v[0] == v[-1] and v[0] in '"\'':
                    v = v[1:-1]
                fm[mm.group(1)] = v
    return text, fm


def write_fm(path: Path, text: str, values: dict) -> str:
    mt = FM_RE.match(text)
    if not mt:
        raise Stop(f'{path.name} に先頭の --- がありません')
    body = mt.group(1)
    for k, v in values.items():
        line = f'{k}: "{v}"'
        pat = re.compile(rf'^{re.escape(k)}:.*$', re.M)
        body = pat.sub(lambda _m: line, body, count=1) if pat.search(body) else body + '\n' + line
    nl = '\r\n' if '\r\n' in mt.group(0) else '\n'
    return f'---{nl}{body}{nl}---{nl}' + text[mt.end():]


def job_values(fm: dict) -> dict:
    return {'due': fm.get('due', ''), 'stage': fm.get('stage', ''), 'progress': fm.get('status', '')}


def app_values(p: dict) -> dict:
    return {'due': p.get('dueDate') or '', 'stage': stage_label(p), 'progress': p.get('progress') or ''}


def to_app_fields(field: str, value: str, p: dict) -> dict:
    if field == 'due':
        return {'dueDate': value}
    if field == 'progress':
        return {'progress': value}
    return stage_fields(value, p)


def cmd_link(a) -> None:
    m, ib = load_mirror(), load_inbox()
    job = Path(a.job)
    if not job.is_absolute():
        job = COMPANY / 'production' / 'jobs' / job
    p = find_project(projects_view(m, ib), a.query)
    text, fm = read_fm(job)
    dest = backup(job)
    new = write_fm(job, text, {'anken_id': p['id']})
    job.write_text(new, encoding='utf-8', newline='')
    log(f'結び付け {job.name} ⇔ {p["id"]} （バックアップ {dest.name}）')
    print(f'{job.name} ⇔ {row(p)}\n次に `company` を実行すると、納期・段階・進行メモがそろいます')


def cmd_company(a) -> None:
    m, ib = load_mirror(), load_inbox()
    view = {p['id']: p for p in projects_view(m, ib)}
    state = json.loads(STATE.read_text(encoding='utf-8')) if STATE.exists() else {}
    patches, job_writes, report = [], {}, []
    for job in sorted((COMPANY / 'production' / 'jobs').glob('*.md')):
        if job.name.startswith('_'):
            continue
        text, fm = read_fm(job)
        pid = fm.get('anken_id')
        if not pid:
            continue
        p = view.get(pid)
        if not p:
            report.append(f'⚠ {job.name}: アプリに案件 {pid[:8]} がありません（削除された？）')
            continue
        jv, av = job_values(fm), app_values(p)
        base = state.get(job.name, {}).get('values', {})
        job_time = dt.datetime.fromtimestamp(job.stat().st_mtime, dt.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
        app_time = p.get('updatedAt') or ''
        to_job, to_app = {}, {}
        for f in ('due', 'stage', 'progress'):
            j, ap, b = jv[f], av[f], base.get(f)
            if j == ap:
                continue
            if not j and f != 'progress':   # .company 側が空なら、アプリの値を入れる
                to_job[f] = ap
            elif b is not None and j == b:  # .company は変わっていない → アプリの変更を反映
                to_job[f] = ap
            elif b is not None and ap == b:  # アプリは変わっていない → .company の変更を反映
                to_app[f] = j
            else:                           # 両方変わった（初めての時も）→ 後から変えた方、同じならアプリ
                winner = 'company' if job_time > app_time else 'app'
                (to_app if winner == 'company' else to_job)[f] = j if winner == 'company' else ap
                report.append(f'⚠ {job.name}: {f} が両方で変わっていた（.company「{j}」/ アプリ「{ap}」）→ '
                              f'{"後から変えた .company" if winner == "company" else "アプリ"}の値にした')
        if to_job:
            new_vals = {{'progress': 'status'}.get(k, k): v for k, v in to_job.items()}
            job_writes[job] = write_fm(job, text, new_vals)
            report.append(f'→ .company {job.name}: {json.dumps(new_vals, ensure_ascii=False)}')
        if to_app:
            fields = {}
            for f, v in to_app.items():
                fields.update(to_app_fields(f, v, p))
            patch = make_update(m, ib, pid, fields, f'.company {job.name} から')
            if patch:
                patches.append(patch)
                report.append(f'→ アプリ「{p.get("title")}」: {json.dumps(patch["after"], ensure_ascii=False)}')
        merged = {f: (to_app.get(f) or to_job.get(f) or jv[f] or av[f]) for f in ('due', 'stage', 'progress')}
        state[job.name] = {'id': pid, 'values': merged}
    # 提出フォルダの動画（アプリ 0.19.0 から。古い版の写しなら書かずに知らせる）
    try:
        d_patches, d_report = delivery_patches(m, {**ib, 'patches': (ib.get('patches') or []) + patches})
    except Exception as e:  # 提出フォルダが読めなくても、ほかのそろえは続ける
        d_patches, d_report = [], [f'⚠ 提出フォルダを見られなかった: {e}']
    if d_patches and app_version(m) < DELIVERY_APP:
        d_report.append(f'（提出した動画 {len(d_patches)} 件分は、アプリ v{".".join(map(str, DELIVERY_APP))} を開いて同期してから入れる）')
        d_patches = []
    patches += d_patches
    report += d_report
    if a.dry_run:
        print('\n'.join(report) or 'そろえる所はありません')
        print('\n（--dry-run なので書いていません）')
        return
    if patches or job_writes:
        dest = backup(MIRROR, INBOX, STATE, *job_writes.keys())
        for job, new in job_writes.items():
            job.write_text(new, encoding='utf-8', newline='')
            log(f'.company に反映 {job.name} （バックアップ {dest.name}）')
        if patches:
            save_patches(patches, m, ib)
    summary = render_summary(m, load_inbox())  # 今書いたパッチも重ねて出す
    WORK.mkdir(parents=True, exist_ok=True)
    STATE.write_text(json.dumps(state, ensure_ascii=False, indent=1), encoding='utf-8')
    out = COMPANY / 'secretary' / 'anken-app.md'
    out.write_text(summary, encoding='utf-8')
    print('\n'.join(report) or 'そろえる所はありません')
    print(f'{out} を作り直しました（{mirror_age_note(m)}）')


def render_summary(m: dict, ib: dict) -> str:
    ps = projects_view(m, ib)
    t = today()
    cur = t[:7]
    nxt = (dt.date.fromisoformat(cur + '-01') + dt.timedelta(days=32)).strftime('%Y-%m')
    prv = (dt.date.fromisoformat(cur + '-01') - dt.timedelta(days=1)).strftime('%Y-%m')
    active = sorted([p for p in ps if p.get('status') != 'done'], key=lambda p: p.get('dueDate') or '')
    lines = ['---', f'generated: "{dt.datetime.now().isoformat(timespec="minutes")}"',
             'source: "案件管理アプリの写し（tools/claude-link/anken.py company が作る。手で書かない）"', '---', '',
             '# 案件管理アプリから（納期・請求・入金）', '',
             f'- {mirror_age_note(m)}。単価・請求・入金はアプリが正。ここは毎回作り直す', '']
    lines += ['## 進行中（納期順）', '']
    if not active:
        lines.append('- なし')
    for p in active:
        left = (dt.date.fromisoformat(p['dueDate']) - dt.date.fromisoformat(t)).days if p.get('dueDate') else None
        when = '' if left is None else (f'{-left}日超過' if left < 0 else '今日' if left == 0 else f'あと{left}日')
        prog = f' ・ {p["progress"]}' if p.get('progress') else ''
        ed = f' ・ 担当 {p["editor"]}' if p.get('editor') else ''
        pend = ' ※アプリ取り込み待ち' if p.get('_pending') else ''
        lines.append(f'- **{p["dueDate"]}（{when}）** [{p.get("client")}] {p.get("title") or "（案件名なし）"} — '
                     f'{stage_label(p)}{prog}{ed} ・ {yen(amount(p))} ・ 請求 {p.get("billingMonth")} ・ id `{p["id"][:8]}`{pend}')
    inv = {r['key']: r for r in m['data'].get('invoices', [])}
    lines += ['', '## 請求・入金（請求月ごと・クライアント別、税込）', '']
    for month in (prv, cur, nxt):
        rows = {}
        for p in ps:
            if p.get('billingMonth') == month:
                rows.setdefault(p.get('client'), []).append(p)
        lines.append(f'### {month}')
        if not rows:
            lines += ['- 案件なし', '']
            continue
        total = 0
        for client, cps in sorted(rows.items()):
            s = sum(amount(p) for p in cps)
            total += s
            r = inv.get(f'{month}|{client}', {})
            undone = sum(1 for p in cps if p.get('status') != 'done')
            st = ('入金済み ' + r['paidAt']) if r.get('paidAt') else ('請求書送付 ' + r['invoicedAt']) if r.get('invoicedAt') else '請求前'
            lines.append(f'- {client}: {yen(s)}（{len(cps)}件{f"・うち進行中 {undone}" if undone else ""}）— {st}')
        lines += [f'- 合計 {yen(total)}', '']
    prices = (m['data'].get('settings') or {}).get('clientPrices', {})
    if prices:
        lines += ['## クライアントの単価（アプリの単価タブ）', '']
        for c, cp in prices.items():
            parts = [f'{k} {yen(cp[k])}' for k in ('short', 'long', 'longMin') if cp.get(k) is not None]
            lines.append(f'- {c}: {" / ".join(parts) or "未設定"}{(" ・ 担当 " + cp["editor"]) if cp.get("editor") else ""}')
        lines.append('')
    res = m.get('claude', {}).get('results', [])[:8]
    warn = [r for r in res if r.get('result') in ('conflict', 'partial', 'error', 'skipped')]
    if warn:
        lines += ['## Claude の変更で取り込まれなかった物（確認する）', '']
        lines += [f'- {r.get("at", "")[:16]} {r.get("title", "")} {RESULT_LABEL.get(r.get("result"))}: {r.get("detail", "")}' for r in warn]
        lines.append('')
    return '\n'.join(lines)


def main() -> int:
    ap = argparse.ArgumentParser(description='案件管理アプリ ⇔ Claude の連携')
    sub = ap.add_subparsers(dest='cmd', required=True)
    sub.add_parser('status', help='写しの新しさ・取り込み待ち・最近の結果')
    s = sub.add_parser('list', help='案件タブ（--done で完了済みタブ）')
    s.add_argument('--all', action='store_true'); s.add_argument('--done', action='store_true'); s.add_argument('--json', action='store_true')
    s = sub.add_parser('show', help='1 件の中身'); s.add_argument('query')
    s = sub.add_parser('add', help='案件を足す（入力画面の「追加」）')
    s.add_argument('--client', required=True); s.add_argument('--title', required=True)
    s.add_argument('--kind', required=True); s.add_argument('--due', required=True)
    s.add_argument('--price', type=float); s.add_argument('--count', type=int, default=1)
    s.add_argument('--per-minute', action='store_true'); s.add_argument('--minutes', type=float)
    s.add_argument('--start'); s.add_argument('--billing'); s.add_argument('--memo'); s.add_argument('--progress')
    s.add_argument('--stage'); s.add_argument('--editor'); s.add_argument('--note')
    s.add_argument('--fee', help='委託単価（円。1分あたりの案件は1分あたり）。「なし」で消す')
    s.add_argument('--outsource', action='append', help='一部の業務の外注「業務:外注先:金額」（何回でも）')
    s.add_argument('--extra', action='append', help='追加料金「名前:単価[:回数]」（何回でも）')
    s = sub.add_parser('set', help='案件を変える（入力画面の「更新」・段階のボタン）'); s.add_argument('query')
    for o in ('due', 'start', 'billing', 'title', 'memo', 'progress', 'editor', 'stage', 'note', 'client', 'kind', 'price', 'minutes'):
        s.add_argument(f'--{o}')
    s.add_argument('--count', type=int)
    s.add_argument('--per-minute', action='store_true', help='単価を 1分あたりに（ロングだけ。--minutes も）')
    s.add_argument('--per-video', action='store_true', help='単価を 1本あたりに')
    s.add_argument('--fee', help='委託単価（円。1分あたりの案件は1分あたり）。「なし」で消す')
    s.add_argument('--outsource', action='append', help='一部の業務の外注「業務:外注先:金額」（何回でも、0・なしで消す）')
    s.add_argument('--extra', action='append', help='追加料金「名前:単価[:回数]」（同じ名前は差し替え、単価 なし で消す）')
    s.add_argument('--extras-clear', action='store_true', help='追加料金を全部外す（--extra と一緒なら入れ直し）')
    s.add_argument('--invoiced', help='案件別の請求書を発行した日（今日・日付・なし）')
    for name, hl in (('done', '完了にする（「完了」ボタン）'), ('undone', '進行中に戻す（完了済みタブの「戻す」）'),
                     ('delete', 'ゴミ箱に移す（入力画面の「削除」）'), ('restore', 'ゴミ箱から戻す')):
        s = sub.add_parser(name, help=hl); s.add_argument('query'); s.add_argument('--note')
    sub.add_parser('trash', help='ゴミ箱の中身')
    s = sub.add_parser('billing', help='請求タブ（--tsv で「表をコピー」と同じ）'); s.add_argument('month', nargs='?'); s.add_argument('--tsv', action='store_true')
    s = sub.add_parser('bill', help='請求書の発行・振込の確認の済／未（請求タブのボタン）')
    s.add_argument('month'); s.add_argument('client'); s.add_argument('--invoiced'); s.add_argument('--paid'); s.add_argument('--note')
    s = sub.add_parser('director', help='ディレクタータブ（--tsv で「表をコピー」と同じ）'); s.add_argument('month', nargs='?'); s.add_argument('--tsv', action='store_true')
    s = sub.add_parser('calendar', help='カレンダータブ（その月の納期）'); s.add_argument('month', nargs='?'); s.add_argument('--done', action='store_true')
    s = sub.add_parser('clients', help='クライアント別タブ'); s.add_argument('--period', help='all・YYYY-MM・YYYY-MM..YYYY-MM'); s.add_argument('--client')
    s = sub.add_parser('price', help='単価タブ（クライアントの単価・担当・委託単価・色・並び・リンク）'); s.add_argument('client', nargs='?')
    for o in PRICE_KEYS:
        s.add_argument(f'--{o.replace("_", "-")}', dest=o)
    s.add_argument('--color', help='色相 0〜359、「なし」で元の色'); s.add_argument('--move', help='up・down・top・bottom・何番目')
    s.add_argument('--youtube'); s.add_argument('--x'); s.add_argument('--add', action='store_true', help='クライアントを一覧に足すだけ')
    s.add_argument('--clear', action='store_true', help='このクライアントの単価の設定を消す（案件は残る）'); s.add_argument('--note')
    s = sub.add_parser('extra-item', help='単価タブの追加料金の項目')
    s.add_argument('action', choices=['list', 'add', 'set', 'remove']); s.add_argument('name', nargs='?'); s.add_argument('price', nargs='?')
    s.add_argument('--rename'); s.add_argument('--note')
    s = sub.add_parser('editor', help='委託先の編集者（ディレクタータブ）')
    s.add_argument('action', choices=['list', 'add', 'remove']); s.add_argument('name', nargs='?'); s.add_argument('--note')
    s = sub.add_parser('setting', help='請求書の設定（自分の名前・住所・振込先・備考・宛名）とファイル名の決まり')
    for o in SETTING_OPTS:
        s.add_argument(f'--{o.replace("_", "-")}', dest=o)
    s.add_argument('--rule-reset', action='store_true'); s.add_argument('--addressee', action='append', help='クライアント=宛名')
    s.add_argument('--honorific', action='append', help='クライアント=様|御中'); s.add_argument('--why', dest='note_text', help='受け箱に残す理由')
    s = sub.add_parser('invoice', help='請求書の PDF・CSV を作り「発行済」にする（発行済みなら控えを出す）')
    s.add_argument('month', nargs='?'); s.add_argument('client', nargs='?'); s.add_argument('--project')
    s.add_argument('--issue'); s.add_argument('--due'); s.add_argument('--out')
    s.add_argument('--pdf', action='store_true'); s.add_argument('--csv', action='store_true'); s.add_argument('--html', action='store_true')
    s.add_argument('--remake', action='store_true', help='控えがあっても今の内容で作り直す'); s.add_argument('--no-mark', action='store_true', help='発行済みにしない（下書き）')
    s.add_argument('--note')
    s = sub.add_parser('export', help='書き出し（アプリの「書き出し」と同じ形の JSON）'); s.add_argument('--out')
    s = sub.add_parser('import', help='読み込み（置き換え。消える案件はゴミ箱へ）'); s.add_argument('file'); s.add_argument('--yes', action='store_true'); s.add_argument('--note')
    s = sub.add_parser('company', help='.company の jobs とそろえ、anken-app.md を作り直す'); s.add_argument('--dry-run', action='store_true')
    s = sub.add_parser('deliveries', help='提出フォルダの動画を案件に入れる（--all で古い完了済みも）')
    s.add_argument('--dry-run', action='store_true'); s.add_argument('--all', action='store_true')
    s = sub.add_parser('link', help='jobs のファイルに案件を結び付ける'); s.add_argument('job'); s.add_argument('query')
    a = ap.parse_args()
    for k in ('price', 'minutes'):
        v = getattr(a, k, None)
        if isinstance(v, float) and v.is_integer():
            setattr(a, k, int(v))
    try:
        {'status': cmd_status, 'list': cmd_list, 'show': cmd_show, 'add': cmd_add, 'set': cmd_set,
         'done': cmd_done, 'undone': cmd_done, 'delete': cmd_delete, 'restore': cmd_restore, 'trash': cmd_trash,
         'billing': cmd_billing, 'bill': cmd_bill, 'director': cmd_director, 'calendar': cmd_calendar, 'clients': cmd_clients,
         'price': cmd_price, 'extra-item': cmd_extra_item, 'editor': cmd_editor, 'setting': cmd_setting, 'invoice': cmd_invoice,
         'export': cmd_export, 'import': cmd_import,
         'company': cmd_company, 'deliveries': cmd_deliveries, 'link': cmd_link}[a.cmd](a)
    except Stop as e:
        print(f'止めました: {e}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
