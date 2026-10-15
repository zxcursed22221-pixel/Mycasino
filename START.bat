@echo off
chcp 65001 >nul
cd /d "%~dp0"
title NIGHT CLUB - запуск
if not exist node_modules (
  echo Зависимости не установлены. Сначала запусти УСТАНОВИТЬ.bat
  pause
  exit /b 1
)
echo Запускаю NIGHT CLUB. Не закрывай это окно.
echo Vite обычно доступен по адресу http://localhost:5173
call npm.cmd run dev
pause
