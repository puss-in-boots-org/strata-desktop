@echo off
REM Builds the release exe and the NSIS installer
REM (target\release\bundle\nsis\Strata_<version>_x64-setup.exe) inside the
REM same Visual Studio 2022 environment as cargo-msvc.cmd. Needs Node.js for
REM the Tauri CLI; Tauri downloads NSIS itself the first time.
REM
REM   scripts\build-installer.cmd
setlocal
set "NoDefaultCurrentDirectoryInExePath="
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" (
  echo Visual Studio Installer not found. Install Visual Studio 2022 with "Desktop development with C++".
  exit /b 1
)
set "VS2022="
for /f "usebackq delims=" %%i in (`"%VSWHERE%" -latest -products * -version [17.0^,18.0^) -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VS2022=%%i"
if not defined VS2022 (
  echo Visual Studio 2022 with the C++ tools isn't installed.
  exit /b 1
)
call "%VS2022%\VC\Auxiliary\Build\vcvarsall.bat" amd64 10.0.19041.0 >nul
if errorlevel 1 exit /b 1
cd /d "%~dp0.."
call npx --yes @tauri-apps/cli@2 build %*
