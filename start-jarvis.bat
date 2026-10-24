@echo off
cd /d "%~dp0"
rem PATH sur : ne depend pas d'un PATH Windows abime (node, python et les commandes de base)
set "PATH=%SystemRoot%\System32;%SystemRoot%;C:\nvm4w\nodejs;C:\Python312;C:\Python312\Scripts;%PATH%"
:loop
node jarvis.js
echo Jarvis s est arrete, redemarrage dans 10 secondes...
timeout /t 10
goto loop
