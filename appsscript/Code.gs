/**
 * แบบทดสอบผู้ใช้ SSM — Apps Script backend
 * อ้างอิงเอกสารออกแบบ: docs/superpowers/specs/2026-09-17-ssm-user-assessment-design.md
 *
 * ไฟล์ในโปรเจกต์นี้
 *   Code.gs     — ไฟล์นี้ · เขียนด้วยมือ · API รับคำตอบ
 *   Keys.gs     — GENERATED · เฉลย คะแนน แกน คำอธิบาย แหล่งอ้างอิง (ไม่เคยออกจากที่นี่)
 *
 * หน้าเว็บ (index.html + items.js) อยู่บน GitHub Pages คนละที่กับไฟล์นี้
 *
 * ห้ามแก้ Keys.gs และ Items.html ด้วยมือ — สร้างจาก docs/training/exam/items/*.toml เท่านั้น (สเปก §15.3)
 */

const SHEET_ATTEMPTS  = 'Attempts';
const SHEET_RESPONSES = 'Responses';
const LOCK_WAIT_MS    = 30000;

/** บทบาททั้งหมด · ใช้กรองค่าที่มาจาก URL ด้วย — ห้ามรับค่าดิบจาก e.parameter ตรง ๆ */
const ROLES = {
  admin:        { th: 'ผู้ดูแลระบบ',  track: 'office' },
  zonehead:     { th: 'หัวหน้าเขต',   track: 'office' },
  surveyor:     { th: 'นักสำรวจ',     track: 'field'  },
  gis:          { th: 'ผู้ใช้งาน GIS', track: 'office' },
  cutter:       { th: 'รถตัดอ้อย',    track: 'field'  },
  servicepoint: { th: 'จุดบริการ',    track: 'field'  }
};

const COMPETENCIES = [
  { key: 'C1', name: 'ความรู้และการใช้งาน' },
  { key: 'C2', name: 'ทำตามขั้นตอนได้ถูก'  },
  { key: 'C3', name: 'แก้ปัญหาและส่งต่อ'   }
];

const PASS_TOTAL_PCT = 0.70;   // สเปก §4.3
const PASS_C3_PCT    = 0.60;

/* ============================== API ==============================
 * หน้าเว็บอยู่บน GitHub Pages ไม่ได้อยู่ในโปรเจกต์นี้แล้ว
 * Apps Script ทำหน้าที่เดียว: รับคำตอบ ตรวจเฉลย เขียนชีต
 * เฉลยจึงไม่มีทางไปอยู่ใน repo สาธารณะ เพราะมันไม่เคยออกจากที่นี่
 * ================================================================= */

/** เปิด URL ตรง ๆ ในเบราว์เซอร์จะเจออันนี้ -- ใช้เช็กว่า deploy ติดแล้วจริง */
function doGet() {
  return json_({
    ok: true,
    service: 'SSM exam endpoint',
    bank_version: BANK_VERSION,
    roles: Object.keys(ROLES).filter(function (r) { return itemKeysFor_(r).length > 0; })
  });
}

/**
 * รับคำตอบจากหน้าเว็บบน Pages
 *
 * หน้าเว็บส่งมาโดยไม่ตั้ง Content-Type เอง เพื่อให้เป็น simple request
 * ไม่มี preflight OPTIONS ซึ่ง Apps Script ตอบไม่ได้ -- body จึงมาเป็นข้อความดิบ
 *
 * ข้อผิดพลาดต้องตอบกลับเป็น JSON เสมอ ห้ามปล่อยให้ throw ขึ้นไป
 * เพราะ Apps Script จะตอบเป็นหน้า HTML แล้ว r.json() ฝั่ง client จะพังด้วย
 * ข้อความที่ไม่เกี่ยวกับสาเหตุจริง
 */
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return json_({ ok: false, error: 'ไม่มีข้อมูลส่งมา' });
    }
    return json_(submitExam(JSON.parse(e.postData.contents)));
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err) });
  }
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ============================== รับคำตอบ ============================== */

