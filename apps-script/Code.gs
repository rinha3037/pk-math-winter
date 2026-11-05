/**
 * PK수학 2027 겨울방학 특강 — 선착순 신청 접수 백엔드 (Google Apps Script)
 *
 * - 학부모 신청 페이지(index.html)에서 보낸 신청서를 이 스프레드시트의 '신청내역' 시트에 한 줄씩 기록합니다.
 * - 반별 정원(9명)을 서버에서 잠금(LockService)으로 확인하므로, 동시에 신청이 몰려도 정원을 넘지 않습니다.
 * - 정원이 찬 뒤 들어온 신청은 '대기'로 접수됩니다.
 * - 관리자는 시트에서 상태(접수/대기/취소)와 결제안내·결제완료 체크박스를 직접 관리합니다.
 *   상태를 '취소'로 바꾸면 그 자리가 남은 자리로 다시 잡히고, 대기자를 '접수'로 바꾸면 정원에 포함됩니다.
 *
 * 설치 방법은 저장소 루트의 SETUP.md 를 보세요.
 */

// ───────── 설정 ─────────

/** 반 구성: 운영안 4번 '타임별 실제 배치안' 기준. 코드(T1~T3)는 index.html 과 같아야 합니다. */
var CLASSES = {
  T1: { name: '1타임 · 중등부 (월·수·금)', capacity: 9, grades: ['중1', '중2'] },
  T2: { name: '2타임 · 고등부 A반 (월~금)', capacity: 9, grades: ['중3', '고1', '고2', '고3'] },
  T3: { name: '3타임 · 고등부 B반 (월~금)', capacity: 9, grades: ['중3', '고1', '고2', '고3'] }
};

/**
 * 접수 시작 시각(한국시간). 비워두면 바로 접수가 열립니다.
 * 예: '2026-12-01T10:00:00+09:00'
 */
var OPEN_AT = '';

/** 접수 마감 시각. 비워두면 마감하지 않습니다. */
var CLOSE_AT = '';

/** 남은 자리가 이 수 이하이면 페이지에 '마감임박'으로 표시합니다. 정확한 인원 수는 학부모에게 공개하지 않습니다. */
var FEW_AT = 3;

var SHEET_NAME = '신청내역';
var RECEIPT_PREFIX = 'W27-';

var HEADERS = [
  '접수번호', '접수일시', '상태', '반', '반코드',
  '학생 이름', '학교', '학년', '학부모 이름', '학부모 연락처', '학생 연락처',
  '요청사항', '결제안내', '결제완료', '관리자 메모'
];
var COL = {}; // 헤더 이름 → 열 번호(1부터)
HEADERS.forEach(function (h, i) { COL[h] = i + 1; });

var STATUS_OK = '접수';
var STATUS_WAIT = '대기';
var STATUS_CANCEL = '취소';

// ───────── 웹앱 진입점 ─────────

function doGet(e) {
  var p = (e && e.parameter) || {};
  try {
    if (p.action === 'lookup') return json_(lookup_(p.name, p.phone));
    return json_(status_());
  } catch (err) {
    return json_({ ok: false, error: 'server', message: String(err) });
  }
}

function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    return json_(apply_(body));
  } catch (err) {
    return json_({ ok: false, error: 'server', message: String(err) });
  }
}

// ───────── 동작 ─────────

function status_() {
  // 학부모 페이지에는 반별 상태(접수중/마감임박/마감)만 내보내고, 실제 신청 인원은 내보내지 않습니다.
  var counts = counts_(rows_());
  var classes = {};
  Object.keys(CLASSES).forEach(function (code) {
    var remaining = CLASSES[code].capacity - counts[code].ok;
    classes[code] = { state: remaining <= 0 ? 'full' : remaining <= FEW_AT ? 'few' : 'open' };
  });
  var w = window_();
  return { ok: true, open: w.open, phase: w.phase, openAt: OPEN_AT, closeAt: CLOSE_AT, classes: classes };
}

