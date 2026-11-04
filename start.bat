@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
set "NODE_EXE=node"
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)" >nul 2>nul
if errorlevel 1 set "NODE_EXE=%~dp0.runtime\node-v22.16.0-win-x64\node.exe"
"%NODE_EXE%" -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)" >nul 2>nul
if errorlevel 1 (
  echo 请先安装 Node.js 22 或更高版本，然后重新打开。
  pause
  exit /b 1
)
if not exist .env copy .env.example .env >nul
"%NODE_EXE%" server\index.mjs
pause
