/* =========================================================================
   report.js — 일일 업무보고 (Phase 3-1)
   Completed-work daily report: for the chosen 보고일 it lists only tasks with
   taskDate === 보고일 AND done === true, plus 보고 대상 / 참조(CC), a free-text
   "주요 성과 및 특이사항" and "기타 보고사항", a live preview, 임시저장 and a
   local-only "보고서 전송" (status -> submitted; nothing leaves the browser).
   Phase 3-2 adds 첨부파일: files are kept on the report as Data URLs
   (see attach.js) and saved / submitted / restored together with it.
   Tasks are only read here — never modified.
   ========================================================================= */
(function () {
  "use strict";

  var U = TP.utils;
  var S = TP.store;
  var UI = TP.ui;
  var A = TP.attach;
  var el = U.el;

  /* Phase 3-3: 상급자 확인 / 반려 workflow. Every label below is derived from
     the report's own status + review — the reporter's view and the reviewer's
     view read the very same stored report. */
  var STATUS_LABEL = {
    draft: "임시저장", submitted: "제출완료", reviewed: "검토중",
    rejected: "반려", confirmed: "확인완료"
  };
  var STATUS_CHIP = {
    draft: "chip--high", submitted: "chip--normal", reviewed: "chip--recur",
    rejected: "chip--top", confirmed: "chip--done"
  };
  var STATUS_SUB = {
    submitted: "상급자 미확인", reviewed: "상급자 검토중",
    rejected: "수정 후 재제출 필요", confirmed: "상급자 확인 완료"
  };
  var REVIEW_LABEL = { none: "미제출", pending: "미확인", reviewing: "검토중", rejected: "반려", confirmed: "확인완료" };
  var HISTORY_LABEL = {
    submitted: "제출", resubmitted: "재제출", withdrawn: "제출 회수(다시 작성)", reviewing: "검토 시작",
    rejected: "반려", revising: "수정 시작", confirmed: "확인 완료"
  };
  var FILTERS = [["all", "전체"], ["pending", "미확인"], ["confirmed", "확인완료"], ["rejected", "반려"]];

  // Working copy of the report being edited. Kept at module level so moving
  // to another menu and back does not lose unsaved typing.
  var work = null;
  var dirty = false;
  var listFilter = "all";
  var openNext = null; // report date to open when the view is entered from a notice

  function shared() { return TP.views.shared; }

  /* ------------------------------ model ------------------------------- */
  function reporterNow() {
    var userId = TP.auth && TP.auth.currentUser ? TP.auth.currentUser() : "";
    var name = S.get().reportProfile.displayName || userId || "사용자";
    return { userId: userId, name: name };
  }

  function reviewOf(r) {
    return r && r.review ? r.review : { status: "none", reviewer: "", reviewedAt: null, comment: "" };
  }
  function isRevising(r) { return r.status === "draft" && reviewOf(r).status === "rejected"; }

  /* chip label / class + 상급자 확인 상태 sub-text for a report */
  function statusInfo(r) {
    var info = {
      label: STATUS_LABEL[r.status] || r.status,
      chip: STATUS_CHIP[r.status] || "",
      sub: STATUS_SUB[r.status] || ""
    };
    if (r.status === "draft" && !r.updatedAt) info.label = "작성중"; // never saved yet
    if (isRevising(r)) info.sub = "반려 후 수정중";
    return info;
  }

  function matchesFilter(r, f) {
    if (f === "pending") return r.status === "submitted" || r.status === "reviewed";
    if (f === "confirmed") return r.status === "confirmed";
    if (f === "rejected") return r.status === "rejected" || isRevising(r);
    return true;
  }

  /* "YYYY-MM-DD HH:MM" */
  function fmtDT(iso) {
    if (!iso) return "-";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "-";
    return U.dateKey(d) + " " + U.pad(d.getHours()) + ":" + U.pad(d.getMinutes());
  }

  /* "표시이름 (로그인ID)" — the ID is shown only when it differs from the name,
     so the stored reviewer can be matched to the signed-in account. */
  function who(name, id) {
    if (!name && !id) return "-";
    return !id || id === name ? (name || id) : (name || id) + " (" + id + ")";
  }

  /* 최초 제출일시: submittedAt is renewed on every 재제출, the first submission
     is taken from reviewHistory (older reports: submittedAt). */
  function firstSubmittedAt(r) {
    var h = (r.reviewHistory || []).filter(function (x) { return x.action === "submitted"; })[0];
    return h ? h.timestamp : r.submittedAt || null;
  }
  function resubmitCount(r) {
    return (r.reviewHistory || []).filter(function (x) { return x.action === "resubmitted"; }).length;
  }

  /* The rejection a reporter is revising, or the latest one in the history
     (shown as "이전 반려 사유" after a resubmission). */
  function lastRejection(r) {
    var h = (r.reviewHistory || []).filter(function (x) { return x.action === "rejected"; });
    return h.length ? h[h.length - 1] : null;
  }

  /* ------------------------- reporter notices ------------------------- */
  function noticeText(r) {
    return r.review.status === "confirmed"
      ? "상급자" + (r.review.reviewer ? "(" + r.review.reviewer + ")" : "") + "가 " + r.reportDate + " 일일 업무보고를 확인했습니다."
      : r.reportDate + " 일일 업무보고가 반려되었습니다. 반려 사유를 확인해 주세요.";
  }

  function unseen() {
    var userId = TP.auth && TP.auth.currentUser ? TP.auth.currentUser() : "";
    return S.unseenReviewResults(userId);
  }

  /* Open a report in the 일일 업무보고 view (from the dashboard or a toast). */
  function openReport(key) {
    S.markReviewSeen(key);
    if (TP.views.current() === "report" && openFromView) { openFromView(key); return; }
    openNext = key;
    location.hash = "#/report";
  }
  var openFromView = null; // set by the mounted report view

  /* Banner listing review results the reporter has not acknowledged yet.
     Returns null when there is nothing new. Used by the dashboard too. */
  function noticeBanner() {
    var list = unseen();
    if (!list.length) return null;
    var ul = el("ul", { class: "rp-notices__list" });
    list.forEach(function (r) {
      var rejected = r.review.status === "rejected";
      ul.appendChild(el("li", { class: "rp-notice-item" + (rejected ? " is-rejected" : " is-confirmed") }, [
        el("span", { class: "rp-notice-item__icon", "aria-hidden": "true", text: rejected ? "↩" : "✓" }),
        el("span", { class: "rp-notice-item__text", text: noticeText(r) }),
        el("div", { class: "rp-notice-item__acts" }, [
          el("button", {
            type: "button", class: "btn btn--ghost btn--sm", text: "보기",
            onclick: function () { openReport(r.reportDate); }
          }),
          el("button", {
            type: "button", class: "mini-btn", "aria-label": r.reportDate + " 알림 닫기", html: "&times;",
            onclick: function () { S.markReviewSeen(r.reportDate); }
          })
        ])
      ]));
    });
    return el("section", { class: "panel rp-notices", role: "status", "aria-label": "업무보고 확인 알림" }, [
      el("h2", { class: "section-title" }, ["🔔 업무보고 확인 알림", el("span", { class: "section-title__count", text: String(list.length) })]),
      ul
    ]);
  }

  /* One toast on sign-in when the reviewer has acted since the last visit. */
  function loginNotice() {
    var list = unseen();
    if (!list.length) return;
    UI.toast(noticeText(list[0]) + (list.length > 1 ? " 외 " + (list.length - 1) + "건" : ""),
      list[0].review.status === "rejected" ? "danger" : "success", 6000);
  }

  function loadWork(key) {
    var r = S.getReport(key);
    if (r) {
      work = r;
    } else {
      // A new report starts with the previous report's 보고 대상 / 참조 so the
      // same people do not have to be picked again every day.
      var last = S.reports()[0];
      work = {
        reportDate: key, status: "draft", recipient: last ? last.recipient : null,
        cc: last ? last.cc.slice() : [], achievements: "", otherNotes: "", attachments: [], updatedAt: null
      };
    }
    if (!Array.isArray(work.attachments)) work.attachments = [];
    dirty = false;
  }

  function isLocked() { return work.status !== "draft"; }

  /* Draft -> live completed tasks of that day. Submitted -> the snapshot taken
     at submission, so a sent report never changes afterwards. */
  function completedItems() {
    if (isLocked() && Array.isArray(work.completedTasks)) return work.completedTasks;
    return S.completedTasksFor(work.reportDate);
  }

  function reporterOf() {
    return isLocked() && work.reporter && work.reporter.name ? work.reporter : reporterNow();
  }

  function samePerson(a, b) {
    if (!a || !b) return false;
    if (a.contactId && b.contactId) return a.contactId === b.contactId;
    return a.name === b.name;
  }

  function payload(status) {
    return {
      reportDate: work.reportDate,
      status: status,
      reporter: reporterOf(),
      recipient: work.recipient,
      cc: work.cc,
      completedTasks: completedItems(),
      achievements: work.achievements,
      otherNotes: work.otherNotes,
      attachments: work.attachments
    };
  }

  function hhmm(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    return isNaN(d.getTime()) ? "" : U.pad(d.getHours()) + ":" + U.pad(d.getMinutes());
  }

  function previewText() {
    var items = completedItems();
    var lines = [
      "일일 업무보고",
      "",
      "보고일자 : " + work.reportDate,
      "보고자   : " + reporterOf().name,
      "보고대상 : " + (work.recipient ? work.recipient.name : "(미지정)"),
      "참조     : " + (work.cc.length ? work.cc.map(function (p) { return p.name; }).join(", ") : "없음"),
      "",
      "상태     : " + statusInfo(work).label + (statusInfo(work).sub ? " / " + statusInfo(work).sub : ""),
      "",
      "■ 금일 완료 업무",
      ""
    ];
    if (items.length) {
      items.forEach(function (t, i) { lines.push((i + 1) + ". " + t.title); });
    } else {
      lines.push("완료된 업무가 없습니다.");
    }
    lines.push("", "■ 주요 성과 및 특이사항", "", work.achievements.trim() || "없음");
    lines.push("", "■ 기타 보고사항", "", work.otherNotes.trim() || "없음");
    lines.push("", "■ 첨부파일", "");
    if (work.attachments.length) {
      work.attachments.forEach(function (a) { lines.push("📎 " + a.name); });
    } else {
      lines.push("없음");
    }
    var rv = reviewOf(work);
    if (work.status !== "draft" || rv.status === "rejected") {
      lines.push("", "■ 상급자 확인 현황", "");
      var resubs = resubmitCount(work);
      if (resubs || isRevising(work)) lines.push("최초 제출일시 : " + fmtDT(firstSubmittedAt(work)));
      if (resubs && work.status !== "draft") lines.push("재제출일시 : " + fmtDT(work.submittedAt) + " (재제출 " + resubs + "회)");
      else if (!resubs && !isRevising(work) && work.submittedAt) lines.push("제출일시 : " + fmtDT(work.submittedAt));
      lines.push("확인 상태 : " + (isRevising(work) ? "반려 (수정중)" : REVIEW_LABEL[rv.status] || "-"));
      if (rv.status === "confirmed") {
        lines.push("확인자 : " + who(work.confirmation.confirmedBy, work.confirmation.confirmedById),
          "확인일시 : " + fmtDT(work.confirmation.confirmedAt),
          "확인 의견 : " + (work.confirmation.comment || "없음"));
      } else if (rv.status === "rejected") {
        lines.push("반려자 : " + who(rv.reviewer, rv.reviewerId), "반려일시 : " + fmtDT(rv.reviewedAt), "반려 사유 : " + (rv.comment || "-"));
      } else if (rv.status === "reviewing") {
        lines.push("검토자 : " + who(rv.reviewer, rv.reviewerId), "검토 시작 : " + fmtDT(rv.reviewedAt));
      }
    }
    return lines.join("\n");
  }

  /* ------------------------------ dialogs ----------------------------- */
  /* Pick (or add) one person for 보고 대상 or 참조. */
  function pickPerson(mode, onPick) {
    var excluded = [work.recipient].concat(work.cc).filter(Boolean);
    if (mode === "recipient") excluded = work.cc.slice(); // current recipient may be re-picked
    var choices = S.get().reportContacts.filter(function (c) {
      var p = { contactId: c.id, name: c.name };
      return !excluded.some(function (x) { return samePerson(x, p); });
    });

    var input = el("input", {
      type: "text", id: "rp-person", maxlength: "60", autocomplete: "off",
      placeholder: "예: 김부장"
    });
    var field = el("div", { class: "field" }, [
      el("label", { class: "field__label", for: "rp-person", text: "새 이름 / 직함 입력" }),
      input,
      el("p", { class: "field__error", text: "이름을 입력해 주세요." })
    ]);

    function choose(name) {
      var c = S.addContact(name);
      if (!c) return;
      modal.close();
      onPick({ contactId: c.id, name: c.name });
    }
    function submit(ev) {
      if (ev) ev.preventDefault();
      var v = input.value.trim();
      if (!v) { field.classList.add("has-error"); input.focus(); return; }
      choose(v);
    }
    input.addEventListener("input", function () { field.classList.remove("has-error"); });

    var list = el("div", { class: "rp-picks" });
    choices.forEach(function (c) {
      list.appendChild(el("button", {
        type: "button", class: "rp-pick", text: c.name,
        onclick: function () { choose(c.name); }
      }));
    });

    var form = el("form", { novalidate: "novalidate" }, [
      choices.length ? el("p", { class: "field__label", text: "최근 지정한 사람" }) : null,
      choices.length ? list : null,
      field
    ]);
    form.addEventListener("submit", submit);

    var modal = UI.openModal({
      title: mode === "recipient" ? "보고 대상 지정" : "참조자 추가",
      size: "sm",
      content: form,
      initialFocus: "#rp-person",
      footer: [
        el("button", { class: "btn btn--ghost", type: "button", text: "취소", onclick: function () { modal.close(); } }),
        el("button", { class: "btn btn--primary", type: "button", text: "추가", onclick: submit })
      ]
    });
  }

  function editReporterName() {
    var input = el("input", { type: "text", id: "rp-reporter", maxlength: "60", autocomplete: "off" });
    input.value = S.get().reportProfile.displayName || "";
    var current = TP.auth && TP.auth.currentUser ? TP.auth.currentUser() : "";
    function submit(ev) {
      if (ev) ev.preventDefault();
      if (!S.setReporterName(input.value)) return;
      modal.close();
      UI.toast("보고자 이름을 저장했어요.", "success");
    }
    var form = el("form", { novalidate: "novalidate" }, [
      el("div", { class: "field" }, [
        el("label", { class: "field__label", for: "rp-reporter", text: "보고서에 표시할 이름" }),
        input,
        el("p", { class: "setting-row__desc", text: "비워두면 로그인 아이디(" + (current || "-") + ")가 표시됩니다." })
      ])
    ]);
    form.addEventListener("submit", submit);
    var modal = UI.openModal({
      title: "보고자 이름", size: "sm", content: form, initialFocus: "#rp-reporter",
      footer: [
        el("button", { class: "btn btn--ghost", type: "button", text: "취소", onclick: function () { modal.close(); } }),
        el("button", { class: "btn btn--primary", type: "button", text: "저장", onclick: submit })
      ]
    });
  }

  function infoDialog(title, lines) {
    var d = UI.openModal({
      title: title, size: "sm",
      content: el("div", {}, lines.map(function (l) { return el("p", { class: "confirm__msg", text: l }); })),
      footer: [el("button", { class: "btn btn--primary", type: "button", text: "확인", onclick: function () { d.close(); } })]
    });
  }

  /* Image -> preview dialog, PDF -> new tab, anything else -> download. */
  function openAttachment(a) {
    try {
      var k = A.kind(a);
      if (k === "image") {
        var d = UI.openModal({
          title: a.name,
          content: el("div", { class: "rp-imgview" }, [el("img", { src: a.data, alt: a.name })]),
          footer: [
            el("button", { class: "btn btn--ghost", type: "button", text: "다운로드", onclick: function () { A.download(a); } }),
            el("button", { class: "btn btn--primary", type: "button", text: "닫기", onclick: function () { d.close(); } })
          ]
        });
      } else if (k === "pdf") {
        if (!A.openInNewTab(a)) UI.toast("팝업이 차단되어 PDF를 다운로드했어요.");
      } else {
        A.download(a);
      }
    } catch (e) {
      UI.toast("파일을 열지 못했어요.", "danger");
    }
  }

  /* -------------------------------- view ------------------------------ */
  function render(mount) {
    var today = U.dateKey();
    if (openNext && S.getReport(openNext) && !dirty) { loadWork(openNext); openNext = null; }
    openNext = null;
    if (!work) loadWork(today);
    else if (!dirty) {
      // the stored report may have changed while another menu was open
      // (e.g. backup restore) — pick it up unless there is unsaved typing
      var stored = S.getReport(work.reportDate);
      if ((stored ? stored.updatedAt : null) !== (work.updatedAt || null)) loadWork(work.reportDate);
    }

    mount.appendChild(el("header", { class: "view-head" }, [
      el("h1", { class: "view-head__title", text: "일일 업무보고" }),
      el("p", { class: "view-head__sub", text: "보고일에 완료한 업무를 자동으로 모아 간결하게 보고합니다." })
    ]));

    var formPanel = el("section", { class: "panel rp-form", "aria-label": "보고서 작성" });
    var previewPanel = el("section", { class: "panel rp-preview", "aria-label": "보고서 미리보기" });
    var listPanel = el("section", { class: "panel rp-list", "aria-label": "보고서 목록" });
    var noticeWrap = el("div", { class: "rp-notices-wrap" });
    var reviewPanel = el("section", { class: "panel rp-review", id: "rp-review", "aria-label": "상급자 확인 현황" });
    mount.appendChild(noticeWrap);
    mount.appendChild(reviewPanel);
    mount.appendChild(el("div", { class: "rp-grid" }, [formPanel, previewPanel]));
    mount.appendChild(listPanel);

    // refs filled by paintForm()
    var reporterEl, recipientField, recipientSelect, ccWrap, doneHead, doneBody,
      achField, achInput, otherInput, attachWrap, statusEl, actionsEl, saveInfoEl;
    var previewDoc = el("pre", { class: "rp-doc" });

    function markDirty() {
      dirty = true;
      paintSaveInfo();
      paintPreview();
    }

    /* ---------- form ---------- */
    function paintForm() {
      U.clear(formPanel);
      var locked = isLocked();

      // 보고일
      var dateInput = el("input", { type: "date", id: "rp-date", max: today });
      dateInput.value = work.reportDate;
      dateInput.addEventListener("change", function () {
        var v = dateInput.value;
        if (!U.isKey(v) || v > today) { dateInput.value = work.reportDate; return; }
        if (v === work.reportDate) return;
        switchDate(v, function () { dateInput.value = work.reportDate; });
      });

      var si = statusInfo(work);
      statusEl = el("span", { class: "chip " + si.chip, id: "rp-status", text: si.label });

      reporterEl = el("span", { class: "rp-reporter__name" });
      var reporterRow = el("div", { class: "rp-reporter" }, [
        reporterEl,
        locked ? null : el("button", {
          type: "button", class: "mini-btn rp-reporter__edit", "aria-label": "보고자 이름 변경",
          html: "&#9998;", onclick: editReporterName
        })
      ]);

      recipientSelect = el("select", { id: "rp-recipient" });
      recipientSelect.disabled = locked;
      recipientSelect.addEventListener("change", function () {
        var v = recipientSelect.value;
        if (v === "__current") return;
        if (v === "__new") {
          paintPeople();
          pickPerson("recipient", setRecipient);
          return;
        }
        var c = S.get().reportContacts.find(function (x) { return x.id === v; });
        setRecipient(c ? { contactId: c.id, name: c.name } : null);
      });
      recipientField = el("div", { class: "field" }, [
        el("label", { class: "field__label", for: "rp-recipient", html: '보고 대상 <span class="req">*</span>' }),
        recipientSelect,
        el("p", { class: "field__error", text: "보고 대상을 지정해 주세요." })
      ]);

      ccWrap = el("div", { class: "rp-chips", role: "list", "aria-label": "참조자" });

      formPanel.appendChild(el("div", { class: "rp-meta" }, [
        el("div", { class: "field" }, [
          el("label", { class: "field__label", for: "rp-date", text: "보고일" }),
          dateInput
        ]),
        el("div", { class: "field" }, [
          el("span", { class: "field__label", text: "보고자" }),
          reporterRow
        ]),
        recipientField,
        el("div", { class: "field" }, [
          el("span", { class: "field__label", text: "참조 (CC)" }),
          ccWrap
        ])
      ]));

      // ■ 금일 완료 업무
      doneHead = el("div");
      doneBody = el("div");
      formPanel.appendChild(el("div", { class: "rp-section" }, [doneHead, doneBody]));

      // ■ 주요 성과 및 특이사항
      achInput = el("textarea", {
        id: "rp-ach", maxlength: "4000", rows: "5",
        placeholder: "오늘 완료한 업무 중 주요 성과, 중요한 이슈 또는 상급자에게 전달할 내용을 작성하세요."
      });
      achInput.value = work.achievements;
      achInput.disabled = locked;
      achInput.addEventListener("input", function () {
        work.achievements = achInput.value;
        achField.classList.remove("has-error");
        markDirty();
      });
      achField = el("div", { class: "field rp-section" }, [
        el("label", { class: "rp-section__title", for: "rp-ach", text: "■ 주요 성과 및 특이사항" }),
        achInput,
        el("p", { class: "field__error", text: "완료된 업무가 없으면 주요 성과 및 특이사항을 작성해 주세요." })
      ]);
      formPanel.appendChild(achField);

      // ■ 기타 보고사항 (선택)
      otherInput = el("textarea", {
        id: "rp-other", maxlength: "4000", rows: "3", placeholder: "추가로 보고할 내용이 있으면 작성하세요. (선택)"
      });
      otherInput.value = work.otherNotes;
      otherInput.disabled = locked;
      otherInput.addEventListener("input", function () {
        work.otherNotes = otherInput.value;
        markDirty();
      });
      formPanel.appendChild(el("div", { class: "field rp-section" }, [
        el("label", { class: "rp-section__title", for: "rp-other", text: "■ 기타 보고사항 (선택)" }),
        otherInput
      ]));

      // ■ 첨부파일
      attachWrap = el("div", { class: "rp-section rp-attach" });
      formPanel.appendChild(attachWrap);

      // actions
      saveInfoEl = el("p", { class: "rp-saveinfo" });
      actionsEl = el("div", { class: "rp-actions" });
      if (work.status === "submitted") {
        // 상급자가 처리하기 전에는 기존처럼 회수해서 다시 작성할 수 있다
        actionsEl.appendChild(el("button", {
          type: "button", class: "btn btn--ghost", id: "rp-reopen", text: "✎ 다시 작성하기", onclick: reopen
        }));
      } else if (work.status === "rejected") {
        actionsEl.appendChild(el("button", {
          type: "button", class: "btn btn--primary", id: "rp-revise", text: "✎ 수정", onclick: revise
        }));
      } else if (!locked) {
        actionsEl.appendChild(el("button", {
          type: "button", class: "btn btn--ghost", id: "rp-save", text: "💾 임시저장", onclick: saveDraft
        }));
        actionsEl.appendChild(el("button", {
          type: "button", class: "btn btn--primary", id: "rp-send",
          text: isRevising(work) ? "📨 재제출" : "📨 보고서 전송", onclick: submit
        }));
      }
      formPanel.appendChild(el("div", { class: "rp-foot" }, [
        el("div", { class: "rp-foot__status" }, [statusEl, saveInfoEl]),
        actionsEl
      ]));
      var lockText = {
        submitted: "이 보고서는 전송 대기 상태로 저장되어 있습니다. 현재 버전에서는 실제 외부 전송은 지원하지 않습니다.",
        reviewed: "상급자가 검토 중인 보고서는 수정할 수 없습니다. 확인 또는 반려 결과를 기다려 주세요.",
        rejected: "반려된 보고서입니다. [수정]을 눌러 내용을 고친 뒤 재제출해 주세요.",
        confirmed: "확인 완료된 보고서는 수정할 수 없습니다. 내용과 첨부파일은 계속 볼 수 있습니다."
      }[work.status];
      if (lockText) {
        formPanel.appendChild(el("p", {
          class: "rp-notice" + (work.status === "confirmed" ? " rp-notice--lock" : ""), id: "rp-lock-notice", text: lockText
        }));
      }

      paintPeople();
      paintDone();
      paintAttach();
      paintSaveInfo();
    }

    function paintSaveInfo() {
      if (!saveInfoEl) return;
      var sub = statusInfo(work).sub;
      if (dirty) saveInfoEl.textContent = "저장되지 않은 변경사항이 있어요";
      else if (work.status !== "draft" && work.submittedAt) saveInfoEl.textContent = sub + " · 제출 " + U.relTimeKo(work.submittedAt);
      else if (isRevising(work)) saveInfoEl.textContent = sub + (work.updatedAt ? " · 저장 " + U.relTimeKo(work.updatedAt) : "");
      else if (work.updatedAt) saveInfoEl.textContent = "임시저장 " + U.relTimeKo(work.updatedAt);
      else saveInfoEl.textContent = "아직 저장하지 않았어요";
    }

    /* 보고자 / 보고 대상 / 참조 */
    function paintPeople() {
      var locked = isLocked();
      reporterEl.textContent = reporterOf().name;

      U.clear(recipientSelect);
      recipientSelect.appendChild(el("option", { value: "", text: "보고 대상 선택" }));
      var contacts = S.get().reportContacts.filter(function (c) {
        return !work.cc.some(function (p) { return samePerson(p, { contactId: c.id, name: c.name }); });
      });
      var selected = "";
      contacts.forEach(function (c) {
        if (work.recipient && samePerson(work.recipient, { contactId: c.id, name: c.name })) selected = c.id;
        recipientSelect.appendChild(el("option", { value: c.id, text: c.name }));
      });
      if (work.recipient && !selected) {
        // recipient no longer in the contact list (e.g. restored report) — still show it
        selected = "__current";
        recipientSelect.appendChild(el("option", { value: "__current", text: work.recipient.name }));
      }
      if (!locked) recipientSelect.appendChild(el("option", { value: "__new", text: "+ 새 보고 대상 추가…" }));
      recipientSelect.value = selected;

      U.clear(ccWrap);
      work.cc.forEach(function (p, i) {
        ccWrap.appendChild(el("span", { class: "rp-chip", role: "listitem" }, [
          el("span", { text: p.name }),
          locked ? null : el("button", {
            type: "button", class: "rp-chip__x", "aria-label": p.name + " 참조 삭제", html: "&times;",
            onclick: function () { work.cc.splice(i, 1); paintPeople(); markDirty(); }
          })
        ]));
      });
      if (!work.cc.length && locked) ccWrap.appendChild(el("span", { class: "rp-muted", text: "없음" }));
      if (!locked) {
        ccWrap.appendChild(el("button", {
          type: "button", class: "rp-chip rp-chip--add", id: "rp-cc-add", text: "+ 참조자 추가",
          onclick: function () {
            pickPerson("cc", function (p) {
              if (!work.cc.some(function (x) { return samePerson(x, p); }) && !samePerson(work.recipient, p)) {
                work.cc.push(p);
              }
              paintPeople();
              markDirty();
            });
          }
        }));
      }
    }

    function setRecipient(p) {
      work.recipient = p;
      if (p) {
        work.cc = work.cc.filter(function (x) { return !samePerson(x, p); });
        recipientField.classList.remove("has-error");
      }
      paintPeople();
      markDirty();
    }

    /* ■ 금일 완료 업무 */
    function paintDone() {
      var items = completedItems();
      U.clear(doneHead).appendChild(el("div", { class: "panel__head" }, [
        el("h2", { class: "rp-section__title" }, [
          "■ 금일 완료 업무",
          el("span", { class: "section-title__count", text: items.length + "건" })
        ]),
        isLocked() ? null : el("a", { class: "btn btn--ghost btn--sm", href: "#/tasks", text: "할 일 관리" })
      ]));
      U.clear(doneBody);
      if (!items.length) {
        doneBody.appendChild(el("p", { class: "rp-empty", text: "완료된 업무가 없습니다." }));
      } else {
        var ol = el("ol", { class: "rp-done" });
        items.forEach(function (t, i) {
          var meta = [];
          if (t.priority !== "normal") meta.push(shared().priorityChip(t.priority));
          var time = hhmm(t.completedAt);
          if (time) meta.push(el("span", { class: "task__time", text: "✓ " + time + " 완료" }));
          ol.appendChild(el("li", { class: "rp-done__item" }, [
            el("span", { class: "rp-done__num", text: (i + 1) + "." }),
            el("div", { class: "rp-done__main" }, [
              el("span", { class: "rp-done__title", text: t.title }),
              meta.length ? el("div", { class: "task__meta" }, meta) : null,
              t.note ? el("span", { class: "task__note", text: t.note }) : null
            ])
          ]));
        });
        doneBody.appendChild(ol);
      }
      if (!isLocked()) {
        doneBody.appendChild(el("p", {
          class: "rp-hint",
          text: "보고일에 완료 처리한 할 일만 자동으로 표시됩니다. 미완료·예정 업무는 포함되지 않습니다."
        }));
      }
    }

    /* ■ 첨부파일 */
    function paintAttach() {
      var locked = isLocked();
      var list = work.attachments;
      var fileInput = el("input", {
        type: "file", id: "rp-file", multiple: true, accept: A.ACCEPT, class: "rp-attach__input"
      });
      fileInput.addEventListener("change", function () {
        var files = Array.prototype.slice.call(fileInput.files || []);
        fileInput.value = "";
        addFiles(files);
      });
      U.clear(attachWrap).appendChild(el("div", { class: "panel__head" }, [
        el("h2", { class: "rp-section__title" }, [
          "■ 첨부파일",
          el("span", { class: "section-title__count", text: list.length + "/" + A.LIMITS.maxFiles }),
          list.length ? el("span", { class: "rp-attach__total", text: A.formatSize(A.totalBytes(list)) }) : null
        ]),
        locked ? null : el("label", { class: "btn btn--ghost btn--sm", for: "rp-file", id: "rp-file-btn", text: "📎 파일 선택" })
      ]));
      if (!locked) attachWrap.appendChild(fileInput);

      if (!list.length) {
        attachWrap.appendChild(el("p", { class: "rp-empty", text: "첨부된 파일이 없습니다." }));
      } else {
        var ul = el("ul", { class: "rp-files" });
        list.forEach(function (a) {
          var k = A.kind(a);
          ul.appendChild(el("li", { class: "rp-file" }, [
            el("button", {
              type: "button", class: "rp-file__name", title: a.name,
              onclick: function () { openAttachment(a); }
            }, [el("span", { "aria-hidden": "true", text: "📎 " }), el("span", { class: "rp-file__text", text: a.name })]),
            el("span", { class: "rp-file__size", text: A.formatSize(a.size) }),
            el("div", { class: "rp-file__acts" }, [
              el("button", {
                type: "button", class: "btn btn--ghost btn--sm rp-file__open",
                text: k === "file" ? "다운로드" : "보기",
                onclick: function () { openAttachment(a); }
              }),
              locked ? null : el("button", {
                type: "button", class: "btn btn--ghost btn--sm rp-file__del", text: "삭제",
                "aria-label": a.name + " 첨부 삭제",
                onclick: function () { removeAttachment(a.id); }
              })
            ])
          ]));
        });
        attachWrap.appendChild(ul);
      }
      if (!locked) {
        // 전체 보고서 첨부 사용량 + 남은 브라우저 저장 공간 (이 보고서의 미저장 파일 포함)
        var usage = S.attachmentUsage(work.reportDate);
        var allBytes = usage.otherBytes + A.totalBytes(list);
        var free = Math.min(A.freeBytes(list, usage), Math.max(0, A.LIMITS.maxTotalBytes - allBytes));
        attachWrap.appendChild(el("p", {
          class: "rp-attach__usage", id: "rp-attach-usage",
          text: "전체 보고서 첨부 " + A.formatSize(allBytes) + " / " + A.formatSize(A.LIMITS.maxTotalBytes) +
            " 사용 · 추가 가능 약 " + A.formatSize(free)
        }));
        attachWrap.appendChild(el("p", {
          class: "rp-hint",
          text: "PDF·Word·Excel·PowerPoint·TXT·CSV·PNG·JPG·ZIP / 파일당 최대 2MB, 보고서당 최대 5개, " +
            "모든 보고서 합계 2.5MB. 파일은 이 브라우저에만 저장됩니다."
        }));
      }
    }

    /* Validate each picked file against the running list; read the good ones. */
    function addFiles(files) {
      if (!files.length || isLocked()) return;
      var usage = S.attachmentUsage(work.reportDate);
      var pending = work.attachments.slice();
      var accepted = [];
      var errors = [];
      files.forEach(function (f) {
        var why = A.checkFile(f, pending, usage);
        if (why) { if (errors.indexOf(why) < 0) errors.push(why); return; }
        pending.push({ name: f.name, size: f.size });
        accepted.push(f);
      });
      errors.forEach(function (m) { UI.toast(m, "danger", 5000); });
      if (!accepted.length) return;
      var targetDate = work.reportDate;
      Promise.all(accepted.map(function (f) {
        return A.readFile(f).catch(function () { return null; });
      })).then(function (records) {
        if (work.reportDate !== targetDate || isLocked()) return; // switched report meanwhile
        var ok = records.filter(Boolean);
        if (ok.length < records.length) UI.toast(A.MSG.read, "danger");
        if (!ok.length) return;
        work.attachments = work.attachments.concat(ok);
        paintAttach();
        markDirty();
        UI.toast("파일 " + ok.length + "개를 첨부했어요. 임시저장하거나 전송하면 함께 저장됩니다.", "success");
      });
    }

    function removeAttachment(id) {
      work.attachments = work.attachments.filter(function (a) { return a.id !== id; });
      paintAttach();
      markDirty();
    }

    function saveFailed() {
      UI.toast(work.attachments.length ? A.MSG.quota : "보고서를 저장하지 못했어요.", "danger", 6000);
    }

    /* ---------- preview ---------- */
    function paintPreview() {
      previewDoc.textContent = previewText();
    }
    previewPanel.appendChild(el("div", { class: "panel__head" }, [
      el("h2", { class: "section-title", text: "👀 보고서 미리보기" }),
      el("button", {
        type: "button", class: "btn btn--ghost btn--sm", text: "📋 복사",
        onclick: function () {
          var txt = previewText();
          var ok = function () { UI.toast("보고서 내용을 복사했어요.", "success"); };
          var fail = function () { UI.toast("복사하지 못했어요. 미리보기 내용을 직접 선택해 주세요.", "danger"); };
          try {
            if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(ok, fail);
            else fail();
          } catch (e) { fail(); }
        }
      })
    ]));
    previewPanel.appendChild(previewDoc);

    /* ---------- list ---------- */
    function paintList() {
      U.clear(listPanel);
      var all = S.reports();
      listPanel.appendChild(shared().panelHeader("🗂️ 보고서 목록", String(all.length),
        work.reportDate !== today ? el("button", {
          type: "button", class: "btn btn--ghost btn--sm", text: "오늘 보고서",
          onclick: function () { switchDate(today); }
        }) : null));
      if (!all.length) {
        listPanel.appendChild(shared().emptyState("🗒️", "작성한 보고서가 없어요", "임시저장하거나 전송한 보고서가 여기에 표시됩니다."));
        return;
      }
      paintQueue(all);
      // 상급자 확인 상태 필터 (전체 / 미확인 / 확인완료 / 반려)
      var bar = el("div", { class: "filters filters--scroll rp-filters", role: "group", "aria-label": "보고서 확인 상태 필터" });
      FILTERS.forEach(function (f) {
        var n = all.filter(function (r) { return matchesFilter(r, f[0]); }).length;
        bar.appendChild(el("button", {
          type: "button", class: "filters__btn" + (listFilter === f[0] ? " is-active" : ""),
          "aria-pressed": listFilter === f[0] ? "true" : "false", "data-filter": f[0],
          text: f[1] + " " + n,
          onclick: function () { listFilter = f[0]; paintList(); }
        }));
      });
      listPanel.appendChild(bar);
      var shown = all.filter(function (r) { return matchesFilter(r, listFilter); });
      if (!shown.length) {
        listPanel.appendChild(el("p", { class: "rp-empty", text: "해당 상태의 보고서가 없습니다." }));
        return;
      }
      var ul = el("ul", { class: "rp-rows" });
      shown.forEach(function (r) {
        var isCur = r.reportDate === work.reportDate;
        var si = statusInfo(r);
        ul.appendChild(el("li", { class: "rp-row" + (isCur ? " is-current" : "") }, [
          el("button", {
            type: "button", class: "rp-row__main", "aria-current": isCur ? "true" : null,
            onclick: function () { if (!isCur) switchDate(r.reportDate); }
          }, [
            el("span", { class: "rp-row__date", text: r.reportDate }),
            el("span", { class: "rp-row__cell", text: r.recipient ? r.recipient.name : "보고 대상 미지정" }),
            el("span", { class: "rp-row__cell", text: "CC " + r.cc.length + "명" }),
            el("span", {
              class: "rp-row__cell rp-row__att",
              text: r.attachments.length ? "📎 " + r.attachments.length : "",
              "aria-label": r.attachments.length ? "첨부파일 " + r.attachments.length + "개" : null
            }),
            el("span", { class: "rp-row__state" }, [
              el("span", { class: "chip " + si.chip, text: si.label }),
              si.sub ? el("span", { class: "rp-row__sub" + (r.status === "submitted" || r.status === "reviewed" ? " is-pending" : ""), text: si.sub }) : null
            ])
          ]),
          el("button", {
            type: "button", class: "mini-btn mini-btn--danger", "aria-label": r.reportDate + " 보고서 삭제",
            html: "&#128465;", onclick: function () { removeReport(r); }
          })
        ]));
      });
      listPanel.appendChild(ul);
    }

    /* 상급자 확인 대기 현황: 확인 대기 / 확인완료 / 반려 건수 + 확인 대기 목록.
       Counts come from the same reports as the list (no separate data). */
    function paintQueue(all) {
      var pending = all.filter(function (r) { return matchesFilter(r, "pending"); });
      var nConfirmed = all.filter(function (r) { return matchesFilter(r, "confirmed"); }).length;
      var nRejected = all.filter(function (r) { return matchesFilter(r, "rejected"); }).length;
      if (!pending.length && !nConfirmed && !nRejected) return; // nothing submitted yet
      function stat(f, label, n, cls) {
        return el("button", {
          type: "button", class: "rp-queue__stat " + cls, "data-queue": f,
          "aria-label": label + " " + n + "건 보기",
          onclick: function () { listFilter = f; paintList(); }
        }, [el("span", { class: "rp-queue__num", text: String(n) }), el("span", { text: label })]);
      }
      var box = el("div", { class: "rp-queue", id: "rp-queue" }, [
        el("div", { class: "rp-queue__stats" }, [
          stat("pending", "확인 대기", pending.length, "is-pending"),
          stat("confirmed", "확인완료", nConfirmed, "is-ok"),
          stat("rejected", "반려", nRejected, "is-bad")
        ])
      ]);
      if (pending.length) {
        var ul = el("ul", { class: "rp-queue__list", "aria-label": "확인 대기 보고서" });
        pending.forEach(function (r) {
          ul.appendChild(el("li", {}, [el("button", {
            type: "button", class: "rp-queue__item",
            onclick: function () { if (r.reportDate !== work.reportDate) switchDate(r.reportDate); }
          }, [
            el("span", { class: "rp-row__date", text: r.reportDate }),
            el("span", { class: "rp-row__cell", text: "보고대상 " + (r.recipient ? r.recipient.name : "-") }),
            el("span", { class: "rp-row__sub is-pending", text: (r.status === "reviewed" ? "검토중 · " : "") + "제출 " + fmtDT(r.submittedAt) })
          ])]));
        });
        box.appendChild(ul);
      }
      box.appendChild(el("p", {
        class: "rp-hint",
        text: "LocalStorage 테스트 환경: 이 브라우저에 저장된 모든 보고서를 집계하며, 보고대상(상급자)별 접근 권한은 분리하지 않습니다. 실제 권한 분리는 서버 도입 단계에서 구현합니다."
      }));
      listPanel.appendChild(box);
    }

    /* ---------- actions ---------- */
    function switchDate(key, onCancel) {
      function go() { loadWork(key); paintAll(); }
      if (!dirty) { go(); return; }
      UI.confirm({
        title: "보고일 변경",
        message: "저장하지 않은 변경사항이 있어요. 저장하지 않고 이동할까요?",
        confirmText: "이동", cancelText: "취소"
      }).then(function (ok) {
        if (ok) go();
        else if (onCancel) onCancel();
      });
    }

    function saveDraft() {
      var saved = S.saveReport(payload("draft"), reporterNow());
      if (!saved) { saveFailed(); return; }
      work = saved;
      dirty = false;
      paintAll();
      UI.toast("보고서를 임시저장했어요.", "success");
    }

    function submit() {
      // 1) 필수 항목
      var items = completedItems();
      if (!U.isKey(work.reportDate) || work.reportDate > today) {
        UI.toast("보고일을 확인해 주세요.", "danger");
        return;
      }
      if (!items.length && !work.achievements.trim()) {
        achField.classList.add("has-error");
        achInput.focus();
        UI.toast("완료된 업무가 없으면 주요 성과 및 특이사항을 작성해 주세요.", "danger");
        return;
      }
      // 2) 보고 대상
      if (!work.recipient) {
        recipientField.classList.add("has-error");
        recipientSelect.focus();
        UI.toast("보고 대상을 지정해 주세요.", "danger");
        return;
      }
      // 3) 참조자 확인
      var ccText = work.cc.length
        ? work.cc.map(function (p) { return p.name; }).join(", ") + " (" + work.cc.length + "명)"
        : "없음";
      var resubmit = isRevising(work);
      UI.confirm({
        title: resubmit ? "보고서 재제출" : "보고서 전송",
        message: "보고 대상: " + work.recipient.name + " / 참조: " + ccText +
          " / 완료 업무 " + items.length + "건" +
          (work.attachments.length ? " / 첨부파일 " + work.attachments.length + "개" : "") +
          (resubmit ? ". 수정한 내용으로 재제출할까요?" : ". 이 내용으로 보고할까요?"),
        confirmText: resubmit ? "재제출하기" : "보고하기", cancelText: "취소"
      }).then(function (ok) {
        if (!ok) return;
        // 4) 저장 + 5) submitted (재제출이면 이전 반려 정보는 reviewHistory에만 남는다)
        var saved = S.saveReport(payload("submitted"), reporterNow());
        if (!saved) { saveFailed(); return; }
        work = saved;
        dirty = false;
        paintAll();
        // 6) 완료 메시지 — 실제 외부 전송은 하지 않는다
        infoDialog(resubmit ? "보고서 재제출 완료" : "보고서 저장 완료", [
          resubmit ? "수정한 일일 업무보고가 재제출되었습니다." : "일일 업무보고가 전송 대기 상태로 저장되었습니다.",
          "상급자가 확인하기 전까지 '상급자 미확인'으로 표시됩니다.",
          "현재 버전에서는 실제 외부 전송은 지원하지 않습니다."
        ]);
      });
    }

    /* 반려 -> 수정: rejected -> draft. The rejection stays on the report so the
       reporter can read it while editing; it is cleared on 재제출. */
    function revise() {
      UI.confirm({
        title: "보고서 수정",
        message: "반려된 보고서를 수정할까요? 수정 후 [재제출]해야 상급자에게 다시 보고됩니다. 완료 업무 목록은 현재 할 일 기준(보고일에 완료한 업무)으로 다시 집계됩니다.",
        confirmText: "수정하기", cancelText: "취소"
      }).then(function (ok) {
        if (!ok || work.status !== "rejected") return;
        var saved = S.saveReport(payload("draft"), reporterNow());
        if (!saved) { saveFailed(); return; }
        work = saved;
        dirty = false;
        paintAll();
        UI.toast("수정할 수 있어요. 내용을 고친 뒤 재제출해 주세요.", "success");
        try { achInput.focus(); } catch (e) { /* ignore */ }
      });
    }

    /* ---------- 상급자 처리 (LocalStorage 테스트용: 현재 로그인 사용자) ---------- */
    function afterReview(saved, msg) {
      if (!saved) { UI.toast("처리하지 못했어요. 보고서 상태를 확인해 주세요.", "danger"); return; }
      work = saved;
      dirty = false;
      paintAll();
      UI.toast(msg, "success", 4000);
      reviewPanel.classList.remove("is-flash");
      void reviewPanel.offsetWidth; // restart the highlight animation
      reviewPanel.classList.add("is-flash");
    }

    function startReview() {
      afterReview(S.reviewReport(work.reportDate, "review", reporterNow()), "검토중으로 표시했어요.");
    }

    function commentDialog(opts) {
      var input = el("textarea", { id: "rp-review-comment", maxlength: "1000", rows: "4", placeholder: opts.placeholder });
      var field = el("div", { class: "field" }, [
        el("label", { class: "field__label", for: "rp-review-comment", html: opts.label + (opts.required ? ' <span class="req">*</span>' : " (선택)") }),
        input,
        el("p", { class: "field__error", text: opts.required || "" })
      ]);
      input.addEventListener("input", function () { field.classList.remove("has-error"); });
      function ok() {
        var v = input.value.trim();
        if (opts.required && !v) {
          field.classList.add("has-error");
          UI.toast(opts.required, "danger");
          input.focus();
          return;
        }
        d.close();
        opts.onOk(v);
      }
      var d = UI.openModal({
        title: opts.title, size: "sm", initialFocus: "#rp-review-comment",
        content: el("div", {}, [el("p", { class: "confirm__msg", text: opts.message }), field]),
        footer: [
          el("button", { class: "btn btn--ghost", type: "button", text: "취소", onclick: function () { d.close(); } }),
          el("button", { class: "btn " + (opts.danger ? "btn--danger" : "btn--primary"), type: "button", id: "rp-review-ok", text: opts.okText, onclick: ok })
        ]
      });
    }

    function confirmReport() {
      commentDialog({
        title: "업무보고 확인",
        message: "이 업무보고를 확인 완료 처리하시겠습니까? 확인 완료 후에는 보고서를 수정할 수 없습니다.",
        label: "확인 의견", placeholder: "예: 업무 내용 확인했습니다.", okText: "확인 완료",
        onOk: function (comment) {
          afterReview(S.reviewReport(work.reportDate, "confirm", reporterNow(), comment), "확인 완료 처리했어요.");
        }
      });
    }

    function rejectReport() {
      commentDialog({
        title: "업무보고 반려",
        message: "반려하면 보고자가 내용을 수정한 뒤 재제출해야 합니다.",
        label: "■ 반려 사유", placeholder: "예: 업무성과 내용을 조금 더 구체적으로 작성해 주세요.",
        required: "반려 사유를 입력해 주세요.", okText: "반려 처리", danger: true,
        onOk: function (comment) {
          afterReview(S.reviewReport(work.reportDate, "reject", reporterNow(), comment), "반려 처리했어요.");
        }
      });
    }

    /* ■ 상급자 확인 현황 — what the reporter sees after submitting, plus the
       reviewer's 확인 / 반려 buttons (same report data for both). */
    function paintReview() {
      U.clear(reviewPanel);
      var rv = reviewOf(work);
      var show = work.status !== "draft" || rv.status === "rejected" || (work.reviewHistory || []).length;
      reviewPanel.hidden = !show;
      if (!show) return;
      var si = statusInfo(work);
      reviewPanel.className = reviewPanel.className.replace(/\brp-review--\w+/g, "").trim() + " rp-review--" + work.status;

      reviewPanel.appendChild(el("div", { class: "panel__head" }, [
        el("h2", { class: "section-title" }, ["■ 상급자 확인 현황"]),
        el("div", { class: "rp-review__badge" }, [
          el("span", { class: "chip " + si.chip, text: si.label }),
          si.sub ? el("span", { class: "rp-row__sub", text: si.sub }) : null
        ])
      ]));

      var rows = [
        ["보고일자", work.reportDate],
        ["보고자", reporterOf().name],
        ["보고대상", work.recipient ? work.recipient.name : "(미지정)"],
        ["참조", work.cc.length ? work.cc.map(function (p) { return p.name; }).join(", ") : "없음"]
      ];
      var resubs = resubmitCount(work);
      if (resubs || isRevising(work)) rows.push(["최초 제출일시", fmtDT(firstSubmittedAt(work))]);
      if (resubs && work.status !== "draft") rows.push(["재제출일시", fmtDT(work.submittedAt) + " (" + resubs + "회)"]);
      else if (!resubs && !isRevising(work)) rows.push(["제출일시", fmtDT(work.status === "draft" ? null : work.submittedAt)]);
      rows.push(
        ["확인 상태", isRevising(work) ? "반려 (수정중)" : REVIEW_LABEL[rv.status] || "-"]
      );
      var callout = null;
      if (rv.status === "confirmed") {
        rows.push(["확인자", who(work.confirmation.confirmedBy, work.confirmation.confirmedById)], ["확인일시", fmtDT(work.confirmation.confirmedAt)]);
        callout = el("div", { class: "rp-callout rp-callout--ok", id: "rp-confirm-comment" }, [
          el("strong", { text: "확인 의견" }), el("p", { text: work.confirmation.comment || "의견 없음" })
        ]);
      } else if (rv.status === "rejected") {
        rows.push(["반려자", who(rv.reviewer, rv.reviewerId)], ["반려일시", fmtDT(rv.reviewedAt)]);
        callout = el("div", { class: "rp-callout rp-callout--bad", id: "rp-reject-reason" }, [
          el("strong", { text: "반려 사유" }), el("p", { text: rv.comment || "-" })
        ]);
      } else if (rv.status === "reviewing") {
        rows.push(["검토자", who(rv.reviewer, rv.reviewerId)], ["검토 시작", fmtDT(rv.reviewedAt)]);
        callout = el("div", { class: "rp-callout" }, [el("strong", { text: "확인 의견" }), el("p", { text: "상급자가 검토 중입니다." })]);
      } else if (rv.status === "pending") {
        rows.push(["확인자", "-"], ["확인일시", "-"]);
        callout = el("div", { class: "rp-callout" }, [el("strong", { text: "확인 의견" }), el("p", { text: "아직 확인되지 않았습니다." })]);
      }
      var dl = el("dl", { class: "rp-kv" });
      rows.forEach(function (kv) {
        dl.appendChild(el("div", { class: "rp-kv__row" }, [el("dt", { text: kv[0] }), el("dd", { text: kv[1] })]));
      });
      reviewPanel.appendChild(dl);
      if (callout) reviewPanel.appendChild(callout);
      // 보고대상과 실제 처리자가 다르면 분명히 알린다 (LocalStorage: 권한 분리 없음)
      var actor = rv.status === "confirmed" ? work.confirmation.confirmedBy
        : rv.status === "rejected" || rv.status === "reviewing" ? rv.reviewer : "";
      if (actor && work.recipient && actor !== work.recipient.name) {
        reviewPanel.appendChild(el("p", {
          class: "rp-hint rp-actor-note",
          text: "보고대상(" + work.recipient.name + ")이 아닌 " + actor + " 계정으로 처리되었습니다. " +
            "현재는 서버 없는 LocalStorage 버전이라 상급자 권한을 검증하지 않고, 처리 당시 로그인 사용자를 기록합니다."
        }));
      }

      // 재제출 후: 이전 반려 사유는 참고용으로만 보여 준다 (현재 제출 건의 결과 아님)
      var prev = lastRejection(work);
      if (prev && rv.status !== "rejected") {
        reviewPanel.appendChild(el("p", {
          class: "rp-hint rp-prev-reject",
          text: "이전 반려 사유 (" + fmtDT(prev.timestamp) + ", " + who(prev.user, prev.userId) + "): " + prev.comment
        }));
      }

      // 처리 이력
      var hist = work.reviewHistory || [];
      if (hist.length) {
        var ol = el("ol", { class: "rp-history" });
        hist.forEach(function (h, i) { // 시간순 (오래된 것부터)
          ol.appendChild(el("li", { class: "rp-history__item is-" + h.action }, [
            el("span", { class: "rp-history__time", text: (i + 1) + ". " + fmtDT(h.timestamp) }),
            el("span", { class: "rp-history__act", text: HISTORY_LABEL[h.action] || h.action }),
            el("span", { class: "rp-history__user", text: h.user ? who(h.user, h.userId) : "" }),
            h.comment ? el("span", { class: "rp-history__comment", text: "“" + h.comment + "”" }) : null
          ]));
        });
        reviewPanel.appendChild(el("details", { class: "rp-history-wrap" }, [
          el("summary", { text: "처리 이력 " + hist.length + "건" }), ol
        ]));
      }

      // 상급자 처리 버튼 (제출완료 / 검토중일 때만)
      if (work.status === "submitted" || work.status === "reviewed") {
        var acts = el("div", { class: "rp-review__acts" }, [
          work.status === "submitted" ? el("button", {
            type: "button", class: "btn btn--ghost", id: "rp-review-start", text: "🔍 검토 시작", onclick: startReview
          }) : null,
          el("button", { type: "button", class: "btn btn--ghost rp-btn-reject", id: "rp-reject", text: "↩ 반려", onclick: rejectReport }),
          el("button", { type: "button", class: "btn btn--primary", id: "rp-confirm", text: "✓ 확인", onclick: confirmReport })
        ]);
        reviewPanel.appendChild(el("div", { class: "rp-review__box" }, [
          el("div", {}, [
            el("strong", { class: "rp-review__boxtitle", text: "상급자 처리" }),
            el("p", {
              class: "rp-hint",
              text: "서버 연동 전 테스트 기능입니다. 실제 상급자 권한 검증은 하지 않으며(서버 도입 단계에서 구현), 현재 로그인 사용자 " +
                who(reporterNow().name, reporterNow().userId) + "를 확인자로 기록합니다. 첨부파일은 아래 보고서의 ■ 첨부파일에서 열어볼 수 있습니다."
            })
          ]),
          acts
        ]));
      }
    }

    function paintNotices() {
      U.clear(noticeWrap);
      var b = noticeBanner();
      if (b) noticeWrap.appendChild(b);
    }

    function reopen() {
      UI.confirm({
        title: "다시 작성하기",
        message: "제출한 보고서를 회수해 임시저장 상태로 되돌릴까요? 완료 업무 목록은 현재 할 일 기준으로 다시 집계됩니다.",
        confirmText: "임시저장으로 변경", cancelText: "취소"
      }).then(function (ok) {
        if (!ok || work.status !== "submitted") return; // 상급자가 그 사이 처리했으면 회수 불가
        var snapshot = payload("draft"); // snapshot of the submitted content
        var saved = S.saveReport(snapshot, reporterNow());
        if (!saved) { saveFailed(); return; }
        work = saved;
        dirty = false;
        paintAll();
      });
    }

    function removeReport(r) {
      UI.confirm({
        title: "보고서 삭제",
        message: (r.status === "confirmed" ? "상급자 확인 완료된 보고서입니다. 삭제하면 확인 기록과 첨부파일도 함께 사라집니다. " : "") +
          r.reportDate + " 보고서를 삭제할까요? 할 일 데이터는 삭제되지 않습니다.",
        confirmText: "삭제", danger: true
      }).then(function (ok) {
        if (!ok) return;
        if (!S.removeReport(r.reportDate)) return;
        if (r.reportDate === work.reportDate) loadWork(work.reportDate);
        paintAll();
        UI.toast("보고서를 삭제했어요.");
      });
    }

    function paintAll() {
      paintNotices();
      paintReview();
      paintForm();
      paintPreview();
      paintList();
    }

    openFromView = function (key) { if (key !== work.reportDate) switchDate(key); };
    paintAll();

    // Data changed elsewhere (task toggled, contact added, backup restored…):
    // keep what the user is typing, refresh everything derived.
    return function onChange() {
      if (!dirty) {
        var stored = S.getReport(work.reportDate);
        var storedAt = stored ? stored.updatedAt : null;
        if (storedAt !== (work.updatedAt || null)) { loadWork(work.reportDate); paintAll(); return; }
      }
      paintNotices();
      paintReview();
      paintPeople();
      paintDone();
      paintSaveInfo();
      paintPreview();
      paintList();
    };
  }

  TP.reportView = {
    render: render,
    noticeBanner: noticeBanner,   // dashboard: unseen 확인/반려 results
    loginNotice: loginNotice      // app.js: one toast after sign-in
  };
})();
