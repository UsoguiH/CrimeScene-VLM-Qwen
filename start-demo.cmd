@echo off
rem Evidence demo — double-click to start the server, then open http://localhost:8000
cd /d "%~dp0"
where node >nul 2>&1
if %errorlevel%==0 (
  start "" http://localhost:8000
  node server.mjs
) else (
  start "" http://localhost:8000
  "D:\Downloads\node.exe" server.mjs
)
