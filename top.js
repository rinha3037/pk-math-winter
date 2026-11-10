// 링크를 열면 항상 페이지 맨 위부터 보이게 합니다.
// (휴대폰·카카오톡 브라우저가 예전 스크롤 위치나 주소의 #... 위치로 여는 것을 막습니다)
(function () {
  try { if ("scrollRestoration" in history) history.scrollRestoration = "manual"; } catch (e) {}
  var touched = false;
  ["touchstart", "wheel", "keydown", "mousedown"].forEach(function (ev) {
    window.addEventListener(ev, function () { touched = true; }, { passive: true, once: true });
  });
  function toTop() {
    if (touched) return; // 이미 사용자가 스크롤을 시작했으면 건드리지 않음
    try { if (location.hash) history.replaceState(null, "", location.pathname + location.search); } catch (e) {}
    window.scrollTo(0, 0);
  }
  document.addEventListener("DOMContentLoaded", toTop);
  window.addEventListener("load", function () { setTimeout(toTop, 0); });
  window.addEventListener("pageshow", function (e) { if (e.persisted) { touched = false; toTop(); } });
})();
