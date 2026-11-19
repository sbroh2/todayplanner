@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is required: https://nodejs.org & pause & exit /b 1)
if not exist node_modules\playwright-core call npm install --silent
set FAILED=0
echo ===== 일일 업무보고 테스트 =====
node report-test.js || set FAILED=1
echo.
echo ===== 첨부파일 테스트 =====
node attach-test.js || set FAILED=1
echo.
echo ===== 상급자 확인 / 반려 테스트 =====
node review-test.js || set FAILED=1
echo.
echo ===== 상급자 확인 최종 점검 (알림 유지 / 반복 재제출) =====
node review-cycle-test.js || set FAILED=1
echo.
echo ===== 통계 / 설정 메뉴 숨김 =====
node menu-test.js || set FAILED=1
echo.
if "%FAILED%"=="1" (echo 실패한 테스트가 있습니다. 위 결과를 확인하세요.) else (echo 모든 테스트를 통과했습니다.)
pause
