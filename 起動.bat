@echo off
rem Anken-kanri: keep port 8770 (data is stored per address in the browser)
cd /d "%~dp0"
start "" http://127.0.0.1:8770/
python -m http.server 8770 --bind 127.0.0.1
