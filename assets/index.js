/* 진입 페이지: 세션의 역할에 따라 관리자는 대시보드, 그 외는 체크리스트로 보낸다.
   구역장도 대시보드를 볼 수 있지만(자기 구역만) 주 업무는 입력이므로 체크리스트로 보낸다.
   체크리스트 머리말의 그래프 버튼으로 언제든 넘어갈 수 있다. */
(function () {
  'use strict';
  var sb = C41.init();
  (async function () {
    var r = await sb.auth.getSession();
    var target = 'church-checklist.html';
    if (r.data && r.data.session) {
      var app = r.data.session.user.app_metadata || {};
      // 교역자(pastor)는 입력 권한이 없으므로 반드시 대시보드로 보낸다.
      if (app.role === 'admin' || app.role === 'super' || app.role === 'pastor') target = 'church-dashboard.html';
    }
    window.location.replace(target);
  })();
})();
