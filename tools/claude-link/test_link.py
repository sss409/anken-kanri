"""連携のテスト（Google ドライブ・本物の .company を使わない）
  python test_link.py
一時フォルダに写し・受け箱・.company の jobs を作り、anken.py（Claude 側）と fake-app.cjs（アプリ側＝本物の claude-link.js）を交互に動かす。
"""
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
OK = []


def check(name, cond, info=''):
    OK.append(bool(cond))
    print(('OK  ' if cond else 'NG  ') + name + ('' if cond else f'  {info}'))


def main():
    tmp = Path(tempfile.mkdtemp(prefix='anken-link-'))
    link, company = tmp / 'link', tmp / 'company'
    (company / 'production' / 'jobs').mkdir(parents=True)
    (company / 'secretary').mkdir(parents=True)
    link.mkdir()
    env = {**os.environ, 'ANKEN_LINK_DIR': str(link), 'ANKEN_COMPANY': str(company), 'PYTHONIOENCODING': 'utf-8'}

    def claude(*args):
        r = subprocess.run([sys.executable, str(HERE / 'anken.py'), *args], env=env, capture_output=True, text=True, encoding='utf-8')
        return r.returncode, r.stdout + r.stderr

    def app(edits=None):
        r = subprocess.run(['node', str(HERE / 'fake-app.cjs'), str(link)] + ([json.dumps(edits, ensure_ascii=False)] if edits else []),
                           capture_output=True, text=True, encoding='utf-8')
        assert r.returncode == 0, r.stderr
        return r.stdout

    def appdata():
        return json.loads((link / 'appdata.json').read_text(encoding='utf-8'))

    def proj(pid):
        return next(p for p in appdata()['projects'] if p['id'] == pid)

    # アプリの最初のデータ（アプリが受け箱を作った状態）
    t0 = '2026-11-10T00:00:00.000Z'
    x = {'id': 'aaaaaaaa-0000-4000-8000-000000000001', 'client': '吠瑠うに', 'title': '1116_BD攻略', 'kind': 'long', 'unitPrice': 20000,
         'count': 1, 'priceUnit': 'video', 'minutes': None, 'extras': [], 'startDate': '2026-11-16', 'dueDate': '2026-11-20',
         'billingMonth': '2026-11', 'memo': '', 'status': 'active', 'completedAt': None, 'stage': None, 'createdAt': t0, 'updatedAt': t0}
    (link / 'appdata.json').write_text(json.dumps({'projects': [x], 'invoices': [], 'deleted': [], 'settings': None}), encoding='utf-8')
    (link / 'claude-inbox.json').write_text(json.dumps({'patches': []}), encoding='utf-8')
    rc, out = claude('status')
    check('写しが無い時は止まる', rc == 1 and '同期してください' in out, out)
    app()

    # 1. Claude が段階・進行メモ・納期を変える → アプリが取り込む
    rc, out = claude('set', '1116_BD攻略', '--stage', '初稿提出', '--progress', 'カット初稿提出済み・戻り待ち', '--due', '2026-11-18')
    check('set が受け箱に書く', rc == 0, out)
    rc, out = claude('list')
    check('list に取り込み待ちが出る', '取り込み待ち' in out and '初稿提出' in out, out)
    out = app()
    p = proj(x['id'])
    check('アプリが取り込む', p['stage'] == 'draft' and p['dueDate'] == '2026-11-18' and p['progress'].startswith('カット') and p['draftAt'], out)
    check('取り込んだ記録が写しに出る', 'applied' in out)
    rc, out = claude('status')
    check('取り込み済みは受け箱から消える（次の書き込みで）', '取り込み待ち: 0' in out, out)
    out = app()
    check('2 回目の同期で同じパッチを当て直さない', out.strip() == '', out)

    # 2. 同じ項目を両方で変えた：アプリの方が後 → アプリを残す
    claude('set', '1116_BD攻略', '--due', '2026-11-19')
    time.sleep(0.05)
    out = app({x['id']: {'dueDate': '2026-11-21'}})
    check('アプリが後に変えたらアプリの値', proj(x['id'])['dueDate'] == '2026-11-21' and 'conflict' in out, out)

    # 3. 同じ項目を両方で変えた：Claude の方が後 → Claude の値
    d = appdata()
    d['projects'][0].update({'dueDate': '2026-11-22', 'updatedAt': '2026-01-01T00:00:00.000Z'})  # 古い時刻のアプリの変更（写しにまだ出ていない）
    (link / 'appdata.json').write_text(json.dumps(d), encoding='utf-8')
    claude('set', '1116_BD攻略', '--due', '2026-11-18')  # 写しは 11-21 のまま
    out = app()
    check('Claude が後に変えたら Claude の値', proj(x['id'])['dueDate'] == '2026-11-18', out)

    # 4. 別の項目を同時に変えた → 両方残る
    claude('set', '1116_BD攻略', '--progress', '戻り来た・修正中')
    out = app({x['id']: {'memo': 'アプリで書いたメモ'}})
    p = proj(x['id'])
    check('別の項目は両方残る', p['memo'] == 'アプリで書いたメモ' and p['progress'] == '戻り来た・修正中', out)

    # 5. 案件の追加（2 回同期しても 1 件）
    rc, out = claude('add', '--client', '吠瑠うに', '--title', '1120_テスト', '--kind', 'long', '--due', '2026-11-25', '--price', '15000')
    check('add', rc == 0, out)
    app()
    app()
    check('追加は 1 件だけ', sum(1 for p in appdata()['projects'] if p['title'] == '1120_テスト') == 1)
    rc, out = claude('add', '--client', '吠瑠うに', '--title', '1120_テスト', '--kind', 'long', '--due', '2026-11-25', '--price', '15000')
    check('同じ案件は二重に足さない', rc == 1, out)
    # 追加してすぐ（アプリが取り込む前に）変えても、競合にならない
    claude('add', '--client', '吠瑠うに', '--title', '1121_続けて', '--kind', 'long', '--due', '2026-11-26', '--price', '15000', '--progress', 'はじめ')
    claude('set', '1121_続けて', '--progress', 'つぎ')
    out = app()
    p = next(p for p in appdata()['projects'] if p['title'] == '1121_続けて')
    check('追加の直後の変更も取り込まれる', p['progress'] == 'つぎ' and 'conflict' not in out, out)
    # 写しの記録が消えても（別の端末など）二重に足さない
    m = json.loads((link / 'anken-kanri.json').read_text(encoding='utf-8'))
    ib = json.loads((link / 'claude-inbox.json').read_text(encoding='utf-8'))
    add_patch = {'id': 'c-again', 'at': '2026-11-16T00:00:00.000Z', 'by': '秘書', 'op': 'add',
                 'project': next(p for p in m['data']['projects'] if p['title'] == '1120_テスト')}
    ib['patches'].append(add_patch)
    (link / 'claude-inbox.json').write_text(json.dumps(ib), encoding='utf-8')
    out = app()
    check('同じ id の追加は「取り込み済み」', 'already' in out, out)

    # 6. .company とそろえる
    job = company / 'production' / 'jobs' / '2026-11-16-hoeru-yoko-bd.md'
    job.write_text('---\ncreated: "2026-11-16"\nproject: "吠瑠うに 横動画"\nstatus: 確認待ち（カット初稿提出済み）\ndue: "2026-11-18"\n---\n\n# 本文\n', encoding='utf-8')
    rc, out = claude('link', job.name, '1116_BD攻略')
    check('link', rc == 0 and 'anken_id' in job.read_text(encoding='utf-8'), out)
    rc, out = claude('company')
    check('company が動く', rc == 0, out)
    app()
    text = job.read_text(encoding='utf-8')
    check('jobs に段階が入る', 'stage: "初稿提出"' in text, text)
    check('本文は変えない', text.endswith('# 本文\n'))
    check('秘書の一覧ができる', '1116_BD攻略' in (company / 'secretary' / 'anken-app.md').read_text(encoding='utf-8'))
    # .company で納期を変える → アプリへ
    time.sleep(0.05)
    job.write_text(job.read_text(encoding='utf-8').replace('due: "2026-11-18"', 'due: "2026-11-19"'), encoding='utf-8')
    rc, out = claude('company')
    app()
    check('.company の納期の変更がアプリに出る', proj(x['id'])['dueDate'] == '2026-11-19', out)
    # アプリで段階を変える → .company へ
    app({x['id']: {'status': 'done', 'completedAt': '2026-11-18'}})
    rc, out = claude('company')
    check('アプリの完了が .company に出る', 'stage: "完了"' in job.read_text(encoding='utf-8'), out)
    rc, out = claude('company')
    check('2 回目は何も変えない', 'そろえる所はありません' in out, out)
    check('バックアップがある', any((company / '.anken' / 'backup').iterdir()))

    print(f'\n{sum(OK)}/{len(OK)} OK  （一時フォルダ {tmp}）')
    return 0 if all(OK) else 1


if __name__ == '__main__':
    sys.exit(main())