function apply_(b) {
  // 봇 차단용 숨김 칸
  if (b.website) return { ok: false, error: 'invalid', message: '잘못된 요청입니다.' };

  var w = window_();
  if (!w.open) {
    return { ok: false, error: w.phase, message: w.phase === 'before' ? '아직 접수 시작 전입니다.' : '접수가 마감되었습니다.' };
  }

  var f = {
    classCode: clean_(b.classCode, 4),
    studentName: clean_(b.studentName, 20),
    school: clean_(b.school, 30),
    grade: clean_(b.grade, 4),
    parentName: clean_(b.parentName, 20),
    parentPhone: phone_(b.parentPhone),
    studentPhone: b.studentPhone ? phone_(b.studentPhone) : '',
    note: clean_(b.note, 300),
    agree: b.agree === true
  };

  var cls = CLASSES[f.classCode];
  if (!cls) return bad_('수강할 반을 선택해 주세요.');
  if (!f.studentName) return bad_('학생 이름을 입력해 주세요.');
  if (!f.school) return bad_('학교를 입력해 주세요.');
  if (cls.grades.indexOf(f.grade) < 0) return bad_(f.grade ? f.grade + ' 학생은 이 반을 신청할 수 없습니다.' : '학년을 선택해 주세요.');
  if (!f.parentName) return bad_('학부모 이름을 입력해 주세요.');
  if (!f.parentPhone) return bad_('학부모 연락처를 정확히 입력해 주세요. (예: 010-1234-5678)');
  if (b.studentPhone && !f.studentPhone) return bad_('학생 연락처 형식을 확인해 주세요.');
  if (!f.agree) return bad_('개인정보 수집·이용에 동의해 주세요.');

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) {
    return { ok: false, error: 'busy', message: '신청이 몰려 처리가 지연되고 있습니다. 잠시 후 다시 시도해 주세요.' };
  }
  try {
    var sheet = sheet_();
    var rows = rows_(sheet);

    // 같은 학생(이름+학부모 연락처)이 이미 접수/대기 중이면 중복 신청 차단
    var dup = rows.filter(function (r) {
      return r.status !== STATUS_CANCEL && r.studentName === f.studentName && r.parentPhone === f.parentPhone;
    })[0];
    if (dup) {
      return {
        ok: false, error: 'duplicate',
        message: '이미 신청된 학생입니다. (' + dup.receiptNo + ' · ' + dup.className + ' · ' + dup.status + ')\n반 변경은 학원으로 연락 주세요.'
      };
    }

    var counts = counts_(rows);
    var status = counts[f.classCode].ok < cls.capacity ? STATUS_OK : STATUS_WAIT;
    var receiptNo = RECEIPT_PREFIX + ('000' + (rows.length + 1)).slice(-3);
    var now = new Date();

    var row = [];
    row[COL['접수번호'] - 1] = receiptNo;
    row[COL['접수일시'] - 1] = now;
    row[COL['상태'] - 1] = status;
    row[COL['반'] - 1] = cls.name;
    row[COL['반코드'] - 1] = f.classCode;
    row[COL['학생 이름'] - 1] = f.studentName;
    row[COL['학교'] - 1] = f.school;
    row[COL['학년'] - 1] = f.grade;
    row[COL['학부모 이름'] - 1] = f.parentName;
    row[COL['학부모 연락처'] - 1] = f.parentPhone;
    row[COL['학생 연락처'] - 1] = f.studentPhone;
    row[COL['요청사항'] - 1] = f.note;
    row[COL['결제안내'] - 1] = false;
    row[COL['결제완료'] - 1] = false;
    row[COL['관리자 메모'] - 1] = '';

    sheet.appendRow(row);
    var r = sheet.getLastRow();
    sheet.getRange(r, COL['결제안내'], 1, 2).insertCheckboxes();
    sheet.getRange(r, COL['접수일시']).setNumberFormat('yyyy-mm-dd hh:mm:ss');
    SpreadsheetApp.flush();

    var waitingNo = status === STATUS_WAIT ? counts[f.classCode].wait + 1 : 0;
    return {
      ok: true, status: status, receiptNo: receiptNo, className: cls.name,
      waitingNo: waitingNo
    };
  } finally {
    lock.releaseLock();
  }
}

