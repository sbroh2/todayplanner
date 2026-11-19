/* =========================================================================
   attach-test.js — 일일 업무보고 첨부파일 자동 테스트 (Chrome)

   실행: tests 폴더에서 `node attach-test.js`
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
const SLOW = Number(process.env.SLOW || (HEADLESS ? 0 : 200));
const MB = 1024 * 1024;

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

// 1x1 PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const file = (name, mimeType, buffer) => ({ name, mimeType, buffer });
const blob = (n) => Buffer.alloc(n, 65);

(async () => {
  const chrome = findChrome();
  if (!chrome) { console.error("Google Chrome을 찾지 못했습니다."); process.exit(2); }
  fs.mkdirSync(SHOTS, { recursive: true });
  const TODAY = key(new Date());
  const y = new Date(); y.setDate(y.getDate() - 1);
  const YDAY = key(y);

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "tp-attach-"));
  const ctx = await chromium.launchPersistentContext(profile, {
    executablePath: chrome, headless: HEADLESS, slowMo: SLOW, acceptDownloads: true,
    viewport: { width: 1360, height: 900 }
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !/저장 실패/.test(m.text())) errors.push(m.text()); });

  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem("today-planner:v1")));
  const reportOf = async (d) => (await stored()).reports.find((r) => r.reportDate === d);
  const fileNames = () => page.$$eval(".rp-file__text", (n) => n.map((x) => x.textContent));
  const lastToast = async () => (await page.$$eval(".toast", (n) => n.map((x) => x.textContent))).join(" | ");
  const clearToasts = () => page.evaluate(() => document.querySelectorAll(".toast").forEach((t) => t.remove()));
  async function pick(files) { await clearToasts(); await page.setInputFiles("#rp-file", files); await page.waitForTimeout(300); }
  async function gotoReport() { await page.click('a[data-view="report"]'); await page.waitForSelector(".rp-form"); }

  await page.goto(APP);
  await page.fill("#loginUsername", "admin");
  await page.fill("#loginPassword", "1234");
  await page.click("#loginSubmit");
  await page.waitForSelector(".dash-head");

  // a done task, an open task and a future task for today's report
  await page.click('a[data-view="tasks"]');
  for (const [t, d] of [["완료 업무 A", null], ["진행 업무 B", null], ["예정 업무 C", "2099-01-01"]]) {
    await page.click("text=+ 새 할 일");
    await page.fill("#tf-title", t);
    if (d) await page.fill("#tf-date", d);
    await page.click(".modal__foot .btn--primary");
  }
  await page.locator(".task", { hasText: "완료 업무 A" }).locator(".check").check();
  await gotoReport();

  console.log("\n[1] 파일 없음 / 1개 첨부");
  check("빈 상태 문구", (await page.textContent(".rp-attach")).includes("첨부된 파일이 없습니다."));
  check("accept 속성", (await page.getAttribute("#rp-file", "accept")).includes(".xlsx") && (await page.getAttribute("#rp-file", "multiple")) !== null);
  await pick([file("업무결과.xlsx", XLSX_MIME, blob(128000))]);
  const one = await page.innerText(".rp-file");
  check("파일명·크기 표시", one.includes("업무결과.xlsx") && one.includes("125 KB") && one.includes("다운로드") && one.includes("삭제"), one.replace(/\s+/g, " "));

  console.log("\n[2] 여러 파일 첨부");
  await pick([file("작업화면.png", "image/png", PNG), file("보고서.pdf", "application/pdf", PDF), file("메모.txt", "text/plain", Buffer.from("hello"))]);
  check("4개 표시", (await fileNames()).length === 4, (await fileNames()).join(", "));
  check("이미지/PDF는 [보기]", (await page.locator(".rp-file", { hasText: "작업화면.png" }).innerText()).includes("보기"));

  console.log("\n[3] 파일 삭제");
  await page.click('button[aria-label="메모.txt 첨부 삭제"]');
  check("삭제 반영", !(await fileNames()).includes("메모.txt") && (await fileNames()).length === 3);

  console.log("\n[4] 허용되지 않는 형식");
  await pick([file("setup.exe", "application/x-msdownload", blob(100))]);
  check("exe 거부 + 안내", (await fileNames()).length === 3 && (await lastToast()).includes("지원하지 않는 파일 형식"));
  await pick([file("가짜.pdf", "application/x-msdownload", blob(100))]);
  check("확장자/MIME 불일치 거부", (await fileNames()).length === 3);

  console.log("\n[5] 파일당 2MB 제한 (실제 제한값: TP.attach.LIMITS)");
  const limits = await page.evaluate(() => TP.attach.LIMITS);
  check("제한값 확인: 파일당 2MB / 합계 2.5MB / 5개", limits.maxFileBytes === 2 * MB && limits.maxTotalBytes === 2.5 * MB && limits.maxFiles === 5, JSON.stringify(limits));
  await pick([file("큰파일.zip", "application/zip", blob(2 * MB + 1))]);
  check("2MB 초과(2MB+1B) 거부 + 안내", (await fileNames()).length === 3 && (await lastToast()).includes("파일 1개당 최대 2MB"));
  await pick([file("정확히2MB.zip", "application/zip", blob(2 * MB))]);
  check("정확히 2MB 허용", (await fileNames()).includes("정확히2MB.zip"));
  await page.click('button[aria-label="정확히2MB.zip 첨부 삭제"]');

  console.log("\n[6] 5개 초과");
  await pick([file("a.txt", "text/plain", blob(10)), file("b.txt", "text/plain", blob(10)), file("c.txt", "text/plain", blob(10))]);
  check("5개까지만 추가 + 안내", (await fileNames()).length === 5 && (await lastToast()).includes("최대 5개"), (await fileNames()).join(","));
  for (const n of ["a.txt", "b.txt"]) await page.click(`button[aria-label="${n} 첨부 삭제"]`);

  console.log("\n[7] 전체 용량 2.5MB 초과");
  // 현재 3개 ≈ 125KB → big1(2MB) 허용(합계 약 2.1MB), big2(1MB)는 2.5MB 초과로 거부
  await pick([file("big1.zip", "application/zip", blob(2 * MB)), file("big2.zip", "application/zip", blob(1 * MB))]);
  const n7 = await fileNames();
  check("합계 2.5MB 넘는 파일 거부 + 안내", n7.length === 4 && n7.includes("big1.zip") && !n7.includes("big2.zip") && (await lastToast()).includes("합계 최대 2.5MB"), n7.join(","));
  check("사용량 표시", (await page.textContent("#rp-attach-usage")).includes("/ 2.5 MB"), await page.textContent("#rp-attach-usage"));

  console.log("\n[10-1] LocalStorage 용량 초과 시 보호");
  const before = JSON.stringify(await stored());
  await clearToasts();
  await page.click("#rp-save");
  await page.waitForTimeout(300);
  const t10 = await lastToast();
  const after = JSON.stringify(await stored());
  if (t10.includes("임시저장했어요")) {
    check("(브라우저 용량 내 저장됨)", true, "이 브라우저는 8MB+ 저장 허용");
  } else {
    check("저장 실패 안내 문구", t10.includes("첨부파일 용량이 커서 저장할 수 없습니다"), t10);
    check("기존 저장 데이터 손상 없음", before === after);
    check("화면의 작성 내용 유지", (await fileNames()).length === 4 && (await page.textContent(".rp-saveinfo")).includes("저장되지 않은"));
  }
  for (const n of ["big1.zip"]) await page.click(`button[aria-label="${n} 첨부 삭제"]`);
  check("Task 기능 정상(용량 초과 이후)", (await stored()).tasks.length === 3);

  console.log("\n[8] 임시저장 후 다시 열기");
  await page.selectOption("#rp-recipient", "__new");
  await page.fill("#rp-person", "김부장");
  await page.click(".modal__foot .btn--primary");
  await page.click("#rp-save");
  await page.waitForTimeout(200);
  await page.reload();
  await page.waitForSelector(".rp-form");
  const r8 = await reportOf(TODAY);
  check("저장 데이터 attachments 3개(id/name/size/type/data/addedAt)", r8.attachments.length === 3 &&
    r8.attachments.every((a) => a.id && a.name && typeof a.size === "number" && a.data.startsWith("data:") && a.addedAt) &&
    r8.attachments[0].type === XLSX_MIME, r8.attachments.map((a) => a.name + ":" + a.size).join(","));
  check("새로고침 후 목록 복원", (await fileNames()).join(",") === "업무결과.xlsx,작업화면.png,보고서.pdf");

  console.log("\n[10] Preview 첨부파일");
  const doc = await page.textContent(".rp-doc");
  check("■ 첨부파일 + 📎 파일명", doc.includes("■ 첨부파일") && doc.includes("📎 업무결과.xlsx") && doc.includes("📎 작업화면.png"));
  check("완료 업무 규칙 유지", doc.includes("1. 완료 업무 A") && !doc.includes("진행 업무 B") && !doc.includes("예정 업무 C"));

  console.log("\n[11] 이미지 열기");
  await page.click('.rp-file:has-text("작업화면.png") .rp-file__open');
  const img = await page.waitForSelector(".rp-imgview img");
  check("이미지 미리보기", (await img.evaluate((i) => i.complete && i.naturalWidth === 1)));
  await page.screenshot({ path: path.join(SHOTS, "4-첨부-이미지미리보기.png") });
  await page.click(".modal__foot .btn--primary");

  console.log("\n[12] 문서 다운로드 / PDF 열기");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click('.rp-file:has-text("업무결과.xlsx") .rp-file__open')]);
  const dlPath = await dl.path();
  check("파일명 유지 + 내용 동일", dl.suggestedFilename() === "업무결과.xlsx" && fs.statSync(dlPath).size === 128000, dl.suggestedFilename());
  const [tab] = await Promise.all([ctx.waitForEvent("page"), page.click('.rp-file:has-text("보고서.pdf") .rp-file__open')]);
  await tab.waitForURL(/^blob:/, { timeout: 5000 }).catch(() => {});
  check("PDF 새 탭(blob URL)", tab.url().startsWith("blob:"), tab.url());
  await tab.close();

  console.log("\n[9] 보고서 제출 후 다시 열기");
  await page.click("#rp-send");
  check("확인창에 첨부 개수", (await page.textContent(".confirm__msg")).includes("첨부파일 3개"));
  await page.click(".modal__foot .btn--primary");
  await page.waitForSelector("text=전송 대기 상태로 저장되었습니다");
  check("기존 안내 문구 유지", (await page.textContent(".modal__body")).includes("현재 버전에서는 실제 외부 전송은 지원하지 않습니다."));
  await page.click(".modal__foot .btn--primary");
  const r9 = await reportOf(TODAY);
  check("submitted + 첨부 유지", r9.status === "submitted" && r9.attachments.length === 3);
  check("잠금: 파일 선택/삭제 숨김, 보기 가능", (await page.locator("#rp-file-btn").count()) === 0 &&
    (await page.locator(".rp-file__del").count()) === 0 && (await page.locator(".rp-file__open").count()) === 3);
  await page.screenshot({ path: path.join(SHOTS, "5-첨부-제출후.png"), fullPage: true });
  await page.click("text=✎ 다시 작성하기");
  await page.click(".modal__foot .btn--primary");
  await page.waitForTimeout(200);
  const r9b = await reportOf(TODAY);
  check("다시 작성하기 후 draft + 첨부 유지", r9b.status === "draft" && r9b.attachments.length === 3 && (await fileNames()).length === 3);

  console.log("\n[9-2] 반려 → 수정 → 재제출 → 확인완료 후 첨부");
  const sig = (r) => r.attachments.map((a) => a.id + ":" + a.name + ":" + a.size + ":" + a.data.length).join("|");
  const sig0 = sig(r9b);
  await page.click("#rp-send");
  await page.click(".modal__foot .btn--primary");
  await page.click(".modal__foot .btn--primary");
  await page.click("#rp-reject");
  await page.fill("#rp-review-comment", "첨부 확인 필요");
  await page.click("#rp-review-ok");
  await page.waitForTimeout(150);
  check("반려 후 첨부 유지(동일 데이터)", (await reportOf(TODAY)).status === "rejected" && sig(await reportOf(TODAY)) === sig0);
  await page.click("#rp-revise");
  await page.click(".modal__foot .btn--primary");
  check("수정 중 첨부 삭제 버튼 사용 가능", (await page.locator(".rp-file__del").count()) === 3);
  await page.click("#rp-send");
  await page.click(".modal__foot .btn--primary");
  await page.click(".modal__foot .btn--primary");
  check("재제출 후 첨부 유지", (await reportOf(TODAY)).status === "submitted" && sig(await reportOf(TODAY)) === sig0);
  await page.click("#rp-confirm");
  await page.click("#rp-review-ok");
  await page.waitForTimeout(150);
  check("확인완료 후 첨부 유지 + 삭제 불가", (await reportOf(TODAY)).status === "confirmed" && sig(await reportOf(TODAY)) === sig0 &&
    (await page.locator(".rp-file__del").count()) === 0 && (await page.locator("#rp-file-btn").count()) === 0);
  await page.click('.rp-file:has-text("작업화면.png") .rp-file__open');
  check("확인완료 후 이미지 열기", await (await page.waitForSelector(".rp-imgview img")).evaluate((i) => i.complete && i.naturalWidth === 1));
  await page.click(".modal__foot .btn--primary");
  const [dl2] = await Promise.all([page.waitForEvent("download"), page.click('.rp-file:has-text("업무결과.xlsx") .rp-file__open')]);
  check("확인완료 후 다운로드(파일명·크기)", dl2.suggestedFilename() === "업무결과.xlsx" && fs.statSync(await dl2.path()).size === 128000);
  const [tab2] = await Promise.all([ctx.waitForEvent("page"), page.click('.rp-file:has-text("보고서.pdf") .rp-file__open')]);
  await tab2.waitForURL(/^blob:/, { timeout: 5000 }).catch(() => {});
  check("확인완료 후 PDF 열기", tab2.url().startsWith("blob:"));
  await tab2.close();

  console.log("\n[13] Backup 후 Restore");
  await page.click('#backupLink');
  const [bk] = await Promise.all([page.waitForEvent("download"), page.click("text=📥 데이터 내보내기")]);
  const backupText = fs.readFileSync(await bk.path(), "utf8");
  const backup = JSON.parse(backupText);
  check("백업에 첨부 포함", backup.data.reports.find((r) => r.reportDate === TODAY).attachments.length === 3);
  // wipe the report in this browser, then restore
  await gotoReport();
  await page.click(`button[aria-label="${TODAY} 보고서 삭제"]`);
  await page.click(".modal__foot .btn--danger");
  check("보고서 삭제됨", !(await reportOf(TODAY)));
  await page.click('#backupLink');
  await page.setInputFiles('input[type=file][accept*="json"]', { name: "backup.json", mimeType: "application/json", buffer: Buffer.from(backupText) });
  await page.click(".modal__foot .btn--primary");
  await page.waitForTimeout(300);
  const r13 = await reportOf(TODAY);
  check("Restore 후 첨부 복원(데이터 동일)", r13 && r13.attachments.length === 3 &&
    r13.attachments[1].data === backup.data.reports.find((r) => r.reportDate === TODAY).attachments[1].data);
  check("Task/Event 영향 없음", (await stored()).tasks.length === 3);
  await gotoReport();
  check("Restore 후 화면 표시", (await fileNames()).length === 3);

  console.log("\n[14] attachments 없는 기존 보고서 / 기존 백업");
  const legacy = JSON.parse(backupText);
  legacy.data.reports.forEach((r) => { delete r.attachments; });
  legacy.data.reports.push({ reportDate: YDAY, status: "submitted", reporter: { name: "admin" }, recipient: { name: "김부장" }, cc: [], completedTasks: [{ title: "어제 업무" }], achievements: "", otherNotes: "" });
  await page.click('#backupLink');
  await page.setInputFiles('input[type=file][accept*="json"]', { name: "old.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(legacy)) });
  await page.click(".modal__foot .btn--primary");
  await page.waitForTimeout(300);
  const s14 = await stored();
  check("attachments 없으면 []", s14.reports.every((r) => Array.isArray(r.attachments) && r.attachments.length === 0));
  await gotoReport();
  await page.click(`.rp-row__main:has-text("${YDAY}")`);
  check("기존 보고서 열기 정상", (await page.textContent(".rp-attach")).includes("첨부된 파일이 없습니다.") &&
    (await page.textContent(".rp-doc")).includes("■ 첨부파일"));
  // restore the full backup again for the remaining checks
  await page.click('#backupLink');
  await page.setInputFiles('input[type=file][accept*="json"]', { name: "backup.json", mimeType: "application/json", buffer: Buffer.from(backupText) });
  await page.click(".modal__foot .btn--primary");
  await page.waitForTimeout(300);

  console.log("\n[15] Dark Mode");
  await page.click("#themeToggle");
  await gotoReport();
  await page.click(`.rp-row__main:has-text("${TODAY}")`).catch(() => {});
  const dark = await page.evaluate(() => ({
    theme: document.documentElement.getAttribute("data-theme"),
    bg: getComputedStyle(document.querySelector(".rp-file")).backgroundColor
  }));
  check("다크 모드 첨부 목록 색상", dark.theme === "dark" && dark.bg !== "rgb(255, 255, 255)", JSON.stringify(dark));
  await page.screenshot({ path: path.join(SHOTS, "6-첨부-다크모드.png"), fullPage: true });

  console.log("\n[16] Mobile");
  await page.setViewportSize({ width: 375, height: 800 });
  await page.waitForTimeout(200);
  const mob = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth > window.innerWidth,
    rows: [...document.querySelectorAll(".rp-file")].every((r) => r.getBoundingClientRect().right <= window.innerWidth)
  }));
  check("가로 스크롤 없음 / 목록이 화면 안", !mob.overflow && mob.rows, JSON.stringify(mob));
  await clearToasts();
  await page.locator(".rp-attach").screenshot({ path: path.join(SHOTS, "7-첨부-모바일.png") });
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.click("#themeToggle");

  console.log("\n[17] 기존 Task / Calendar / Event");
  await page.click('a[data-view="tasks"]');
  await page.click("text=+ 새 할 일");
  await page.fill("#tf-title", "추가 업무 D");
  await page.click(".modal__foot .btn--primary");
  check("Task 추가", (await stored()).tasks.some((t) => t.title === "추가 업무 D"));
  await page.click('a[data-view="events"]');
  await page.waitForTimeout(200);
  check("일정/캘린더 화면 렌더", (await page.locator(".main").innerText()).length > 0 && errors.length === 0);

  check("콘솔 오류 없음", errors.length === 0, errors.join(" | "));
  console.log("\n결과: " + pass + "/" + (pass + fail) + " 통과" + (fail ? "  (실패 " + fail + "건)" : ""));
  if (!HEADLESS) await page.waitForTimeout(3000);
  await ctx.close();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* temp dir */ }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("\n테스트 중 오류:", e.message || e); process.exit(2); });
