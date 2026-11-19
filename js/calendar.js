/* =========================================================================
   calendar.js — self-contained mini month calendar
   TP.createCalendar({ selected, onSelect, getMarks }) -> { root, refresh, setSelected }
     selected  : "YYYY-MM-DD" | null   currently highlighted day
     onSelect  : fn(key)               called when a day is clicked (toggles off
                                       when the same day is clicked again)
     getMarks  : fn(year, month) -> { "YYYY-MM-DD": mark }  days to badge
       `mark` may be `true` (legacy: plain event dot) or an object
       `{ event: bool, task: bool }` to badge events and/or tasks separately.
   ========================================================================= */
(function () {
  "use strict";

  var U = TP.utils;

  function createCalendar(opts) {
    opts = opts || {};
    var selected = U.isKey(opts.selected) ? opts.selected : null;
    var onSelect = typeof opts.onSelect === "function" ? opts.onSelect : function () {};
    var getMarks = typeof opts.getMarks === "function" ? opts.getMarks : function () { return {}; };

    var view = U.firstOfMonth(selected ? U.parseKey(selected) : new Date());
    var root = U.el("div", { class: "cal" });

    function render() {
      U.clear(root);
      var year = view.getFullYear();
      var month = view.getMonth();
      var today = new Date();
      var todayKey = U.dateKey(today);
      var marks = getMarks(year, month) || {};

      var prevBtn = U.el("button", {
        class: "icon-btn btn--sm", type: "button", "aria-label": "이전 달", html: "&#8249;",
        onclick: function () { view = U.addMonths(view, -1); render(); }
      });
      var todayBtn = U.el("button", {
        class: "btn btn--ghost btn--sm", type: "button", text: "오늘",
        onclick: function () { view = U.firstOfMonth(new Date()); render(); }
      });
      var nextBtn = U.el("button", {
        class: "icon-btn btn--sm", type: "button", "aria-label": "다음 달", html: "&#8250;",
        onclick: function () { view = U.addMonths(view, 1); render(); }
      });

      root.appendChild(U.el("div", { class: "cal__head" }, [
        U.el("div", { class: "cal__title", text: year + "년 " + (month + 1) + "월" }),
        U.el("div", { class: "cal__nav" }, [prevBtn, todayBtn, nextBtn])
      ]));

      var grid = U.el("div", { class: "cal__grid", role: "grid" });
      U.WEEKDAYS.forEach(function (w) {
        grid.appendChild(U.el("div", { class: "cal__wd", role: "columnheader", text: w }));
      });

      var firstDow = new Date(year, month, 1).getDay();
      var gridStart = U.addDays(new Date(year, month, 1), -firstDow);

      for (var i = 0; i < 42; i++) {
        var d = U.addDays(gridStart, i);
        var key = U.dateKey(d);
        var outside = d.getMonth() !== month;
        var mark = marks[key];
        var hasEvent = mark === true || (mark && mark.event);
        var hasTask = !!(mark && mark.task);
        var cls = "cal__day";
        if (outside) cls += " is-outside";
        if (key === todayKey) cls += " is-today";
        if (key === selected) cls += " is-selected";
        if (hasEvent) cls += " has-events";
        if (hasTask) cls += " has-tasks";

        var markLabel = (hasEvent && hasTask) ? ", 일정·할 일 있음"
          : hasEvent ? ", 일정 있음"
          : hasTask ? ", 할 일 있음" : "";
        grid.appendChild(U.el("button", {
          class: cls, type: "button", role: "gridcell",
          "aria-label": U.formatDateShort(key) + markLabel,
          "aria-pressed": key === selected ? "true" : "false",
          dataset: { key: key },
          text: String(d.getDate()),
          onclick: (function (k) {
            return function () {
              selected = (selected === k) ? null : k;
              render();
              onSelect(selected);
            };
          })(key)
        }));
      }
      root.appendChild(grid);
    }

    render();

    return {
      root: root,
      refresh: render,
      setSelected: function (key) {
        selected = U.isKey(key) ? key : null;
        if (selected) view = U.firstOfMonth(U.parseKey(selected));
        render();
      }
    };
  }

  TP.createCalendar = createCalendar;
})();