/**
 * เรียกจากหน้าเว็บด้วย google.script.run.submitExam(payload)
 *
 * payload = {
 *   clientToken: 'uuid',            // กันเขียนซ้ำเมื่อ client ลองส่งใหม่
 *   role: 'surveyor', session: 'SSM-SEP26-A', track: 'field',
 *   name: '...', department: '...',
 *   startedAt: 1695000000000, submittedAt: 1695001200000,
 *   responses: { 'EX-SUR-P1-01': [1], 'EX-SUR-P2-03': [0,2,1,3], ... }
 * }
 *
 * คืนค่า { ok, attemptId, submittedAt, answeredCount, totalItems }
 * — ไม่มีคะแนน ไม่มีเฉลย ตามสเปก D15
 */
function submitExam(payload) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) {
    throw new Error('ระบบกำลังบันทึกคำตอบของคนอื่นอยู่ กรุณาลองอีกครั้ง');
  }
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const shA = ensureSheet_(ss, SHEET_ATTEMPTS,  ATTEMPT_HEADERS_);
    const shR = ensureSheet_(ss, SHEET_RESPONSES, RESPONSE_HEADERS_);

    // กันเขียนซ้ำ: ถ้า clientToken นี้เคยบันทึกแล้ว คืนผลเดิม ไม่เขียนใหม่
    const role = (payload && ROLES[payload.role]) ? String(payload.role) : '';
    const keys = itemKeysFor_(role);
    if (!keys.length) throw new Error('ไม่พบชุดข้อสอบของบทบาท: ' + (role || '(ไม่ได้ระบุ)'));

    const token = String((payload && payload.clientToken) || '');
    const prior = token ? findAttemptByToken_(shA, token) : null;
    if (prior) {
      return { ok: true, attemptId: prior.attemptId, submittedAt: prior.submittedAt,
               answeredCount: prior.answeredCount, totalItems: keys.length, duplicate: true };
    }

    const graded   = gradeSubmission_(payload.responses || {}, role);
    const attempt  = nextAttemptId_(shA);
    const tz       = Session.getScriptTimeZone();
    const started  = payload.startedAt   ? new Date(payload.startedAt)   : null;
    const finished = payload.submittedAt ? new Date(payload.submittedAt) : new Date();
    const minutes  = started ? Math.max(1, Math.round((finished - started) / 60000)) : '';

    const c = {};
    graded.byComp.forEach(function (x) { c[x.key] = x; });
    const c3pct = c.C3.max ? c.C3.earned / c.C3.max : 0;
    const pass  = (graded.total / graded.max) >= PASS_TOTAL_PCT && c3pct >= PASS_C3_PCT;

    shA.appendRow([
      attempt,
      String(payload.session || ''),
      String(payload.role || ''),
      String(payload.track || ''),
      BANK_VERSION,
      String(payload.name || ''),
      String(payload.department || ''),
      started ? Utilities.formatDate(started, tz, 'yyyy-MM-dd HH:mm:ss') : '',
      Utilities.formatDate(finished, tz, 'yyyy-MM-dd HH:mm:ss'),
      minutes,
      c.C1.earned, c.C1.max,
      c.C2.earned, c.C2.max,
      c.C3.earned, c.C3.max,
      graded.total, graded.max,
      Math.round(c3pct * 100),
      pass ? 'PASS' : 'FAIL',
      graded.answeredCount,
      token
    ]);

    if (graded.rows.length) {
      const out = graded.rows.map(function (r) {
        return [attempt, r.id, r.part, r.competency, r.difficulty, r.type,
                r.response, r.isCorrect, r.earned, r.points];
      });
      shR.getRange(shR.getLastRow() + 1, 1, out.length, out[0].length).setValues(out);
    }

    return {
      ok: true,
      attemptId: attempt,
      submittedAt: Utilities.formatDate(finished, tz, 'HH:mm'),
      answeredCount: graded.answeredCount,
      totalItems: keys.length
    };
  } finally {
    lock.releaseLock();
  }
}

