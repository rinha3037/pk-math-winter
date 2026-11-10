/**
 * PK수학 특강 선착순 신청 — 서버 (Google Apps Script)
 *
 * 하는 일
 *  - 학부모 신청 페이지(index.html)의 신청을 받아 이 스프레드시트에 시즌별 탭으로 기록합니다.
 *  - 반별 정원을 잠금(LockService)으로 지켜, 동시에 몰려도 정원을 넘지 않고 초과분은 '대기'로 받습니다.
 *  - 관리자 페이지(admin.html)에 신청·결제 현황을 보여 주고, 상태·결제 체크·메모 수정과 시즌 설정을 처리합니다.
 *
 * 매 시즌(여름·겨울)마다 코드를 고칠 필요는 없습니다. 관리자 페이지의 '시즌 설정'에서 바꾸면 됩니다.
 * 시즌 ID를 바꾸면 새 탭에 따로 쌓이고, 지난 시즌 기록은 그대로 남습니다.
 *
 * 설치 방법은 저장소의 SETUP.md 를 보세요.
 */

// 처음 설치했을 때 쓰는 기본 시즌 (2027 겨울: 6주 · 3타임 × 2시간, 반별 9명)
var DEFAULT_SEASON = {
  id: '2027-겨울',
  title: 'PK수학 겨울방학 특강',
  label: 'WINTER 2027',
  period: '2027.1.11(월) ~ 2.26(금) · 6주',
  openAt: '',   // 접수 시작 'YYYY-MM-DDTHH:mm' (한국시간). 비우면 바로 접수
  closeAt: '',  // 접수 마감. 비우면 계속 접수
  fewAt: 4,     // 남은 자리가 이 수 이하이면 '마감임박' 표시
  contact: '',
  classes: [
    { code: 'T1', name: '1타임 중등부', target: '중1·중2', time: '10:00–12:00', days: '월·수·금', sessions: '18회 36시간', price: 450000, capacity: 9 },
    { code: 'T2', name: '2타임 고등 A반', target: '예비고1~고3', time: '12:00–14:00', days: '월~금 매일', sessions: '30회 60시간', price: 800000, capacity: 9 },
    { code: 'T3', name: '3타임 고등 B반', target: '예비고1~고3', time: '14:00–16:00', days: '월~금 매일', sessions: '30회 60시간', price: 800000, capacity: 9 }
  ]
};

var FIELDS = ['접수번호', '접수일시', '상태', '반코드', '반', '수강료', '학생 이름', '결제안내', '결제완료', '관리자 메모'];
var C = {}; FIELDS.forEach(function (h, i) { C[h] = i + 1; });
var OK = '접수', WAIT = '대기', CANCEL = '취소';
var TZ = 'Asia/Seoul';

// ───────── 진입점 ─────────

function doGet(e) {
  var p = (e && e.parameter) || {};
  return guard_(function () {
    if (p.action === 'lookup') return lookup_(p.name);
    return public_();
  });
}

function doPost(e) {
  var b = {};
  try { b = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) { return json_(bad_('잘못된 요청입니다.')); }
  return guard_(function () {
    if (b.action === 'apply') return apply_(b);
    if (b.action === 'admin') return admin_(b);
    return bad_('잘못된 요청입니다.');
  });
}

function guard_(fn) {
  try { return json_(fn()); }
  catch (err) { return json_({ ok: false, error: 'server', message: '일시적인 오류입니다. 잠시 후 다시 시도해 주세요.', detail: String(err) }); }
}

// ───────── 학부모 ─────────

function public_() {
  var s = season_();
  var counts = counts_(rows_(s.id));
  return {
    ok: true,
    phase: phase_(s),
    season: { title: s.title, label: s.label, period: s.period, openAt: s.openAt, closeAt: s.closeAt, contact: s.contact },
    // 학부모에게는 실제 인원 대신 상태(open / few / full)만 보냅니다.
    classes: s.classes.map(function (c) {
      var left = c.capacity - ((counts[c.code] || {}).ok || 0);
      return {
        code: c.code, name: c.name, target: c.target, time: c.time, days: c.days, sessions: c.sessions, price: c.price,
        state: left <= 0 ? 'full' : left <= s.fewAt ? 'few' : 'open'
      };
    })
  };
}

