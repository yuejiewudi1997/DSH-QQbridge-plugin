@echo off
setlocal EnableExtensions
chcp 65001 >nul 2>&1
cd /d "%~dp0"
set "APP=%~dp0meme_renamer.py"
title Meme Renamer

rem ============================================================
rem  Python detection, in order:
rem    1. portable runtime next to this file:  .\runtime\python.exe
rem    2. "py -3" launcher
rem    3. python on PATH
rem    4. DeepSeek Harness bundled runtime (under %USERPROFILE% .dsh)
rem ============================================================

if exist "%~dp0runtime\python.exe" goto :use_runtime
py -3 -c "import tkinter" >nul 2>&1
if not errorlevel 1 goto :use_py
python -c "import tkinter" >nul 2>&1
if not errorlevel 1 goto :use_python
set "DSH_PY=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python"
if exist "%DSH_PY%\python.exe" goto :use_dsh

echo.
echo  [ERROR] Python 3.9+ with tkinter was not found.
echo.
echo  Fix: install Python from https://www.python.org/downloads/
echo       and tick "Add python.exe to PATH" during setup.
echo       Or drop a portable Python into .\runtime\ next to this file.
echo.
pause
exit /b 1

:use_runtime
"%~dp0runtime\python.exe" -c "import PIL" >nul 2>&1
if not errorlevel 1 goto :run_runtime_w
echo  [warn] Pillow missing - thumbnails disabled. Install: "%~dp0runtime\python.exe" -m pip install pillow
"%~dp0runtime\python.exe" "%~dp0meme_renamer.py" %*
if errorlevel 1 pause
exit /b 0

:run_runtime_w
if not exist "%~dp0runtime\pythonw.exe" goto :run_runtime_c
start "" "%~dp0runtime\pythonw.exe" "%~dp0meme_renamer.py" %*
exit /b 0

:run_runtime_c
"%~dp0runtime\python.exe" "%~dp0meme_renamer.py" %*
if errorlevel 1 pause
exit /b 0

:use_py
py -3 -c "import PIL" >nul 2>&1
if errorlevel 1 echo  [warn] Pillow missing - thumbnails disabled. Install: py -3 -m pip install pillow
where pyw >nul 2>&1
if errorlevel 1 goto :run_py_c
start "" pyw -3 "%~dp0meme_renamer.py" %*
exit /b 0

:run_py_c
py -3 "%~dp0meme_renamer.py" %*
if errorlevel 1 pause
exit /b 0

:use_python
python -c "import PIL" >nul 2>&1
if errorlevel 1 echo  [warn] Pillow missing - thumbnails disabled. Install: python -m pip install pillow
where pythonw >nul 2>&1
if errorlevel 1 goto :run_python_c
start "" pythonw "%~dp0meme_renamer.py" %*
exit /b 0

:run_python_c
python "%~dp0meme_renamer.py" %*
if errorlevel 1 pause
exit /b 0

:use_dsh
if exist "%DSH_PY%\pythonw.exe" goto :run_dsh_w
"%DSH_PY%\python.exe" "%~dp0meme_renamer.py" %*
if errorlevel 1 pause
exit /b 0

:run_dsh_w
start "" "%DSH_PY%\pythonw.exe" "%~dp0meme_renamer.py" %*
exit /b 0