/* ============================== การให้คะแนน (สเปก §4.8) ============================== */

function gradeSubmission_(responses, role) {
  const keys = itemKeysFor_(role);
  const rows = [];
  let total = 0, answeredCount = 0;
  const comp = {};
  COMPETENCIES.forEach(function (x) { comp[x.key] = { key: x.key, name: x.name, earned: 0, max: 0 }; });

  keys.forEach(function (k) {
    const given  = responses[k.id];
    const has    = given !== undefined && given !== null &&
                   (Array.isArray(given) ? given.length > 0 : true);
    if (has) answeredCount++;

    const s = scoreOne_(k, has ? given : []);
    total += s.earned;
    comp[k.competency].earned += s.earned;
    comp[k.competency].max    += k.points;

    rows.push({
      id: k.id, part: k.part, competency: k.competency, difficulty: k.difficulty, type: k.type,
      response: Array.isArray(given) ? given.join(',') : '',
      isCorrect: s.frac === 1 ? 'TRUE' : (s.frac > 0 ? 'PARTIAL' : 'FALSE'),
      earned: s.earned, points: k.points
    });
  });

  return {
    total: round1_(total),
    max: keys.reduce(function (a, k) { return a + k.points; }, 0),
    byComp: COMPETENCIES.map(function (x) {
      const r = comp[x.key];
      return { key: r.key, name: r.name, earned: round1_(r.earned), max: r.max };
    }),
    rows: rows,
    answeredCount: answeredCount
  };
}

function scoreOne_(k, given) {
  const arr = Array.isArray(given) ? given : [];

  if (k.type === 'ordering') {
    // คะแนนตามสัดส่วนคู่ลำดับที่วางถูกสัมพัทธ์ — สลับติดกัน 1 คู่ยังได้เกือบเต็ม
    const n = k.answer.length;
    const pos = {};
    arr.forEach(function (v, i) { pos[v] = i; });
    let good = 0, pairs = 0;
    for (var a = 0; a < n; a++) {
      for (var b = a + 1; b < n; b++) {
        pairs++;
        if (pos[k.answer[a]] !== undefined && pos[k.answer[b]] !== undefined &&
            pos[k.answer[a]] < pos[k.answer[b]]) good++;
      }
    }
    const frac = pairs ? good / pairs : 0;
    return { earned: round1_(frac * k.points), frac: frac };
  }

  if (k.type === 'multiple') {
    // หักคะแนนตัวเลือกผิด — ไม่งั้นกาหมดทุกช่องได้เต็มเสมอ
    let right = 0, wrong = 0;
    arr.forEach(function (i) { if (k.answer.indexOf(i) >= 0) right++; else wrong++; });
    const frac = Math.max(0, (right - wrong) / k.answer.length);
    return { earned: round1_(frac * k.points), frac: frac };
  }

  const ok = arr.length === 1 && k.answer.indexOf(arr[0]) >= 0;
  return { earned: ok ? k.points : 0, frac: ok ? 1 : 0 };
}

function round1_(n) { return Math.round(n * 10) / 10; }

/* ============================== ชีต ============================== */

const ATTEMPT_HEADERS_ = [
  'attempt_id', 'session', 'role', 'track', 'bank_version', 'name', 'department',
  'started_at', 'submitted_at', 'duration_min',
  'c1_score', 'c1_max', 'c2_score', 'c2_max', 'c3_score', 'c3_max',
  'total', 'total_max', 'c3_pct', 'result', 'answered', 'client_token'
];
const RESPONSE_HEADERS_ = [
  'attempt_id', 'item_id', 'part', 'competency', 'difficulty', 'type',
  'response', 'is_correct', 'points_earned', 'points_max'
];

function ensureSheet_(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(headers);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  } else if (sh.getLastRow() === 0) {
    sh.appendRow(headers);
    sh.setFrozenRows(1);
  }
  return sh;
}

