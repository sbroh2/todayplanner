/* =========================================================================
   menu-test.js — 통계 / 설정 메뉴 숨김 자동 테스트 (Chrome)

   실행: tests 폴더에서 `node menu-test.js` (창 없이: HEADLESS=1)
   - 사이드바에서 통계·설정 메뉴가 보이지 않는지
   - #/stats, #/settings 직접 접근 시 기존 화면이 오류 없이 표시되는지
   - 하단 바로가기(백업/복원, 로그아웃), 다크 모드, 모바일 사이드바
   ========================================================================= */
const { chromium } = require("playwright-core");
const path = require("path");
const fs = require("fs");
const os = require("os");

const APP = "file:///" + path.resolve(__dirname, "..", "index.html").replace(/\\/g, "/");
const SHOTS = path.join(__dirname, "screenshots");
const HEADLESS = !!process.env.HEADLESS;
const SLOW = Number(process.env.SLOW || (HEADLESS ? 0 : 150));
const KEY = "today-planner:v1";

function findChrome() {
  const c = [
    path.join(process.env.PROGRAMFILES || "C:\\Program Files", "Google/Chrome/Application/chrome.exe"),
    path.join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Google/Chrome/Application/chrome.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Google/Chrome/Application/chrome.exe")
  ];
  return c.find((p) => fs.existsSync(p));
}

let pass = 0, fail = 0;
function check(name, cond, extra) {
  cond ? pass++ : fail++;
  console.log((cond ? "  [통과] " : "  [실패] ") + name + (extra ? "  → " + extra : ""));
}

