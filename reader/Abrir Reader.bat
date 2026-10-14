@echo off
chcp 65001 >nul
title Reader
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)"
if errorlevel 1 goto oldnode

if exist node_modules goto run
echo Preparando Reader por primera vez. Puede tardar un minuto...
call npm install
if errorlevel 1 goto failed

:run
start "" cmd /c "timeout /t 3 >nul & start http://localhost:3000"
echo.
echo Reader esta abierto en http://localhost:3000
echo Deja esta ventana abierta mientras lo usas. Para cerrarlo, cierra esta ventana.
echo.
call npm start
pause
exit /b 0

:nonode
echo No se encontro Node.js en este equipo.
echo Instala la version LTS desde https://nodejs.org y despues vuelve a abrir este archivo.
start https://nodejs.org
pause
exit /b 1

:oldnode
echo La version de Node.js es muy antigua. Instala la version LTS mas reciente desde https://nodejs.org
start https://nodejs.org
pause
exit /b 1

:failed
echo Algo fallo al preparar Reader. Revisa tu conexion a internet y vuelve a intentarlo.
pause
exit /b 1
