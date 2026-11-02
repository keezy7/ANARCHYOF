@echo off
chcp 65001 >nul
echo ====================================
echo  LIMPANDO E INICIANDO ANARCHY
echo ====================================
echo.
echo Matando processos Node antigoss...
taskkill /f /im node.exe >nul 2>&1
timeout /t 2 >nul

echo Iniciando servidor em http://localhost:3000
echo.

cd /d "%~dp0"
node server.js

pause
