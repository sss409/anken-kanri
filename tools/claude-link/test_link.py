"""連携のテスト（Google ドライブ・本物の .company を使わない）
  python test_link.py
一時フォルダに写し・受け箱・.company の jobs を作り、anken.py（Claude 側）と fake-app.cjs（アプリ側＝本物の claude-link.js）を交互に動かす。
"""
import json
import os
os.environ['ANKEN_NO_DRIVE_SYNC'] = '1'  # テストでは本物のドライブにつながない
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


def load_inbox_patches(link):
    return json.loads((link / 'claude-inbox.json').read_text(encoding='utf-8')).get('patches') or []


def main():
    tmp = Path(tempfile.mkdtemp(prefix='anken-link-'))
    link, company = tmp / 'link', tmp / 'company'
    (company / 'production' / 'jobs').mkdir(parents=True)
    (company / 'secretary').mkdir(parents=True)
    link.mkdir()
    env = {**os.environ, 'ANKEN_LINK_DIR': str(link), 'ANKEN_COMPANY': str(company), 'PYTHONIOENCODING': 'utf-8',
           'ANKEN_DELIVERY_ROOT': str(tmp / 'delivery')}

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
    rc, out = claude('add', '--client', '吠瑠うに', '--title', '1120_テスト', '--kind', 'long', '--due', '2026-11-25', '--start', '2026-11-20', '--price', '15000')
    check('add', rc == 0, out)
    app()
    app()
    check('追加は 1 件だけ', sum(1 for p in appdata()['projects'] if p['title'] == '1120_テスト') == 1)
    rc, out = claude('add', '--client', '吠瑠うに', '--title', '1120_テスト', '--kind', 'long', '--due', '2026-11-25', '--start', '2026-11-20', '--price', '15000')
    check('同じ案件は二重に足さない', rc == 1, out)
    # 追加してすぐ（アプリが取り込む前に）変えても、競合にならない
    claude('add', '--client', '吠瑠うに', '--title', '1121_続けて', '--kind', 'long', '--due', '2026-11-26', '--price', '15000', '--progress', 'はじめ')
    claude('set', '1121_続けて', '--progress', 'つぎ')
    out = app()
    p = next(p for p in appdata()['projects'] if p['title'] == '1121_続けて')
    check('追加の直後の変更も取り込まれる', p['progress'] == 'つぎ' and 'conflict' not in out, out)
    # 依頼メッセージ（改行も残る）：add で入れ・set で変え・写しから show で読める
    req1 = 'お世話になっております！\n1:23:45〜1:25:10 をショートに'
    claude('add', '--client', '吠瑠うに', '--title', '1122_依頼', '--kind', 'short', '--due', '2026-11-27', '--price', '5000', '--request', req1)
    app()
    p = next(p for p in appdata()['projects'] if p['title'] == '1122_依頼')
    check('add の依頼メッセージをアプリが取り込む', p.get('request') == req1, p)
    req2 = req1 + '\n【注意点】顔を大きめに'
    claude('set', '1122_依頼', '--request', req2)
    app()
    rc, out = claude('show', '1122_依頼')
    check('set の依頼メッセージが取り込まれ show で読める',
          next(p for p in appdata()['projects'] if p['title'] == '1122_依頼').get('request') == req2 and json.loads(out).get('request') == req2, out)
    claude('delete', '1122_依頼')
    app()
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

    # 7. 0.18.0 の操作（画面でできることを全部）
    def mirror():
        return json.loads((link / 'anken-kanri.json').read_text(encoding='utf-8'))

    # 古いアプリが書いた写しには新しい操作を書かない（古い版は捨ててしまうので）
    env_old = {**os.environ, 'FAKE_APP_VERSION': '0.17.0'}
    subprocess.run(['node', str(HERE / 'fake-app.cjs'), str(link)], env=env_old, capture_output=True)
    rc, out = claude('bill', '2026-11', '吠瑠うに', '--paid', '今日')
    check('古いアプリの写しなら新しい操作は止める', rc == 1 and '0.18.0' in out, out)
    app()

    # 完了・戻す
    rc, out = claude('undone', '1116_BD攻略')
    app()
    check('undone で進行中に戻る', proj(x['id'])['status'] == 'active' and proj(x['id'])['completedAt'] is None, out)
    claude('done', '1116_BD攻略')
    app()
    check('done で完了', proj(x['id'])['status'] == 'done')

    # 単価・本数・数え方・追加料金・案件別の請求書
    rc, out = claude('set', '1116_BD攻略', '--per-minute', '--minutes', '12', '--price', '1500', '--extra', 'サムネイル:2000', '--extra', '選定:1000:2')
    app()
    p = proj(x['id'])
    check('set で単価・数え方・追加料金', p['priceUnit'] == 'minute' and p['minutes'] == 12 and p['unitPrice'] == 1500
          and [e['name'] for e in p['extras']] == ['サムネイル', '選定'] and p['extras'][1]['qty'] == 2, out)
    rc, out = claude('set', '1116_BD攻略', '--per-video', '--price', '20000', '--extra', 'サムネイル:なし')
    app()
    p = proj(x['id'])
    check('1本あたりに戻す・追加料金を消す', p['priceUnit'] == 'video' and p['minutes'] is None and [e['name'] for e in p['extras']] == ['選定'], out)
    rc, out = claude('set', '1116_BD攻略', '--kind', 'short', '--per-minute', '--minutes', '3')
    check('ショートで 1分あたりは止める', rc == 1, out)

    # 請求書・入金の状態
    rc, out = claude('bill', '2026-11', '吠瑠うに', '--invoiced', '2026-11-30', '--paid', '12/5')
    check('bill が受け箱に書く', rc == 0, out)
    rc, out = claude('billing', '2026-11')
    check('billing に取り込み待ちが重なる', '入金済 2026-12-05' in out and '取り込み待ち' in out, out)
    out = app()
    r = next(r for r in appdata()['invoices'] if r['key'] == '2026-11|吠瑠うに')
    check('アプリが請求・入金の状態を取り込む', r['invoicedAt'] == '2026-11-30' and r['paidAt'] == '2026-12-05' and r['updatedAt'], out)
    rc, out = claude('bill', '2026-11', '別のクライアント', '--paid', '今日')
    check('その月に案件の無いクライアントは止める', rc == 1, out)
    # アプリで後から入金を外していたら、アプリを残す
    claude('bill', '2026-11', '吠瑠うに', '--paid', '2026-12-06')
    time.sleep(0.05)
    d = appdata()
    for r in d['invoices']:
        if r['key'] == '2026-11|吠瑠うに':
            r.update({'paidAt': None, 'updatedAt': '2099-01-01T00:00:00.000Z'})
    (link / 'appdata.json').write_text(json.dumps(d), encoding='utf-8')
    out = app()
    r = next(r for r in appdata()['invoices'] if r['key'] == '2026-11|吠瑠うに')
    check('請求の状態もアプリが後ならアプリの値', r['paidAt'] is None and 'conflict' in out, out)

    # ゴミ箱
    rc, out = claude('delete', '1120_テスト')
    out = app()
    t = next(p for p in appdata()['projects'] if p['title'] == '1121_続けて')
    d = appdata()
    check('delete でゴミ箱へ（中身が残る）', not any(p['title'] == '1120_テスト' for p in d['projects'])
          and any(z.get('project', {}).get('title') == '1120_テスト' for z in d['deleted']), out)
    rc, out = claude('trash')
    check('trash に出る', '1120_テスト' in out, out)
    claude('restore', '1120_テスト')
    out = app()
    check('restore で戻る', sum(1 for p in appdata()['projects'] if p['title'] == '1120_テスト') == 1, out)
    claude('delete', '1121_続けて')
    time.sleep(0.05)
    out = app({t['id']: {'memo': '消される前にアプリで書いた'}})
    check('Claude が見た後にアプリで変えた案件は消さない', any(p['id'] == t['id'] for p in appdata()['projects']) and 'conflict' in out, out)

    # 単価タブ・委託先・追加料金の項目・請求書の設定
    d = appdata()
    d['settings'] = {'clientPrices': {'吠瑠うに': {'short': 5000}}, 'updatedAt': '2026-11-10T00:00:00.000Z', 'clientIcons': {'吠瑠うに': {'src': 'data:x'}}}
    (link / 'appdata.json').write_text(json.dumps(d), encoding='utf-8')
    app()
    claude('price', '吠瑠うに', '--long-min', '1500', '--editor', 'かおりまる', '--fee-long-min', '500', '--color', '29', '--x', 'https://x.com/example')
    claude('price', '新しいクライアント', '--add')
    claude('editor', 'add', 'かおりまる')
    claude('extra-item', 'add', 'サムネイル', '2000')
    claude('setting', '--my-name', 'テスト 太郎', '--bank', 'テスト銀行', '--number', '1234567', '--addressee', '吠瑠うに=株式会社テスト',
           '--honorific', '吠瑠うに=御中', '--rule-month', '{年}{請求月}_{宛名}')
    # 取り込む前にアプリで別のクライアントの単価を変える → 両方残る
    d = appdata()
    d['settings']['clientPrices']['なるる'] = {'short': 4000}
    d['settings']['updatedAt'] = '2099-01-01T00:00:00.000Z'
    (link / 'appdata.json').write_text(json.dumps(d), encoding='utf-8')
    out = app()
    st = appdata()['settings']
    cp = st['clientPrices']
    check('単価タブ（単価・担当・委託・色・リンク）', cp['吠瑠うに'] == {'short': 5000, 'longMin': 1500, 'editor': 'かおりまる', 'feeLongMin': 500}
          and st['clientColors']['吠瑠うに'] == 29 and st['clientLinks']['吠瑠うに']['x'] == 'https://x.com/example', json.dumps(st, ensure_ascii=False))
    check('別の所の変更は両方残る（設定）', cp.get('なるる') == {'short': 4000} and '新しいクライアント' in cp, out)
    check('委託先・追加料金の項目・請求書の設定', st['editors'] == ['かおりまる'] and st['extraItems'] == [{'name': 'サムネイル', 'price': 2000}]
          and st['myName'] == 'テスト 太郎' and st['bankInfo']['number'] == '1234567' and st['addressees']['吠瑠うに'] == '株式会社テスト'
          and st['honorifics']['吠瑠うに'] == '御中' and st['fileNameRules']['month'] == '{年}{請求月}_{宛名}', json.dumps(st, ensure_ascii=False))
    check('アイコンの画像はそのまま', st['clientIcons'] == {'吠瑠うに': {'src': 'data:x'}})
    claude('price', '新しいクライアント', '--clear')
    claude('editor', 'remove', 'かおりまる')
    out = app()
    st = appdata()['settings']
    check('単価の設定を消す・委託先を外す', '新しいクライアント' not in st['clientPrices'] and st['editors'] == [], out)
    claude('price', 'なるる', '--move', 'top')
    app()
    check('並びを変える', appdata()['settings']['clientOrder'][0] == 'なるる', appdata()['settings'].get('clientOrder'))

    # 請求書（CSV・HTML）→ 発行済み・控え
    outdir = tmp / 'invoices'
    rc, out = claude('invoice', '2026-11', '吠瑠うに', '--csv', '--html', '--out', str(outdir))
    check('invoice が CSV・HTML を作る', rc == 0 and len(list(outdir.glob('*.csv'))) == 1 and len(list(outdir.glob('*.html'))) == 1, out)
    csv = next(outdir.glob('*.csv')).read_text(encoding='utf-8-sig')
    check('ファイル名の決まり・宛名・振込先が入る', next(outdir.glob('*.csv')).name.startswith('202611_株式会社テスト御中')
          and '株式会社テスト 御中' in csv and 'テスト銀行' in csv and '1234567' in csv, out)
    app()
    r = next(r for r in appdata()['invoices'] if r['key'] == '2026-11|吠瑠うに')
    check('請求書を作ると発行済み・控えが残る', r['invoicedAt'] == '2026-11-30' and r['snapshot']['fileName'].startswith('202611'), r)
    rc, out = claude('invoice', '2026-11', '吠瑠うに', '--csv', '--out', str(tmp / 'again'))
    check('発行済みなら控えを出す（受け箱に書かない）', '控え' in out and '受け箱' not in out, out)
    rc, out = claude('invoice', '--project', '1120_テスト', '--csv', '--out', str(outdir))
    app()
    check('案件別の請求書', rc == 0 and next(p for p in appdata()['projects'] if p['title'] == '1120_テスト').get('invoiceSnapshot'), out)
    if __import__('shutil').which('msedge') or Path(r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe').exists():
        rc, out = claude('invoice', '2026-11', '吠瑠うに', '--pdf', '--no-mark', '--remake', '--out', str(tmp / 'pdf'))
        pdf = list((tmp / 'pdf').glob('*.pdf'))
        check('PDF を作る（Edge）', rc == 0 and pdf and pdf[0].read_bytes()[:4] == b'%PDF', out)

    # 備考は請求書ごと（0.22.0）。前の版の共通の備考は使わない
    claude('setting', '--note', '別のクライアントのメモ')
    app()
    rc, out = claude('invoice', '2026-11', '吠瑠うに', '--html', '--no-mark', '--remake', '--remark', 'この請求書の備考', '--out', str(tmp / 'note1'))
    app()
    page = next((tmp / 'note1').glob('*.html')).read_text(encoding='utf-8')
    r = next(r for r in appdata()['invoices'] if r['key'] == '2026-11|吠瑠うに')
    check('備考: --remark がこの請求書に入り、アプリにも残る', rc == 0 and 'この請求書の備考' in page and '別のクライアントのメモ' not in page
          and r.get('note') == 'この請求書の備考', out)
    rc, out = claude('invoice', '2026-11', '吠瑠うに', '--html', '--no-mark', '--remake', '--out', str(tmp / 'note2'))
    page = next((tmp / 'note2').glob('*.html')).read_text(encoding='utf-8')
    check('備考: 次に作る時も同じ請求書の備考を使う', rc == 0 and 'この請求書の備考' in page, out)
    rc, out = claude('invoice', '--project', '1120_テスト', '--html', '--no-mark', '--remake', '--out', str(tmp / 'note3'))
    page = next((tmp / 'note3').glob('*.html')).read_text(encoding='utf-8')
    check('備考: 別の請求書には入らない（共通の備考も使わない）', rc == 0 and 'この請求書の備考' not in page and '別のクライアントのメモ' not in page, out)
    rc, out = claude('invoice', '--project', '1120_テスト', '--html', '--no-mark', '--remake', '--remark', '案件別の備考', '--out', str(tmp / 'note4'))
    app()
    check('備考: 案件別の請求書は案件に残る', rc == 0 and next(p for p in appdata()['projects'] if p['title'] == '1120_テスト').get('invoiceNote') == '案件別の備考', out)

    # 書き出し・読み込み
    rc, out = claude('export', '--out', str(tmp / 'export.json'))
    ex = json.loads((tmp / 'export.json').read_text(encoding='utf-8'))
    check('export', rc == 0 and ex['app'] == 'anken-kanri' and len(ex['projects']) == len(appdata()['projects']), out)
    one = dict(ex, projects=ex['projects'][:1])
    (tmp / 'one.json').write_text(json.dumps(one, ensure_ascii=False), encoding='utf-8')
    rc, out = claude('import', str(tmp / 'one.json'))
    check('import は --yes が無いと書かない', rc == 0 and '--yes' in out, out)
    claude('import', str(tmp / 'one.json'), '--yes')
    app()
    d = appdata()
    check('import で置き換え・消えた分はゴミ箱', len(d['projects']) == 1 and len([z for z in d['deleted'] if z.get('project')]) >= 2, out)
    claude('import', str(tmp / 'export.json'), '--yes')
    app()
    check('元の書き出しで戻せる', len(appdata()['projects']) == len(ex['projects']))

    # 提出した動画（提出フォルダ → deliveries）
    sub = tmp / 'delivery' / '吠瑠うに' / '提出' / '横動画' / '1116_BD攻略'
    (sub / 'frameio').mkdir(parents=True)
    t18 = time.mktime((2026, 11, 18, 12, 0, 0, 0, 0, -1))
    for name, t in (('【初稿】1118_BD攻略.mp4', t18), ('【二稿】1118_BD攻略.mp4', t18 + 86400), ('カット.mp4', t18 - 86400),
                    ('frameio/【初稿】1118_BD攻略.mp4', t18), ('../関係ない動画.mp4', t18), ('メモ.txt', t18)):
        f = sub / name
        f.write_bytes(b'0' * 10)
        os.utime(f, (t, t))
    old = sub.parent / '【初稿】1116_BD攻略.mp4'   # 着手より 3 日以上前の同じ名前は数えない
    old.write_bytes(b'0'); os.utime(old, (t18 - 30 * 86400,) * 2)
    rc, out = claude('deliveries', '--dry-run')
    check('deliveries --dry-run は書かない', rc == 0 and '書いていません' in out and '3 本' in out, out)
    os.environ['FAKE_APP_VERSION'] = '0.18.0'; app(); del os.environ['FAKE_APP_VERSION']
    rc, out = claude('deliveries')
    check('アプリが 0.19.0 より前なら止める', rc == 1 and '0.19.0' in out, out)
    app()
    rc, out = claude('deliveries')
    app()
    dl = proj(x['id']).get('deliveries') or []
    check('提出した動画が案件に入る（古い順・frameio と関係ない物・古い物は入らない）',
          rc == 0 and [d['label'] for d in dl] == ['カット', '初稿', '二稿'] and all(d['path'].endswith('.mp4') for d in dl)
          and dl[-1]['at'] == '2026-11-19T12:00', json.dumps(dl, ensure_ascii=False))
    rc, out = claude('deliveries')
    check('変わらなければ書かない', rc == 0 and '新しく提出した動画はありません' in out, out)
    rc, out = claude('company')
    check('company でも提出を見る（変わらなければ何もしない）', rc == 0 and '提出した動画' not in out, out)
    (sub / '【三稿】1118_BD攻略.mp4').write_bytes(b'0')
    rc, out = claude('company')
    app()
    check('company が新しい提出を入れる', rc == 0 and '提出した動画 4 本' in out
          and (proj(x['id']).get('deliveries') or [{}])[-1].get('label') == '三稿', out)

    # 作業枠（worklogs、0.21.0・0.23.0 で種類と休憩）
    os.environ['FAKE_APP_VERSION'] = '0.22.0'; app(); del os.environ['FAKE_APP_VERSION']
    rc, out = claude('work', 'start', '演出')
    check('作業枠: アプリが 0.23.0 より前なら止める', rc == 1 and '0.23.0' in out, out)
    app()
    rc, out = claude('work', 'start', '演出', '--at', '9:00')
    check('作業枠: 種類の一部で始める（演出 → 編集・演出）', rc == 0 and '編集・演出 を始める' in out, out)
    rc, out = claude('work', 'start', '--project', x['id'][:8], '--at', '9:30')
    check('作業枠: 案件だけ押すと種類を引き継いで次を始める', rc == 0 and '編集・演出 を終える（30分）' in out and '編集・演出｜' in out, out)
    rc, out = claude('work', 'break', '--at', '9:50')
    check('作業枠: 休憩', rc == 0 and '（20分）' in out and '休憩 を始める' in out, out)
    rc, out = claude('work', 'resume', '--at', '10:00')
    check('作業枠: 休憩から戻ると前の種類と案件', rc == 0 and '休憩 を終える（10分）' in out and '編集・演出｜' in out, out)
    rc, out = claude('work', 'start', 'ないもの')
    check('作業枠: 無い種類は止める', rc == 1 and 'ありません' in out, out)
    rc, out = claude('work', 'start', '返事', '--at', '10:10')
    check('作業枠: 種類だけ押すと案件を引き継ぐ', rc == 0 and '連絡・返事｜' in out, out)
    rc, out = claude('work', 'end', '--at', '10:30', '--memo', 'うにさん')
    check('作業枠: 終える（メモ付き）', rc == 0 and '連絡・返事 を終える' in out and '20分' in out, out)
    rc, out = claude('work', 'edit', '--kind', '確認')
    check('作業枠: 後から種類を直す', rc == 0 and '記録を直す（kind・isBreak）' in out, out)
    app()
    logs = sorted([r for r in appdata().get('worklogs', []) if not r.get('deletedAt')], key=lambda r: r['startAt'])
    check('作業枠: アプリに 5 件（休憩 1・案件の引き継ぎ・メモ・直した種類）',
          len(logs) == 5 and [bool(r.get('isBreak')) for r in logs] == [False, False, True, False, False]
          and [r.get('kind') for r in logs] == ['編集・演出', '編集・演出', None, '編集・演出', '確認・チェック']
          and [r.get('projectId') for r in logs] == [None, x['id'], None, x['id'], x['id']]
          and logs[-1].get('memo') == 'うにさん' and all(r.get('endAt') for r in logs),
          json.dumps(logs, ensure_ascii=False))
    rc, out = claude('work', 'list')
    check('作業枠: list で作業・休憩・種類ごと', rc == 0 and '作業 80分・休憩 10分' in out and '編集・演出 60分' in out and '確認・チェック 20分' in out, out)
    rc, out = claude('work', 'list', '--week')
    check('作業枠: list --week', rc == 0 and '作業 80分・休憩 10分' in out, out)
    rc, out = claude('work', 'end')
    check('作業枠: 記録中が無ければ end は止める', rc == 1 and '記録中の作業がありません' in out, out)
    rc, out = claude('company')
    md = (Path(env['ANKEN_COMPANY']) / 'secretary' / 'anken-app.md')
    check('作業枠: company の anken-app.md に今日の合計と内訳', rc == 0 and md.exists() and '今日' in md.read_text(encoding='utf-8')
          and '作業 80分・休憩 10分' in md.read_text(encoding='utf-8') and '種類ごと' in md.read_text(encoding='utf-8'), out)

    print(f'\n{sum(OK)}/{len(OK)} OK  （一時フォルダ {tmp}）')
    return 0 if all(OK) else 1


if __name__ == '__main__':
    sys.exit(main())