function apply_(b) {
  if (b.website) return bad_('잘못된 요청입니다.'); // 봇 차단용 숨김 칸
  var s = season_();
  var ph = phase_(s);
  if (ph !== 'open') return { ok: false, error: ph, message: ph === 'before' ? '아직 접수 시작 전입니다.' : '접수가 마감되었습니다.' };

  var cls = s.classes.filter(function (c) { return c.code === b.classCode; })[0];
  var name = clean_(b.studentName, 20);
  if (!cls) return bad_('수강할 반을 선택해 주세요.');
  if (!name) return bad_('학생 이름을 입력해 주세요.');
  if (b.agree !== true) return bad_('개인정보 수집·이용에 동의해 주세요.');

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, error: 'busy', message: '신청이 몰려 처리가 늦어지고 있습니다. 잠시 후 다시 시도해 주세요.' };
  try {
    var sh = sheet_(s.id);
    var rows = rows_(s.id, sh);
    var dup = rows.filter(function (r) { return r.status !== CANCEL && r.name === name; })[0];
    if (dup) return { ok: false, error: 'duplicate', message: name + ' 학생은 이미 신청되어 있습니다. (' + dup.className + ' · ' + dup.status + ')\n반 변경은 학원으로 연락 주세요.' };

    var cnt = counts_(rows)[cls.code] || { ok: 0, wait: 0 };
    var status = cnt.ok < cls.capacity ? OK : WAIT;
    var no = ('00' + (rows.length + 1)).slice(-3);
    var row = [];
    row[C['접수번호'] - 1] = no;
    row[C['접수일시'] - 1] = new Date();
    row[C['상태'] - 1] = status;
    row[C['반코드'] - 1] = cls.code;
    row[C['반'] - 1] = cls.name;
    row[C['수강료'] - 1] = cls.price;
    row[C['학생 이름'] - 1] = name;
    row[C['결제안내'] - 1] = false;
    row[C['결제완료'] - 1] = false;
    row[C['관리자 메모'] - 1] = '';
    sh.appendRow(row);
    sh.getRange(sh.getLastRow(), C['결제안내'], 1, 2).insertCheckboxes();
    SpreadsheetApp.flush();
    var result = { ok: true, status: status, receiptNo: no, className: cls.name, waitingNo: status === WAIT ? cnt.wait + 1 : 0 };
    var after = { ok: cnt.ok + (status === OK ? 1 : 0), wait: cnt.wait + (status === WAIT ? 1 : 0), capacity: cls.capacity };
  } finally {
    lock.releaseLock();
  }
  notify_(s, name, result, after);
  return result;
}

// ───────── 신청 알림 (원장님 이메일) ─────────

/** 새 신청이 들어오면 원장님(이 스크립트를 배포한 구글 계정) 이메일로 알림을 보냅니다. 끄려면 false. */
var NOTIFY_EMAIL = true;
var ADMIN_URL = 'https://rinha3037.github.io/pk-math-winter/admin.html';

function notify_(s, name, r, after) {
  if (!NOTIFY_EMAIL) return;
  try {
    var to = Session.getEffectiveUser().getEmail();
    if (!to) return;
    var head = r.status === OK ? '새 신청' : '대기 신청';
    var subject = '[PK수학 특강] ' + head + ': ' + name + ' · ' + r.className + (r.status === WAIT ? ' (대기 ' + r.waitingNo + '번)' : '');
    var body = [
      s.title + ' 신청이 들어왔습니다.',
      '',
      '학생: ' + name,
      '반: ' + r.className,
      '상태: ' + (r.status === OK ? '접수' : '대기 ' + r.waitingNo + '번'),
      '접수번호: ' + r.receiptNo,
      '시각: ' + Utilities.formatDate(new Date(), TZ, 'M월 d일 HH:mm'),
      '',
      '이 반 현황: 접수 ' + after.ok + ' / 정원 ' + after.capacity + '명' + (after.wait ? ' · 대기 ' + after.wait + '명' : ''),
      '',
      '관리자 페이지: ' + ADMIN_URL
    ].join('\n');
    MailApp.sendEmail({ to: to, subject: subject, body: body, name: 'PK수학 특강 신청' });
  } catch (err) {
    return String(err); // 알림이 실패해도 신청 접수에는 영향을 주지 않습니다.
  }
}

/** 설치 후 Apps Script 편집기에서 한 번 실행하세요: 이메일 권한을 승인하고 테스트 메일을 보냅니다. */
function testNotification() {
  var s = season_();
  var c = s.classes[0];
  var err = notify_(s, '테스트', { status: OK, receiptNo: '000', className: c.name, waitingNo: 0 }, { ok: 0, wait: 0, capacity: c.capacity });
  if (err) throw new Error('알림 메일을 보내지 못했습니다: ' + err);
  Logger.log('테스트 알림 메일을 ' + Session.getEffectiveUser().getEmail() + ' 로 보냈습니다.');
}

function lookup_(name) {
  var n = clean_(name, 20);
  if (!n) return bad_('학생 이름을 입력해 주세요.');
  var s = season_(), order = {}, out = [];
  rows_(s.id).forEach(function (r) {
    if (r.status === WAIT) order[r.code] = (order[r.code] || 0) + 1;
    if (r.name === n) out.push({
      receiptNo: r.no, className: r.className, status: r.status,
      waitingNo: r.status === WAIT ? order[r.code] : 0,
      appliedAt: r.at ? Utilities.formatDate(r.at, TZ, 'M월 d일 HH:mm') : '',
      notified: r.notified, paid: r.paid
    });
  });
  return { ok: true, results: out };
}

