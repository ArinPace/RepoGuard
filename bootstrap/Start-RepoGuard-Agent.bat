@echo off
REM RepoGuard helper starter for Windows.
REM Double-click after installing Docker Desktop + Node.js + Git.
setlocal
set ROOT=%USERPROFILE%\.repoguard
set SRC=%ROOT%\src
set AGENT=%SRC%\agent
set LOG=%ROOT%\agent.log
set REPO_URL=https://github.com/ArinPace/RepoGuard.git

if not exist "%ROOT%" mkdir "%ROOT%"
echo === RepoGuard agent setup ===

where docker >nul 2>&1
if errorlevel 1 (
  echo Docker is not installed. Download Docker Desktop from the RepoGuard setup popup, install it, then run this again.
  pause
  exit /b 1
)

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js is not installed. Download Node from the RepoGuard setup popup, install it, then run this again.
  pause
  exit /b 1
)

where git >nul 2>&1
if errorlevel 1 (
  echo git is required. Install Git for Windows, then run this again.
  pause
  exit /b 1
)

docker info >nul 2>&1
if errorlevel 1 (
  echo Starting Docker Desktop...
  start "" "C:\Program Files\Docker\Docker\Docker Desktop.exe"
  echo Waiting for Docker...
  timeout /t 20 /nobreak >nul
)

if exist "%SRC%\.git" (
  echo Updating RepoGuard...
  git -C "%SRC%" fetch --depth 1 origin main
  git -C "%SRC%" reset --hard FETCH_HEAD
) else (
  echo Downloading RepoGuard...
  if exist "%SRC%" rmdir /s /q "%SRC%"
  git clone --depth 1 "%REPO_URL%" "%SRC%"
)

curl -sf http://127.0.0.1:3847/v1/health >nul 2>&1
if not errorlevel 1 (
  echo Agent already running.
  pause
  exit /b 0
)

echo Starting agent...
cd /d "%AGENT%"
start "RepoGuard agent" /MIN cmd /c "node src\index.js >> "%LOG%" 2>&1"

echo Waiting for agent...
for /l %%i in (1,1,40) do (
  curl -sf http://127.0.0.1:3847/v1/health >nul 2>&1
  if not errorlevel 1 (
    echo Ready. Return to Chrome and click Test production.
    timeout /t 4 >nul
    exit /b 0
  )
  timeout /t 1 /nobreak >nul
)

echo Agent did not start. Check %LOG%
pause
exit /b 1
