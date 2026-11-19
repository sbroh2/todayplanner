/* =========================================================================
   review-test.js — 일일 업무보고 상급자 확인 / 반려 / 재제출 자동 테스트 (Chrome)

   실행: tests 폴더에서 `node review-test.js`
         (창 없이 실행하려면 HEADLESS=1, 동작 간 지연은 SLOW=ms)
   - 매번 새 임시 프로필을 사용하므로 평소 Chrome의 플래너 데이터는 건드리지 않습니다.
   - 스크린샷은 tests/screenshots 에 저장됩니다.
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
function key(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
const DT = /^\d{4}-\d{2}-\d{2}T/;

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

(async () => {
  const chrome = findChrome();
  if (!chrome) { console.error("Google Chrome을 찾지 못했습니다."); process.exit(2); }
  fs.mkdirSync(SHOTS, { recursive: true });
  const TODAY = key(new Date());
  const y = new Date(); y.setDate(y.getDate() - 1);
  const YDAY = key(y);
  const y2 = new Date(); y2.setDate(y2.getDate() - 2);
  const Y2 = key(y2);

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "tp-review-"));
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
  const rowText = async (d) => (await page.locator(".rp-row__main", { hasText: d }).innerText()).replace(/\s+/g, " ");
  async function gotoReport() { await page.click('a[data-view="report"]'); await page.waitForSelector(".rp-form"); }
  async function openRow(d) { await page.locator(".rp-row__main", { hasText: d }).click(); await page.waitForTimeout(150); }
  async function setRecipientAndCc() {
    await page.selectOption("#rp-recipient", "__new");
    await page.fill("#rp-person", "김부장");
    await page.click(".modal__foot .btn--primary");
    for (const n of ["이대리", "박과장"]) {
      await page.click("#rp-cc-add");
      await page.fill("#rp-person", n);
      await page.click(".modal__foot .btn--primary");
    }
  }
  const tasksSig = () => page.evaluate((k) => JSON.parse(localStorage.getItem(k)).tasks
    .map((x) => x.id + "|" + x.title + "|" + x.taskDate + "|" + x.done).sort().join(","), KEY);

  await page.goto(APP);
  await page.fill("#loginUsername", "admin");
  await page.fill("#loginPassword", "1234");
  await page.click("#loginSubmit");
  await page.waitForSelector(".dash-head");

  // tasks: 2 done today, 1 open today, 1 tomorrow
  await page.click('a[data-view="tasks"]');
  const tm = new Date(); tm.setDate(tm.getDate() + 1);
  for (const [t, d] of [["업무 A", null], ["업무 B", null], ["진행중 업무 C", null], ["내일 업무 D", key(tm)]]) {
    await page.click("text=+ 새 할 일");
    await page.fill("#tf-title", t);
    if (d) await page.fill("#tf-date", d);
    await page.click(".modal__foot .btn--primary");
  }
  for (const t of ["업무 A", "업무 B"]) await page.locator(".task", { hasText: t }).locator(".check").check();
  // memo + event
  await page.click('a[data-view="events"]');
  await page.click("text=+ 새 일정");
  await page.fill("#ef-title", "팀 회의");
  await page.click(".modal__foot .btn--primary");
  await page.click('a[data-view="dashboard"]');
  await page.fill('textarea[aria-label="빠른 메모"]', "메모 테스트");
  await page.waitForTimeout(700);
  const dashSummaryBefore = await text(".summary");
  const tasksBefore = await tasksSig();
  const before = await stored();

  /* ───────── [보고서 작성] 1~4 ───────── */
  console.log("\n[보고서 작성] 작성 → 임시저장 → 제출 → 제출 상태");
  await gotoReport();
  check("1. 새 보고서: 완료 업무 2건만(진행중/내일 제외)",
    (await page.$$eval(".rp-done__title", (n) => n.map((x) => x.textContent))).join(",") === "업무 A,업무 B");
  check("새 보고서는 상급자 확인 현황 숨김", await page.locator("#rp-review").isHidden());
  await setRecipientAndCc();
  await page.fill("#rp-ach", "거래처 견적 확정");
  await page.setInputFiles("#rp-file", [
    { name: "업무결과.xlsx", mimeType: XLSX, buffer: Buffer.alloc(2048, 65) },
    { name: "작업화면.png", mimeType: "image/png", buffer: PNG },
    { name: "보고서.pdf", mimeType: "application/pdf", buffer: PDF }
  ]);
  await page.waitForTimeout(300);
  await page.click("#rp-save");
  check("2. 임시저장 → 임시저장 배지", (await text("#rp-status")) === "임시저장" && (await reportOf(TODAY)).status === "draft");
  check("목록: 임시저장", (await rowText(TODAY)).includes("임시저장"));
  await page.click("#rp-send");
  await page.click(".modal__foot .btn--primary");
  await page.waitForSelector("text=상급자 미확인'으로 표시됩니다");
  await page.click(".modal__foot .btn--primary");
  const r1 = await reportOf(TODAY);
  check("3. 제출 → status=submitted, review.status=pending",
    r1.status === "submitted" && r1.review.status === "pending" && DT.test(r1.submittedAt) && r1.reviewHistory.at(-1).action === "submitted");
  check("4. 보고자 화면: 제출완료 / 상급자 미확인 배지·목록",
    (await text("#rp-status")) === "제출완료" && (await rowText(TODAY)).includes("제출완료 상급자 미확인"));
  const rv1 = await text("#rp-review");
  check("상급자 확인 현황: 보고대상·미확인·아직 확인되지 않았습니다",
    rv1.includes("김부장") && rv1.includes("미확인") && rv1.includes("아직 확인되지 않았습니다.") && rv1.includes("이대리, 박과장"), rv1.replace(/\s+/g, " ").slice(0, 160));
  check("미리보기에 상태 표시", (await text(".rp-doc")).includes("상태     : 제출완료 / 상급자 미확인"));
  await page.screenshot({ path: path.join(SHOTS, "8-확인-제출완료.png"), fullPage: true });

  /* ───────── [상급자 확인] 5~11 ───────── */
  console.log("\n[상급자 확인] 제출된 보고서 열기 → 확인 → 확인 의견");
  await page.click('a[data-view="dashboard"]');
  await gotoReport();
  await openRow(TODAY);
  check("5. 제출된 보고서 열기 + 확인/반려 버튼", (await page.locator("#rp-confirm").count()) === 1 && (await page.locator("#rp-reject").count()) === 1);
  check("상급자 화면에서 첨부파일 3개 보기 가능", (await page.locator(".rp-file__open").count()) === 3);
  await page.click("#rp-confirm");
  check("6. 확인 버튼 → 확인 메시지", (await text(".modal__body")).includes("이 업무보고를 확인 완료 처리하시겠습니까?"));
  await page.fill("#rp-review-comment", "업무 내용 확인했습니다.");
  await page.click("#rp-review-ok");
  await page.waitForTimeout(200);
  const r2 = await reportOf(TODAY);
  check("7. status=confirmed", r2.status === "confirmed" && r2.review.status === "confirmed");
  check("8. 확인자 저장(로그인 사용자)", r2.confirmation.confirmedBy === "admin" && r2.confirmation.confirmedById === "admin");
  check("9. 확인일시 저장", DT.test(r2.confirmation.confirmedAt));
  check("10. 확인 의견 저장", r2.confirmation.comment === "업무 내용 확인했습니다.");
  const rv2 = await text("#rp-review");
  check("11. 확인완료 표시(확인자·일시·의견)", (await text("#rp-status")) === "확인완료" &&
    rv2.includes("확인완료") && rv2.includes("admin") && /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(rv2) && rv2.includes("업무 내용 확인했습니다."));
  check("즉시 안내 토스트", (await toasts()).includes("확인 완료 처리했어요"));
  check("첨부파일 손상 없음", JSON.stringify(r2.attachments) === JSON.stringify(r1.attachments) && r2.attachments.length === 3);

  /* ───────── [확인 완료 제한] 21~22 ───────── */
  console.log("\n[확인 완료 제한]");
  check("21. 확인완료 보고서 수정 불가(입력 잠금·버튼 없음·안내)",
    await page.$eval("#rp-ach", (e) => e.disabled) && (await page.locator("#rp-send, #rp-save, #rp-reopen, #rp-revise, #rp-confirm, #rp-reject, .rp-file__del, #rp-file").count()) === 0 &&
    (await text("#rp-lock-notice")).includes("확인 완료된 보고서는 수정할 수 없습니다."));
  const guarded = await page.evaluate((d) => TP.store.saveReport({ reportDate: d, status: "draft" }) === null, TODAY);
  check("저장소 수준에서도 확인완료 보고서 덮어쓰기 차단", guarded && (await reportOf(TODAY)).status === "confirmed");
  await page.locator(".rp-file", { hasText: "작업화면.png" }).locator(".rp-file__open").click();
  check("22. 확인완료 보고서 첨부 이미지 미리보기", (await page.locator(".rp-imgview img").count()) === 1);
  await page.click(".modal__foot .btn--primary");
  await page.screenshot({ path: path.join(SHOTS, "9-확인-확인완료.png"), fullPage: true });

  /* ───────── [보고자 조회] 알림 + 새로고침 ───────── */
  console.log("\n[보고자 조회] 새로고침 → 접속 알림 → 대시보드 알림 → 보기");
  await page.goto(APP + "#/dashboard");
  await page.reload();
  await page.waitForSelector(".dash-head");
  await page.waitForTimeout(200);
  check("접속 시 알림 토스트", (await toasts()).includes("상급자(admin)가 " + TODAY + " 일일 업무보고를 확인했습니다."), await toasts());
  check("대시보드 알림 배너", (await text(".rp-notices")).includes(TODAY + " 일일 업무보고를 확인했습니다."));
  await page.locator(".rp-notice-item", { hasText: TODAY }).locator("text=보기").click();
  await page.waitForSelector(".rp-form");
  check("보기 → 해당 보고서 열림 + 알림 해제",
    (await page.inputValue("#rp-date")) === TODAY && (await page.locator(".rp-notices").count()) === 0 && !!(await reportOf(TODAY)).reviewSeenAt);
  check("새로고침 후 확인완료 유지", (await text("#rp-status")) === "확인완료" && (await rowText(TODAY)).includes("확인완료 상급자 확인 완료"));

  /* ───────── [반려] 12~17 ───────── */
  console.log("\n[반려] 어제 보고서 제출 → 검토 시작 → 반려");
  await page.fill("#rp-date", YDAY);
  await page.dispatchEvent("#rp-date", "change");
  await page.waitForTimeout(150);
  check("어제 보고서: 완료 업무 없음(오늘 완료 업무 미포함)", (await page.locator(".rp-done__title").count()) === 0);
  await page.fill("#rp-ach", "자료 정리");
  await page.setInputFiles("#rp-file", [{ name: "메모.txt", mimeType: "text/plain", buffer: Buffer.from("hello") }]);
  await page.waitForTimeout(200);
  await page.click("#rp-send");
  await page.click(".modal__foot .btn--primary");
  await page.click(".modal__foot .btn--primary");
  await page.click("#rp-review-start");
  const rs = await reportOf(YDAY);
  check("검토 시작 → reviewed / 상급자 검토중", rs.status === "reviewed" && rs.review.status === "reviewing" &&
    (await rowText(YDAY)).includes("검토중 상급자 검토중") && (await page.locator("#rp-review-start").count()) === 0);
  check("검토중: 보고자 회수 불가", (await page.locator("#rp-reopen").count()) === 0);
  await page.click("#rp-reject");
  await page.click("#rp-review-ok");
  check("빈 반려 사유 → 안내 + 미처리", (await toasts()).includes("반려 사유를 입력해 주세요.") &&
    (await page.locator(".modal .field.has-error").count()) === 1 && (await reportOf(YDAY)).status === "reviewed");
  await page.fill("#rp-review-comment", "업무성과 내용을 조금 더 구체적으로 작성해 주세요.");
  await page.click("#rp-review-ok");
  await page.waitForTimeout(200);
  const r3 = await reportOf(YDAY);
  check("12. 반려 → status=rejected", r3.status === "rejected" && r3.review.status === "rejected");
  check("13. 반려 사유 저장", r3.review.comment === "업무성과 내용을 조금 더 구체적으로 작성해 주세요.");
  check("14. 반려 상태 표시(배지·목록)", (await text("#rp-status")) === "반려" && (await rowText(YDAY)).includes("반려 수정 후 재제출 필요"));
  check("15. 반려자 저장", r3.review.reviewer === "admin");
  check("16. 반려일시 저장", DT.test(r3.review.reviewedAt));
  check("17. 반려 사유 표시", (await text("#rp-reject-reason")).includes("구체적으로 작성해 주세요") && (await text("#rp-review")).includes("반려자"));
  check("반려 이력 기록", r3.reviewHistory.map((h) => h.action).join(">") === "submitted>reviewing>rejected");
  check("반려 후 첨부 유지", r3.attachments.length === 1 && r3.attachments[0].name === "메모.txt");
  await page.click('a[data-view="dashboard"]');
  check("대시보드 반려 알림", (await text(".rp-notices")).includes(YDAY + " 일일 업무보고가 반려되었습니다. 반려 사유를 확인해 주세요."));
  await gotoReport();
  await openRow(YDAY);

  /* 필터 */
  const counts = await page.$$eval(".rp-filters .filters__btn", (n) => n.map((x) => x.textContent).join(","));
  check("필터 개수(전체2·미확인0·확인완료1·반려1)", counts === "전체 2,미확인 0,확인완료 1,반려 1", counts);
  await page.click('.rp-filters [data-filter="rejected"]');
  check("반려 필터", (await page.locator(".rp-row").count()) === 1 && (await rowText(YDAY)).includes("반려"));
  await page.click('.rp-filters [data-filter="confirmed"]');
  check("확인완료 필터", (await page.locator(".rp-row").count()) === 1 && (await page.locator(".rp-row", { hasText: TODAY }).count()) === 1);
  await page.click('.rp-filters [data-filter="all"]');
  await page.screenshot({ path: path.join(SHOTS, "10-확인-반려.png"), fullPage: true });

  /* ───────── [재작성] 18~20 ───────── */
  console.log("\n[재작성] 수정 → 재제출");
  await page.click("#rp-revise");
  await page.click(".modal__foot .btn--primary");
  const r4 = await reportOf(YDAY);
  check("18. 수정 → draft, 반려 사유는 계속 보임", r4.status === "draft" && r4.review.status === "rejected" &&
    !(await page.$eval("#rp-ach", (e) => e.disabled)) && (await text("#rp-reject-reason")).includes("구체적으로"));
  check("수정중 목록 표시(임시저장 / 반려 후 수정중)", (await rowText(YDAY)).includes("임시저장 반려 후 수정중"));
  check("버튼 이름: 재제출", (await text("#rp-send")).includes("재제출"));
  await page.fill("#rp-ach", "자료 정리 — 거래처 3곳 견적 비교표 작성, 단가 5% 절감");
  await page.fill("#rp-other", "추가 보고");
  await page.setInputFiles("#rp-file", [{ name: "비교표.png", mimeType: "image/png", buffer: PNG }]);
  await page.waitForTimeout(200);
  await page.click("#rp-send");
  check("재제출 확인창", (await text(".modal__title")) === "보고서 재제출");
  await page.click(".modal__foot .btn--primary");
  await page.click(".modal__foot .btn--primary");
  const r5 = await reportOf(YDAY);
  check("19~20. 재제출 → submitted, 다시 미확인", r5.status === "submitted" && r5.review.status === "pending" &&
    r5.review.comment === "" && !r5.review.reviewedAt && r5.confirmation.confirmedAt === null);
  check("수정 내용·첨부 반영", r5.achievements.includes("단가 5% 절감") && r5.attachments.map((a) => a.name).join(",") === "메모.txt,비교표.png");
  check("반려 이력 보존", r5.reviewHistory.map((h) => h.action).join(">") === "submitted>reviewing>rejected>revising>resubmitted" &&
    r5.reviewHistory[2].comment.includes("구체적으로"));
  const rv5 = await text("#rp-review");
  check("재제출 후 보고자 화면: 미확인(이전 결과를 현재 결과로 표시 안 함)",
    (await rowText(YDAY)).includes("제출완료 상급자 미확인") && rv5.includes("아직 확인되지 않았습니다.") &&
    !rv5.includes("확인완료") && (await page.locator("#rp-reject-reason").count()) === 0 &&
    (await text(".rp-prev-reject")).includes("이전 반려 사유"));
  check("재제출 후 반려 알림 사라짐", (await page.locator(".rp-notice-item", { hasText: YDAY }).count()) === 0);
  await page.reload();
  await page.waitForSelector(".rp-form");
  await openRow(YDAY);
  check("새로고침 후 미확인 상태 유지", (await text("#rp-status")) === "제출완료" && (await rowText(YDAY)).includes("상급자 미확인"));
  // 재제출 건 확인
  await page.click("#rp-confirm");
  await page.click("#rp-review-ok"); // 의견 없이도 확인 가능
  const r6 = await reportOf(YDAY);
  check("재제출 건 확인완료(의견 선택)", r6.status === "confirmed" && r6.confirmation.comment === "" &&
    (await text("#rp-confirm-comment")).includes("의견 없음") && r6.reviewHistory.at(-1).action === "confirmed");

  /* ───────── 회수(다시 작성하기) 유지 ───────── */
  console.log("\n[기존 다시 작성하기]");
  await page.fill("#rp-date", Y2);
  await page.dispatchEvent("#rp-date", "change");
  await page.waitForTimeout(150);
  await page.fill("#rp-ach", "회수 테스트");
  await page.click("#rp-send");
  await page.click(".modal__foot .btn--primary");
  await page.click(".modal__foot .btn--primary");
  await page.click("#rp-reopen");
  await page.click(".modal__foot .btn--primary");
  const r7 = await reportOf(Y2);
  check("제출완료 → 다시 작성하기 → 임시저장", r7.status === "draft" && r7.review.status === "none" && r7.reviewHistory.at(-1).action === "withdrawn");
  await page.click(`button[aria-label="${Y2} 보고서 삭제"]`);
  await page.click(".modal__foot .btn--danger");

  /* ───────── [기존 기능] 23~26 ───────── */
  console.log("\n[기존 기능]");
  check("23. Task 데이터 변경 없음", (await tasksSig()) === tasksBefore);
  const after = await stored();
  check("25·26. Event / Memo 변경 없음", JSON.stringify(after.events) === JSON.stringify(before.events) && after.notes === "메모 테스트");
  await page.click('a[data-view="dashboard"]');
  await page.waitForSelector(".dash-head");
  await page.waitForTimeout(150);
  // 메모의 상대 시간("저장 방금" / "저장 10초 전")은 시간이 지나며 바뀌므로 비교에서 제외
  const noRel = (t) => t.replace(/저장 [^\n]*/g, "저장");
  const dashAfter = await text(".summary");
  check("Dashboard 통계 변경 없음", noRel(dashAfter) === noRel(dashSummaryBefore), dashAfter === dashSummaryBefore ? "" : JSON.stringify(dashSummaryBefore) + " vs " + JSON.stringify(dashAfter));
  await page.click('a[data-view="tasks"]');
  check("Task 화면 정상", (await page.locator(".task").count()) >= 3);
  await page.click("text=+ 새 할 일");
  await page.fill("#tf-title", "추가 업무 E");
  await page.click(".modal__foot .btn--primary");
  check("Task 추가 정상", (await stored()).tasks.some((t) => t.title === "추가 업무 E"));
  await page.click('a[data-view="events"]');
  await page.waitForSelector(".cal__title").catch(() => {});
  check("24. Calendar 렌더", (await page.locator(".cal__title").count()) >= 1);
  check("25. Event 표시", (await page.locator(".main").innerText()).includes("팀 회의"));
  await page.evaluate(() => { location.hash = "#/stats"; }); await page.waitForTimeout(150);
  check("통계 화면 정상", (await page.locator(".main").innerText()).length > 0);

  /* ───────── [Backup / Restore] 27 ───────── */
  console.log("\n[Backup / Restore]");
  const backupText = await page.evaluate(() => TP.store.exportJSON());
  const backup = JSON.parse(backupText);
  const br = backup.data.reports.find((r) => r.reportDate === YDAY);
  check("백업에 status/review/confirmation/reviewHistory/attachments 포함",
    br.status === "confirmed" && br.review && br.confirmation && br.reviewHistory.length === 6 && br.attachments.length === 2);
  await gotoReport();
  await page.click(`button[aria-label="${YDAY} 보고서 삭제"]`);
  check("확인완료 삭제 시 경고", (await text(".confirm__msg")).includes("상급자 확인 완료된 보고서입니다"));
  await page.click(".modal__foot .btn--danger");
  await page.click('#backupLink');
  await page.setInputFiles('input[type=file][accept*="json"]', { name: "backup.json", mimeType: "application/json", buffer: Buffer.from(backupText) });
  await page.click(".modal__foot .btn--primary");
  await page.waitForTimeout(300);
  const rr = await reportOf(YDAY);
  check("Restore 후 확인 정보·이력·첨부 복원", rr && JSON.stringify(rr) === JSON.stringify(br));

  // 기존(확인 필드 없는) 백업
  const legacy = JSON.parse(backupText);
  legacy.data.reports = [
    { reportDate: TODAY, status: "submitted", reporter: { name: "admin" }, recipient: { name: "김부장" }, cc: [], completedTasks: [{ title: "옛 업무" }], achievements: "", otherNotes: "" },
    { reportDate: YDAY, status: "draft", recipient: null, cc: [], achievements: "x", otherNotes: "" },
    { reportDate: Y2, recipient: { name: "김부장" }, cc: [] }
  ];
  await page.click('#backupLink');
  await page.setInputFiles('input[type=file][accept*="json"]', { name: "old.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(legacy)) });
  await page.click(".modal__foot .btn--primary");
  await page.waitForTimeout(300);
  const s8 = await stored();
  const byD = (d) => s8.reports.find((r) => r.reportDate === d);
  check("기존 백업 Restore: 오류 없이 기본값 보완",
    byD(TODAY).review.status === "pending" && byD(YDAY).review.status === "none" && byD(Y2).status === "draft" &&
    s8.reports.every((r) => Array.isArray(r.reviewHistory) && r.confirmation && Array.isArray(r.attachments)));
  await gotoReport();
  check("기존 submitted 보고서 → 상급자 미확인 표시", (await rowText(TODAY)).includes("제출완료 상급자 미확인"));

  /* ───────── [30] 기존 LocalStorage 데이터 호환 ───────── */
  console.log("\n[30] 기존 LocalStorage 데이터 (확인 필드 없음)");
  await page.evaluate((k) => {
    const s = JSON.parse(localStorage.getItem(k));
    s.reports = [{ reportDate: "2026-01-05", status: "submitted", recipient: { name: "김부장" }, cc: [{ name: "이대리" }], completedTasks: [], achievements: "옛 데이터", otherNotes: "", submittedAt: "2026-01-05T09:00:00.000Z" },
      { reportDate: "2026-01-04", status: "weird", cc: "bad" }];
    localStorage.setItem(k, JSON.stringify(s));
    localStorage.setItem("other-app-key", "keep");
  }, KEY);
  await page.reload();
  await page.waitForSelector(".rp-form");
  await openRow("2026-01-05");
  check("옛 데이터 열기 정상(미확인)", (await text("#rp-review")).includes("아직 확인되지 않았습니다.") && (await text("#rp-status")) === "제출완료");
  await page.click("#rp-confirm");
  await page.click("#rp-review-ok");
  check("옛 데이터도 확인 처리 가능", (await reportOf("2026-01-05")).status === "confirmed");
  check("다른 LocalStorage 키 보존(clear 미사용)", await page.evaluate(() => localStorage.getItem("other-app-key") === "keep"));

  /* ───────── [28·29] Dark / Mobile ───────── */
  console.log("\n[Dark Mode / Mobile]");
  await page.click("#themeToggle");
  await page.fill("#rp-date", TODAY);
  await page.dispatchEvent("#rp-date", "change");
  await page.waitForTimeout(150);
  // 오늘 보고서를 제출해 상급자 처리 버튼이 보이게 한다 (보고 대상은 직전 보고서 값)
  await page.fill("#rp-ach", "모바일 확인용");
  await page.click("#rp-send");
  await page.click(".modal__foot .btn--primary");
  await page.click(".modal__foot .btn--primary");
  const dark = await page.evaluate(() => ({
    theme: document.documentElement.getAttribute("data-theme"),
    bg: getComputedStyle(document.querySelector("#rp-review")).backgroundColor
  }));
  check("28. 다크 모드 확인 패널", dark.theme === "dark" && dark.bg !== "rgb(255, 255, 255)", JSON.stringify(dark));
  await clearToasts();
  await page.screenshot({ path: path.join(SHOTS, "11-확인-다크모드.png"), fullPage: true });
  await page.click("#themeToggle");
  await page.setViewportSize({ width: 375, height: 800 });
  await page.waitForTimeout(200);
  const mob = await page.evaluate(() => {
    const b = [...document.querySelectorAll("#rp-confirm, #rp-reject")].map((x) => x.getBoundingClientRect());
    return {
      overflow: document.documentElement.scrollWidth > window.innerWidth,
      btn: b.map((r) => Math.round(r.width) + "x" + Math.round(r.height)).join(" "),
      big: b.length === 2 && b.every((r) => r.height >= 44 && r.width >= 120 && r.right <= window.innerWidth)
    };
  });
  check("29. 모바일: 가로 스크롤 없음 / 확인·반려 버튼 크게", !mob.overflow && mob.big, JSON.stringify(mob));
  await clearToasts();
  await page.locator("#rp-review").screenshot({ path: path.join(SHOTS, "12-확인-모바일.png") });
  await page.locator(".rp-list").screenshot({ path: path.join(SHOTS, "13-확인-모바일목록.png") });

  check("콘솔 오류 없음", errors.length === 0, errors.join(" | "));
  console.log("\n결과: " + pass + "/" + (pass + fail) + " 통과" + (fail ? "  (실패 " + fail + "건)" : ""));
  if (!HEADLESS) await page.waitForTimeout(3000);
  await ctx.close();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* temp dir */ }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("\n테스트 중 오류:", e.message || e); process.exit(2); });