(async () => {
  const chrome = findChrome();
  if (!chrome) { console.error("Google Chrome을 찾지 못했습니다."); process.exit(2); }
  fs.mkdirSync(SHOTS, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "tp-menu-"));
  const ctx = await chromium.launchPersistentContext(profile, {
    executablePath: chrome, headless: HEADLESS, slowMo: SLOW, viewport: { width: 1360, height: 900 }
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  const stored = () => page.evaluate((k) => JSON.parse(localStorage.getItem(k)), KEY);
  const mainText = () => page.locator("#main").innerText();
  const go = async (h) => { await page.evaluate((x) => { location.hash = x; }, h); await page.waitForTimeout(150); };
  async function login() {
    await page.waitForSelector("#loginUsername");
    await page.fill("#loginUsername", "admin");
    await page.fill("#loginPassword", "1234");
    await page.click("#loginSubmit");
    await page.waitForSelector("#main .view-head, #main .dash-head");
  }

  await page.goto(APP);
  await login();

  console.log("\n[1] 사이드바 메뉴");
  const visibleNav = await page.$$eval(".nav__item", (n) => n.filter((a) => a.offsetParent !== null).map((a) => a.textContent.trim()));
  check("통계 메뉴 숨김", !(await page.isVisible('a[data-view="stats"]')));
  check("설정 메뉴 숨김", !(await page.isVisible('a[data-view="settings"]')));
  check("보이는 메뉴 4개 유지", JSON.stringify(visibleNav) === JSON.stringify(["🏠대시보드", "✓할 일 관리", "📅일정 관리", "📝일일 업무보고"]), visibleNav.join(", "));
  check("백업/복원 · 로그아웃 바로가기 표시", (await page.isVisible("#backupLink")) && (await page.isVisible("#sidebarLogout")));
  await page.screenshot({ path: path.join(SHOTS, "menu-1-데스크톱.png") });

  console.log("\n[2] 대시보드");
  const dash = await mainText();
  check("대시보드 정상 표시", dash.length > 0 && (await page.locator(".dash-head").count()) === 1);
  check("대시보드에 통계/설정 이동 링크 없음",
    (await page.locator('#main a[href="#/stats"], #main a[href="#/settings"]').count()) === 0);

  console.log("\n[3] 할 일 / 일정 / 업무보고");
  await page.click('a[data-view="tasks"]');
  await page.click("text=+ 새 할 일");
  await page.fill("#tf-title", "메뉴 숨김 확인 업무");
  await page.click(`label[for="tf-p-top"]`);
  await page.click(".modal__foot .btn--primary");
  check("Task 등록", (await stored()).tasks.some((t) => t.title === "메뉴 숨김 확인 업무"));
  await page.locator(".task", { hasText: "메뉴 숨김 확인 업무" }).locator(".check").check();
  check("Task 완료 처리", (await stored()).tasks.find((t) => t.title === "메뉴 숨김 확인 업무").done === true);
  await page.click('a[data-view="dashboard"]');
  await page.waitForSelector(".dash-head");
  check("대시보드 요약에 반영", (await mainText()).includes("100%"), "완료율 100% 표시");
  await page.click('a[data-view="events"]');
  await page.waitForTimeout(150);
  check("일정 관리 화면", (await page.locator(".cal__title").count()) >= 1);
  await page.click('a[data-view="report"]');
  await page.waitForSelector(".rp-form");
  check("일일 업무보고 화면 + 완료 업무 자동 집계", (await page.textContent(".rp-form")).includes("메뉴 숨김 확인 업무"));

  console.log("\n[4] 직접 URL 접근 (기존 라우팅 유지)");
  await go("#/stats");
  check("#/stats 통계 화면 표시", (await page.locator("#main .view-head__title").innerText()) === "통계");
  check("통계: 메뉴 숨김 상태 유지", !(await page.isVisible('a[data-view="stats"]')));
  await go("#/settings");
  check("#/settings 설정 화면 표시", (await page.locator("#main .view-head__title").innerText()) === "설정");
  await go("#/dashboard");
  await page.click("#backupLink");
  await page.waitForTimeout(150);
  check("백업/복원 바로가기 → 설정 화면(내보내기/복원 버튼)",
    (await page.isVisible("text=📥 데이터 내보내기")) && (await page.locator('input[type=file][accept*="json"]').count()) === 1);
  check("바로가기 활성 표시", await page.$eval("#backupLink", (a) => a.classList.contains("is-active")));
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("text=📥 데이터 내보내기")]);
  const backup = JSON.parse(fs.readFileSync(await dl.path(), "utf8"));
  check("Backup 내보내기", backup.data.tasks.some((t) => t.title === "메뉴 숨김 확인 업무"));

  console.log("\n[5] 다크 모드");
  await page.click("#themeToggle");
  check("다크 모드 적용", (await page.getAttribute("html", "data-theme")) === "dark" && (await stored()).settings.theme === "dark");
  await page.screenshot({ path: path.join(SHOTS, "menu-2-다크.png") });
  await page.click("#themeToggle");
  check("라이트 모드 복귀", (await page.getAttribute("html", "data-theme")) === "light");

  console.log("\n[6] 모바일 사이드바");
  await page.setViewportSize({ width: 390, height: 844 });
  await go("#/dashboard");
  await page.click("#navToggle");
  await page.waitForTimeout(300);
  check("모바일 사이드바 열림", await page.$eval("#sidebar", (s) => s.classList.contains("is-open")));
  check("모바일: 통계/설정 숨김, 4개 메뉴 표시",
    !(await page.isVisible('a[data-view="stats"]')) && !(await page.isVisible('a[data-view="settings"]')) &&
    (await page.isVisible('a[data-view="report"]')));
  check("모바일: 하단 바로가기 표시", await page.isVisible("#sidebarLogout"));
  const hScroll = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  check("모바일 가로 스크롤 없음", !hScroll);
  await page.screenshot({ path: path.join(SHOTS, "menu-3-모바일.png") });
  await page.click('a[data-view="tasks"]');
  await page.waitForTimeout(300);
  check("모바일 메뉴 클릭 → 이동 후 닫힘", !(await page.$eval("#sidebar", (s) => s.classList.contains("is-open"))));
  await page.setViewportSize({ width: 1360, height: 900 });

  console.log("\n[7] 로그아웃 (하단 버튼)");
  const before = JSON.stringify(await stored());
  await page.click("#sidebarLogout");
  await page.click(".modal__foot .btn--secondary, .modal__foot .btn--ghost").catch(() => {});
  check("취소 시 로그아웃 안 됨", await page.isVisible(".dash-head, #main .view-head"));
  await page.click("#sidebarLogout");
  await page.click(".modal__foot .btn--primary");
  await page.waitForSelector("#loginUsername");
  check("로그아웃 → 로그인 화면", await page.isVisible("#loginUsername"));
  await login();
  check("재로그인 후 데이터 동일", JSON.stringify(await stored()) === before);

  check("콘솔 오류 없음", errors.length === 0, errors.join(" | "));
  console.log("\n결과: " + pass + "/" + (pass + fail) + " 통과" + (fail ? "  (실패 " + fail + "건)" : ""));
  await ctx.close();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* temp dir */ }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("\n테스트 중 오류:", e.message || e); process.exit(2); });
