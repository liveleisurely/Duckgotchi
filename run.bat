@echo off
cd /d "%~dp0"
if exist node_modules goto :run
echo first run, installing...
call npm install
:run
start "" npx electron .
