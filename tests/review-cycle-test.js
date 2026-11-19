/* =========================================================================
   review-cycle-test.js — 상급자 확인 최종 점검 (Chrome)
   - 확인자 ID / 표시 이름 / 보고대상 표시
   - 보고자 알림 유지 (새로고침 · 로그아웃 후 재로그인 · 보기/× 후 재표시 안 됨 · 새 결과 알림)
   - 제출 → 반려 → 수정 → 재제출 → 반려 → 수정 → 재제출 → 확인완료 이력
   - 확인 대기 현황(건수 · 목록)
   - Login / Logout · Statistics 회귀

   실행: tests 폴더에서 `node review-cycle-test.js`  (창 없이: HEADLESS=1)
   ========================================================================= */
const { chromium } = require("playwright-core");
const path = require("path");
const fs = require("fs");
const os = require("os");

const APP = "file:///" + path.resolve(__dirname, "..", "index.html").replace(/\\/g, "/");
const SHOTS = path.join(__dirname, "screenshots");
const HEADLESS = !!process.env.HEADLESS;
const SLOW = Number(process.env.SLOW || (HEADLESS ? 0 : 120));
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
function key(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
const fmt = (iso) => { const d = new Date(iso); return key(d) + " " + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); };

(async () => {
  const chrome = findChrome();
  if (!chrome) { console.error("Google Chrome을 찾지 못했습니다."); process.exit(2); }
  fs.mkdirSync(SHOTS, { recursive: true });
  const day = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return key(d); };
  const D0 = day(0), D1 = day(1), D2 = day(2), D3 = day(3);

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "tp-cycle-"));
  const ctx = await chromium.launchPersistentContext(profile, {
    executablePath: chrome, headless: HEADLESS, slowMo: SLOW, viewport: { width: 1360, height: 900 }
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

  const stored = () => page.evaluate((k) => JSON.parse(localStorage.getItem(k)), KEY);
  const reportOf = async (d) => (await stored()).reports.find((r) => r.reportDate === d);
  const text = (sel) => page.locator(sel).innerText();
  const toasts = async () => (await page.$$eval(".toast", (n) => n.map((x) => x.textContent))).join(" | ");
  const clearToasts = () => page.evaluate(() => document.querySelectorAll(".toast").forEach((t) => t.remove()));
  const ok = () => page.click(".modal__foot .btn--primary");
  async function login() {
    await page.waitForSelector("#loginUsername");
    await page.fill("#loginUsername", "admin");
    await page.fill("#loginPassword", "1234");
    await page.click("#loginSubmit");
    await page.waitForSelector("#main .view-head, #main .dash-head");
    await page.waitForTimeout(200);
  }
  async function logout() {
    await page.click('#backupLink');
    await page.click('.setting-row:has-text("로그아웃") button');
    await ok();
    await page.waitForSelector("#loginUsername");
  }
  async function gotoReport() { await page.click('a[data-view="report"]'); await page.waitForSelector(".rp-form"); }
  async function openDate(d) {
    await page.fill("#rp-date", d);
    await page.dispatchEvent("#rp-date", "change");
    await page.waitForTimeout(120);
  }
  async function submitReport(d, ach) {
    await openDate(d);
    await page.fill("#rp-ach", ach);
    await page.click("#rp-send");
    await ok(); await ok();
  }
  async function reject(reason) {
    await page.click("#rp-reject");
    await page.fill("#rp-review-comment", reason);
    await page.click("#rp-review-ok");
    await page.waitForTimeout(120);
  }
  async function confirm(comment) {
    await page.click("#rp-confirm");
    if (comment) await page.fill("#rp-review-comment", comment);
    await page.click("#rp-review-ok");
    await page.waitForTimeout(120);
  }
  async function reviseAndResubmit(ach) {
    await page.click("#rp-revise");
    await ok();
    await page.fill("#rp-ach", ach);
    await page.click("#rp-send");
    await ok(); await ok();
  }

  await page.goto(APP);
  await login();
  check("Login 정상", (await page.locator(".dash-head").count()) === 1);

  // 보고 대상 1회 지정 (이후 보고서는 직전 보고 대상을 이어받음)
  await gotoReport();
  await page.selectOption("#rp-recipient", "__new");
  await page.fill("#rp-person", "김부장");
  await ok();
  await page.click("#rp-save"); // 저장해 두어야 날짜 이동 시 '저장 안 함' 확인창이 뜨지 않음

  /* ───────── 1. 확인자와 보고대상 표시 ───────── */
  console.log("\n[1] 확인자 ID / 표시 이름 / 보고대상");
  await submitReport(D3, "표시 이름 테스트");
  await page.evaluate(() => TP.store.setReporterName("홍길동"));
  await page.waitForTimeout(100);
  check("상급자 처리 안내: 권한 검증 아님 + 현재 로그인 사용자(이름·ID)",
    (await text(".rp-review__box")).includes("실제 상급자 권한 검증은 하지 않으며") && (await text(".rp-review__box")).includes("홍길동 (admin)"));
  await confirm("확인함");
  const r1 = await reportOf(D3);
  const user = await page.evaluate(() => TP.auth.currentUser());
  check("confirmedById = 로그인 ID, confirmedBy = 표시 이름", r1.confirmation.confirmedById === user && user === "admin" && r1.confirmation.confirmedBy === "홍길동",
    r1.confirmation.confirmedBy + " / " + r1.confirmation.confirmedById);
  check("reviewHistory 사용자 = 같은 ID/이름", r1.reviewHistory.at(-1).user === "홍길동" && r1.reviewHistory.at(-1).userId === "admin");
  const p1 = await text("#rp-review");
  check("화면: 보고대상 김부장 / 확인자 홍길동 (admin)", p1.includes("김부장") && p1.includes("홍길동 (admin)"));
  check("보고대상 ≠ 확인자 안내(LocalStorage 권한 검증 없음)", (await text(".rp-actor-note")).includes("보고대상(김부장)이 아닌 홍길동 계정으로 처리"));
  await page.evaluate(() => TP.store.setReporterName(""));
  await page.click(`.rp-notice-item:has-text("${D3}") button[aria-label$="알림 닫기"]`);

  /* ───────── 3. 반복 재제출 이력 ───────── */
  console.log("\n[3] 제출 → 반려 → 수정 → 재제출 → 반려 → 수정 → 재제출 → 확인완료");
  await submitReport(D2, "1차 작성");
  const t0 = (await reportOf(D2)).submittedAt;
  await page.waitForTimeout(50);
  await reject("반려 사유 1: 수치 보완");
  const rj1 = await reportOf(D2);
  check("1차 반려 표시", (await text("#rp-reject-reason")).includes("반려 사유 1"));
  await page.waitForTimeout(50);
  await reviseAndResubmit("2차 작성");
  const rs1 = await reportOf(D2);
  check("1차 재제출 → 미확인, 반려 사유 현재 건에 미표시", rs1.status === "submitted" && rs1.review.comment === "" &&
    (await page.locator("#rp-reject-reason").count()) === 0 && (await text(".rp-prev-reject")).includes("반려 사유 1"));
  await page.evaluate(() => TP.store.setReporterName("박부장"));
  await page.waitForTimeout(50);
  await reject("반려 사유 2: 성과 구체화");
  const rj2 = await reportOf(D2);
  const reason = await text("#rp-reject-reason");
  check("2차 반려: 현재 사유는 2만 표시(1 아님)", reason.includes("반려 사유 2") && !reason.includes("반려 사유 1") &&
    rj2.review.comment === "반려 사유 2: 성과 구체화" && rj2.review.reviewer === "박부장");
  await page.evaluate(() => TP.store.setReporterName(""));
  await page.waitForTimeout(50);
  await reviseAndResubmit("3차 작성");
  const rs2 = await reportOf(D2);
  check("2차 재제출 → 미확인, 이전 반려 사유는 2", rs2.status === "submitted" && rs2.review.status === "pending" &&
    (await text(".rp-prev-reject")).includes("반려 사유 2"));
  await page.waitForTimeout(50);
  await confirm("최종 확인했습니다.");
  const fin = await reportOf(D2);
  const H = fin.reviewHistory;
  const acts = H.map((h) => h.action).join(">");
  check("이력 순서", acts === "submitted>rejected>revising>resubmitted>rejected>revising>resubmitted>confirmed", acts);
  check("이력 시간순(오름차순)", H.every((h, i) => i === 0 || H[i - 1].timestamp <= h.timestamp));
  check("최초 제출일시 보존", H[0].timestamp === t0 && fin.submittedAt !== t0);
  check("각 반려일시·사유·반려자", H[1].timestamp === rj1.review.reviewedAt && H[1].comment === "반려 사유 1: 수치 보완" && H[1].user === "admin" &&
    H[4].timestamp === rj2.review.reviewedAt && H[4].comment === "반려 사유 2: 성과 구체화" && H[4].user === "박부장");
  check("재제출일시", H[3].timestamp === rs1.submittedAt && H[6].timestamp === rs2.submittedAt && fin.submittedAt === rs2.submittedAt);
  check("최종 확인자·확인일시·의견", fin.status === "confirmed" && fin.confirmation.confirmedBy === "admin" &&
    fin.confirmation.confirmedAt === H[7].timestamp && fin.confirmation.comment === "최종 확인했습니다." && fin.achievements === "3차 작성");
  const pf = await text("#rp-review");
  check("화면: 최초 제출일시 / 재제출일시(2회) / 확인 의견",
    pf.includes("최초 제출일시") && pf.includes(fmt(t0)) && pf.includes("재제출일시") && pf.includes("(2회)") && pf.includes("최종 확인했습니다.") &&
    (await page.locator("#rp-reject-reason").count()) === 0);
  await page.click(".rp-history-wrap summary");
  const hi = await page.$$eval(".rp-history__item", (n) => n.map((x) => x.innerText.replace(/\s+/g, " ")));
  check("화면 이력 8건 시간순 + 반려자 표시", hi.length === 8 && hi[0].includes("제출") && hi[7].includes("확인 완료") &&
    hi[4].includes("박부장") && hi[4].includes("반려 사유 2"), hi[4]);
  check("미리보기: 최초 제출일시·재제출일시", (await text(".rp-doc")).includes("최초 제출일시 : " + fmt(t0)) && (await text(".rp-doc")).includes("재제출 2회"));
  await page.screenshot({ path: path.join(SHOTS, "14-재제출이력.png"), fullPage: true });

  /* ───────── 4. 확인 대기 현황 ───────── */
  console.log("\n[4] 확인 대기 현황");
  await submitReport(D1, "대기 1");
  await submitReport(D0, "대기 2");
  await page.click("#rp-review-start");
  const q = await page.$$eval(".rp-queue__stat", (n) => n.map((x) => x.innerText.replace(/\s+/g, "")));
  check("건수: 확인 대기 2 · 확인완료 2 · 반려 0", q.join(",") === "2확인대기,2확인완료,0반려", q.join(","));
  const ql = await page.$$eval(".rp-queue__item", (n) => n.map((x) => x.innerText.replace(/\s+/g, " ")));
  check("확인 대기 목록(검토중 포함)", ql.length === 2 && ql[0].includes(D0) && ql[0].includes("검토중") && ql[1].includes(D1), ql.join(" / "));
  check("권한 분리 없음 안내", (await text("#rp-queue")).includes("보고대상(상급자)별 접근 권한은 분리하지 않습니다"));
  await page.locator(".rp-queue__item", { hasText: D1 }).click();
  check("목록 클릭 → 보고서 열림", (await page.inputValue("#rp-date")) === D1);
  await page.click('[data-queue="confirmed"]');
  check("건수 클릭 → 필터 적용", (await page.locator(".rp-row").count()) === 2 &&
    (await page.getAttribute('.rp-filters [data-filter="confirmed"]', "aria-pressed")) === "true");
  await page.click('.rp-filters [data-filter="all"]');
  await page.click('a[data-view="dashboard"]');
  await page.waitForSelector(".dash-head");
  check("Dashboard에는 현황 패널 추가 안 함(기존 레이아웃 유지)", (await page.locator(".rp-queue").count()) === 0);

  /* ───────── 2. 알림 유지 ───────── */
  console.log("\n[2] 보고자 알림 유지");
  await gotoReport();
  await openDate(D1);
  await confirm("확인");
  await openDate(D0);
  await reject("다시 작성 바랍니다");
  await page.click('a[data-view="dashboard"]');
  const n1 = await page.$$eval(".rp-notice-item", (n) => n.map((x) => x.innerText));
  check("확인·반려 알림 표시", n1.some((t) => t.includes(D1 + " 일일 업무보고를 확인했습니다")) && n1.some((t) => t.includes(D0 + " 일일 업무보고가 반려되었습니다")), n1.join(" | "));
  check("미확인 결과 3건(D0 반려·D1·D2 확인)만, 이미 닫은 D3 제외", n1.length === 3 && !n1.some((t) => t.includes(D3)), String(n1.length));
  await page.reload(); await page.waitForSelector(".dash-head");
  check("새로고침 후 알림 유지", (await page.locator(".rp-notice-item").count()) === 3);
  await logout();
  await login();
  const t2 = await toasts();
  await page.click('a[data-view="dashboard"]');
  await page.waitForSelector(".dash-head");
  check("로그아웃 → 재로그인 후 알림 유지 + 접속 토스트", (await page.locator(".rp-notice-item").count()) === 3 && t2.includes("외 2건"), t2);
  await page.locator(".rp-notice-item", { hasText: D0 }).locator("text=보기").click();
  await page.waitForSelector(".rp-form");
  check("[보기] → 해당 보고서 열림", (await page.inputValue("#rp-date")) === D0 && (await text("#rp-status")) === "반려");
  await page.locator(".rp-notice-item", { hasText: D1 }).locator('button[aria-label$="알림 닫기"]').click();
  await page.locator(".rp-notice-item", { hasText: D2 }).locator('button[aria-label$="알림 닫기"]').click();
  check("[보기]/[×] 후 알림 사라짐", (await page.locator(".rp-notice-item").count()) === 0);
  await page.reload(); await page.waitForSelector(".rp-form");
  check("새로고침 후 다시 나타나지 않음", (await page.locator(".rp-notice-item").count()) === 0);
  await clearToasts();
  await logout(); await login();
  check("재로그인 후에도 다시 나타나지 않음(토스트 없음)", (await page.locator(".rp-notice-item").count()) === 0 && !(await toasts()).includes("업무보고"));
  const seen = await reportOf(D0);
  check("reviewSeenAt만 사용(중복 필드 없음)", !!seen.reviewSeenAt &&
    Object.keys(seen).filter((k) => /seen|notice|notif/i.test(k)).join(",") === "reviewSeenAt");
  // 새 결과 → 새 알림
  await gotoReport();
  await openDate(D0);
  await reviseAndResubmit("수정본");
  check("재제출 후 이전 반려 알림 없음", (await page.locator(".rp-notice-item").count()) === 0);
  await confirm("이번엔 확인");
  check("새 확인 결과 → 새 알림", (await text(".rp-notices")).includes(D0 + " 일일 업무보고를 확인했습니다"));

  /* ───────── 회귀: Statistics / Logout 데이터 유지 ───────── */
  console.log("\n[회귀]");
  await page.evaluate(() => { location.hash = "#/stats"; }); await page.waitForTimeout(150);
  check("Statistics 화면 정상", (await page.locator(".main").innerText()).length > 0);
  const beforeLogout = JSON.stringify(await stored());
  await logout(); await login();
  check("Logout/Login 후 데이터 동일", JSON.stringify(await stored()) === beforeLogout);

  check("콘솔 오류 없음", errors.length === 0, errors.join(" | "));
  console.log("\n결과: " + pass + "/" + (pass + fail) + " 통과" + (fail ? "  (실패 " + fail + "건)" : ""));
  if (!HEADLESS) await page.waitForTimeout(3000);
  await ctx.close();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* temp dir */ }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("\n테스트 중 오류:", e.message || e); process.exit(2); });
