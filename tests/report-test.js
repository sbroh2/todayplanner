/* =========================================================================
   report-test.js — 일일 업무보고 자동 테스트 (실제 Chrome 창에서 실행)

   실행: tests 폴더의 "테스트실행.bat" 더블클릭  (또는 tests 폴더에서 `npm test`)

   - 설치된 Google Chrome을 화면에 띄워 클릭/입력 과정을 그대로 보여줍니다.
   - 매번 새 임시 프로필을 사용하므로 평소 쓰는 Chrome의 플래너 데이터는
     건드리지 않습니다.
   - 결과 스크린샷은 tests/screenshots 에 저장됩니다.
   ========================================================================= */
const { chromium } = require("playwright-core");
const path = require("path");
const fs = require("fs");
const os = require("os");

const APP = "file:///" + path.resolve(__dirname, "..", "index.html").replace(/\\/g, "/");
const SHOTS = path.join(__dirname, "screenshots");
const HEADLESS = !!process.env.HEADLESS;
const SLOW = Number(process.env.SLOW || (HEADLESS ? 0 : 350)); // ms between actions, so the run is watchable

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

(async () => {
  const chrome = findChrome();
  if (!chrome) { console.error("Google Chrome을 찾지 못했습니다."); process.exit(2); }
  fs.mkdirSync(SHOTS, { recursive: true });

  const TODAY = key(new Date());
  const tm = new Date(); tm.setDate(tm.getDate() + 1);
  const TMR = key(tm);

  // fresh, throw-away profile -> the user's real Chrome data is never touched
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "tp-test-"));
  const ctx = await chromium.launchPersistentContext(profile, {
    executablePath: chrome, headless: HEADLESS, slowMo: SLOW,
    viewport: { width: 1360, height: 860 }, args: ["--window-size=1400,980"]
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

  console.log("Chrome: " + chrome);
  console.log("앱:     " + APP);

  await page.goto(APP);
  await page.fill("#loginUsername", "admin");
  await page.fill("#loginPassword", "1234");
  await page.click("#loginSubmit");
  await page.waitForSelector(".dash-head");

  async function addTask(title, opts = {}) {
    await page.click("text=+ 새 할 일");
    await page.fill("#tf-title", title);
    if (opts.date) await page.fill("#tf-date", opts.date);
    if (opts.priority) await page.click(`label[for="tf-p-${opts.priority}"]`);
    if (opts.note) await page.fill("#tf-note", opts.note);
    await page.click(".modal__foot .btn--primary");
  }
  async function complete(title) {
    await page.locator(".task", { hasText: title }).locator(".check").check();
  }

  /* ───────── 테스트 1: 완료 업무만 자동 집계 ───────── */
  console.log("\n[테스트 1] 업무 5건 등록 → 3건 완료 → 보고서에 완료 3건만 표시");
  await page.click('a[data-view="tasks"]');
  await addTask("거래처 A 자료 작성", { priority: "high", note: "견적서 포함" });
  await addTask("주간회의 자료 준비", { priority: "top" });
  await addTask("고객 문의 처리");
  await addTask("신규 기획서 작성(진행 중)");
  await addTask("내일 거래처 방문", { date: TMR });
  await complete("거래처 A 자료 작성");
  await complete("주간회의 자료 준비");
  await complete("고객 문의 처리");
  await page.click('a[data-view="report"]');
  await page.waitForSelector(".rp-form");
  const titles = await page.$$eval(".rp-done__title", (n) => n.map((x) => x.textContent));
  check("완료 3건 자동 표시", titles.length === 3 &&
    ["거래처 A 자료 작성", "주간회의 자료 준비", "고객 문의 처리"].every((x) => titles.includes(x)), titles.join(" / "));
  const doc1 = await page.textContent(".rp-doc");
  check("진행 중 업무 제외", !doc1.includes("신규 기획서") && !(await page.textContent(".rp-form")).includes("신규 기획서"));
  check("내일 예정 업무 제외", !doc1.includes("내일 거래처 방문"));
  check("메모·우선순위 보조 표시", (await page.textContent(".rp-done")).includes("견적서 포함") &&
    (await page.locator(".rp-done .chip--top").count()) === 1);
  check("보고일=오늘 / 보고자=로그인 사용자", (await page.inputValue("#rp-date")) === TODAY &&
    (await page.textContent(".rp-reporter__name")).trim() === "admin");
  await page.screenshot({ path: path.join(SHOTS, "1-완료업무집계.png"), fullPage: true });

  /* ───────── 테스트 2: 보고 대상/참조 + 임시저장 + 새로고침 복원 ───────── */
  console.log("\n[테스트 2] 보고 대상·참조 지정 → 참조 1명 삭제 → 임시저장 → 새로고침 복원");
  await page.selectOption("#rp-recipient", "__new");
  await page.fill("#rp-person", "김부장");
  await page.click(".modal__foot .btn--primary");
  for (const n of ["이과장", "박대리", "최주임"]) {
    await page.click("#rp-cc-add");
    await page.fill("#rp-person", n);
    await page.click(".modal__foot .btn--primary");
  }
  await page.click('button[aria-label="최주임 참조 삭제"]');
  await page.fill("#rp-ach", "거래처 A 견적 확정, 주간회의 안건 정리 완료");
  await page.fill("#rp-other", "내일 오전 거래처 방문 예정");
  await page.click("#rp-save");
  await page.reload();
  await page.waitForSelector(".rp-form");
  const cc = await page.$$eval(".rp-chip:not(.rp-chip--add) span", (n) => n.map((x) => x.textContent));
  check("보고 대상 복원", (await page.$eval("#rp-recipient", (s) => s.options[s.selectedIndex].text)) === "김부장");
  check("참조자 복원(삭제 반영)", cc.join(",") === "이과장,박대리", cc.join(", "));
  check("주요 성과 / 기타 보고사항 복원",
    (await page.inputValue("#rp-ach")) === "거래처 A 견적 확정, 주간회의 안건 정리 완료" &&
    (await page.inputValue("#rp-other")) === "내일 오전 거래처 방문 예정");
  const saved = await page.evaluate((d) =>
    JSON.parse(localStorage.getItem("today-planner:v1")).reports.find((r) => r.reportDate === d), TODAY);
  check("저장 데이터: 작성중(draft), 대상/참조 분리 저장",
    !!saved && saved.status === "draft" && saved.recipient.name === "김부장" && saved.cc.length === 2);
  await page.screenshot({ path: path.join(SHOTS, "2-임시저장복원.png"), fullPage: true });

  /* ───────── 테스트 3: 보고서 전송 ───────── */
  console.log("\n[테스트 3] 보고서 전송 → 확인창 → 제출완료 / 목록 / 잠금 / Task 불변");
  const tasksOf = () => page.evaluate(() => JSON.parse(localStorage.getItem("today-planner:v1")).tasks
    .map((x) => x.id + "|" + x.taskDate + "|" + x.done).sort().join(","));
  const before = await tasksOf();
  await page.click("#rp-send");
  const msg = await page.textContent(".confirm__msg");
  check("전송 전 확인창(대상·참조·건수)", msg.includes("김부장") && msg.includes("이과장, 박대리 (2명)") && msg.includes("3건"), msg);
  await page.click(".modal__foot .btn--primary");
  await page.waitForSelector("text=전송 대기 상태로 저장되었습니다");
  check("완료 안내(실제 외부 전송 아님 명시)", (await page.textContent(".modal__body")).includes("실제 외부 전송은 지원하지 않습니다"));
  await page.click(".modal__foot .btn--primary");
  const row = (await page.innerText(".rp-row.is-current .rp-row__main")).replace(/\s+/g, " ").trim();
  check("목록: 날짜 | 김부장 | CC 2명 | 제출완료 / 상급자 미확인",
    row.includes(TODAY) && row.includes("김부장") && row.includes("CC 2명") && row.includes("제출완료") && row.includes("상급자 미확인"), row);
  check("제출완료 후 입력 잠금", await page.$eval("#rp-ach", (e) => e.disabled) && (await page.locator("#rp-send").count()) === 0);
  check("기존 Task taskDate/done 변경 없음", before === (await tasksOf()));
  await page.screenshot({ path: path.join(SHOTS, "3-보고서전송.png"), fullPage: true });

  check("콘솔 오류 없음", errors.length === 0, errors.join(" | "));

  console.log("\n결과: " + pass + "/" + (pass + fail) + " 통과" + (fail ? "  (실패 " + fail + "건)" : ""));
  console.log("스크린샷: " + SHOTS);
  console.log("5초 후 테스트용 Chrome 창이 닫힙니다.");
  if (!HEADLESS) await page.waitForTimeout(5000);
  await ctx.close();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* temp dir */ }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("\n테스트 중 오류:", e.message || e); process.exit(2); });
