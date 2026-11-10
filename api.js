// 신청 페이지와 관리자 페이지가 함께 쓰는 서버 연결.
// SCRIPT_URL 이 비어 있으면 브라우저 안에서만 동작하는 미리보기 서버를 씁니다 (실제 저장 안 됨).
window.PK = (function () {
  const URL_ = (window.PK_CONFIG || {}).SCRIPT_URL || "";
  const DEMO = !URL_;

  const real = {
    async get(params) {
      const r = await fetch(URL_ + "?" + new URLSearchParams({ ...params, t: Date.now() }));
      return r.json();
    },
    async post(body) {
      // text/plain 으로 보내야 CORS 사전요청 없이 Apps Script 로 전달됩니다.
      const r = await fetch(URL_, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify(body) });
      return r.json();
    },
  };

  const api = DEMO ? demo() : {
    publicInfo: () => real.get({ action: "public" }),
    apply: (b) => real.post({ action: "apply", ...b }),
    lookup: (name) => real.get({ action: "lookup", name }),
    admin: (b) => real.post({ action: "admin", ...b }),
  };

  // ───── 미리보기 서버 (Code.gs 와 같은 규칙) ─────
  function demo() {
    const KEY = "pk-special-demo-v2";
    const DEFAULT_SEASON = {
      id: "2027-겨울", title: "PK수학 겨울방학 특강", label: "WINTER 2027", period: "2027.1.11(월) ~ 2.26(금) · 6주",
      openAt: "", closeAt: "", fewAt: 4, contact: "",
      classes: [
        { code: "T1", name: "1타임 중등부", target: "중1·중2", time: "10:00–12:00", days: "월·수·금", sessions: "18회 36시간", price: 450000, capacity: 9 },
        { code: "T2", name: "2타임 고등 A반", target: "예비고1~고3", time: "12:00–14:00", days: "월~금 매일", sessions: "30회 60시간", price: 800000, capacity: 9 },
        { code: "T3", name: "3타임 고등 B반", target: "예비고1~고3", time: "14:00–16:00", days: "월~금 매일", sessions: "30회 60시간", price: 800000, capacity: 9 },
      ],
    };
    const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } };
    const save = (d) => { try { localStorage.setItem(KEY, JSON.stringify(d)); } catch {} };
    const later = (v) => new Promise((r) => setTimeout(() => r(v), 250));
    const bad = (message) => later({ ok: false, error: "invalid", message });
    const season = (d) => d.season || DEFAULT_SEASON;
    const rows = (d, id) => ((d.data = d.data || {})[id] = d.data[id] || []);
    const counts = (list) => { const c = {}; list.forEach((r) => { c[r.code] = c[r.code] || { ok: 0, wait: 0 }; if (r.status === "접수") c[r.code].ok++; else if (r.status === "대기") c[r.code].wait++; }); return c; };
    const kst = (v) => new Date(v.length <= 16 ? v + ":00+09:00" : v).getTime();
    const phase = (s) => (s.openAt && Date.now() < kst(s.openAt) ? "before" : s.closeAt && Date.now() >= kst(s.closeAt) ? "closed" : "open");
    const pad = (n) => String(n).padStart(3, "0");
    const fmt = (iso, long) => { const d = new Date(iso), z = (n) => String(n).padStart(2, "0");
      return long ? `${d.getMonth() + 1}월 ${d.getDate()}일 ${z(d.getHours())}:${z(d.getMinutes())}` : `${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`; };

    return {
      demo: true,
      publicInfo() {
        const d = load(), s = season(d), c = counts(rows(d, s.id));
        return later({ ok: true, phase: phase(s),
          season: { title: s.title, label: s.label, period: s.period, openAt: s.openAt, closeAt: s.closeAt, contact: s.contact },
          classes: s.classes.map((k) => { const left = k.capacity - ((c[k.code] || {}).ok || 0);
            return { ...k, capacity: undefined, state: left <= 0 ? "full" : left <= s.fewAt ? "few" : "open" }; }) });
      },
      apply(b) {
        const d = load(), s = season(d), list = rows(d, s.id);
        if (phase(s) !== "open") return bad(phase(s) === "before" ? "아직 접수 시작 전입니다." : "접수가 마감되었습니다.");
        const cls = s.classes.find((k) => k.code === b.classCode), name = String(b.studentName || "").trim();
        if (!cls) return bad("수강할 반을 선택해 주세요.");
        if (!name) return bad("학생 이름을 입력해 주세요.");
        const dup = list.find((r) => r.status !== "취소" && r.name === name);
        if (dup) return bad(`${name} 학생은 이미 신청되어 있습니다. (${dup.className} · ${dup.status})\n반 변경은 학원으로 연락 주세요.`);
        const c = counts(list)[cls.code] || { ok: 0, wait: 0 }, status = c.ok < cls.capacity ? "접수" : "대기";
        const r = { no: pad(list.length + 1), at: new Date().toISOString(), status, code: cls.code, className: cls.name, price: cls.price, name, notified: false, paid: false, memo: "" };
        list.push(r); save(d);
        return later({ ok: true, status, receiptNo: r.no, className: cls.name, waitingNo: status === "대기" ? c.wait + 1 : 0 });
      },
      lookup(name) {
        const d = load(), s = season(d), order = {}, out = [];
        rows(d, s.id).forEach((r) => { if (r.status === "대기") order[r.code] = (order[r.code] || 0) + 1;
          if (r.name === String(name).trim()) out.push({ receiptNo: r.no, className: r.className, status: r.status, waitingNo: r.status === "대기" ? order[r.code] : 0, appliedAt: fmt(r.at, true), notified: r.notified, paid: r.paid }); });
        return later({ ok: true, results: out });
      },
      admin(b) {
        const d = load();
        if (b.op === "hasPassword") return later({ ok: true, hasPassword: !!d.pw });
        if (b.op === "setPassword") { if (d.pw) return bad("이미 비밀번호가 설정되어 있습니다."); if (!b.key || b.key.length < 6) return bad("비밀번호는 6자 이상으로 정해 주세요."); d.pw = b.key; save(d); return later({ ok: true }); }
        if (!d.pw) return later({ ok: false, error: "nopassword", message: "관리자 비밀번호를 먼저 만들어 주세요." });
        if (b.key !== d.pw) return later({ ok: false, error: "auth", message: "비밀번호가 맞지 않습니다." });
        const s = season(d);
        if (b.op === "login") return later({ ok: true });
        if (b.op === "dashboard") {
          const id = b.seasonId || s.id, ids = Object.keys(d.data || {});
          if (!ids.includes(s.id)) ids.unshift(s.id);
          return later({ ok: true, season: s, viewing: id, seasons: ids, phase: phase(s), rows: rows(d, id).map((r) => ({ ...r, at: fmt(r.at) })) });
        }
        if (b.op === "update") {
          const r = rows(d, b.seasonId || s.id).find((x) => x.no === String(b.receiptNo));
          if (!r) return bad("해당 신청을 찾을 수 없습니다.");
          const f = { status: "status", notified: "notified", paid: "paid", memo: "memo" }[b.field];
          if (!f) return bad("수정할 수 없는 항목입니다.");
          r[f] = b.value; save(d); return later({ ok: true });
        }
        if (b.op === "saveSeason") {
          const x = b.season;
          if (!x.id || /[\[\]\*\?:\/\\']/.test(x.id)) return bad("시즌 ID에는 [ ] * ? : / \\ ' 를 쓸 수 없습니다. 예: 2027-여름");
          if (!x.classes.length) return bad("반을 하나 이상 넣어 주세요.");
          d.season = x; rows(d, x.id); save(d); return later({ ok: true, season: x });
        }
        if (b.op === "changePassword") { if (!b.newKey || b.newKey.length < 6) return bad("비밀번호는 6자 이상으로 정해 주세요."); d.pw = b.newKey; save(d); return later({ ok: true }); }
        return bad("알 수 없는 요청입니다.");
      },
    };
  }

  return { ...api, DEMO };
})();