/** 학부모가 이름+연락처로 본인 신청 상태를 확인. 개인정보는 돌려주지 않습니다. */
function lookup_(name, phone) {
  var n = clean_(name, 20), ph = phone_(phone);
  if (!n || !ph) return bad_('학생 이름과 학부모 연락처를 정확히 입력해 주세요.');
  var rows = rows_();
  var waitOrder = {};
  var found = [];
  rows.forEach(function (r) {
    if (r.status === STATUS_WAIT) waitOrder[r.classCode] = (waitOrder[r.classCode] || 0) + 1;
    if (r.studentName === n && r.parentPhone === ph) {
      found.push({
        receiptNo: r.receiptNo, className: r.className, status: r.status,
        waitingNo: r.status === STATUS_WAIT ? waitOrder[r.classCode] : 0,
        appliedAt: r.appliedAt ? Utilities.formatDate(r.appliedAt, 'Asia/Seoul', 'M월 d일 HH:mm') : '',
        paymentNotified: r.paymentNotified, paid: r.paid
      });
    }
  });
  return { ok: true, results: found };
}

// ───────── 시트 ─────────

function sheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_NAME);
  if (sh) return sh;
  sh = ss.insertSheet(SHEET_NAME, 0);
  sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS])
    .setFontWeight('bold').setBackground('#1e3a5f').setFontColor('#ffffff');
  sh.setFrozenRows(1);
  sh.getRange('B:B').setNumberFormat('yyyy-mm-dd hh:mm:ss');
  sh.getRange('J:K').setNumberFormat('@');
  var rule = SpreadsheetApp.newDataValidation()
    .requireValueInList([STATUS_OK, STATUS_WAIT, STATUS_CANCEL], true).build();
  sh.getRange(2, COL['상태'], sh.getMaxRows() - 1, 1).setDataValidation(rule);
  [90, 140, 60, 190, 60, 80, 110, 50, 80, 120, 120, 220, 70, 70, 200]
    .forEach(function (wd, i) { sh.setColumnWidth(i + 1, wd); });
  return sh;
}

function rows_(sheet) {
  var sh = sheet || sheet_();
  var last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, HEADERS.length).getValues()
    .filter(function (v) { return v[COL['접수번호'] - 1] !== ''; })
    .map(function (v) {
      return {
        receiptNo: String(v[COL['접수번호'] - 1]),
        appliedAt: v[COL['접수일시'] - 1] instanceof Date ? v[COL['접수일시'] - 1] : null,
        status: String(v[COL['상태'] - 1]).trim(),
        className: String(v[COL['반'] - 1]),
        classCode: String(v[COL['반코드'] - 1]).trim(),
        studentName: String(v[COL['학생 이름'] - 1]).trim(),
        parentPhone: phone_(v[COL['학부모 연락처'] - 1]),
        paymentNotified: v[COL['결제안내'] - 1] === true,
        paid: v[COL['결제완료'] - 1] === true
      };
    });
}

function counts_(rows) {
  var c = {};
  Object.keys(CLASSES).forEach(function (k) { c[k] = { ok: 0, wait: 0 }; });
  rows.forEach(function (r) {
    if (!c[r.classCode]) return;
    if (r.status === STATUS_OK) c[r.classCode].ok++;
    else if (r.status === STATUS_WAIT) c[r.classCode].wait++;
  });
  return c;
}

/** 시트 상단 메뉴: 시트를 처음 만들 때 쓰세요. */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('PK수학 특강')
    .addItem('신청내역 시트 만들기', 'setupSheet')
    .addToUi();
}

function setupSheet() {
  sheet_();
  SpreadsheetApp.getActiveSpreadsheet().toast('신청내역 시트가 준비되었습니다.');
}

// ───────── 도우미 ─────────

function window_() {
  var now = Date.now();
  if (OPEN_AT && now < new Date(OPEN_AT).getTime()) return { open: false, phase: 'before' };
  if (CLOSE_AT && now >= new Date(CLOSE_AT).getTime()) return { open: false, phase: 'closed' };
  return { open: true, phase: 'open' };
}

function clean_(v, max) {
  // 수식 주입 방지: = + - @ 로 시작하는 값은 앞에 ' 를 붙입니다.
  var s = String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function phone_(v) {
  var d = String(v == null ? '' : v).replace(/\D/g, '');
  if (!/^01[016789]\d{7,8}$/.test(d)) return '';
  return d.length === 11 ? d.slice(0, 3) + '-' + d.slice(3, 7) + '-' + d.slice(7)
                         : d.slice(0, 3) + '-' + d.slice(3, 6) + '-' + d.slice(6);
}

function bad_(message) { return { ok: false, error: 'invalid', message: message }; }

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
