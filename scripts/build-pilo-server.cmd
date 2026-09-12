@echo off
setlocal
cd /d "%~dp0.."

where cargo >nul 2>nul || set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"

for /f "tokens=2" %%h in ('cargo -vV ^| findstr /b "host:"') do set "HOST=%%h"
if not defined HOST (
  echo Unable to detect the Rust host triple. >&2
  exit /b 2
)

if "%HOST:~0,6%"=="x86_64" set "ARCH=x86_64"
if "%HOST:~0,7%"=="aarch64" set "ARCH=aarch64"
if not defined ARCH (
  echo Unsupported Rust host triple: %HOST% >&2
  exit /b 2
)

set "RESOURCE=src-tauri\resources\pilo-server-windows-%ARCH%.exe"

echo Building pilo-server windows-%ARCH% release
cargo build -p pilo-server --release || exit /b 1

if not exist "target\release\pilo-server.exe" (
  echo Build finished but target\release\pilo-server.exe is missing. >&2
  exit /b 1
)

copy /y "target\release\pilo-server.exe" "%RESOURCE%" >nul || exit /b 1
echo Updated %RESOURCE%
