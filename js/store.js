/* =========================================================================
   store.js — single source of truth
   - LocalStorage persistence with defensive parsing / normalization
   - CRUD for tasks / events / notes / settings
   - daily rollover (midnight or reopen) + 7-day history
   - derived selectors
   Emits a "tp:change" DOM event after every mutation (except silent note saves,
   which emit "tp:note").
   ========================================================================= */
(function () {
  "use strict";

  var U = TP.utils;
  var KEY = "today-planner:v1";
  var PRIORITIES = ["top", "high", "normal"];
  var RECURRENCES = ["none", "daily", "weekdays", "weekly", "monthly"];
  var BACKUP_APP = "Today Planner";
  var HISTORY_LIMIT = 90;
  // 일일 업무보고 (Phase 3-1). Phase 3-3 adds the 상급자 확인 / 반려 workflow:
  //   draft -> submitted -> reviewed(검토중) -> confirmed
  //   submitted|reviewed -> rejected -> draft(수정) -> submitted(재제출)
  var REPORT_STATUSES = ["draft", "submitted", "reviewed", "rejected", "confirmed"];
  // review.status of the *current* submission
  var REVIEW_STATUSES = ["none", "pending", "reviewing", "rejected", "confirmed"];
  // reviewHistory actions (kept across resubmissions; future server audit log)
  var REVIEW_ACTIONS = ["submitted", "resubmitted", "withdrawn", "reviewing", "rejected", "revising", "confirmed"];
  var DONE_ARCHIVE_LIMIT = 120; // days of completed-task snapshots kept for reports

  var hadStoredData = false;
  var state = null;

  /* ------------------------------- defaults ------------------------------ */
  function defaults() {
    return {
      version: 1,
      tasks: [],
      events: [],
      notes: "",
      noteSavedAt: null,
      history: {},                 // { "YYYY-MM-DD": { completed, total } }
      lastActiveDate: U.dateKey(),
      settings: { theme: "light" },
      // 일일 업무보고 (Phase 3-1)
      reports: [],                 // one report per reportDate
      reportContacts: [],          // people who can be picked as 보고 대상 / 참조
      reportProfile: { displayName: "" },
      doneArchive: {}              // { "YYYY-MM-DD": [completed task snapshot] }
    };
  }

  /* --------------------------- normalization --------------------------- */
  /* `fallbackDate` is used only to migrate pre-1.5 tasks that have no taskDate:
     an existing task with a saved nextOccurrence keeps that date, everything
     else inherits the day it was last active on (or today). New tasks always
     pass an explicit taskDate, so this fallback never affects them. */
  function normTask(raw, fallbackDate) {
    if (!raw || typeof raw !== "object") return null;
    var title = typeof raw.title === "string" ? raw.title.trim() : "";
    if (!title) return null;
    var done = !!raw.done;
    var taskDate = U.isKey(raw.taskDate) ? raw.taskDate
      : (U.isKey(raw.nextOccurrence) ? raw.nextOccurrence
        : (U.isKey(fallbackDate) ? fallbackDate : U.dateKey()));
    return {
      id: typeof raw.id === "string" && raw.id ? raw.id : U.uid(),
      title: title.slice(0, 200),
      priority: PRIORITIES.indexOf(raw.priority) >= 0 ? raw.priority : "normal",
      done: done,
      // taskDate = the day this task is actually meant to be done (added in 1.5).
      taskDate: taskDate,
      due: U.isHHMM(raw.due) ? raw.due : "",
      note: typeof raw.note === "string" ? raw.note.slice(0, 500) : "",
      // Recurrence (added in Phase 1). Older records simply lack these keys and
      // fall back to the safe defaults below.
      recurrence: RECURRENCES.indexOf(raw.recurrence) >= 0 ? raw.recurrence : "none",
      recurrenceId: typeof raw.recurrenceId === "string" ? raw.recurrenceId.slice(0, 40) : "",
      nextOccurrence: U.isKey(raw.nextOccurrence) ? raw.nextOccurrence : "",
      createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
      completedAt: done
        ? (typeof raw.completedAt === "string" ? raw.completedAt : new Date().toISOString())
        : null
    };
  }

  function normEvent(raw) {
    if (!raw || typeof raw !== "object") return null;
    var title = typeof raw.title === "string" ? raw.title.trim() : "";
    if (!title) return null;
    return {
      id: typeof raw.id === "string" && raw.id ? raw.id : U.uid(),
      title: title.slice(0, 200),
      date: U.isKey(raw.date) ? raw.date : U.dateKey(),
      start: U.isHHMM(raw.start) ? raw.start : "",
      end: U.isHHMM(raw.end) ? raw.end : "",
      place: typeof raw.place === "string" ? raw.place.slice(0, 200) : "",
      memo: typeof raw.memo === "string" ? raw.memo.slice(0, 1000) : ""
    };
  }

  function normHistory(raw) {
    var out = {};
    if (!raw || typeof raw !== "object") return out;
    Object.keys(raw).forEach(function (k) {
      if (!U.isKey(k)) return;
      var v = raw[k];
      if (!v || typeof v !== "object") return;
      var total = Math.max(0, parseInt(v.total, 10) || 0);
      var completed = U.clamp(parseInt(v.completed, 10) || 0, 0, total);
      out[k] = { completed: completed, total: total };
    });
    return out;
  }

  /* ---------------------- daily report (Phase 3-1) ---------------------- */
  function str(v, max) { return typeof v === "string" ? v.slice(0, max) : ""; }

  /* snapshot of a completed task as it appears in a report */
  function normDoneItem(raw) {
    if (!raw || typeof raw !== "object") return null;
    var title = str(raw.title, 200).trim();
    if (!title) return null;
    return {
      taskId: str(raw.taskId, 80),
      title: title,
      priority: PRIORITIES.indexOf(raw.priority) >= 0 ? raw.priority : "normal",
      completedAt: typeof raw.completedAt === "string" ? raw.completedAt : null,
      note: str(raw.note, 500)
    };
  }

  function normPerson(raw) {
    if (!raw || typeof raw !== "object") return null;
    var name = str(raw.name, 60).trim();
    if (!name) return null;
    return { contactId: str(raw.contactId, 80), name: name };
  }

  function normContact(raw) {
    if (!raw || typeof raw !== "object") return null;
    var name = str(raw.name, 60).trim();
    if (!name) return null;
    return { id: typeof raw.id === "string" && raw.id ? raw.id : U.uid(), name: name };
  }

  /* 첨부파일 (Phase 3-2). Only allowed types with an embedded Data URL are
     kept. Loading uses the original (looser) caps rather than TP.attach.LIMITS
     so files saved before the limits were tightened are never dropped; new
     files are checked against TP.attach.LIMITS when they are picked. */
  var ATTACH_LOAD_MAX_FILE = 5 * 1024 * 1024;
  var ATTACH_LOAD_MAX_REPORT = 10 * 1024 * 1024;
  // Estimated LocalStorage capacity in characters (Chrome measured ~5.2M).
  var STORAGE_BUDGET = 4900000;

  function normAttachment(raw) {
    var A = TP.attach;
    if (!raw || typeof raw !== "object") return null;
    var name = str(raw.name, 255).trim();
    var type = str(raw.type, 120);
    var data = typeof raw.data === "string" && raw.data.slice(0, 5) === "data:" ? raw.data : "";
    if (!name || !data || !A.isAllowed(name, type)) return null;
    var size = typeof raw.size === "number" && raw.size >= 0 ? Math.floor(raw.size)
      : Math.floor((data.length - data.indexOf(",") - 1) * 3 / 4);
    if (size > ATTACH_LOAD_MAX_FILE) return null;
    return {
      id: typeof raw.id === "string" && raw.id ? raw.id : U.uid(),
      name: name,
      size: size,
      type: type,
      data: data,
      addedAt: typeof raw.addedAt === "string" ? raw.addedAt : new Date().toISOString()
    };
  }

  function normAttachments(list) {
    var out = [];
    var total = 0;
    (Array.isArray(list) ? list : []).forEach(function (r) {
      var a = normAttachment(r);
      if (!a || out.length >= TP.attach.LIMITS.maxFiles) return;
      if (total + a.size > ATTACH_LOAD_MAX_REPORT) return;
      total += a.size;
      out.push(a);
    });
    return out;
  }

  /* 상급자 확인 / 반려 (Phase 3-3). Reports saved before this phase have no
     review / confirmation / reviewHistory: they are derived from `status` so
     an old "submitted" report shows as 상급자 미확인 and an old draft as none. */
  function isoOrNull(v) { return typeof v === "string" && v ? v : null; }

  function normReview(raw, status) {
    var fallback = status === "draft" ? "none"
      : status === "submitted" ? "pending"
        : status === "reviewed" ? "reviewing" : status; // rejected / confirmed
    var r = raw && typeof raw === "object" ? raw : {};
    var st = REVIEW_STATUSES.indexOf(r.status) >= 0 ? r.status : fallback;
    // the review must agree with the report status (a draft may still carry
    // the previous rejection so the reporter can read it while revising)
    if (status === "submitted") st = "pending";
    else if (status === "reviewed") st = "reviewing";
    else if (status === "rejected" || status === "confirmed") st = status;
    else if (st !== "rejected") st = "none";
    return {
      status: st,
      reviewer: str(r.reviewer, 60),
      reviewerId: str(r.reviewerId, 60),
      reviewedAt: st === "pending" || st === "none" ? null : isoOrNull(r.reviewedAt),
      comment: st === "pending" || st === "none" ? "" : str(r.comment, 1000)
    };
  }

  function normConfirmation(raw, status) {
    var c = raw && typeof raw === "object" ? raw : {};
    if (status !== "confirmed") return { confirmedBy: "", confirmedById: "", confirmedAt: null, comment: "" };
    return {
      confirmedBy: str(c.confirmedBy, 60),
      confirmedById: str(c.confirmedById, 60),
      confirmedAt: isoOrNull(c.confirmedAt),
      comment: str(c.comment, 1000)
    };
  }

  function normReviewHistory(list) {
    // kept in time order (oldest first); a restored file with shuffled entries
    // is re-sorted (stable, so same-time entries keep their order)
    return (Array.isArray(list) ? list : []).filter(function (h) {
      return h && REVIEW_ACTIONS.indexOf(h.action) >= 0 && typeof h.timestamp === "string";
    }).sort(function (a, b) {
      return a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0;
    }).slice(-100).map(function (h) {
      return {
        action: h.action, user: str(h.user, 60), userId: str(h.userId, 60),
        comment: str(h.comment, 1000), timestamp: h.timestamp
      };
    });
  }

  function normReport(raw) {
    if (!raw || typeof raw !== "object" || !U.isKey(raw.reportDate)) return null;
    var now = new Date().toISOString();
    var status = REPORT_STATUSES.indexOf(raw.status) >= 0 ? raw.status : "draft";
    return {
      id: typeof raw.id === "string" && raw.id ? raw.id : U.uid(),
      reportDate: raw.reportDate,
      status: status,
      reporter: {
        userId: str(raw.reporter && raw.reporter.userId, 60),
        name: str(raw.reporter && raw.reporter.name, 60)
      },
      // 보고 대상(1명)과 참조자(CC, 0..n)는 별도 필드로 보관한다.
      recipient: normPerson(raw.recipient),
      cc: Array.isArray(raw.cc) ? raw.cc.map(normPerson).filter(Boolean) : [],
      completedTasks: Array.isArray(raw.completedTasks)
        ? raw.completedTasks.map(normDoneItem).filter(Boolean) : [],
      achievements: str(raw.achievements, 4000),
      otherNotes: str(raw.otherNotes, 4000),
      // reports saved before Phase 3-2 have no attachments -> []
      attachments: normAttachments(raw.attachments),
      createdAt: typeof raw.createdAt === "string" ? raw.createdAt : now,
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : now,
      submittedAt: typeof raw.submittedAt === "string" ? raw.submittedAt : null,
      statusHistory: Array.isArray(raw.statusHistory)
        ? raw.statusHistory.filter(function (h) {
            return h && REPORT_STATUSES.indexOf(h.status) >= 0 && typeof h.at === "string";
          }).map(function (h) { return { status: h.status, at: h.at }; })
        : [],
      // Phase 3-3 상급자 확인 / 반려
      review: normReview(raw.review, status),
      confirmation: normConfirmation(raw.confirmation, status),
      reviewHistory: normReviewHistory(raw.reviewHistory),
      // when the reporter last acknowledged the review result (in-app notice)
      reviewSeenAt: isoOrNull(raw.reviewSeenAt)
    };
  }

  function normReports(list) {
    var byDate = {};
    (Array.isArray(list) ? list : []).forEach(function (r) {
      var n = normReport(r);
      if (n) byDate[n.reportDate] = n; // one report per date; last one wins
    });
    return Object.keys(byDate).map(function (k) { return byDate[k]; });
  }

  function normDoneArchive(raw) {
    var out = {};
    if (!raw || typeof raw !== "object") return out;
    Object.keys(raw).forEach(function (k) {
      if (!U.isKey(k) || !Array.isArray(raw[k])) return;
      var items = raw[k].map(normDoneItem).filter(Boolean);
      if (items.length) out[k] = items;
    });
    return out;
  }

  function coerce(data) {
    var d = defaults();
    if (!data || typeof data !== "object") return d;
    // Resolve the migration fallback date first so pre-1.5 tasks without a
    // taskDate inherit the day the planner was last active on.
    var fallbackDate = U.isKey(data.lastActiveDate) ? data.lastActiveDate : U.dateKey();
    d.tasks = Array.isArray(data.tasks)
      ? data.tasks.map(function (r) { return normTask(r, fallbackDate); }).filter(Boolean)
      : [];
    d.events = Array.isArray(data.events) ? data.events.map(normEvent).filter(Boolean) : [];
    d.notes = typeof data.notes === "string" ? data.notes.slice(0, 8000) : "";
    d.noteSavedAt = typeof data.noteSavedAt === "string" ? data.noteSavedAt : null;
    d.history = normHistory(data.history);
    d.lastActiveDate = fallbackDate;
    d.settings = {
      theme: (data.settings && data.settings.theme === "dark") ? "dark" : "light"
    };
    d.reports = normReports(data.reports);
    d.reportContacts = Array.isArray(data.reportContacts)
      ? data.reportContacts.map(normContact).filter(Boolean) : [];
    d.reportProfile = {
      displayName: str(data.reportProfile && data.reportProfile.displayName, 60).trim()
    };
    d.doneArchive = normDoneArchive(data.doneArchive);
    return d;
  }

  /* ---------------------------- persistence --------------------------- */
  function load() {
    var raw = null;
    try { raw = localStorage.getItem(KEY); } catch (e) { raw = null; }
    hadStoredData = !!raw;
    if (!raw) { state = defaults(); return state; }
    try {
      state = coerce(JSON.parse(raw));
    } catch (e) {
      console.warn("[Today Planner] 저장 데이터를 해석하지 못해 초기화합니다.", e);
      state = defaults();
    }
    return state;
  }

  /* `quiet` skips the generic toast so the caller can roll back and show a
     more specific message (used by report save / backup restore). */
  function persist(quiet) {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
      return true;
    } catch (e) {
      console.error("[Today Planner] 저장 실패", e);
      if (!quiet && TP.ui && TP.ui.toast) {
        TP.ui.toast("저장 공간이 부족해 변경사항을 저장하지 못했어요. 보고서 첨부파일을 삭제해 공간을 확보해 주세요.", "danger", 6000);
      }
      return false;
    }
  }

  function get() { return state || load(); }

  /* Returns false when LocalStorage refused the change. The in-memory state
     is then reloaded from what is actually stored, so the screen never shows
     a change that would vanish on the next reload. */
  function commit(mutator, eventName) {
    mutator(state);
    var ok = persist();
    if (!ok) state = storedState();
    document.dispatchEvent(new CustomEvent(ok ? (eventName || "tp:change") : "tp:change"));
    return ok;
  }

  function storedState() {
    try {
      var raw = localStorage.getItem(KEY);
      return raw ? coerce(JSON.parse(raw)) : defaults();
    } catch (e) {
      return state;
    }
  }

  /* ------------------------------ rollover --------------------------- */
  /* Called on startup and every clock tick. When the calendar day has moved
     past lastActiveDate we archive the ended day's numbers (its own tasks
     only), drop finished tasks whose work date has already passed, pull
     still-open past-due tasks onto today, and stamp the new day.
     Future-dated tasks (recurrence occurrences, or anything manually dated
     ahead) are left untouched — done or not — so they surface intact on
     their own day instead of being swept away by today's cleanup. */
  function rolloverIfNeeded() {
    var today = U.dateKey();
    if (state.lastActiveDate === today) return false;

    var prev = state.lastActiveDate;
    var dayTasks = state.tasks.filter(function (t) { return t.taskDate === prev; });
    if (dayTasks.length > 0) {
      state.history[prev] = {
        completed: dayTasks.filter(function (t) { return t.done; }).length,
        total: dayTasks.length
      };
    }

    // Before finished past-dated tasks are dropped, keep a read-only snapshot
    // of them so the 일일 업무보고 for those days can still list them. The
    // tasks themselves are handled exactly as before.
    state.tasks.forEach(function (t) {
      if (t.done && U.isKey(t.taskDate) && t.taskDate < today) archiveDone(t);
    });
    pruneDoneArchive();

    state.tasks = state.tasks.filter(function (t) {
      if (!t.done) return true;
      // keep completed tasks dated today-or-later; drop completed past-dated ones
      return U.isKey(t.taskDate) && t.taskDate >= today;
    });
    state.tasks.forEach(function (t) {
      if (U.isKey(t.taskDate) && t.taskDate < today) t.taskDate = today;
    });
    state.lastActiveDate = today;
    pruneHistory();
    persist();
    document.dispatchEvent(new CustomEvent("tp:change"));
    return true;
  }

  function doneSnapshot(t) {
    return normDoneItem({
      taskId: t.id, title: t.title, priority: t.priority,
      completedAt: t.completedAt, note: t.note
    });
  }

  function archiveDone(t) {
    var list = state.doneArchive[t.taskDate] || (state.doneArchive[t.taskDate] = []);
    if (list.some(function (x) { return x.taskId === t.id; })) return;
    var snap = doneSnapshot(t);
    if (snap) list.push(snap);
  }

  function pruneDoneArchive() {
    var keys = Object.keys(state.doneArchive).sort();
    while (keys.length > DONE_ARCHIVE_LIMIT) delete state.doneArchive[keys.shift()];
  }

  function pruneHistory() {
    var keys = Object.keys(state.history).sort();
    while (keys.length > HISTORY_LIMIT) delete state.history[keys.shift()];
  }

  /* -------------------------------- tasks --------------------------- */
  function addTask(data) {
    var t = normTask({
      title: data.title,
      priority: data.priority,
      taskDate: U.isKey(data.taskDate) ? data.taskDate : U.dateKey(),
      due: data.due,
      note: data.note,
      recurrence: data.recurrence,
      recurrenceId: data.recurrenceId
    });
    if (!t) return null;
    if (t.recurrence !== "none" && !t.recurrenceId) t.recurrenceId = U.uid();
    return commit(function (s) { s.tasks.unshift(t); }) ? t : null;
  }

  function updateTask(id, patch) {
    return commit(function (s) {
      var t = s.tasks.find(function (x) { return x.id === id; });
      if (!t) return;
      if (patch.title != null) t.title = String(patch.title).trim().slice(0, 200) || t.title;
      if (patch.priority && PRIORITIES.indexOf(patch.priority) >= 0) t.priority = patch.priority;
      // taskDate (Phase 1.5) — only overwritten with a valid YYYY-MM-DD key, so
      // an edit that omits it (or sends a blank) leaves the stored date intact.
      if (U.isKey(patch.taskDate)) t.taskDate = patch.taskDate;
      if (patch.due != null) t.due = U.isHHMM(patch.due) ? patch.due : "";
      if (patch.note != null) t.note = String(patch.note).slice(0, 500);
      if (patch.recurrence != null) {
        t.recurrence = RECURRENCES.indexOf(patch.recurrence) >= 0 ? patch.recurrence : "none";
        if (t.recurrence !== "none" && !t.recurrenceId) t.recurrenceId = U.uid();
      }
      if (patch.done != null) {
        var wasDone = t.done;
        t.done = !!patch.done;
        t.completedAt = t.done ? new Date().toISOString() : null;
        if (t.done && !wasDone && t.recurrence && t.recurrence !== "none") {
          spawnNextOccurrence(s, t);
        }
      }
    });
  }

  /* When a repeating task is completed, drop in the next occurrence. The next
     date is computed from the completed task's own taskDate (not "now"), and we
     skip creation if any task in the same recurrence chain already carries that
     date. That makes generation idempotent: refreshing or re-checking never
     piles up duplicates. */
  function spawnNextOccurrence(s, parent) {
    if (!parent.recurrenceId) parent.recurrenceId = U.uid();
    var base = U.isKey(parent.taskDate) ? U.parseKey(parent.taskDate) : new Date();
    var nextKey = U.nextRecurrenceDate(parent.recurrence, base);
    if (!U.isKey(nextKey)) return;

    var exists = s.tasks.some(function (x) {
      return x.recurrenceId === parent.recurrenceId && x.taskDate === nextKey;
    });
    if (exists) return;

    parent.nextOccurrence = nextKey;
    var child = normTask({
      title: parent.title,
      priority: parent.priority,
      taskDate: nextKey,
      due: parent.due,
      note: parent.note,
      recurrence: parent.recurrence,
      recurrenceId: parent.recurrenceId,
      nextOccurrence: nextKey
    });
    if (child) s.tasks.unshift(child);
  }

  function toggleTask(id) {
    var t = state.tasks.find(function (x) { return x.id === id; });
    return t ? updateTask(id, { done: !t.done }) : false;
  }

  function removeTask(id) {
    return commit(function (s) {
      s.tasks = s.tasks.filter(function (x) { return x.id !== id; });
    });
  }

  /* ------------------------------- events -------------------------- */
  function addEvent(data) {
    var e = normEvent(data);
    if (!e) return null;
    return commit(function (s) { s.events.push(e); }) ? e : null;
  }

  function updateEvent(id, patch) {
    return commit(function (s) {
      var e = s.events.find(function (x) { return x.id === id; });
      if (!e) return;
      var merged = normEvent(Object.assign({}, e, patch));
      if (merged) Object.assign(e, merged, { id: e.id });
    });
  }

  function removeEvent(id) {
    return commit(function (s) {
      s.events = s.events.filter(function (x) { return x.id !== id; });
    });
  }

  /* -------------------------------- notes ------------------------- */
  function setNotes(text) {
    state.notes = String(text == null ? "" : text).slice(0, 8000);
    state.noteSavedAt = new Date().toISOString();
    persist();
    document.dispatchEvent(new CustomEvent("tp:note"));
  }

  /* ------------------------------ settings ----------------------- */
  function setTheme(theme) {
    return commit(function (s) { s.settings.theme = theme === "dark" ? "dark" : "light"; });
  }

  function resetAll() {
    state = defaults();
    persist();
    document.dispatchEvent(new CustomEvent("tp:change"));
  }

  function exportJSON() {
    return JSON.stringify({
      app: BACKUP_APP,
      version: 1,
      exportedAt: new Date().toISOString(),
      data: state
    }, null, 2);
  }

  /* Accepts the wrapped backup { app, version, exportedAt, data } and, for
     backward compatibility, a bare state object from older exports. Throws
     Error("BAD_BACKUP") when the file is clearly not a Today Planner backup. */
  function readBackup(parsed) {
    if (!parsed || typeof parsed !== "object") throw new Error("BAD_BACKUP");
    if (parsed.app === BACKUP_APP && parsed.data && typeof parsed.data === "object") {
      return parsed.data;
    }
    var looksLikePlanner =
      Array.isArray(parsed.tasks) || Array.isArray(parsed.events) ||
      typeof parsed.notes === "string" ||
      (parsed.settings && typeof parsed.settings === "object" && "theme" in parsed.settings);
    if (looksLikePlanner) return parsed;
    throw new Error("BAD_BACKUP");
  }

  function importJSON(text) {
    var parsed = JSON.parse(text);      // SyntaxError on bad JSON — caller handles
    var payload = readBackup(parsed);   // Error("BAD_BACKUP")    — caller handles
    var prev = state;
    state = coerce(payload);
    // Backups made before Phase 3-1 have no report data. Restoring one keeps
    // the reports already in this browser instead of wiping them.
    if (prev) {
      if (!Array.isArray(payload.reports)) state.reports = prev.reports || [];
      if (!Array.isArray(payload.reportContacts)) state.reportContacts = prev.reportContacts || [];
      if (!payload.reportProfile) state.reportProfile = prev.reportProfile || { displayName: "" };
      if (!payload.doneArchive) state.doneArchive = prev.doneArchive || {};
    }
    // Same treatment a midnight rollover would give: still-open tasks dated
    // before today are pulled onto today; done and future-dated tasks are left
    // exactly as backed up.
    var today = U.dateKey();
    state.tasks.forEach(function (t) {
      if (!t.done && U.isKey(t.taskDate) && t.taskDate < today) t.taskDate = today;
    });
    state.lastActiveDate = today;
    // A backup with large attachments may not fit: keep the current data.
    if (!persist(true)) {
      state = prev;
      throw new Error("QUOTA");
    }
    document.dispatchEvent(new CustomEvent("tp:change"));
  }

  function storageBytes() {
    try { return new Blob([localStorage.getItem(KEY) || ""]).size; }
    catch (e) { return (localStorage.getItem(KEY) || "").length; }
  }

  /* ------------------------ daily report API ------------------------ */
  /* Completed work for a report date: taskDate === key AND done === true.
     Live tasks first; for past days, finished tasks already cleared by the
     rollover are taken from doneArchive. Sorted by completion time. Read-only:
     tasks are never modified here. */
  function completedTasksFor(key) {
    if (!U.isKey(key)) return [];
    var out = [];
    var seen = {};
    state.tasks.forEach(function (t) {
      if (t.taskDate === key && t.done === true) {
        var snap = doneSnapshot(t);
        if (snap) { out.push(snap); seen[t.id] = true; }
      }
    });
    (state.doneArchive[key] || []).forEach(function (x) {
      if (x.taskId && seen[x.taskId]) return;
      // a task that still exists but is no longer done must not be reported
      if (x.taskId && state.tasks.some(function (t) { return t.id === x.taskId; })) return;
      out.push(Object.assign({}, x));
    });
    out.sort(function (a, b) {
      var ta = a.completedAt || "", tb = b.completedAt || "";
      return ta < tb ? -1 : ta > tb ? 1 : 0;
    });
    return out;
  }

  function reports() {
    return state.reports.slice().sort(function (a, b) {
      return a.reportDate < b.reportDate ? 1 : a.reportDate > b.reportDate ? -1 : 0;
    });
  }

  function getReport(key) {
    var r = state.reports.find(function (x) { return x.reportDate === key; });
    return r ? JSON.parse(JSON.stringify(r)) : null;
  }

  /* Upsert by reportDate. `status` is set by the caller ("draft" for 임시저장,
     "submitted" for 보고서 전송); a status change is appended to statusHistory. */
  /* Which status the reporter side may move a stored report to with
     saveReport(). Reviewer actions (검토/확인/반려) go through reviewReport(). */
  var REPORTER_MOVES = {
    none: ["draft", "submitted"],
    draft: ["draft", "submitted"],
    submitted: ["draft"],          // 다시 작성하기 (제출 회수, 상급자 처리 전만)
    rejected: ["draft"],           // 반려 -> 수정
    reviewed: [],                  // 검토중에는 보고자가 바꿀 수 없음
    confirmed: []                  // 확인 완료된 보고서는 수정할 수 없음
  };

  function lastIndexOfAction(list, action) {
    for (var i = list.length - 1; i >= 0; i--) if (list[i].action === action) return i;
    return -1;
  }

  /* Puts `merged` in place of the stored report with the same date and
     persists. On a LocalStorage failure the previous array is restored, so
     memory and storage stay exactly as they were (attachments included). */
  function replaceReport(merged) {
    var prevReports = state.reports;
    state.reports = prevReports.filter(function (x) { return x.reportDate !== merged.reportDate; });
    state.reports.push(merged);
    if (!persist(true)) {
      state.reports = prevReports;
      return null;
    }
    document.dispatchEvent(new CustomEvent("tp:change"));
    return getReport(merged.reportDate);
  }

  /* Upsert by reportDate. `status` is set by the caller ("draft" for 임시저장 /
     수정, "submitted" for 보고서 전송 / 재제출); a status change is appended to
     statusHistory and, for workflow steps, to reviewHistory. `actor` is the
     signed-in user ({ userId, name }) recorded in reviewHistory. */
  function saveReport(data, actor) {
    var now = new Date().toISOString();
    var existing = state.reports.find(function (x) { return x.reportDate === data.reportDate; });
    var prevStatus = existing ? existing.status : null;
    if ((REPORTER_MOVES[prevStatus || "none"] || []).indexOf(data.status) < 0) return null;
    var merged = normReport(Object.assign({}, existing || {}, data, {
      id: existing ? existing.id : U.uid(),
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now
    }));
    if (!merged) return null;
    var who = actor || data.reporter || {};
    function log(action) {
      merged.reviewHistory.push({ action: action, user: str(who.name, 60), userId: str(who.userId, 60), comment: "", timestamp: now });
    }
    if (merged.status !== prevStatus) {
      merged.statusHistory.push({ status: merged.status, at: now });
      if (merged.status === "submitted") {
        merged.submittedAt = now;
        // A new submission starts unreviewed. The previous rejection stays in
        // reviewHistory only, so it can never be shown as this one's result.
        merged.review = { status: "pending", reviewer: "", reviewerId: "", reviewedAt: null, comment: "" };
        merged.confirmation = normConfirmation(null, "submitted");
        merged.reviewSeenAt = null;
        log(lastIndexOfAction(merged.reviewHistory, "rejected") >= 0 ? "resubmitted" : "submitted");
      } else if (merged.status === "draft" && prevStatus === "rejected") {
        log("revising");
      } else if (merged.status === "draft" && prevStatus === "submitted") {
        log("withdrawn");
      }
    }
    return replaceReport(merged);
  }

  /* 상급자 처리 (Phase 3-3): action = "review" (검토 시작) | "confirm" | "reject".
     LocalStorage-only: `reviewer` is simply the signed-in user — this is NOT a
     permission check; a future server must verify the reviewer's rights.
     Returns the updated report, or null when the move is not allowed or the
     save failed (nothing is changed then). Attachments are never touched. */
  function reviewReport(key, action, reviewer, comment) {
    var existing = state.reports.find(function (x) { return x.reportDate === key; });
    if (!existing) return null;
    var from = existing.status;
    var to = action === "review" ? "reviewed" : action === "confirm" ? "confirmed" : action === "reject" ? "rejected" : null;
    if (!to) return null;
    if (to === "reviewed" && from !== "submitted") return null;
    if (to !== "reviewed" && from !== "submitted" && from !== "reviewed") return null;
    var text = str(comment == null ? "" : String(comment).trim(), 1000);
    if (to === "rejected" && !text) return null; // 반려 사유 필수
    var now = new Date().toISOString();
    var who = { name: str(reviewer && reviewer.name, 60), userId: str(reviewer && reviewer.userId, 60) };
    var merged = JSON.parse(JSON.stringify(existing));
    merged.status = to;
    merged.updatedAt = now;
    merged.statusHistory.push({ status: to, at: now });
    merged.review = {
      status: to === "reviewed" ? "reviewing" : to,
      reviewer: who.name, reviewerId: who.userId, reviewedAt: now,
      comment: to === "reviewed" ? "" : text
    };
    merged.confirmation = to === "confirmed"
      ? { confirmedBy: who.name, confirmedById: who.userId, confirmedAt: now, comment: text }
      : normConfirmation(null, to);
    merged.reviewHistory.push({
      action: to === "reviewed" ? "reviewing" : to,
      user: who.name, userId: who.userId, comment: to === "reviewed" ? "" : text, timestamp: now
    });
    merged = normReport(merged);
    return merged ? replaceReport(merged) : null;
  }

  /* The reporter acknowledged the current review result (in-app notice). */
  function markReviewSeen(key) {
    var r = state.reports.find(function (x) { return x.reportDate === key; });
    if (!r || !r.review.reviewedAt) return false;
    return commit(function () { r.reviewSeenAt = new Date().toISOString(); });
  }

  /* Reports whose 확인/반려 result the reporter has not acknowledged yet.
     Same report data the reviewer wrote — no separate copy is kept. */
  function unseenReviewResults(userId) {
    return reports().filter(function (r) {
      if (r.review.status !== "confirmed" && r.review.status !== "rejected") return false;
      if (r.status !== r.review.status) return false; // e.g. already revising
      if (userId && r.reporter.userId && r.reporter.userId !== userId) return false;
      return !r.reviewSeenAt || (r.review.reviewedAt && r.reviewSeenAt < r.review.reviewedAt);
    });
  }

  function removeReport(key) {
    return commit(function (s) {
      s.reports = s.reports.filter(function (x) { return x.reportDate !== key; });
    });
  }

  /* Attachment room for the report of `key`, excluding its own attachments:
     otherBytes = raw size of every other report's files (app-wide limit),
     freeChars  = estimated LocalStorage characters left for this report's files. */
  function attachmentUsage(key) {
    var otherBytes = 0;
    var ownChars = 0;
    state.reports.forEach(function (r) {
      (r.attachments || []).forEach(function (a) {
        if (r.reportDate === key) ownChars += TP.attach.storedChars(a);
        else otherBytes += a.size || 0;
      });
    });
    // every key on this site shares the quota (login flags etc. as well)
    var stored = 0;
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        stored += k.length + (localStorage.getItem(k) || "").length;
      }
    } catch (e) { stored = 0; }
    return { otherBytes: otherBytes, freeChars: Math.max(0, STORAGE_BUDGET - (stored - ownChars)) };
  }

  /* Returns the existing contact with the same name, or a newly added one. */
  function addContact(name) {
    var n = String(name == null ? "" : name).trim().slice(0, 60);
    if (!n) return null;
    var found = state.reportContacts.find(function (c) { return c.name === n; });
    if (found) return Object.assign({}, found);
    var c = normContact({ name: n });
    if (!commit(function (s) { s.reportContacts.push(c); })) return null;
    return Object.assign({}, c);
  }

  function setReporterName(name) {
    return commit(function (s) {
      s.reportProfile.displayName = String(name == null ? "" : name).trim().slice(0, 60);
    });
  }

  /* ---------------------------- selectors ----------------------- */
  function tasksSorted() {
    var order = { top: 0, high: 1, normal: 2 };
    // Deadline pressure outranks priority so overdue / imminent work floats up,
    // then the original priority + due-time ordering applies unchanged.
    var urgency = { overdue: 0, soon: 1, today: 2, none: 3, scheduled: 4 };
    var now = new Date();
    return state.tasks.slice().sort(function (a, b) {
      if (a.done !== b.done) return a.done ? 1 : -1;
      var ua = urgency[U.taskDueStatus(a, now)];
      var ub = urgency[U.taskDueStatus(b, now)];
      if (ua !== ub) return ua - ub;
      if (order[a.priority] !== order[b.priority]) return order[a.priority] - order[b.priority];
      var am = U.toMinutes(a.due), bm = U.toMinutes(b.due);
      if (am != null && bm != null && am !== bm) return am - bm;
      if (am != null && bm == null) return -1;
      if (am == null && bm != null) return 1;
      return 0;
    });
  }

  /* tasks whose work date is `key` (default today), in display order */
  function tasksForDate(key) {
    key = U.isKey(key) ? key : U.dateKey();
    return tasksSorted().filter(function (t) { return t.taskDate === key; });
  }
  function tasksToday() { return tasksForDate(U.dateKey()); }

  function topTasks() {
    var today = U.dateKey();
    return tasksSorted().filter(function (t) {
      return t.priority === "top" && t.taskDate === today;
    });
  }

  /* Today-only task stats — future recurrence occurrences never count toward
     today's totals or completion rate. */
  function taskStats() {
    var today = U.dateKey();
    var ts = state.tasks.filter(function (t) { return t.taskDate === today; });
    var done = ts.filter(function (t) { return t.done; }).length;
    var remaining = ts.filter(function (t) { return !t.done; });
    var by = { top: 0, high: 0, normal: 0 };
    remaining.forEach(function (t) { by[t.priority]++; });
    var byAll = { top: 0, high: 0, normal: 0 };
    var byDone = { top: 0, high: 0, normal: 0 };
    ts.forEach(function (t) {
      byAll[t.priority]++;
      if (t.done) byDone[t.priority]++;
    });
    return {
      total: ts.length,
      done: done,
      remaining: remaining.length,
      byRemaining: by,
      byAll: byAll,
      byDone: byDone,
      percent: U.pct(done, ts.length)
    };
  }

  function eventsOn(key) {
    return state.events
      .filter(function (e) { return e.date === key; })
      .sort(function (a, b) {
        var am = U.toMinutes(a.start), bm = U.toMinutes(b.start);
        if (am == null && bm == null) return a.title.localeCompare(b.title);
        if (am == null) return 1;
        if (bm == null) return -1;
        return am - bm;
      });
  }

  function eventDaysInMonth(year, month) {
    var set = {};
    state.events.forEach(function (e) {
      var d = U.parseKey(e.date);
      if (d.getFullYear() === year && d.getMonth() === month) set[e.date] = true;
    });
    return set;
  }

  /* dates in {year, month} that have at least one task (any status) */
  function taskDaysInMonth(year, month) {
    var set = {};
    state.tasks.forEach(function (t) {
      if (!U.isKey(t.taskDate)) return;
      var d = U.parseKey(t.taskDate);
      if (d.getFullYear() === year && d.getMonth() === month) set[t.taskDate] = true;
    });
    return set;
  }

  /* status of an event relative to a reference Date (default: now) */
  function eventStatus(e, ref) {
    ref = ref || new Date();
    if (e.date !== U.dateKey(ref)) {
      return U.parseKey(e.date) < U.parseKey(U.dateKey(ref)) ? "past" : "upcoming";
    }
    var cur = U.nowMinutes(ref);
    var s = U.toMinutes(e.start);
    var en = U.toMinutes(e.end);
    if (s == null) return "upcoming";
    if (en != null && cur >= s && cur < en) return "live";
    if (en == null && cur >= s && cur < s + 60) return "live";
    if (cur >= (en != null ? en : s + 60)) return "past";
    return "upcoming";
  }

  /* completion rate for the last N days (oldest -> newest), today live */
  function recentRates(days) {
    var out = [];
    var todayKey = U.dateKey();
    var live = taskStats();
    for (var i = days - 1; i >= 0; i--) {
      var d = U.addDays(new Date(), -i);
      var key = U.dateKey(d);
      var rec;
      if (key === todayKey) rec = { completed: live.done, total: live.total };
      else rec = state.history[key] || null;
      out.push({
        key: key,
        date: d,
        isToday: key === todayKey,
        completed: rec ? rec.completed : 0,
        total: rec ? rec.total : 0,
        hasData: !!rec && rec.total > 0,
        rate: rec ? U.pct(rec.completed, rec.total) : 0
      });
    }
    return out;
  }

  TP.store = {
    load: load,
    get: get,
    hadStoredData: function () { return hadStoredData; },
    rolloverIfNeeded: rolloverIfNeeded,

    addTask: addTask,
    updateTask: updateTask,
    toggleTask: toggleTask,
    removeTask: removeTask,

    addEvent: addEvent,
    updateEvent: updateEvent,
    removeEvent: removeEvent,

    setNotes: setNotes,
    setTheme: setTheme,
    resetAll: resetAll,
    exportJSON: exportJSON,
    importJSON: importJSON,
    storageBytes: storageBytes,

    tasksSorted: tasksSorted,
    tasksForDate: tasksForDate,
    tasksToday: tasksToday,
    topTasks: topTasks,
    taskStats: taskStats,
    eventsOn: eventsOn,
    eventDaysInMonth: eventDaysInMonth,
    taskDaysInMonth: taskDaysInMonth,
    eventStatus: eventStatus,
    recentRates: recentRates,

    completedTasksFor: completedTasksFor,
    reports: reports,
    getReport: getReport,
    saveReport: saveReport,
    reviewReport: reviewReport,
    markReviewSeen: markReviewSeen,
    unseenReviewResults: unseenReviewResults,
    removeReport: removeReport,
    attachmentUsage: attachmentUsage,
    addContact: addContact,
    setReporterName: setReporterName,

    PRIORITIES: PRIORITIES,
    REPORT_STATUSES: REPORT_STATUSES
  };
})();