function findAttemptByToken_(sh, token) {
  const last = sh.getLastRow();
  if (last < 2) return null;
  const idx  = ATTEMPT_HEADERS_.indexOf('client_token') + 1;
  const vals = sh.getRange(2, 1, last - 1, ATTEMPT_HEADERS_.length).getValues();
  for (var i = vals.length - 1; i >= 0; i--) {         // ค้นจากท้ายเพราะแถวใหม่มักอยู่ท้าย
    if (String(vals[i][idx - 1]) === token) {
      return {
        attemptId: vals[i][0],
        submittedAt: String(vals[i][ATTEMPT_HEADERS_.indexOf('submitted_at')]).slice(11, 16),
        answeredCount: vals[i][ATTEMPT_HEADERS_.indexOf('answered')]
      };
    }
  }
  return null;
}

function nextAttemptId_(sh) {
  const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd');
  const n = Math.max(0, sh.getLastRow() - 1) + 1;
  return 'EX-' + stamp + '-' + ('00000' + n).slice(-5);
}

/* ============================== การหมดอายุของข้อมูล (D17) ============================== */

/**
 * ชื่อและหน่วยงานเป็นข้อมูลส่วนบุคคล เก็บได้ 1 เดือน
 * ติดตั้งครั้งเดียวด้วย installPurgeTrigger() แล้วมันจะลบให้เองทุกวันตอนตี 2
 *
 * ⚠️ purgeExpired ลบถาวร กู้คืนไม่ได้ — ใช้ purgePreview() ดูก่อนเสมอ
 */
const RETENTION_DAYS = 30;

/** ดูว่าจะลบอะไรบ้าง โดยไม่ลบจริง */
function purgePreview() { return purge_(true); }

/** ลบจริง — ถูกเรียกโดย trigger รายวัน */
function purgeExpired() { return purge_(false); }

function purge_(dryRun) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) { Logger.log('ข้ามรอบนี้ — ล็อกไม่ว่าง'); return 0; }
  try {
    const ss  = SpreadsheetApp.getActiveSpreadsheet();
    const shA = ss.getSheetByName(SHEET_ATTEMPTS);
    const shR = ss.getSheetByName(SHEET_RESPONSES);
    if (!shA || shA.getLastRow() < 2) { Logger.log('ยังไม่มีข้อมูล'); return 0; }

    const cutoff = Date.now() - RETENTION_DAYS * 86400000;
    const colSub = ATTEMPT_HEADERS_.indexOf('submitted_at');
    const rows   = shA.getRange(2, 1, shA.getLastRow() - 1, ATTEMPT_HEADERS_.length).getValues();

    const keep = [], expired = {};
    rows.forEach(function (r) {
      const t = parseStamp_(r[colSub]);
      // อ่านวันที่ไม่ออก = ไม่ลบ · ปลอดภัยไว้ก่อนเสมอเมื่อไม่แน่ใจ
      if (t !== null && t < cutoff) expired[String(r[0])] = true;
      else keep.push(r);
    });

    const n = rows.length - keep.length;
    if (!n) { Logger.log('ไม่มีแถวที่เกิน %s วัน', RETENTION_DAYS); return 0; }

    if (dryRun) {
      Logger.log('ทดลอง — จะลบ %s แถวจาก %s และแถวที่เกี่ยวข้องใน %s · รหัส: %s',
                 n, SHEET_ATTEMPTS, SHEET_RESPONSES, Object.keys(expired).join(', '));
      return n;
    }

    rewrite_(shA, ATTEMPT_HEADERS_, keep);
    if (shR && shR.getLastRow() > 1) {
      const rr = shR.getRange(2, 1, shR.getLastRow() - 1, RESPONSE_HEADERS_.length).getValues();
      rewrite_(shR, RESPONSE_HEADERS_, rr.filter(function (x) { return !expired[String(x[0])]; }));
    }
    Logger.log('ลบแล้ว %s แถวที่เกิน %s วัน', n, RETENTION_DAYS);
    return n;
  } finally {
    lock.releaseLock();
  }
}

