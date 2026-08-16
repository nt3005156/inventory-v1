@echo off
setlocal EnableExtensions
TITLE Mittho OPS - Docker Starter
cd /d "%~dp0"

echo.
echo ==========================================================
echo   Mittho OPS - Restaurant Inventory and Costing System
echo   Docker startup for Windows
echo ==========================================================
echo.

REM Confirm Docker Desktop / Docker Engine is running.
docker info >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Docker Desktop is not running or is not installed.
  echo.
  echo 1. Install Docker Desktop: https://www.docker.com/products/docker-desktop/
  echo 2. Open Docker Desktop and wait until it says Engine running.
  echo 3. Run this file again.
  echo.
  pause
  exit /b 1
)

REM Make a local environment file on first start.
if not exist ".env" (
  copy /Y ".env.example" ".env" >nul
  echo [OK] Created .env from .env.example
)

REM Replace the documented placeholder with a cryptographically random local
REM secret. Production startup deliberately rejects the placeholder.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$path=Join-Path (Get-Location) '.env'; $content=[IO.File]::ReadAllText($path); if ($content.Contains('JWT_SECRET=replace-with-a-long-random-secret')) { $bytes=New-Object byte[] 32; $rng=[Security.Cryptography.RandomNumberGenerator]::Create(); try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }; $secret=[BitConverter]::ToString($bytes).Replace('-','').ToLowerInvariant(); $content=$content.Replace('JWT_SECRET=replace-with-a-long-random-secret','JWT_SECRET='+$secret); [IO.File]::WriteAllText($path,$content,(New-Object Text.UTF8Encoding($false))); Write-Host '[OK] Generated a random JWT secret in .env' }"
if errorlevel 1 (
  echo [ERROR] Could not validate or generate JWT_SECRET in .env.
  pause
  exit /b 1
)

echo.
echo Building and starting MongoDB, API, and web app...
docker compose up -d --build
if errorlevel 1 (
  echo.
  echo [ERROR] Docker could not start the project. Read the errors above.
  echo Check that CLIENT_URL contains the exact browser origin and that any
  echo custom COMPOSE_MONGODB_URI points to a writable replica set or cluster.
  pause
  exit /b 1
)

echo.
echo Waiting for the same-origin web and API health endpoint...
set APP_READY=
for /L %%i in (1,1,60) do (
  curl -fsS http://localhost:8080/health >nul 2>&1
  if not errorlevel 1 set APP_READY=1
  if defined APP_READY goto app_ready
  timeout /t 2 /nobreak >nul
)

:app_ready
if not defined APP_READY (
  echo [ERROR] The application did not become ready within two minutes.
  echo Check container state and logs with:
  echo docker compose ps
  echo docker compose logs api mongo-init web
  echo.
  pause
  exit /b 1
)

echo [OK] Web, API, migrations, and database are ready.
echo.
choice /C YN /M "Load or RESET the sample Mittho Biryani House demo data?"
if errorlevel 2 goto open_app

echo Loading demo data...
docker compose exec -T api npm run seed
if errorlevel 1 (
  echo [WARNING] Demo data could not be seeded. Check: docker compose logs api
) else (
  echo [OK] Demo data loaded.
  echo Login: owner@mittho.com   Password: mittho123
)

:open_app
echo.
echo ==========================================================
echo   Mittho OPS is running:  http://localhost:8080
echo   Same-origin health:     http://localhost:8080/health
echo ==========================================================
echo.
start "" http://localhost:8080
pause
