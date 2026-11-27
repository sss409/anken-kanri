"""P-49 のテスト（2026-11-27）: 同じ項目を両方で変えた時に、項目ごとの時刻で新しい方を選ぶか
  python test_p49.py
11/27 朝の再現: .company の progress を 01:00 に新しくした。アプリでは前の晩（11/26 23:00）に progress を古い値にしていて、
朝 10:00 に別の項目（memo）を触ったので、案件全体の updatedAt は 10:00。前は updatedAt で比べてアプリが勝ち、新しい progress が消えた。
本物の .company・ドライブは触らない（一時フォルダと差し替えの関数で回す）。
"""
import io
import json
import os
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace

tmp = Path(tempfile.mkdtemp(prefix='p49-'))
os.environ['ANKEN_COMPANY'] = str(tmp / 'company')
os.environ['ANKEN_LINK_DIR'] = str(tmp / 'link')
os.environ['ANKEN_NO_DRIVE_SYNC'] = '1'
sys.path.insert(0, str(Path(__file__).resolve().parent))
import anken  # noqa: E402

sys.stdout.reconfigure(encoding='utf-8')
OK = []


def check(name, cond, info=''):
    OK.append(bool(cond))
    print(('OK  ' if cond else 'NG  ') + name + ('' if cond else f'  {info}'))


def run(project, job_text, job_mtime, state):
    """cmd_company を 1 回まわし、(.company に書いた値, アプリに送ったパッチ, 報告) を返す"""
    job = tmp / 'company' / 'job.md'
    job.parent.mkdir(parents=True, exist_ok=True)
    job.write_text(job_text, encoding='utf-8')
    os.utime(job, (job_mtime, job_mtime))
    anken.WORK.mkdir(parents=True, exist_ok=True)
    (tmp / 'company' / 'secretary').mkdir(parents=True, exist_ok=True)
    anken.STATE.write_text(json.dumps(state, ensure_ascii=False), encoding='utf-8')
    sent, written = [], {}
    anken.load_mirror = lambda: {'data': {'projects': [project]}}
    anken.load_inbox = lambda: {'patches': []}
    anken.projects_view = lambda m, ib: [project]
    anken.job_files = lambda: [job]
    anken.job_key = lambda j: 'job'
    anken.make_update = lambda m, ib, pid, after, note='': {'after': after}
    anken.save_patches = lambda new, m, ib, extra_backup=(): sent.extend(new)
    anken.backup = lambda *a: tmp
    anken.delivery_patches = lambda m, ib, only_recent=True: ([], [])
    anken.render_summary = lambda m, ib: ''
    anken.mirror_age_note = lambda m: ''
    anken.log = lambda msg: None
    out = io.StringIO()
    real = sys.stdout
    sys.stdout = out
    try:
        anken.cmd_company(SimpleNamespace(dry_run=False, no_sync=True))
    finally:
        sys.stdout = real
    _, fm = anken.read_fm(job)
    return fm, sent, out.getvalue(), json.loads(anken.STATE.read_text(encoding='utf-8'))


def ts(s):  # ISO → epoch
    import datetime as dt
    return dt.datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp()


PID = 'p-1'
base_state = {'job': {'id': PID, 'values': {'due': '2026-11-28', 'stage': '作業中', 'progress': '11/26 昼 カットまで'}}}
JOB = '---\nanken_id: "{pid}"\nstatus: "{st}"\ndue: "2026-11-28"\nstage: "作業中"\n---\n本文\n'

# 1. 11/27 朝の再現（アプリ 0.25.0 の fieldAt あり）→ .company の新しい値が勝つ
proj = {'id': PID, 'title': '11月の切り抜き', 'client': 'クライアントA', 'dueDate': '2026-11-28', 'stage': None, 'status': 'active',
        'progress': '11/26 夜 古い値', 'memo': '朝に触った', 'updatedAt': '2026-11-27T01:00:00.000Z',  # JST 10:00
        'fieldAt': {'progress': '2026-11-26T14:00:00.000Z', 'memo': '2026-11-27T01:00:00.000Z'}}  # progress は JST 11/26 23:00
fm, sent, out, st = run(proj, JOB.format(pid=PID, st='11/27 1時 最終版まで'), ts('2026-11-26T16:00:00Z'), base_state)  # JST 01:00
check('fieldAt があれば項目の時刻で比べて .company が勝つ', fm.get('status') == '11/27 1時 最終版まで' and any(p['after'].get('progress') == '11/27 1時 最終版まで' for p in sent), out)

# 2. 同じ形で fieldAt が無い（古いアプリ）→ 前と同じく案件全体の updatedAt（アプリが勝つ）
proj2 = {k: v for k, v in proj.items() if k != 'fieldAt'}
fm, sent, out, st = run(proj2, JOB.format(pid=PID, st='11/27 1時 最終版まで'), ts('2026-11-26T16:00:00Z'), base_state)
check('fieldAt が無ければ前と同じ（updatedAt で比べる）', fm.get('status') == '11/26 夜 古い値' and not sent, out)

# 3. アプリの progress の方が本当に新しい → アプリが勝つ
proj3 = dict(proj, progress='11/27 11時 アプリで直した', fieldAt={'progress': '2026-11-27T02:00:00.000Z'})
fm, sent, out, st = run(proj3, JOB.format(pid=PID, st='11/27 1時 最終版まで'), ts('2026-11-26T16:00:00Z'), base_state)
check('アプリの項目が新しければアプリが勝つ', fm.get('status') == '11/27 11時 アプリで直した' and not sent, out)

# 4. 状態に「初めて見た時刻」が残る
check('state に項目ごとの時刻（seen）が残る', 'seen' in st.get('job', {}) and st['job']['seen']['progress']['job'][0] == '11/27 11時 アプリで直した', json.dumps(st, ensure_ascii=False)[:300])

print(f'\n{sum(OK)}/{len(OK)} OK')
sys.exit(0 if all(OK) else 1)
