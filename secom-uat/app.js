/* SECOM UAT recorder page: rendering, routing, saving. Pure logic is in lib.js. */
(function () {
  "use strict";
  var UAT = window.UAT, L = window.UATLib;
  var DEMO = typeof ENDPOINT === "undefined" || ENDPOINT.indexOf("PASTE_") === 0;
  var params = L.parseParams(location.search);
  var app = document.getElementById("app");
  var top = document.getElementById("top");
  var bottom = document.getElementById("bottom");
  var banner = document.getElementById("banner");
  var viewer = document.getElementById("viewer");

  var HINTS = {
    ok: "หน้าจอตรงกับ “สิ่งที่ควรเห็นบนหน้าจอ”",
    fail: "ทำครบทุกขั้นแล้วแต่ผลไม่ตรง",
    blocked: "ไปต่อไม่ได้กลางทาง เช่น ระบบค้าง ขึ้นข้อผิดพลาด หรือข้อมูลที่ต้องใช้ยังไม่พร้อม ให้ข้ามไปข้อถัดไป",
    not_assigned: "ขั้นนี้ของ Golden Thread มีผู้อื่นในบทบาทเดียวกันเป็นผู้ทำ"
  };
  var PHOTO_WARNING = "ถ่ายเฉพาะจุดที่ผิดพลาด ห้ามถ่ายรหัสผ่าน เลขผู้เสียภาษี ข้อมูลบัญชีธนาคาร หรือบุคคล";
  var ICONS = {
    ok: '<path d="M5 12l4 4 10-10" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>',
    fail: '<path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>',
    blocked: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2.5"/><path d="M6 6l12 12" stroke="currentColor" stroke-width="2.5"/>',
    not_assigned: '<path d="M5 12h14" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>',
    camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="12" cy="13" r="3.5" fill="none" stroke="currentColor" stroke-width="2"/>'
  };

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0;
      return (c === "x" ? r : (r & 3 | 8)).toString(16);
    });
  }

  function el(tag, attrs, children) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === "text") e.textContent = attrs[k];
      else if (k === "html") e.innerHTML = attrs[k];
      else if (k.indexOf("on") === 0) e.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== null && attrs[k] !== undefined && attrs[k] !== false) e.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) e.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return e;
  }

  function svg(name) {
    return '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">' + ICONS[name] + "</svg>";
  }

  function showBanner(text) { banner.textContent = text; banner.hidden = false; }

  // ---------- no role: role picker ----------
  if (!params.role) {
    top.appendChild(el("h1", { text: "UAT SECOM Supplier Portal" }));
    var card = el("div", { "class": "card" }, [el("h2", { text: "เลือกบทบาทของท่าน" })]);
    Object.keys(UAT.roles).forEach(function (r) {
      card.appendChild(el("a", { "class": "row", href: "?role=" + r + "&s=" + params.run },
        [el("span", { text: UAT.roles[r].role_th })]));
    });
    app.appendChild(card);
    return;
  }

  var role = UAT.roles[params.role];
  var ctxBase = { run: params.run, role: params.role, device: navigator.userAgent.slice(0, 120) };
  var store;
  try { store = L.createStore(window.localStorage, params.role, params.run); }
  catch (e) { store = L.createStore({ getItem: function () { throw e; }, setItem: function () { throw e; } }, params.role, params.run); }
  var state = store.load(uuid);
  state.drafts = state.drafts || {};
  var sendState = { failed: false, attempt: 0, timer: null, error: "" };
  var MEMORY_WARNING_START = "โหมดนี้จำความคืบหน้าไม่ได้ อย่าปิดหน้านี้";

  if (DEMO) showBanner("โหมดทดลอง ไม่ส่งผลเข้าชีต");
  else if (!store.persistent) showBanner(MEMORY_WARNING_START);

  var MEMORY_WARNING = "โหมดนี้จำความคืบหน้าไม่ได้ อย่าปิดหน้านี้";
  function save() {
    if (store.save(state) === "memory") showBanner(MEMORY_WARNING);
  }

  // Another tab of the same role and run may have saved meanwhile: merge its work before changing anything.
  function syncFromDisk() {
    if (!store.persistent) return;
    var disk = store.load(uuid);
    if (disk && disk.testerKey === state.testerKey) {
      var merged = L.mergeState(state, disk);
      Object.keys(merged).forEach(function (k) { state[k] = merged[k]; });
    }
  }
  window.addEventListener("storage", function (e) {
    if (e.key !== store.key) return;
    syncFromDisk();
    route();
  });

  // ---------- sending ----------
  function post(sub) {
    return fetch(ENDPOINT, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify(sub) })
      .then(function (r) { return r.json(); });
  }

  function flush() {
    if (DEMO || !state.outbox.length) { renderChip(); return; }
    clearTimeout(sendState.timer);
    L.flushOutbox(state, post).then(function (res) {
      save();
      sendState.failed = res.failed;
      sendState.error = res.error || "";
      if (res.failed) {
        sendState.timer = setTimeout(flush, L.backoffMs(sendState.attempt++));
      } else {
        sendState.attempt = 0;
      }
      renderChip();
    });
  }
  window.addEventListener("online", flush);

  function chipState() {
    if (DEMO) return { cls: "", text: "โหมดทดลอง" };
    if (state.dead && state.dead.length) {
      return { cls: "err", text: "ส่งไม่ได้ " + state.dead.length + " รายการ (" + state.dead[state.dead.length - 1].error + ") แจ้งผู้ประสานงาน UAT" };
    }
    if (sendState.failed) return { cls: "err", text: "ส่งไม่สำเร็จ แตะเพื่อลองใหม่" };
    if (state.outbox.length) return { cls: "", text: "รอส่ง (" + state.outbox.length + ")" };
    return { cls: "ok", text: "บันทึกแล้ว ✓" };
  }

  function renderChip() {
    var c = document.getElementById("chip");
    if (!c) return;
    var s = chipState();
    c.className = "chip " + s.cls;
    c.textContent = s.text;
  }

  function record(caseId, result, note, photo) {
    var ctx = { run: ctxBase.run, role: ctxBase.role, device: ctxBase.device, photo: photo || null };
    syncFromDisk();
    L.recordResult(state, ctx, caseId, result, note, uuid, Date.now());
    save();
    renderChip();
    flush();
  }

  // ---------- header ----------
  function renderTop(sub) {
    var p = L.progress(state, UAT, params.role);
    top.innerHTML = "";
    top.appendChild(el("h1", { text: role.role_th }));
    top.appendChild(el("div", { "class": "sub", text: (state.name ? state.name + " · " : "") + "ทำแล้ว " + p.done + " / " + p.total + (sub ? " · " + sub : "") }));
    var bar = el("div", { "class": "progress", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": String(p.total), "aria-valuenow": String(p.done) });
    bar.appendChild(el("i", { style: "width:" + Math.round(100 * p.done / Math.max(1, p.total)) + "%" }));
    top.appendChild(bar);
  }

  function setBottom(items) {
    bottom.innerHTML = "";
    if (!items) { bottom.hidden = true; return; }
    bottom.hidden = false;
    var chip = el("button", { id: "chip", "class": "chip", type: "button", onclick: function () { sendState.attempt = 0; flush(); } });
    bottom.appendChild(chip);
    items.forEach(function (i) { bottom.appendChild(i); });
    renderChip();
  }

  // ---------- start ----------
  function renderStart() {
    renderTop();
    setBottom(null);
    app.innerHTML = "";
    app.appendChild(el("div", { "class": "card notice" }, [
      el("h3", { text: "การเก็บข้อมูลส่วนบุคคล" }),
      el("p", { "class": "muted", text: UAT.controller + " เก็บชื่อ ฝ่าย ผลการทดสอบ ข้อความที่ท่านพิมพ์ ภาพที่ท่านแนบ และชนิดอุปกรณ์ เพื่อบันทึกและติดตามผล UAT เท่านั้น ทีมโครงการเท่านั้นที่เห็นชื่อและภาพ ข้อมูลเก็บใน Google ซึ่งอาจอยู่บนเซิร์ฟเวอร์นอกประเทศไทย ข้อความปัญหาที่ไม่มีชื่อผู้ทดสอบจะถูกวิเคราะห์ด้วยผู้ช่วย AI (Claude) เพื่อนำไปแก้ไขระบบ ชื่อและภาพจะถูกลบภายในวันที่ " + UAT.purge_date_th + " ติดต่อ: " + UAT.contact })
    ]));
    var name = el("input", { id: "name", "class": "field", autocomplete: "name", maxlength: "100", value: state.name || "" });
    var dept = el("input", { id: "dept", "class": "field", autocomplete: "organization-title", maxlength: "100", value: state.dept || "" });
    var err = el("div", { "class": "error", id: "name-error", "aria-live": "polite" });
    var resume = L.firstUnfinished(state, UAT, params.role);
    var label = state.name && state.current ? "ทำต่อจากข้อ " + state.current : "เริ่มทดสอบ";
    var go = el("button", { "class": "btn block", type: "button", text: label, onclick: function () {
      if (!name.value.trim()) { err.textContent = "กรุณากรอกชื่อ-นามสกุล"; name.setAttribute("aria-invalid", "true"); name.focus(); return; }
      state.name = name.value.trim().slice(0, 100);
      state.dept = dept.value.trim().slice(0, 100);
      save();
      var target = "#/case/" + (state.current || resume || L.roleCases(UAT, params.role)[0]);
      if (location.hash === target) route(); else location.hash = target;
    } });
    app.appendChild(el("div", { "class": "card" }, [
      el("h2", { text: "ข้อมูลผู้ทดสอบ" }),
      el("label", { "for": "name", text: "ชื่อ-นามสกุล" }), name, err,
      el("label", { "for": "dept", text: "ฝ่าย / ตำแหน่ง" }), dept
    ]));
    app.appendChild(el("div", { "class": "card" }, [
      el("h3", { text: "บัญชีที่ใช้ทดสอบ" }), el("div", { text: role.account + " (รหัสผ่านตามที่ได้รับ)" }),
      el("h3", { text: "ที่อยู่เว็บ" }), el("div", { text: UAT.portal_url }),
      el("p", { "class": "muted", text: role.banner })
    ]));
    var warn = el("ul", {});
    role.warnings.forEach(function (w) { warn.appendChild(el("li", { text: w })); });
    app.appendChild(el("div", { "class": "card warn" }, [el("h3", { text: "คำเตือนก่อนเริ่ม" }), warn]));
    var hints = el("ul", {});
    ["ok", "fail", "blocked"].forEach(function (k) { hints.appendChild(el("li", {}, [el("b", { text: L.RESULTS[k] + ": " }), HINTS[k]])); });
    app.appendChild(el("div", { "class": "card" }, [el("h3", { text: "วิธีเลือกผล" }), hints]));
    app.appendChild(go);
    app.appendChild(el("p", { "class": "muted", text: "ปิดหน้าแล้วเปิดใหม่ในเครื่องเดิมได้ ระบบจำว่าทำถึงข้อไหน" }));
    app.appendChild(el("a", { "class": "btn ghost block", href: "#/list", text: "ดูรายการข้อทั้งหมด" }));
  }

  // ---------- list ----------
  function tagFor(id) {
    var r = state.results[id];
    if (!r) return el("span", { "class": "tag todo", text: "ยังไม่ทำ" });
    return el("span", { "class": "tag " + r.result, text: r.result === "blocked" ? "ติดปัญหา" : r.result === "not_assigned" ? "ไม่ได้รับมอบหมาย" : L.RESULTS[r.result] });
  }

  function renderList() {
    renderTop();
    setBottom([el("a", { "class": "btn ghost", href: "#/info", text: "คำศัพท์และสิ่งที่ต้องเตรียม" })]);
    app.innerHTML = "";
    var p = L.progress(state, UAT, params.role);
    role.categories.forEach(function (cat) {
      var b = p.byCategory[cat.no];
      app.appendChild(el("div", { "class": "cat", text: "หมวดที่ " + cat.no + " " + cat.name + " (" + b.done + "/" + b.total + ")" }));
      cat.cases.forEach(function (id) {
        var c = UAT.cases[id];
        app.appendChild(el("a", { "class": "row", href: "#/case/" + id }, [
          el("span", { "class": "t" }, [el("span", { "class": "id", text: id }), c.title]), tagFor(id)
        ]));
      });
    });
  }

  // ---------- info ----------
  function renderInfo() {
    renderTop();
    setBottom([el("a", { "class": "btn ghost", href: "#/list", text: "‹ รายการข้อ" })]);
    app.innerHTML = "";
    var prep = el("div", { "class": "card" }, [el("h2", { text: "สิ่งที่ต้องเตรียมก่อนเริ่มทดสอบ" })]);
    role.prepare.forEach(function (p) { prep.appendChild(el("p", {}, [el("b", { text: p.what + ": " }), p.detail])); });
    var glo = el("div", { "class": "card" }, [el("h2", { text: "คำที่จะเจอบ่อย" })]);
    role.glossary.forEach(function (g) { glo.appendChild(el("p", {}, [el("b", { text: g.term + ": " }), g.meaning])); });
    app.appendChild(prep);
    app.appendChild(glo);
  }

  // ---------- viewer ----------
  function openViewer(src, alt) {
    viewer.innerHTML = "";
    var close = el("button", { "class": "close", type: "button", "aria-label": "ปิดภาพ", text: "×", onclick: closeViewer });
    viewer.appendChild(el("img", { src: src, alt: alt }));
    viewer.appendChild(close);
    viewer.appendChild(el("div", { "class": "hint", text: "หมุนจอแนวนอนเพื่อดูภาพใหญ่ ใช้สองนิ้วซูมได้" }));
    viewer.hidden = false;
    close.focus();
  }
  function closeViewer() { viewer.hidden = true; viewer.innerHTML = ""; }
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !viewer.hidden) closeViewer(); });

  // ---------- photo ----------
  function resizePhoto(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var scale = Math.min(1, 1600 / Math.max(img.width, img.height));
        var c = document.createElement("canvas");
        c.width = Math.round(img.width * scale);
        c.height = Math.round(img.height * scale);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        var data = c.toDataURL("image/jpeg", 0.8);
        var b64 = data.slice(data.indexOf(",") + 1);
        if (b64.length * 3 / 4 > 2 * 1024 * 1024) { reject(new Error("ภาพใหญ่เกินไป")); return; }
        resolve({ mime: "image/jpeg", b64: b64 });
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("เปิดภาพไม่ได้")); };
      img.src = url;
    });
  }

  // ---------- case ----------
  function numberedList(items, start) {
    var ol = el("ol", { "class": "num" });
    items.forEach(function (t, i) {
      ol.appendChild(el("li", {}, [el("span", { "class": "pin", "aria-hidden": "true", text: String(start + i + 1) }), el("span", { text: t })]));
    });
    return ol;
  }

  function renderCase(id) {
    var c = UAT.cases[id];
    if (!c || c.role !== params.role) { location.hash = "#/list"; return; }
    if (!state.name) { location.hash = "#/start"; return; }
    state.current = id;
    save();
    var ids = L.roleCases(UAT, params.role);
    renderTop(id + " · ข้อ " + (ids.indexOf(id) + 1) + " จาก " + ids.length);
    var prev = L.prevCase(UAT, params.role, id), next = L.nextCase(UAT, params.role, id);
    setBottom([
      el("a", { "class": "btn ghost", href: prev ? "#/case/" + prev : "#/list", text: prev ? "‹ ก่อนหน้า" : "‹ รายการ" }),
      el("a", { "class": "btn", href: next ? "#/case/" + next : "#/list", text: next ? "ข้อถัดไป ›" : "จบ ดูรายการ ›" })
    ]);
    app.innerHTML = "";
    var head = el("div", { "class": "card" }, [
      el("div", { "class": "muted", text: "ประเภท: " + c.type_th + (c.bp ? " · " + c.bp : "") }),
      el("h2", { text: id + " " + c.title })
    ]);
    if (c.gt) head.appendChild(el("span", { "class": "tag gt", text: "Golden Thread " + c.gt.thread + " ขั้น " + c.gt.step + " จาก " + c.gt.of }));
    app.appendChild(head);
    var pre = el("div", { "class": "card notice" }, [el("h3", { text: "สิ่งที่ต้องเตรียมก่อน" })]);
    var ul = el("ul", {});
    c.pre.forEach(function (p) { ul.appendChild(el("li", { text: p })); });
    if (c.data) ul.appendChild(el("li", { text: "ข้อมูลที่ใช้: " + c.data }));
    pre.appendChild(ul);
    app.appendChild(pre);
    if (c.warning) app.appendChild(el("div", { "class": "card warn" }, [el("h3", { text: "คำเตือน" }), el("div", { text: c.warning })]));

    c.blocks.forEach(function (b) {
      var box = el("div", { "class": "card " + (b.kind === "see" ? "see" : "steps") }, [
        el("h3", { text: b.kind === "see" ? "สิ่งที่ควรเห็นบนหน้าจอ" : "ทำตามขั้นตอน" })
      ]);
      if (b.img) {
        var first = b.start + 1, last = b.start + b.items.length;
        var alt = (b.kind === "see" ? "ภาพสิ่งที่ควรเห็น " : "ภาพขั้นตอน ") + (b.kind === "see" ? "" : first + (last > first ? "–" + last : ""));
        var btn = el("button", { type: "button", "aria-label": alt + " แตะเพื่อดูภาพเต็ม", onclick: function () { openViewer(b.img + "-full.webp", alt); } },
          [el("img", { src: b.img + ".webp", alt: alt, width: "720", height: "450", loading: "lazy", decoding: "async" })]);
        box.appendChild(el("div", { "class": "shot" }, [btn, el("div", { "class": "muted", text: "แตะภาพเพื่อดูภาพเต็ม" })]));
      }
      box.appendChild(numberedList(b.items, b.kind === "see" ? 0 : b.start));
      app.appendChild(box);
    });
    if (c.note) app.appendChild(el("div", { "class": "card notice" }, [el("h3", { text: "ข้อควรรู้" }), el("div", { text: c.note })]));

    var cur = state.results[id];
    var noteVal = cur ? cur.note : (state.drafts[id] || "");
    var form = el("div", { "class": "card" }, [el("h2", { text: "ผลการทดสอบ" })]);
    var group = el("div", { "class": "results", role: "radiogroup", "aria-label": "ผลการทดสอบ" });
    var note = el("textarea", { id: "note", "class": "field", maxlength: "2000" });
    note.value = noteVal;
    var photoBox = el("div", { "class": "photo" });
    L.allowedResults(c).forEach(function (k) {
      var inputId = "r-" + k;
      var input = el("input", { type: "radio", name: "result", id: inputId, value: k });
      if (cur && cur.result === k) input.checked = true;
      input.addEventListener("change", function () {
        record(id, k, note.value.slice(0, 2000));
        delete state.drafts[id];
        save();
        updatePhoto();
        renderTop(id + " · ข้อ " + (ids.indexOf(id) + 1) + " จาก " + ids.length);
      });
      group.appendChild(el("div", { "class": "result " + k }, [input,
        el("label", { "for": inputId, html: svg(k) + "<span>" + L.RESULTS[k] + '<span class="hint">' + HINTS[k] + "</span></span>" })]));
    });
    form.appendChild(group);
    form.appendChild(el("label", { "for": "note", text: "สิ่งที่พบ / ปัญหาที่เจอ (ไม่บังคับ)" }));
    form.appendChild(note);

    var timer = null;
    function saveNote() {
      clearTimeout(timer);
      var r = state.results[id];
      var v = note.value.slice(0, 2000);
      if (!r) { state.drafts[id] = v; save(); return; }
      if (r.note !== v) record(id, r.result, v);
    }
    note.addEventListener("input", function () { clearTimeout(timer); timer = setTimeout(saveNote, 1500); });
    note.addEventListener("blur", saveNote);

    var file = el("input", { type: "file", id: "photo", accept: "image/*", capture: "environment", "class": "field" });
    var photoMsg = el("div", { "class": "muted", "aria-live": "polite" });
    file.addEventListener("change", function () {
      var f = file.files && file.files[0];
      if (!f) return;
      photoMsg.textContent = "กำลังเตรียมภาพ...";
      resizePhoto(f).then(function (photo) {
        var r = state.results[id];
        record(id, r.result, note.value.slice(0, 2000), photo);
        photoMsg.textContent = "แนบภาพแล้ว";
        file.value = "";
      }, function (e) { photoMsg.textContent = e.message; });
    });
    photoBox.appendChild(el("label", { "for": "photo", html: svg("camera") + " แนบหรือถ่ายภาพหน้าจอ (ไม่บังคับ)" }));
    photoBox.appendChild(el("div", { "class": "muted", text: PHOTO_WARNING }));
    photoBox.appendChild(file);
    photoBox.appendChild(photoMsg);
    form.appendChild(photoBox);
    function updatePhoto() {
      var r = state.results[id];
      photoBox.hidden = !(r && (r.result === "fail" || r.result === "blocked"));
    }
    updatePhoto();
    app.appendChild(form);
  }

  // ---------- router ----------
  function route() {
    closeViewer();
    var h = location.hash || "";
    var m = h.match(/^#\/case\/([A-Z]+-\d+)$/);
    if (!state.name && h !== "#/list" && h !== "#/info") renderStart();
    else if (m) renderCase(m[1]);
    else if (h === "#/list") renderList();
    else if (h === "#/info") renderInfo();
    else if (h === "#/start" || !state.current) renderStart();
    else { location.hash = "#/case/" + state.current; return; }
    window.scrollTo(0, 0);
    app.focus({ preventScroll: true });
  }
  window.addEventListener("hashchange", route);
  route();
  flush();
  if (!DEMO) {
    fetch(ENDPOINT).then(function (r) { return r.json(); }).then(function (j) {
      if (j && j.version && j.version !== UAT.version) showBanner("ระบบรับผลยังไม่ตรงกับหน้านี้ แจ้งผู้ประสานงาน UAT");
    }).catch(function () { /* offline: the outbox retries */ });
  }
})();