// ───────── 관리자 ─────────

function admin_(b) {
  var props = PropertiesService.getScriptProperties();
  var hasPw = !!props.getProperty('ADMIN_HASH');

  if (b.op === 'hasPassword') return { ok: true, hasPassword: hasPw };
  if (b.op === 'setPassword') {
    if (hasPw) return bad_('이미 비밀번호가 설정되어 있습니다.');
    if (!b.key || String(b.key).length < 6) return bad_('비밀번호는 6자 이상으로 정해 주세요.');
    var salt = Utilities.getUuid();
    props.setProperties({ ADMIN_SALT: salt, ADMIN_HASH: hash_(salt, b.key) });
    return { ok: true };
  }
  var auth = auth_(props, b.key);
  if (auth) return auth;

  if (b.op === 'login') return { ok: true };
  if (b.op === 'dashboard') return dashboard_(b.seasonId);
  if (b.op === 'update') return update_(b);
  if (b.op === 'saveSeason') return saveSeason_(b.season);
  if (b.op === 'changePassword') {
    if (!b.newKey || String(b.newKey).length < 6) return bad_('비밀번호는 6자 이상으로 정해 주세요.');
    var s2 = Utilities.getUuid();
    props.setProperties({ ADMIN_SALT: s2, ADMIN_HASH: hash_(s2, b.newKey) });
    return { ok: true };
  }
  return bad_('알 수 없는 요청입니다.');
}

function auth_(props, key) {
  var cache = CacheService.getScriptCache();
  var fails = Number(cache.get('ADMIN_FAILS') || 0);
  if (fails >= 10) return { ok: false, error: 'locked', message: '비밀번호를 여러 번 틀려 10분간 잠겼습니다.' };
  var salt = props.getProperty('ADMIN_SALT'), h = props.getProperty('ADMIN_HASH');
  if (!h) return { ok: false, error: 'nopassword', message: '관리자 비밀번호를 먼저 만들어 주세요.' };
  if (!key || hash_(salt, key) !== h) {
    cache.put('ADMIN_FAILS', String(fails + 1), 600);
    return { ok: false, error: 'auth', message: '비밀번호가 맞지 않습니다.' };
  }
  return null;
}

function dashboard_(seasonId) {
  var s = season_();
  var id = seasonId || s.id;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var seasons = ss.getSheets().filter(isSeasonSheet_).map(function (x) { return x.getName(); });
  if (seasons.indexOf(s.id) < 0) seasons.unshift(s.id);
  var rows = ss.getSheetByName(id) ? rows_(id) : [];
  return {
    ok: true, season: s, viewing: id, seasons: seasons, phase: phase_(s),
    rows: rows.map(function (r) {
      return { no: r.no, at: r.at ? Utilities.formatDate(r.at, TZ, 'MM-dd HH:mm:ss') : '', status: r.status, code: r.code,
        className: r.className, price: r.price, name: r.name, notified: r.notified, paid: r.paid, memo: r.memo };
    })
  };
}

function update_(b) {
  var id = b.seasonId || season_().id;
  var col = { status: C['상태'], notified: C['결제안내'], paid: C['결제완료'], memo: C['관리자 메모'] }[b.field];
  if (!col) return bad_('수정할 수 없는 항목입니다.');
  var v = b.value;
  if (b.field === 'status' && [OK, WAIT, CANCEL].indexOf(v) < 0) return bad_('상태 값이 올바르지 않습니다.');
  if (b.field === 'notified' || b.field === 'paid') v = v === true;
  if (b.field === 'memo') v = clean_(v, 300);

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, error: 'busy', message: '잠시 후 다시 시도해 주세요.' };
  try {
    var r = rows_(id).filter(function (x) { return x.no === String(b.receiptNo); })[0];
    if (!r) return bad_('해당 신청을 찾을 수 없습니다.');
    sheet_(id).getRange(r.rowIndex, col).setValue(v);
    return { ok: true };
  } finally { lock.releaseLock(); }
}

