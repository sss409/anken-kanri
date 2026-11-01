# 配布用の zip を dist\ に作る
# 使い方: このファイルを右クリック →「PowerShell で実行」
#   バージョンは js\app.js の APP_VERSION から取る（CHANGELOG.md に同じ版の欄が必要）

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

$m = Select-String -Path (Join-Path $root 'js\app.js') -Pattern "APP_VERSION = '([\d.]+)'"
if (-not $m) { throw 'js\app.js に APP_VERSION が見つかりません' }
$ver = $m.Matches[0].Groups[1].Value
if (-not (Select-String -Path (Join-Path $root 'CHANGELOG.md') -Pattern "^## $([regex]::Escape($ver)) " -Quiet)) {
  throw "CHANGELOG.md に $ver の欄がありません"
}

# zip の中身（フォルダ名・ファイル名は文字化けしないよう英数字だけにする）
$stage = Join-Path $env:TEMP 'anken-kanri-dist'
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
$app = Join-Path $stage 'anken-kanri'
New-Item -ItemType Directory -Path (Join-Path $app 'js') -Force | Out-Null
Copy-Item (Join-Path $root 'index.html'), (Join-Path $root 'style.css') $app
Copy-Item (Join-Path $root 'js\*.js') (Join-Path $app 'js')
Copy-Item (Join-Path $root '配布用\README.txt') $app

$dist = Join-Path $root 'dist'
New-Item -ItemType Directory -Path $dist -Force | Out-Null
$zip = Join-Path $dist "anken-kanri-$ver.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path $app -DestinationPath $zip
Remove-Item $stage -Recurse -Force

Write-Host "作成しました: $zip"
