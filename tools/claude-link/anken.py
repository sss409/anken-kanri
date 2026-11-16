"""案件管理アプリ ⇔ Claude（仮想カンパニー .company）の連携ツール

アプリは同期のたびに、マイドライブの「案件管理（Claude連携）」フォルダへ
  anken-kanri.json  … 写し（アプリだけが書く。ここでは読むだけ）
を書き、同じフォルダの
  claude-inbox.json … 受け箱（このツールだけが書く。アプリは読むだけ）
の変更（パッチ）を取り込む。取り込んだ結果は写しの claude.results に出る。

使い方（Python 3.10 以上・標準ライブラリだけ）:
  python anken.py status                 写しの新しさ・取り込み待ち・最近の結果
  python anken.py list [--all] [--json]  進行中（--all で完了も）の案件
  python anken.py show <案件>            1 件の中身（<案件> は id の先頭 6 文字以上か、案件名・クライアントの一部）
  python anken.py add --client 吠瑠うに --title 1116_BD攻略 --kind long --due 2026-11-18 [--price 円] [--stage 初稿提出] [--progress ...]
  python anken.py set <案件> [--due] [--stage 作業中|初稿提出|修正中|完了] [--progress ...] [--title] [--memo] [--start] [--billing]
  python anken.py company [--dry-run]    .company の jobs（anken_id のあるもの）と両方向にそろえ、secretary/anken-app.md を作り直す
  python anken.py link <jobファイル> <案件>   jobs のファイルにアプリの案件を結び付ける
書き込む前に、写し・受け箱・書き換える jobs のファイルを <.company>/.anken/backup/<日時>/ に必ずコピーする。
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import shutil
import sys
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

def projects_view(m: dict, ib: dict) -> list[dict]:
    """写しの案件に、まだ取り込まれていない受け箱の変更を重ねたもの（_pending に印）"""
    ps = {p['id']: dict(p) for p in m['data']['projects']}
    for patch in sorted(pending(m, ib), key=lambda x: x.get('at', '')):
        if patch['op'] == 'add':
            p = dict(patch['project'])
            p.setdefault('status', 'active')
            p['_pending'] = True
            ps.setdefault(p['id'], p)
        elif patch['op'] == 'update' and patch.get('projectId') in ps:
            ps[patch['projectId']].update(patch.get('after', {}))
            ps[patch['projectId']]['_pending'] = True
    return list(ps.values())


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


def yen(n: float) -> str:
    return f'¥{int(round(n)):,}'


def row(p: dict) -> str:
    mark = ' ※アプリ取り込み待ち' if p.get('_pending') else ''
    prog = f' ・ {p["progress"]}' if p.get('progress') else ''
    kind = {'short': 'ショート', 'long': 'ロング'}.get(p.get('kind'), p.get('kind'))
    return (f'{p.get("dueDate")}  {p["id"][:8]}  [{p.get("client")}] {p.get("title") or "（案件名なし）"}'
            f'（{kind}）  {stage_label(p)}{prog}  {yen(amount(p))}{mark}')


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
    if not a.all:
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
    if a.stage:
        after.update(stage_fields(a.stage, p))
    patch = make_update(m, ib, p['id'], after, a.note or '')
    if not patch:
        print('変える所はありません（もう同じ値）')
        return
    save_patches([patch], m, ib)
    print(f'受け箱に追加しました（アプリが次に同期した時に取り込みます）: {json.dumps(patch["after"], ensure_ascii=False)}')


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
    sub.add_parser('status')
    s = sub.add_parser('list'); s.add_argument('--all', action='store_true'); s.add_argument('--json', action='store_true')
    s = sub.add_parser('show'); s.add_argument('query')
    s = sub.add_parser('add')
    s.add_argument('--client', required=True); s.add_argument('--title', required=True)
    s.add_argument('--kind', required=True); s.add_argument('--due', required=True)
    s.add_argument('--price', type=float); s.add_argument('--count', type=int, default=1)
    s.add_argument('--per-minute', action='store_true'); s.add_argument('--minutes', type=float)
    s.add_argument('--start'); s.add_argument('--billing'); s.add_argument('--memo'); s.add_argument('--progress')
    s.add_argument('--stage'); s.add_argument('--editor'); s.add_argument('--note')
    s = sub.add_parser('set'); s.add_argument('query')
    for o in ('due', 'start', 'billing', 'title', 'memo', 'progress', 'editor', 'stage', 'note'):
        s.add_argument(f'--{o}')
    s = sub.add_parser('company'); s.add_argument('--dry-run', action='store_true')
    s = sub.add_parser('link'); s.add_argument('job'); s.add_argument('query')
    a = ap.parse_args()
    for k in ('price', 'minutes'):
        v = getattr(a, k, None)
        if v is not None and float(v).is_integer():
            setattr(a, k, int(v))
    try:
        {'status': cmd_status, 'list': cmd_list, 'show': cmd_show, 'add': cmd_add, 'set': cmd_set,
         'company': cmd_company, 'link': cmd_link}[a.cmd](a)
    except Stop as e:
        print(f'止めました: {e}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