function saveSeason_(x) {
  if (!x || typeof x !== 'object') return bad_('시즌 정보가 없습니다.');
  var id = String(x.id || '').trim();
  if (!id || id.length > 40 || /[\[\]\*\?:\/\\']/.test(id)) return bad_('시즌 ID에는 [ ] * ? : / \\ \' 를 쓸 수 없습니다. 예: 2027-여름');
  var codes = {};
  var classes = (x.classes || []).map(function (c, i) {
    var code = String(c.code || ('T' + (i + 1))).trim().slice(0, 10);
    return {
      code: code, name: clean_(c.name, 30), target: clean_(c.target, 30), time: clean_(c.time, 30),
      days: clean_(c.days, 30), sessions: clean_(c.sessions, 30),
      price: Math.max(0, Math.round(Number(c.price) || 0)), capacity: Math.max(1, Math.round(Number(c.capacity) || 1))
    };
  });
  if (!classes.length) return bad_('반을 하나 이상 넣어 주세요.');
  for (var i = 0; i < classes.length; i++) {
    if (!classes[i].name) return bad_((i + 1) + '번째 반 이름을 입력해 주세요.');
    if (codes[classes[i].code]) return bad_('반 코드가 겹칩니다: ' + classes[i].code);
    codes[classes[i].code] = 1;
  }
  var s = {
    id: id, title: clean_(x.title, 40) || 'PK수학 특강', label: clean_(x.label, 30), period: clean_(x.period, 40),
    openAt: date_(x.openAt), closeAt: date_(x.closeAt), fewAt: Math.max(0, Math.round(Number(x.fewAt) || 0)),
    contact: clean_(x.contact, 30), classes: classes
  };
  PropertiesService.getScriptProperties().setProperty('SEASON', JSON.stringify(s));
  sheet_(id);
  return { ok: true, season: s };
}

/** 비밀번호를 잊었을 때: Apps Script 편집기에서 이 함수를 한 번 실행하면 관리자 페이지에서 새로 만들 수 있습니다. */
function resetAdminPassword() {
  var p = PropertiesService.getScriptProperties();
  p.deleteProperty('ADMIN_HASH'); p.deleteProperty('ADMIN_SALT');
  CacheService.getScriptCache().remove('ADMIN_FAILS');
}

// ───────── 시트 ─────────

function season_() {
  var raw = PropertiesService.getScriptProperties().getProperty('SEASON');
  return raw ? JSON.parse(raw) : DEFAULT_SEASON;
}

function sheet_(id) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(id);
  if (sh) return sh;
  sh = ss.insertSheet(id, 0);
  sh.getRange(1, 1, 1, FIELDS.length).setValues([FIELDS]).setFontWeight('bold').setBackground('#1a7cf5').setFontColor('#ffffff');
  sh.setFrozenRows(1);
  sh.getRange('B:B').setNumberFormat('yyyy-mm-dd hh:mm:ss');
  sh.getRange('A:A').setNumberFormat('@');
  sh.getRange('F:F').setNumberFormat('#,##0');
  sh.getRange(2, C['상태'], sh.getMaxRows() - 1, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList([OK, WAIT, CANCEL], true).build());
  return sh;
}

function isSeasonSheet_(sh) {
  return !!sh && sh.getLastColumn() >= FIELDS.length && sh.getRange(1, 1, 1, 3).getValues()[0].join('|') === FIELDS.slice(0, 3).join('|');
}

function rows_(id, sheet) {
  var sh = sheet || sheet_(id);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var out = [];
  sh.getRange(2, 1, last - 1, FIELDS.length).getValues().forEach(function (v, i) {
    var g = function (h) { return v[C[h] - 1]; };
    if (g('접수번호') === '') return;
    out.push({
      rowIndex: i + 2, no: String(g('접수번호')), at: g('접수일시') instanceof Date ? g('접수일시') : null,
      status: String(g('상태')).trim(), code: String(g('반코드')).trim(), className: String(g('반')),
      price: Number(g('수강료')) || 0, name: String(g('학생 이름')).trim(),
      notified: g('결제안내') === true, paid: g('결제완료') === true, memo: String(g('관리자 메모'))
    });
  });
  return out;
}

function counts_(rows) {
  var c = {};
  rows.forEach(function (r) {
    c[r.code] = c[r.code] || { ok: 0, wait: 0 };
    if (r.status === OK) c[r.code].ok++;
    else if (r.status === WAIT) c[r.code].wait++;
  });
  return c;
}

// ───────── 도우미 ─────────

function phase_(s) {
  var now = Date.now();
  if (s.openAt && now < kst_(s.openAt)) return 'before';
  if (s.closeAt && now >= kst_(s.closeAt)) return 'closed';
  return 'open';
}
function kst_(v) { return new Date(String(v).length <= 16 ? v + ':00+09:00' : v).getTime(); }
function date_(v) { v = String(v || '').trim(); return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v) ? v : ''; }

function clean_(v, max) {
  var s = String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
  return s.replace(/^[=+\-@]+/, ''); // 시트 수식 주입 방지
}

function hash_(salt, key) {
  return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + ':' + key, Utilities.Charset.UTF_8));
}

function bad_(m) { return { ok: false, error: 'invalid', message: m }; }
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
