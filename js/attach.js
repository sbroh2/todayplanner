/* =========================================================================
   attach.js — 일일 업무보고 첨부파일 (Phase 3-2)
   Browser-only file handling for report attachments: limits, type checks,
   FileReader -> Data URL, and open / preview / download of a stored file.
   No DOM state and no storage here — store.js normalizes and persists the
   `attachments` array, report.js renders it.

   Attachment record (also the shape a future server API would return, with
   `data` replaced by a download URL / storage key):
     { id, name, size, type, data: "data:<mime>;base64,...", addedAt }
   ========================================================================= */
(function () {
  "use strict";

  var U = TP.utils;

  var MB = 1024 * 1024;
  // Files are stored as base64 (~4/3 of the size) in LocalStorage, which most
  // browsers cap at ~5M characters per site (Chrome measured: ~5.2M) for ALL
  // planner data. The limits below keep attachments well inside that.
  var LIMITS = {
    maxFiles: 5,              // per report
    maxFileBytes: 2 * MB,     // per file
    maxTotalBytes: 2.5 * MB   // all reports together (so also per report)
  };

  // extension -> MIME types a browser may report for it. An empty type or
  // application/octet-stream is also accepted (Windows often reports those).
  var TYPES = {
    pdf: ["application/pdf"],
    doc: ["application/msword"],
    docx: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    xls: ["application/vnd.ms-excel"],
    xlsx: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ppt: ["application/vnd.ms-powerpoint"],
    pptx: ["application/vnd.openxmlformats-officedocument.presentationml.presentation"],
    txt: ["text/plain"],
    csv: ["text/csv", "application/csv", "text/plain", "application/vnd.ms-excel"],
    png: ["image/png"],
    jpg: ["image/jpeg", "image/pjpeg"],
    jpeg: ["image/jpeg", "image/pjpeg"],
    zip: ["application/zip", "application/x-zip-compressed", "multipart/x-zip"]
  };
  var GENERIC = ["", "application/octet-stream"];

  var ACCEPT = Object.keys(TYPES).map(function (e) { return "." + e; }).join(",");

  var MSG = {
    type: "지원하지 않는 파일 형식입니다. PDF, Word, Excel, PowerPoint, TXT, CSV, PNG, JPG, ZIP 파일만 첨부할 수 있습니다.",
    fileSize: "파일 크기가 너무 큽니다. 파일 1개당 최대 2MB까지 첨부할 수 있습니다.",
    count: "첨부파일은 최대 5개까지 추가할 수 있습니다.",
    duplicate: "같은 이름의 파일이 이미 첨부되어 있습니다.",
    total: "첨부파일 전체 용량이 너무 큽니다. 모든 보고서의 첨부파일은 합계 최대 2.5MB까지 저장할 수 있습니다. 이전 보고서의 첨부파일을 삭제해 주세요.",
    space: "브라우저 저장 공간이 부족합니다. 파일 크기를 줄이거나 이전 보고서의 첨부파일을 삭제해 주세요.",
    read: "파일을 읽지 못했습니다.",
    quota: "첨부파일 용량이 커서 저장할 수 없습니다. 파일 크기를 줄이거나 첨부파일을 삭제해 주세요."
  };

  function ext(name) {
    var m = /\.([^.]+)$/.exec(String(name || ""));
    return m ? m[1].toLowerCase() : "";
  }

  /* Extension must be on the list; a reported MIME type must match it. */
  function isAllowed(name, type) {
    var list = TYPES[ext(name)];
    if (!list) return false;
    var t = String(type || "").toLowerCase();
    return GENERIC.indexOf(t) >= 0 || list.indexOf(t) >= 0;
  }

  function mimeOf(att) {
    if (att.type && GENERIC.indexOf(att.type) < 0) return att.type;
    var list = TYPES[ext(att.name)];
    return list ? list[0] : "application/octet-stream";
  }

  function kind(att) {
    var e = ext(att.name);
    if (e === "png" || e === "jpg" || e === "jpeg") return "image";
    if (e === "pdf") return "pdf";
    return "file";
  }

  function totalBytes(list) {
    return (list || []).reduce(function (sum, a) { return sum + (a.size || 0); }, 0);
  }

  function formatSize(n) {
    n = n || 0;
    if (n < 1024) return n + " B";
    if (n < MB) return Math.max(1, Math.round(n / 1024)) + " KB";
    return (n / MB).toFixed(1) + " MB";
  }

  /* Approximate stored length (characters) of one attachment record. */
  function storedChars(a) {
    var data = a.data ? a.data.length : Math.ceil((a.size || 0) / 3) * 4 + 100;
    return data + String(a.name || "").length + 200; // + JSON keys / metadata
  }

  /* Why `file` cannot be added to `current` (attachments of this report), or "".
     `usage` = { otherBytes, freeChars } from TP.store.attachmentUsage(). */
  function checkFile(file, current, usage) {
    usage = usage || { otherBytes: 0, freeChars: Infinity };
    if (!isAllowed(file.name, file.type)) return MSG.type;
    if (file.size > LIMITS.maxFileBytes) return MSG.fileSize;
    if (current.length >= LIMITS.maxFiles) return MSG.count;
    if (current.some(function (a) { return a.name === file.name; })) return MSG.duplicate;
    if (usage.otherBytes + totalBytes(current) + file.size > LIMITS.maxTotalBytes) return MSG.total;
    var need = current.concat([{ name: file.name, size: file.size }])
      .reduce(function (sum, a) { return sum + storedChars(a); }, 0);
    if (need > usage.freeChars) return MSG.space;
    return "";
  }

  /* Rough free space (bytes of raw file) left for this report's new files. */
  function freeBytes(current, usage) {
    var used = (current || []).reduce(function (sum, a) { return sum + storedChars(a); }, 0);
    return Math.max(0, Math.floor((usage.freeChars - used) * 3 / 4));
  }

  /* File -> Promise<attachment record> */
  function readFile(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error("READ")); };
      reader.onload = function () {
        resolve({
          id: U.uid(),
          name: file.name,
          size: file.size,
          type: file.type || mimeOf({ name: file.name }),
          data: String(reader.result),
          addedAt: new Date().toISOString()
        });
      };
      reader.readAsDataURL(file);
    });
  }

  /* Data URL -> Blob (top-level navigation to data: URLs is blocked by
     browsers, so files are opened / downloaded through blob: URLs). */
  function toBlob(att) {
    var s = att.data;
    var comma = s.indexOf(",");
    var meta = s.slice(5, comma);
    var body = s.slice(comma + 1);
    var bytes;
    if (/;base64/i.test(meta)) {
      var bin = atob(body);
      bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } else {
      bytes = new TextEncoder().encode(decodeURIComponent(body));
    }
    return new Blob([bytes], { type: mimeOf(att) });
  }

  function download(att) {
    var url = URL.createObjectURL(toBlob(att));
    var a = U.el("a", { href: url, download: att.name, style: "display:none" });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  }

  /* PDF -> new tab (falls back to download if pop-ups are blocked). */
  function openInNewTab(att) {
    var url = URL.createObjectURL(toBlob(att));
    var w = window.open(url, "_blank");
    if (!w) { URL.revokeObjectURL(url); download(att); return false; }
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
    return true;
  }

  TP.attach = {
    LIMITS: LIMITS,
    ACCEPT: ACCEPT,
    MSG: MSG,
    ext: ext,
    isAllowed: isAllowed,
    kind: kind,
    totalBytes: totalBytes,
    formatSize: formatSize,
    checkFile: checkFile,
    storedChars: storedChars,
    freeBytes: freeBytes,
    readFile: readFile,
    download: download,
    openInNewTab: openInNewTab
  };
})();