function rewrite_(sh, headers, rows) {
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, headers.length).clearContent();
  if (rows.length)         sh.getRange(2, 1, rows.length, headers.length).setValues(rows);
}

/** รับได้ทั้งค่าที่ชีตแปลงเป็นวันที่แล้ว และค่าที่ยังเป็นข้อความ */
function parseStamp_(v) {
  if (v instanceof Date) return v.getTime();
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : null;
}

function installPurgeTrigger() {
  removePurgeTrigger();
  ScriptApp.newTrigger('purgeExpired').timeBased().everyDays(1).atHour(2).create();
  Logger.log('ตั้งแล้ว — ลบข้อมูลที่เกิน %s วัน ทุกวันตอนตี 2', RETENTION_DAYS);
}

function removePurgeTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'purgeExpired') ScriptApp.deleteTrigger(t);
  });
}

/* ============================== ตรวจสภาพระบบ ============================== */

/** รันมือจากเมนู Apps Script เพื่อทดสอบว่าท่อทั้งเส้นทำงาน โดยไม่ต้องเปิดหน้าเว็บ */
function selfTest() {
  const roles = Object.keys(ROLES).filter(function (r) { return itemKeysFor_(r).length > 0; });
  if (!roles.length) throw new Error('ไม่มีบทบาทไหนมีข้อสอบเลย — ตรวจว่าวาง Keys.gs ครบหรือยัง');

  roles.forEach(function (role) {
    const keys = itemKeysFor_(role);

    // 1) ตอบถูกหมด ต้องได้เต็ม
    const perfect = {};
    keys.forEach(function (k) {
      perfect[k.id] = (k.type === 'ordering') ? k.answer.slice() : k.answer.slice(0, 1);
    });
    const g = gradeSubmission_(perfect, role);
    if (g.total !== g.max) throw new Error(role + ': ตอบถูกหมดแล้วไม่ได้เต็ม — ตรวจ Keys.gs');

    // 2) ไม่ตอบเลย ต้องได้ 0
    const blank = {};
    keys.forEach(function (k) { blank[k.id] = []; });
    if (gradeSubmission_(blank, role).total !== 0) throw new Error(role + ': ไม่ตอบแล้วได้คะแนน');

    // 3) เลือกหลายคำตอบแบบกาหมดทุกช่อง ต้องไม่ได้เต็ม (พิสูจน์ว่าการหักคะแนนทำงาน)
    const greedy = {};
    keys.forEach(function (k) {
      greedy[k.id] = (k.type === 'multiple') ? [0, 1, 2, 3, 4] :
                     (k.type === 'ordering' ? k.answer.slice() : k.answer.slice(0, 1));
    });
    const g3 = gradeSubmission_(greedy, role);
    if (g3.total >= g.max) throw new Error(role + ': กาหมดทุกช่องแล้วได้เต็ม — การหักคะแนนไม่ทำงาน');

    // 4) เรียงลำดับกลับหัว ต้องได้ 0 คู่ที่ถูก
    const rev = {};
    keys.forEach(function (k) {
      rev[k.id] = (k.type === 'ordering') ? k.answer.slice().reverse() : k.answer.slice(0, 1);
    });
    const g4 = gradeSubmission_(rev, role);
    const ordRow = g4.rows.filter(function (r) { return r.type === 'ordering'; })[0];
    if (ordRow && ordRow.earned !== 0) throw new Error(role + ': เรียงกลับหัวแล้วยังได้คะแนน');

    Logger.log('%s ผ่าน · %s ข้อ · เต็ม %s/%s · กาหมด %s · แกน %s',
               role, keys.length, g.total, g.max, g3.total, JSON.stringify(g.byComp));
  });
  Logger.log('selfTest ผ่านทั้งหมด (%s บทบาท) · bank_version = %s', roles.length, BANK_VERSION);
  return 'OK';
}
