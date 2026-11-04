/* Pure page logic for the SECOM UAT recorder: state, outbox, progress, navigation.
   Runs in the browser (window.UATLib) and under node --test (module.exports). */
(function () {
  "use strict";

  var RESULTS = {
    ok: "ทำได้",
    fail: "ทำไม่ได้",
    blocked: "ติดปัญหา ทำต่อไม่ได้",
    not_assigned: "ไม่ได้รับมอบหมายขั้นนี้"
  };
  var ROLES = ["adm", "ap", "aud", "fin", "gad", "va", "vb"];
  var RUN_RE = /^[A-Za-z0-9_-]{1,40}$/;
  var DEFAULT_RUN = "UAT-1110";

  function allowedResults(c) {
    var base = ["ok", "fail", "blocked"];
    return c && c.gt ? base.concat(["not_assigned"]) : base;
  }

  function parseParams(search) {
    var q = new URLSearchParams(search || "");
    var role = (q.get("role") || "").toLowerCase();
    var run = q.get("s") || "";
    return { role: ROLES.indexOf(role) >= 0 ? role : null, run: RUN_RE.test(run) ? run : DEFAULT_RUN };
  }

  function newState(uuidFn) {
    return { testerKey: uuidFn(), name: "", dept: "", current: null, results: {}, outbox: [], dead: [] };
  }

  function createStore(storage, role, run) {
    var key = "uat:" + run + ":" + role;
    var memory = null;
    var persistent = true;
    try {
      var probe = key + ":probe";
      storage.setItem(probe, "1");
      storage.removeItem && storage.removeItem(probe);
    } catch (e) {
      persistent = false;
    }
    var store = {
      key: key,
      persistent: persistent,
      load: function (uuidFn) {
        if (!store.persistent) return memory || (memory = newState(uuidFn));
        try {
          var raw = storage.getItem(key);
          if (raw) return JSON.parse(raw);
        } catch (e) { /* fall through to a fresh state */ }
        return newState(uuidFn);
      },
      // Returns "ok", "photo_dropped" (saved without queued photo data, which still sends from memory) or
      // "memory" (storage refused even that; the page must warn the tester).
      save: function (state) {
        memory = state;
        if (!store.persistent) return "memory";
        try { storage.setItem(key, JSON.stringify(state)); return "ok"; } catch (e) { /* try smaller */ }
        try {
          var slim = JSON.parse(JSON.stringify(state));
          slim.outbox.forEach(function (o) { o.photo = null; });
          storage.setItem(key, JSON.stringify(slim));
          return "photo_dropped";
        } catch (e2) {
          store.persistent = false;
          return "memory";
        }
      }
    };
    return store;
  }

  function recordResult(state, ctx, caseId, result, note, uuidFn, now) {
    var prev = state.results[caseId];
    var editSeq = (prev ? prev.editSeq : 0) + 1;
    state.results[caseId] = { result: result, note: note || "", editSeq: editSeq, savedAt: now,
      hasPhoto: !!ctx.photo || !!(prev && prev.hasPhoto) };
    var sub = {
      action: "submit", rowId: uuidFn(), run: ctx.run, role: ctx.role, caseId: caseId,
      testerKey: state.testerKey, name: state.name, dept: state.dept, result: result,
      note: note || "", editSeq: editSeq, clientTime: new Date(now).toISOString(),
      device: ctx.device || "", photo: ctx.photo || null
    };
    state.outbox.push(sub);
    return sub;
  }

  function roleCases(bundle, role) {
    var out = [];
    bundle.roles[role].categories.forEach(function (c) { out = out.concat(c.cases); });
    return out;
  }

  function progress(state, bundle, role) {
    var done = 0, total = 0, na = 0, byCategory = {};
    bundle.roles[role].categories.forEach(function (cat) {
      var d = 0;
      cat.cases.forEach(function (id) {
        total++;
        var r = state.results[id];
        if (r) { done++; d++; if (r.result === "not_assigned") na++; }
      });
      byCategory[cat.no] = { done: d, total: cat.cases.length };
    });
    var denom = total - na;
    return { done: done, total: total, byCategory: byCategory, rate: denom > 0 ? (done - na) / denom : 0 };
  }

  function nextCase(bundle, role, caseId) {
    var ids = roleCases(bundle, role), i = ids.indexOf(caseId);
    return i >= 0 && i + 1 < ids.length ? ids[i + 1] : null;
  }

  function prevCase(bundle, role, caseId) {
    var ids = roleCases(bundle, role), i = ids.indexOf(caseId);
    return i > 0 ? ids[i - 1] : null;
  }

  function firstUnfinished(state, bundle, role) {
    var ids = roleCases(bundle, role);
    for (var i = 0; i < ids.length; i++) if (!state.results[ids[i]]) return ids[i];
    return null;
  }

  // Errors the server may clear on a retry; anything else is a permanent rejection of that one save.
  var TRANSIENT = ["server error", "too many requests"];
  var inflight = typeof WeakMap !== "undefined" ? new WeakMap() : null;

  function removeByRowId(list, rowId) {
    for (var i = 0; i < list.length; i++) if (list[i].rowId === rowId) { list.splice(i, 1); return; }
  }

  // One flush per state at a time: a second call while one runs joins it (the running loop always takes the
  // current head, so items added meanwhile are sent by it). Items are removed by rowId, never by position.
  function flushOutbox(state, postFn) {
    if (inflight && inflight.has(state)) return inflight.get(state);
    var sent = 0, rejected = 0;
    function done(extra) {
      var r = { sent: sent, failed: false };
      if (rejected) r.rejected = rejected;
      Object.keys(extra || {}).forEach(function (k) { r[k] = extra[k]; });
      return r;
    }
    function step() {
      if (!state.outbox.length) return Promise.resolve(done());
      var sub = state.outbox[0];
      return Promise.resolve()
        .then(function () { return postFn(sub); })
        .then(function (res) {
          if (res && res.ok) { removeByRowId(state.outbox, sub.rowId); sent++; return step(); }
          var error = (res && res.error) || "rejected";
          if (TRANSIENT.indexOf(error) >= 0) return done({ failed: true, error: error });
          removeByRowId(state.outbox, sub.rowId);
          state.dead = state.dead || [];
          var d = {};
          Object.keys(sub).forEach(function (k) { d[k] = sub[k]; });
          d.photo = null;
          d.error = error;
          state.dead.push(d);
          rejected++;
          return step();
        }, function () { return done({ failed: true }); });
    }
    var p = step().then(function (r) { if (inflight) inflight.delete(state); return r; });
    if (inflight) inflight.set(state, p);
    return p;
  }

  // Merge two copies of one tester's state (two tabs): per case the higher editSeq wins, queues are unioned by rowId.
  function mergeState(a, b) {
    var m = JSON.parse(JSON.stringify(b));
    m.testerKey = a.testerKey || b.testerKey;
    m.name = b.name || a.name;
    m.dept = b.dept || a.dept;
    m.current = b.current || a.current;
    m.results = {};
    [a.results || {}, b.results || {}].forEach(function (rs) {
      Object.keys(rs).forEach(function (id) {
        var r = rs[id], have = m.results[id];
        if (!have || r.editSeq > have.editSeq || (r.editSeq === have.editSeq && r.savedAt > have.savedAt)) m.results[id] = r;
      });
    });
    function union(x, y) {
      var seen = {}, out = [];
      (x || []).concat(y || []).forEach(function (o) { if (!seen[o.rowId]) { seen[o.rowId] = 1; out.push(o); } });
      return out.sort(function (p, q) { return p.clientTime < q.clientTime ? -1 : p.clientTime > q.clientTime ? 1 : 0; });
    }
    m.outbox = union(a.outbox, b.outbox);
    m.dead = union(a.dead, b.dead);
    m.drafts = {};
    [a.drafts || {}, b.drafts || {}].forEach(function (d) { Object.keys(d).forEach(function (k) { m.drafts[k] = d[k]; }); });
    return m;
  }

  function backoffMs(attempt) { return Math.min(30000, 1000 * Math.pow(2, attempt)); }

  var UATLib = {
    RESULTS: RESULTS, ROLES: ROLES, allowedResults: allowedResults, parseParams: parseParams,
    newState: newState, createStore: createStore, recordResult: recordResult, roleCases: roleCases,
    progress: progress, nextCase: nextCase, prevCase: prevCase, firstUnfinished: firstUnfinished,
    flushOutbox: flushOutbox, mergeState: mergeState, backoffMs: backoffMs
  };
  if (typeof module !== "undefined" && module.exports) module.exports = UATLib;
  else window.UATLib = UATLib;
})();
