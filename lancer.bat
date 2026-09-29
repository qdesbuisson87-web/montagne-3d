@echo off
cd /d "%~dp0"
echo Montagne 3D - serveur local sur http://localhost:8765
echo Laissez cette fenetre ouverte pendant l utilisation. Fermez-la pour arreter.
rem "py" (lanceur installe avec Python) passe avant "python", que Windows redirige parfois vers le Microsoft Store
set PY=
where py >nul 2>nul && set PY=py -3
if not defined PY if exist "%LOCALAPPDATA%\Programs\Python\Launcher\py.exe" set PY="%LOCALAPPDATA%\Programs\Python\Launcher\py.exe" -3
if not defined PY set PY=python
start "" http://localhost:8765/
%PY% -m http.server 8765 --bind 0.0.0.0
if errorlevel 1 echo Python est introuvable : installez-le depuis python.org (cocher "Add python.exe to PATH").
pause
