@echo off
cd /d "%~dp0voix"
rem PATH sur : ne depend pas d'un PATH Windows abime (python, ffmpeg et les commandes de base)
set "PATH=%SystemRoot%\System32;%SystemRoot%;C:\Python312;C:\Python312\Scripts;C:\nvm4w\nodejs;%PATH%"
:loop
python ecoute.py
if errorlevel 3 (
  echo Une autre ecoute Jarvis tourne deja : cette fenetre peut etre fermee.
  pause
  exit /b
)
echo Ecoute arretee, redemarrage dans 10 secondes...
timeout /t 10
goto loop
