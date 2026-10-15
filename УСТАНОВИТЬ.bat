@echo off
chcp 65001 >nul
cd /d "%~dp0"
title NIGHT CLUB - установка
where node >nul 2>nul
if errorlevel 1 (
  echo [ОШИБКА] Node.js не найден.
  echo Установи Node.js LTS с https://nodejs.org/ и снова запусти этот файл.
  pause
  exit /b 1
)
echo === Версии Node.js и npm ===
node --version
call npm.cmd --version
if errorlevel 1 goto fail
echo.
echo === Установка зависимостей. Это может занять несколько минут ===
call npm.cmd install
if errorlevel 1 goto fail
echo.
echo === Сборка frontend для проверки ===
call npm.cmd run build
if errorlevel 1 goto fail
echo.
echo Установка и сборка завершены успешно.
echo Теперь запусти START.bat
pause
exit /b 0
:fail
echo.
echo [ОШИБКА] Команда завершилась с ошибкой. Скопируй текст выше или пришли скриншот.
pause
exit /b 1
