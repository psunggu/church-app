/* ═══════════════════════════════════════════════════════════════
   41교구 구역보고서 — 공통 모듈 (세 페이지 공용)
   전역 네임스페이스: window.C41

   규칙 (CLAUDE.md 참고)
   · 권한 판단은 서버(get_my_access, RLS)가 한다. 여기서 읽는 role 은 화면 분기용일 뿐이다.
   · DB·URL·메타데이터에서 온 값은 innerHTML 에 넣기 전에 반드시 esc() 를 통과시킨다.
   · 인라인 onclick 금지. data-act + 위임 리스너(bindActions) 만 쓴다.
   · 점수 규칙은 score_items 테이블이 원천이다. DEFAULT_ITEMS 는 테이블을 못 읽을 때의 예비값.
   ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  var C41 = {};
  window.C41 = C41;

  /* ── 설정 · 초기화 ─────────────────────────────────────────── */
  C41.cfg = window.APP_CONFIG || {};
  C41.sb = null;

  C41.fatal = function (title, body) {
    document.getElementById('app').innerHTML =
      '<div class="fatal"><div><h2>⚠️ ' + C41.esc(title) + '</h2><p>' + body + '</p></div></div>';
    throw new Error(title);
  };

  // 클릭재킹 방어. GitHub Pages 는 응답 헤더를 정할 수 없고, CSP 의 frame-ancestors 는
  // <meta> 로 쓰면 브라우저가 무시한다 — 그래서 화면 쪽에서 끊는다.
  // 남의 페이지 안에 투명하게 얹어 놓고 출석 칸을 대신 누르게 만드는 수법을 막는다.
  C41.blockFraming = function (win, doc) {
    win = win || window; doc = doc || document;
    if (win.top === win.self) return false;
    try { win.top.location = win.self.location; }
    catch (e) { if (doc.documentElement) doc.documentElement.innerHTML = ''; }  // 이동이 막히면 내용을 비운다
    return true;
  };

  C41.init = function () {
    var c = C41.cfg;
    if (!c.SB_URL || !c.SB_KEY || /xxxx/.test(c.SB_URL) || /xxxx/.test(c.SB_KEY)) {
      C41.fatal('설정 파일 없음',
        '<code>assets/config.js</code> 가 없거나 값이 비어 있습니다.<br>' +
        '<code>config.example.js</code> 를 복사해 <code>config.js</code> 를 만들고 Supabase URL/키를 넣으세요.' +
        '<pre>window.APP_CONFIG = {\n  SB_URL: \'https://xxx.supabase.co\',\n  SB_KEY: \'sb_publishable_...\'\n};</pre>');
    }
    if (!window.supabase || !window.supabase.createClient) {
      C41.fatal('라이브러리 로드 실패',
        'Supabase 라이브러리를 불러오지 못했습니다.<br>네트워크 상태를 확인하고 새로고침해 주세요.' +
        '<br><br><span style="font-size:12px;color:var(--muted)">계속 반복되면 관리자에게 문의하세요 (SRI 해시 불일치일 수 있습니다)</span>');
    }
    C41.sb = window.supabase.createClient(c.SB_URL, c.SB_KEY);
    return C41.sb;
  };

  /* ── 문자열 · 표시 ─────────────────────────────────────────── */
  var ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  C41.esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) { return ENT[ch]; }); };
  C41.n = function (v) { var x = parseInt(v, 10); return isNaN(x) ? 0 : x; };
  C41.fmt = function (v) { return C41.n(v).toLocaleString('ko-KR'); };
  C41.pct = function (a, b) { return b > 0 ? Math.round(a / b * 100) : 0; };

  var toastTimer = null;
  C41.toast = function (m, ms) {
    var t = document.getElementById('toast'); if (!t) return;
    t.textContent = m; t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, ms || 2400);
  };

  // Supabase/PostgREST 오류를 한국어로. 코드가 없으면 원문.
  C41.errMsg = function (e) {
    if (!e) return '알 수 없는 오류';
    var m = String(e.message || e), code = e.code || '';
    if (/Invalid login credentials/i.test(m)) return '아이디 또는 비밀번호가 올바르지 않습니다';
    if (/Email not confirmed/i.test(m)) return '계정이 아직 활성화되지 않았습니다 — 관리자에게 문의';
    if (/banned/i.test(m)) return '비활성화된 계정입니다 — 관리자에게 문의';
    if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return '네트워크 연결을 확인해 주세요';
    if (/rate limit/i.test(m)) return '요청이 너무 많습니다. 잠시 후 다시 시도하세요';
    if (code === '42501' || /row-level security|permission denied/i.test(m)) return '권한이 없습니다 (' + (code || 'RLS') + ')';
    if (code === '23505') return '이미 존재하는 항목입니다';
    if (code === '23514') return '허용 범위를 벗어난 값입니다';
    if (code === '23503') return '연결된 데이터가 없습니다';
    if (code === 'PGRST116') return '대상이 없습니다';
    if (/JWT expired|invalid claim|refresh_token/i.test(m)) return '세션이 만료되었습니다. 다시 로그인하세요';
    return m + (code ? ' (' + code + ')' : '');
  };

  C41.roleLabel = function (role) {
    return { member: '구역원', assistant: '권찰', leader: '구역장', parish: '구역(공용)',
             pastor: '교역자', admin: '관리자', super: '시스템관리자' }[role] || role || '-';
  };
  C41.enteredLabel = function (e) {
    return { self: '본인', leader: '구역장', assistant: '권찰', parish: '구역 계정', admin: '관리자', legacy: '이전' }[e] || '';
  };

  /* ── 날짜 (KST 고정) ───────────────────────────────────────── */
  var kstFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' });
  C41.kstToday = function () { return kstFmt.format(new Date()); };                 // 'YYYY-MM-DD'
  C41.kstNowLabel = function () {
    var d = new Date();
    var p = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
    return p;
  };
  function toUTC(k) { var p = k.split('-'); return Date.UTC(+p[0], +p[1] - 1, +p[2]); }
  function fromUTC(ms) { var d = new Date(ms); return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0'); }
  C41.addDays = function (k, n) { return fromUTC(toUTC(k) + n * 86400000); };
  C41.diffDays = function (a, b) { return Math.round((toUTC(a) - toUTC(b)) / 86400000); };
  C41.weekSunday = function (k) { var d = new Date(toUTC(k)); return C41.addDays(k, -d.getUTCDay()); }; // 그 주의 일요일(이전 또는 당일)
  C41.currentWeek = function () { return C41.weekSunday(C41.kstToday()); };
  C41.weekLabel = function (k) { var p = k.split('-'); return (+p[1]) + '/' + (+p[2]); };
  C41.weekLabelLong = function (k) { var p = k.split('-'); return p[0] + '년 ' + (+p[1]) + '월 ' + (+p[2]) + '일'; };

  // 주차 목록은 **서버 v_weeks 가 원천**이다 (등록된 구역모임 날짜 ∪ 보고서가 있는 날짜).
  //
  // ★ 예전에는 여기서 "이번 달력주 일요일"을 억지로 끼워 넣고 그 날짜 +6 으로 다시 잘랐다.
  //   그 바람에 두 가지가 틀어졌다(2026-09-12 발견):
  //     · 모임이 없는 9/6 이 탭에 뜨고,
  //     · 정작 다음 날 모임인 **9/13 이 잘려 나갔다** (상한이 9/12 가 되어서).
  //   서버는 `kst_today() + 6` 으로 주는데 클라이언트가 더 좁게 다시 자른 것이 원인이다.
  //   이제 서버가 준 목록을 그대로 쓰고, 같은 기준(오늘+6)으로만 거른다.
  //   뷰를 못 읽었을 때만 예비로 최근 12주를 만든다.
  C41.loadWeeks = async function () {
    var today = C41.kstToday(), limit = C41.addDays(today, 6), keys = {}, out = [];
    var r = await C41.sb.from('v_weeks').select('report_date').order('report_date', { ascending: true });
    if (!r.error && r.data) r.data.forEach(function (x) { keys[String(x.report_date).slice(0, 10)] = true; });
    if (r.error || !r.data || !r.data.length) {
      var cur = C41.currentWeek();
      for (var i = 12; i >= 0; i--) keys[C41.addDays(cur, -7 * i)] = true;
      keys[cur] = true;
    }
    Object.keys(keys).sort().forEach(function (k) {
      if (k <= limit) out.push({ k: k, l: C41.weekLabel(k), future: k > today });
    });
    return out;
  };

  // 대시보드를 볼 수 있는 사람과 그 범위를 한곳에서 정한다.
  //   null  = 전체 구역 (교역자·관리자)
  //   교역자(pastor)는 읽기만 된다 — 쓰기는 RLS 가 막는다. 화면에서도 쓰기 단추를 감춘다.
  //   '4133'= 그 구역만 (구역장)
  //   false = 볼 수 없다 (권찰·구역원·공용계정) → 입력 화면으로 보낸다
  // ★ 이건 화면 분기일 뿐이다. 실제 차단은 RLS 가 한다
  //   (reports_read = is_admin() OR parish_id = jwt_parish(), 분석 뷰는 security_invoker=on).
  // 권찰을 넣지 않은 것은 교역자 결정이다 — 명단은 고칠 수 있어도 현황은 구역장이 본다.
  C41.dashboardScope = function (access) {
    if (!access) return false;
    if (access.isAdmin) return null;
    if (access.role === 'pastor') return null;      // 교역자도 전 구역 (읽기 전용)
    if (access.role === 'leader' && access.parish_id) return String(access.parish_id);
    return false;
  };

  // 처음 열었을 때 고를 주차. 구역모임은 매주가 아니므로 "이번 달력주"는 답이 아니다
  // (모임이 없는 주가 열려 아무것도 못 하거나, 코앞의 모임을 놓친다).
  // 지난 모임 중 가장 최근 것을 고르고, 그런 게 없으면 가장 이른 다가올 모임을 고른다.
  C41.pickWeek = function (weeks, access) {
    if (!weeks || !weeks.length) return C41.currentWeek();
    var today = C41.kstToday(), past = null, pastOk = null, soonOk = null;
    for (var i = 0; i < weeks.length; i++) {
      var k = weeks[i].k || weeks[i];
      var ok = access ? C41.canEditWeek(access, k) : false;
      if (k <= today) { past = k; if (ok) pastOk = k; }
      else if (ok && !soonOk) soonOk = k;
    }
    // 방학이 끼면 "지난 모임 중 가장 최근"이 입력 기간(56일) 밖일 수 있다.
    // 2026-09-12 에 실제로 그랬다 — 6/28 이 열리는데 읽기 전용이라
    // 처음 들어온 구역원은 화면이 고장 난 줄 안다. 고칠 수 있는 주차를 먼저 연다.
    return pastOk || soonOk || past || (weeks[0].k || weeks[0]);
  };

  /* ── 점수 항목 ─────────────────────────────────────────────── */
  // score_items 와 동일한 구조. (마이그레이션 전이거나 조회 실패 시 예비값)
  C41.DEFAULT_ITEMS = [
    { key: 'attendance', label: '출석', grp: 0, grp_label: '출석', type: 'c', points: 20, cap: null, unit: null, max_value: null, leader_only: false, sort_order: 10 },
    { key: 'followup_meeting', label: '후속모임', grp: 0.5, grp_label: '👥 구역장', type: 'c', points: 0, cap: null, unit: null, max_value: null, leader_only: true, sort_order: 20 },
    { key: 'bible_read', label: '성경읽기', grp: 1, grp_label: '📖 성경', type: 'n', points: 1, cap: 30, unit: '장', max_value: 1189, leader_only: false, sort_order: 30 },
    { key: 'bible_write', label: '성경쓰기', grp: 1, grp_label: '📖 성경', type: 'n', points: 5, cap: null, unit: '쪽', max_value: 2000, leader_only: false, sort_order: 40 },
    { key: 'bible_typing', label: '성경타이핑', grp: 1, grp_label: '📖 성경', type: 'n', points: 2, cap: null, unit: '쪽', max_value: 2000, leader_only: false, sort_order: 50 },
    { key: 'memorize', label: '암송', grp: 2, grp_label: '🙏 신앙생활', type: 'c', points: 3, cap: null, unit: null, max_value: null, leader_only: false, sort_order: 60 },
    { key: 'evangelism', label: '전도', grp: 2, grp_label: '🙏 신앙생활', type: 'c', points: 50, cap: null, unit: null, max_value: null, leader_only: false, sort_order: 70 },
    { key: 'nurture', label: '양육', grp: 2, grp_label: '🙏 신앙생활', type: 'c', points: 10, cap: null, unit: null, max_value: null, leader_only: false, sort_order: 80 },
    { key: 'district_service', label: '주차 안내', grp: 3, grp_label: '🤝 구역봉사', type: 'c', points: 100, cap: null, unit: null, max_value: null, leader_only: false, sort_order: 90 },
    { key: 'district_service_saturday', label: '토요관리', grp: 3, grp_label: '🤝 구역봉사', type: 'c', points: 100, cap: null, unit: null, max_value: null, leader_only: false, sort_order: 100 },
    { key: 'district_service_weeding', label: '양화진 묘역 잡초제거', grp: 3, grp_label: '🤝 구역봉사', type: 'c', points: 100, cap: null, unit: null, max_value: null, leader_only: false, sort_order: 110 },
    { key: 'district_service_tombstone', label: '비석닦이 행사', grp: 3, grp_label: '🤝 구역봉사', type: 'c', points: 100, cap: null, unit: null, max_value: null, leader_only: false, sort_order: 120 },
    { key: 'sunday_service_teacher', label: '교사', grp: 3.5, grp_label: '🙋 주일/봉사팀 소속 봉사', type: 'c', points: 30, cap: null, unit: null, max_value: null, leader_only: false, sort_order: 130 },
    { key: 'sunday_service_usher', label: '예배 안내', grp: 3.5, grp_label: '🙋 주일/봉사팀 소속 봉사', type: 'c', points: 30, cap: null, unit: null, max_value: null, leader_only: false, sort_order: 140 },
    { key: 'sunday_service_praise', label: '찬양', grp: 3.5, grp_label: '🙋 주일/봉사팀 소속 봉사', type: 'c', points: 30, cap: null, unit: null, max_value: null, leader_only: false, sort_order: 150 },
    { key: 'sunday_service_choir', label: '성가대', grp: 3.5, grp_label: '🙋 주일/봉사팀 소속 봉사', type: 'c', points: 30, cap: null, unit: null, max_value: null, leader_only: false, sort_order: 160 },
    { key: 'martyr_guide', label: '양화진/순교자 안내', grp: 3.7, grp_label: '🕊️ 양화진/순교자 안내', type: 'c', points: 20, cap: null, unit: null, max_value: null, leader_only: false, sort_order: 170 },
    { key: 'environment', label: '환경보호점수', grp: 4, grp_label: '⭐ 특별항목', type: 'c', points: 100, cap: null, unit: null, max_value: null, leader_only: false, sort_order: 180 },
    { key: 'meeting_place', label: '구역모임 장소', grp: 4, grp_label: '⭐ 특별항목', type: 'c', points: 100, cap: null, unit: null, max_value: null, leader_only: false, sort_order: 190 },
    { key: 'winter_bible', label: '겨울방학 성경읽기', grp: 4, grp_label: '⭐ 특별항목', type: 'n', points: 1, cap: 390, unit: '장', max_value: 1189, leader_only: false, sort_order: 200 },
    { key: 'bible_marathon', label: '성경 통독수련회', grp: 4, grp_label: '⭐ 특별항목', type: 'c', points: 1189, cap: null, unit: null, max_value: null, leader_only: false, sort_order: 210 }
  ];
  C41.items = C41.DEFAULT_ITEMS.slice();
  C41.itemsSource = 'default';

  C41.loadItems = async function () {
    var r = await C41.sb.from('score_items').select('*').eq('active', true).order('sort_order');
    if (!r.error && r.data && r.data.length) {
      C41.items = r.data.map(function (x) { x.grp = Number(x.grp); x.points = C41.n(x.points); x.cap = x.cap == null ? null : C41.n(x.cap); return x; });
      C41.itemsSource = 'db';
    }
    return C41.items;
  };
  C41.itemsFor = function (memberRole) {
    return C41.items.filter(function (it) { return !it.leader_only || memberRole === '구역장'; });
  };
  C41.groups = function (items) {
    var seen = {}, out = [];
    (items || C41.items).forEach(function (it) {
      if (it.key === 'attendance') return; // 출석은 카드 상단의 큰 버튼
      if (!seen[it.grp]) { seen[it.grp] = true; out.push({ g: it.grp, label: it.grp_label }); }
    });
    return out.sort(function (a, b) { return a.g - b.g; });
  };
  C41.itemScore = function (it, v) {
    if (it.type === 'c') return v === 'O' ? it.points : 0;
    var s = C41.n(v) * it.points;
    if (it.cap != null && s > it.cap) s = it.cap;
    return s;
  };
  // row 는 DB 형태({attendance:'O', bible_read: 12, ...}). 서버 compute_score() 와 같은 규칙.
  C41.score = function (row, items) {
    if (!row) return 0;
    var t = 0; (items || C41.items).forEach(function (it) { t += C41.itemScore(it, row[it.key]); }); return t;
  };
  C41.filledCount = function (row, items) {
    if (!row) return 0;
    var c = 0; (items || C41.items).forEach(function (it) { if (it.type === 'c' ? row[it.key] === 'O' : C41.n(row[it.key]) > 0) c++; }); return c;
  };
  C41.emptyRow = function () { var d = {}; C41.items.forEach(function (it) { d[it.key] = it.type === 'c' ? 'X' : 0; }); return d; };

  /* ── 인증 · 접근 ───────────────────────────────────────────── */
  C41.loginEmail = function (id) {
    var dom = C41.cfg.AUTH_DOMAIN || 'c41.app';
    id = String(id || '').trim();
    if (id.indexOf('@') > 0) return id.toLowerCase();
    if (/^\d{4}$/.test(id)) return 'u' + id + '@' + dom;        // 구역 공용 계정 (4133 만 열려 있다)
    if (/^\d{5,8}$/.test(id)) return 'm' + id + '@' + dom;      // 구역원 번호
    // 교역자·관리자 아이디 (admin, admin41 …). 숫자 검사 뒤에 두어야 구역 번호를 가로채지 않는다.
    if (/^[a-z][a-z0-9]{2,19}$/.test(id.toLowerCase())) return id.toLowerCase() + '@' + dom;
    return null;
  };

  // 로그인 직후 한 번. 서버가 JWT(app_metadata)로 판정한 결과를 그대로 쓴다.
  // get_my_access 가 없으면(마이그레이션 전) app_metadata 를 직접 읽는다 — 이때도 user_metadata 는 쓰지 않는다.
  C41.getAccess = async function (user, retried) {
    var r = await C41.sb.rpc('get_my_access');
    var a = null;
    if (!r.error && r.data) a = Array.isArray(r.data) ? r.data[0] : r.data;
    // 권한이 비어 있으면 JWT 가 오래된 것일 수 있다 (마이그레이션 직후 기존 세션).
    // app_metadata 는 토큰을 새로 받아야 반영되므로 한 번 갱신해 다시 읽는다.
    if (!retried && (!a || !a.role)) {
      var rs = await C41.sb.auth.refreshSession();
      if (!rs.error && rs.data && rs.data.session) return C41.getAccess(rs.data.user || user, true);
    }
    if (!a || typeof a !== 'object') {
      var app = (user && user.app_metadata) || {};
      a = { role: app.role || '', parish_id: app.parish_id || null, member_id: app.member_id || null, display_name: (user && user.user_metadata && user.user_metadata.name) || null, legacy: true };
    }
    a.role = String(a.role || '');
    a.parish_id = a.parish_id ? String(a.parish_id) : null;
    a.isAdmin = a.role === 'admin' || a.role === 'super';
    a.isStaff = a.role === 'leader' || a.role === 'assistant' || a.role === 'parish';
    a.isMember = a.role === 'member';
    // 교역자: 전 구역 읽기 전용. 쓰기 권한이 없으므로 2단계 인증을 요구하지 않는다(sql/011).
    a.isPastor = a.role === 'pastor';
    var um = (user && user.user_metadata) || {};
    a.mustChangePw = !!um.must_change_pw;
    // 기본 비밀번호(모두 같은 값)를 쓰는 운영이므로 변경은 강제가 아니라 권유다.
    // 한 번 "나중에"를 고르면 전체 화면으로 다시 막지 않고, 대신 배너가 계속 붙는다.
    a.pwPromptSkipped = !!um.pw_prompt_skipped;
    // 명단에서 빠진 구역원의 계정 (서버 get_my_access 가 member_state 를 돌려준다).
    // 서버 RLS 도 쓰기를 막지만, 화면에서도 즉시 알려 준다.
    a.memberRemoved = String(a.member_state || '') === 'Delete';
    a.today = a.today ? String(a.today).slice(0, 10) : C41.kstToday();
    return a;
  };

  // 서버 report_in_window() 와 같은 규칙 (화면 표시용)
  C41.canEditWeek = function (access, weekKey) {
    if (!access) return false;
    if (access.isAdmin) return true;
    var today = access.today || C41.kstToday();
    if (weekKey > C41.addDays(today, 6)) return false;
    var days = C41.diffDays(today, weekKey);
    if (access.isStaff) return days <= (C41.n(access.window_staff_days) || 56);
    if (access.isMember) return days <= (C41.n(access.window_member_days) || 14);
    return false;
  };

  // 로그아웃은 "눌렀으니 됐다" 로 두면 안 된다.
  // auth-js 의 signOut 은 /logout 이 네트워크 오류·5xx 로 실패하면 예외를 던지지 않고
  // {error} 를 돌려주며 **로컬 세션을 지우지 않는다.** 화면만 로그인 폼으로 바뀌면
  // 본인은 나갔다고 믿는데 토큰은 남는다 — 공용 단말에서 다음 사람이 새로고침하면 그대로 들어간다.
  C41.signOut = async function () {
    var res = null, left = null;
    try { res = await C41.sb.auth.signOut(); } catch (e) { res = { error: e }; }
    try { var g = await C41.sb.auth.getSession(); left = g && g.data && g.data.session; } catch (e) { }
    if (!(res && res.error) && !left) return true;
    try {
      Object.keys(window.localStorage).forEach(function (k) {
        if (/^sb-.*-auth-token/.test(k)) window.localStorage.removeItem(k);
      });
    } catch (e) { }
    // 메모리에 남은 명단·점수까지 확실히 버린다
    if (typeof location !== 'undefined' && location.reload) location.reload();
    return false;
  };

  // 뒤로 가기 한 번으로 직전 화면이 되살아나는 것을 막는다.
  // 인증 확인이 스크립트 첫 실행 때 한 번뿐인데, 브라우저는 떠난 페이지를 bfcache 에 넣고
  // 복원 시에는 스크립트를 다시 돌리지 않는다 — 로그아웃한 뒤 '뒤로' 를 누르면
  // 명단·출석·점수가 그려진 그대로 되살아난다(쓰기는 실패해도 읽기는 이미 화면에 있다).
  C41.guardRestore = function (onLost) {
    function check() {
      if (!C41.sb || !C41.sb.auth) return;
      try {
        C41.sb.auth.getSession().then(function (r) {
          if (!(r && r.data && r.data.session)) onLost();
        }).catch(function () { });
      } catch (e) { }
    }
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('pageshow', function (e) { if (e && e.persisted) check(); });
    }
    if (typeof document !== 'undefined' && document.addEventListener) {
      document.addEventListener('visibilitychange', function () { if (!document.hidden) check(); });
    }
  };

  /* ── 로그인 화면 (공용) ────────────────────────────────────── */
  C41.renderLogin = function (opts) {
    opts = opts || {};
    var app = document.getElementById('app');
    app.innerHTML = '<div class="login"><div class="login-c">'
      + '<div class="logo">⛪</div>'
      + '<h1>' + C41.esc(C41.cfg.APP_NAME || '구역보고서') + '</h1>'
      + '<div class="sub">' + C41.esc(opts.subtitle || '주간 출석 · 봉사 체크') + '</div>'
      + '<div class="err" id="login-err"></div>'
      + '<label for="login-id">아이디</label>'
      // ★ inputmode="numeric" 을 걸지 말 것. iOS 는 그것을 숫자 전용 키패드로 해석하고,
      //   그 키패드에는 영문으로 바꿀 방법이 없다 — 교역자·관리자(admin41 등)가 아이폰에서
      //   아예 로그인하지 못했다(2026-09-12). 구역원은 숫자 키로 한 번 더 누르면 되지만,
      //   영문 아이디는 방법이 없다. 막히는 쪽을 기준으로 고른다.
      + '<input id="login-id" type="text" placeholder="구역 번호 또는 아이디" autocomplete="username" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="next">'
      + '<label for="login-pw">비밀번호</label>'
      + '<input id="login-pw" type="password" placeholder="비밀번호" autocomplete="current-password">'
      + '<button class="btn full" id="login-btn" data-act="doLogin">로그인</button>'
      // 세 갈래를 다 적는다. 구역장이 이 문구만 보고 4133 으로 들어가면 공용 계정(role=parish)이 되어
      // 대시보드가 안 보인다 — 자기 계정이 따로 있다는 것을 여기서 알려 준다.
      // 대부분은 구역원이다. 그 사람들이 읽어야 할 한 줄을 맨 앞에 두고 굵게 뽑는다.
      // 한 문장에 세 갈래를 넣었더니 좁은 화면에서 가운데 정렬로 세 줄이 되며 읽기 나빴다.
      + '<div class="help"><b>구역원은 구역 번호</b>(예: 4133)를 넣으세요.<br>'
      + '구역장은 admin+구역번호(예: admin4133), 권찰은 개인 번호(여섯 자리), 교역자·관리자는 영문 아이디입니다.<br>'
      + '모르시면 구역장 또는 교역자에게 문의하세요. 공용 단말에서는 사용 후 꼭 로그아웃하세요.</div>'
      + '</div></div>';
    var idEl = document.getElementById('login-id'), pwEl = document.getElementById('login-pw');
    if (opts.err) { var e = document.getElementById('login-err'); e.textContent = opts.err; e.style.display = 'block'; }
    idEl.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') pwEl.focus(); });
    pwEl.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') C41.doLogin(); });
    idEl.focus();
  };

  // 로그인 실패 문구.
  // 2026-09: 구역 공용 아이디(네 자리)가 다시 정상 경로가 됐다(sql/012).
  // 대신 **개인 번호(여섯 자리)로 들어오려는 구역원**이 막힌다 — 그 계정들은 잠가 두었다.
  // "비활성화된 계정입니다" 만 보면 무엇을 해야 하는지 알 수 없으므로 그 자리에서 알려 준다.
  C41.loginErrMsg = function (uid, error) {
    var m = String((error && (error.message || error)) || '');
    if (/^\d{5,8}$/.test(String(uid || '').trim()) && /banned/i.test(m)) {
      return '이제 구역 번호로 함께 로그인합니다. 아이디 칸에 구역 번호(네 자리)를 넣으세요. '
           + '모르시면 구역장 또는 교역자에게 문의하세요.';
    }
    return C41.errMsg(error);
  };

  C41._onAuth = null; // 페이지가 설정
  C41.doLogin = async function () {
    var idEl = document.getElementById('login-id'), pwEl = document.getElementById('login-pw');
    var errEl = document.getElementById('login-err'), btn = document.getElementById('login-btn');
    var uid = idEl ? idEl.value.trim() : '', pw = pwEl ? pwEl.value : '';
    function err(m) { if (errEl) { errEl.textContent = m; errEl.style.display = 'block'; } if (btn) { btn.disabled = false; btn.textContent = '로그인'; } }
    if (!uid || !pw) return err('아이디와 비밀번호를 입력하세요');
    var email = C41.loginEmail(uid);
    if (!email) return err('아이디 형식이 올바르지 않습니다');
    if (btn) { btn.disabled = true; btn.textContent = '로그인 중...'; }
    if (errEl) errEl.style.display = 'none';
    var r = await C41.sb.auth.signInWithPassword({ email: email, password: pw });
    if (r.error) return err(C41.loginErrMsg(uid, r.error));
    if (C41._onAuth) await C41._onAuth(r.data.user);
  };

  // 비밀번호 변경 화면 (must_change_pw 는 user_metadata — 권한과 무관한 UX 플래그).
  // opts.skippable 이면 "나중에 하기" 로 지나갈 수 있다. 기본 비밀번호를 모두가 같이 쓰는
  // 운영에서는 변경이 의무가 아니라 권유이기 때문이다. 지나가더라도 배너는 계속 남는다.
  C41.renderChangePw = function (onDone, opts) {
    opts = opts || {};
    var app = document.getElementById('app');
    app.innerHTML = '<div class="login"><div class="login-c">'
      + '<div class="logo">🔐</div><h1>비밀번호 변경</h1>'
      + '<div class="sub">' + (opts.skippable
          ? '지금 쓰는 비밀번호는 <b>구역 모두에게 같은 기본값</b>이라 다른 사람도 알 수 있습니다.<br>'
            + '본인만 아는 비밀번호로 바꾸시길 권합니다. (8자 이상, 숫자만은 불가)'
          : '처음 로그인하셨습니다. 본인만 아는 비밀번호로 바꿔 주세요.<br>(8자 이상, 숫자만은 불가)')
        + '</div>'
      + '<div class="err" id="pw-err"></div>'
      + '<label for="pw1">새 비밀번호</label><input id="pw1" type="password" autocomplete="new-password">'
      + '<label for="pw2">새 비밀번호 확인</label><input id="pw2" type="password" autocomplete="new-password">'
      + '<button class="btn full" id="pw-btn" data-act="doChangePw">변경하고 시작</button>'
      + (opts.skippable
          ? '<button class="btn full ghost" style="margin-top:8px" data-act="skipChangePw">나중에 하기</button>'
          : '')
      + '<button class="btn full ghost" style="margin-top:8px" data-act="doLogout">로그아웃</button>'
      + '</div></div>';
    C41._onPwDone = onDone;
    document.getElementById('pw1').focus();
  };

  // "나중에 하기". must_change_pw 는 일부러 켜 둔 채 둔다 — 그래야 배너가 계속 뜬다.
  // 저장에 실패해도 화면은 통과시킨다(들어가지 못하게 막을 이유가 없다).
  C41.skipChangePw = async function () {
    var btn = document.getElementById('pw-btn'); if (btn) btn.disabled = true;
    var fresh = null;
    try {
      var r = await C41.sb.auth.updateUser({ data: { pw_prompt_skipped: true } });
      fresh = (r && r.data && r.data.user) || null;
      var g = await C41.sb.auth.getUser();
      if (g && g.data && g.data.user) fresh = g.data.user;
    } catch (e) { /* 통과시킨다 */ }
    if (C41._onPwDone) await C41._onPwDone(fresh);
  };

  /* ── 학기표 (교역자 엑셀의 수요일 기준 표) ────────────────────
     구역모임은 주일에 하지만 교역자 표는 **그 주 수요일** 날짜로 열을 세운다.
     9/13(일) 출석 → 9/9(수) 칸. 즉 report_date - 4일. 열은 학기 안의 모든 수요일이고,
     모임이 없는 수요일은 '휴강' 이다. 달력을 여기서 만들되 '주' 이름은 달 안의 순번이다. */
  C41.wedOf = function (sunday) { return C41.addDays(String(sunday).slice(0, 10), -4); };
  // term: {start_date,end_date}, weeks: term_weeks 행들({report_date, note, active}) 또는 날짜 문자열
  // → [{ month: 9, weeks: [{ wed:'2026-09-09', n:1, sunday:'2026-09-13'|null, note:'15과'|null, off:false }] }]
  C41.termGrid = function (term, weeks) {
    var start = String(term.start_date).slice(0, 10), end = String(term.end_date).slice(0, 10);
    var bySun = {};
    (weeks || []).forEach(function (w) {
      var k = String(w && w.report_date ? w.report_date : w).slice(0, 10);
      if (w && w.active === false) return;
      bySun[k] = w && typeof w === 'object' ? w : { report_date: k };
    });
    // 첫 수요일 찾기: 시작일부터 앞으로 가며 요일이 3(수)인 날
    var d = start;
    for (var i = 0; i < 7; i++) { if (new Date(d + 'T00:00:00Z').getUTCDay() === 3) break; d = C41.addDays(d, 1); }
    var months = [], cur = null;
    for (; d <= end; d = C41.addDays(d, 7)) {
      var m = parseInt(d.slice(5, 7), 10);
      if (!cur || cur.month !== m) { cur = { month: m, weeks: [] }; months.push(cur); }
      var sun = C41.addDays(d, 4), tw = bySun[sun] || null;
      cur.weeks.push({ wed: d, n: cur.weeks.length + 1, sunday: tw ? sun : null, note: tw ? (tw.note || null) : null, off: !tw });
    }
    return months;
  };
  // 최근 모임 n 회. **달력주로 거꾸로 세지 말 것** — 구역모임은 매주가 아니다.
  // 여름방학이 끼면 7/5·7/12… 같은 '모임 없는 주'가 줄줄이 만들어져
  // 추이 그래프가 0 으로 바닥을 기고 히트맵에 빈 칸이 늘어선다(2026-09-13 실제로 그랬다).
  // weeks 는 loadWeeks() 가 돌려준 것({k,l,future}) 이거나 날짜 문자열 배열.
  C41.lastMeetings = function (weeks, upto, n) {
    var all = (weeks || []).map(function (w) { return String(w && w.k ? w.k : w).slice(0, 10); })
      .filter(function (k) { return /^\d{4}-\d{2}-\d{2}$/.test(k); })
      .sort();
    var end = String(upto || '').slice(0, 10);
    var upTo = end ? all.filter(function (k) { return k <= end; }) : all;
    // 모임 목록을 못 받았으면 달력주로 물러난다 (아무것도 못 그리는 것보다 낫다)
    if (!upTo.length) {
      var out = [], base = end || C41.kstToday();
      for (var i = n - 1; i >= 0; i--) out.push(C41.addDays(base, -7 * i));
      return out;
    }
    return upTo.slice(Math.max(0, upTo.length - n));
  };

  // 같은 이름이 명단에 이미 있는가. 015 로 유일 규칙이 **살아 있는 명단**에만 걸리게 됐다 —
  // 뺀 사람 이름은 다시 쓸 수 있다. 그런데 대개는 '그분이 돌아온 것'이고, 새 행을 만들면
  // 지난 출석 기록이 끊긴다. 그래서 산 사람(막는다)과 뺀 사람(물어본다)을 나눠 돌려준다.
  C41.findByName = function (list, name) {
    var want = String(name || '').trim(), live = null, gone = null;
    (list || []).forEach(function (m) {
      if (String(m.name || '').trim() !== want) return;
      if (m.state === 'Delete') { if (!gone) gone = m; }
      else if (!live) live = m;
    });
    return { live: live, gone: gone };
  };

  /* ── 명단 정렬 ─────────────────────────────────────────────
     구역장 → 권찰 → 구역원. 직책자는 **등록순 그대로** 두고(둘뿐이라 늘 맨 위가 편하다),
     구역원만 가나다순으로 놓는다 — 스무 명 중에서 이름을 눈으로 찾는 화면이기 때문이다.
     세 화면(체크리스트·대시보드 상세·관리)이 같은 순서를 보여야 해서 여기 한 벌만 둔다. */
  C41.MEMBER_ROLE_ORDER = { '구역장': 0, '권찰': 1 };
  C41.byName = function (a, b) {
    // 'ko' 로케일이 없는 브라우저에서도 한글 음절은 코드포인트 순서가 곧 가나다순이다.
    return String(a || '').localeCompare(String(b || ''), 'ko', { numeric: true });
  };
  C41.sortMembers = function (list, opts) {
    var deletedLast = !!(opts && opts.deletedLast);
    return (list || []).slice().sort(function (a, b) {
      if (deletedLast) {
        var d = (a.state === 'Delete' ? 1 : 0) - (b.state === 'Delete' ? 1 : 0);
        if (d) return d;
      }
      var ra = C41.MEMBER_ROLE_ORDER[a.role], rb = C41.MEMBER_ROLE_ORDER[b.role];
      if (ra == null) ra = 2;
      if (rb == null) rb = 2;
      if (ra !== rb) return ra - rb;
      if (ra !== 2) return 0;   // 직책자끼리는 손대지 않는다 (Array.sort 는 안정 정렬)
      return C41.byName(a.name, b.name);
    });
  };

  // 명단(members)을 고칠 수 있는 사람. **isStaff 를 쓰지 말 것** — 거기엔 구역 공용
  // 계정(parish)이 들어 있고, 그 계정은 구역원 전원이 함께 쓴다(sql/012).
  // 출석 입력은 공용 계정도 하지만, 명단 추가·삭제는 개인 계정을 가진 사람만 한다(sql/013).
  C41.canEditRoster = function (access) {
    if (!access) return false;
    return !!access.isAdmin || access.role === 'leader' || access.role === 'assistant';
  };

  // 비밀번호를 바꾸라고 권할 사람인가.
  // **공용 계정에는 절대 권하지 않는다.** 스무 명이 같은 계정을 쓰므로 한 사람이 바꾸면
  // 나머지가 못 들어온다. 지금은 sql/012 가 must_change_pw 를 꺼 두었지만, 008 을 다시
  // 돌리거나 앞으로 누가 켜면 그 순간 모임 자리에서 열아홉 명이 잠긴다 — 화면에서도 막는다.
  C41.pwPromptNeeded = function (access) {
    if (!access || !access.mustChangePw) return false;
    if (access.role === 'parish') return false;
    return !access.pwPromptSkipped;
  };

  // 아직 기본 비밀번호를 쓰는 사람에게 붙는 경고. 화면마다 render 앞에 끼워 넣는다.
  C41.pwNoticeHtml = function (access) {
    if (!access || !access.mustChangePw) return '';
    // 공용 계정은 여럿이 함께 쓴다. 한 사람이 바꾸면 나머지가 못 들어온다.
    if (access.role === 'parish') return '';
    return '<div class="notice danger" id="pw-notice">'
      + '지금 비밀번호는 <b>모두에게 같은 기본값</b>입니다. 다른 사람이 내 이름으로 입력할 수 있습니다. '
      + '<button class="btn sm" data-act="openChangePw" style="margin-left:6px">비밀번호 바꾸기</button>'
      + '</div>';
  };
  C41.doChangePw = async function () {
    var p1 = document.getElementById('pw1').value, p2 = document.getElementById('pw2').value;
    var errEl = document.getElementById('pw-err'), btn = document.getElementById('pw-btn');
    function err(m) { errEl.textContent = m; errEl.style.display = 'block'; btn.disabled = false; }
    if (p1.length < 8) return err('8자 이상 입력하세요');
    if (/^\d+$/.test(p1)) return err('숫자만으로는 만들 수 없습니다');
    if (p1 !== p2) return err('두 비밀번호가 다릅니다');
    btn.disabled = true;
    var r = await C41.sb.auth.updateUser({ password: p1, data: { must_change_pw: false, pw_prompt_skipped: false, pw_changed_at: new Date().toISOString() } });
    if (r.error) return err(C41.errMsg(r.error));
    C41.toast('비밀번호가 변경되었습니다');
    // ★ 콜백에는 반드시 "갱신된" user 를 넘긴다.
    //   호출부가 로그인 시점의 낡은 user 를 다시 쓰면 must_change_pw 가 여전히 true 로 보여
    //   변경 화면이 무한히 되풀이된다. 서버에서 한 번 더 읽어 확실히 한다.
    var fresh = (r.data && r.data.user) || null;
    try {
      var g = await C41.sb.auth.getUser();
      if (g && g.data && g.data.user) fresh = g.data.user;
    } catch (e) { /* 네트워크 실패 시 updateUser 결과를 쓴다 */ }
    if (C41._onPwDone) await C41._onPwDone(fresh);
  };

  /* ── 2단계 인증 (TOTP) ─────────────────────────────────────── */
  // 관리자 계정 하나가 모든 구역의 읽기·쓰기와 계정 발급 권한을 쥐고 있다.
  // 구역원 비밀번호는 모두 같은 기본값이라 이미 공개된 것이나 마찬가지이므로,
  // 실제로 지켜야 할 자물쇠는 이 계정 하나다. 그래서 관리자에게만 2단계를 요구한다.
  //
  // GoTrue 는 "인증 강도"를 AAL 로 알려준다 — 비밀번호만 통과하면 aal1, 2단계까지면 aal2.
  // ★ 요소를 등록해 두어도 GoTrue 가 스스로 로그인을 막지는 않는다.
  //   aal2 를 요구하는 것은 앱(이 파일)과 RLS 의 몫이다.

  C41.mfaWarn = '';

  // 관리자면 2단계를 통과해야 화면을 준다.
  // true 를 돌려주면 호출부가 계속 그려도 되고, false 면 이 함수가 이미 자기 화면을 그렸다.
  C41.mfaGate = async function (access, retry) {
    if (!access || !access.isAdmin) return true;
    if (!C41.sb.auth.mfa) { C41.mfaWarn = '이 브라우저에서 2단계 인증을 쓸 수 없습니다'; return true; }
    var lv;
    try { lv = await C41.sb.auth.mfa.getAuthenticatorAssuranceLevel(); }
    catch (e) { lv = { error: e }; }
    // 상태를 못 읽었다고 관리 화면을 닫아 버리면 복구가 어려워진다. 경고만 남기고 통과시킨다.
    if (!lv || lv.error || !lv.data) {
      C41.mfaWarn = '2단계 인증 상태를 확인하지 못했습니다: ' + C41.errMsg(lv && lv.error);
      return true;
    }
    C41.mfaWarn = '';
    if (lv.data.currentLevel === 'aal2') return true;        // 이미 통과
    if (lv.data.nextLevel === 'aal2') { C41.renderMfaChallenge(retry); return false; }
    C41.renderMfaEnroll(retry);                              // 아직 등록 전
    return false;
  };

  function mfaShell(title, sub, body) {
    return '<div class="login"><div class="login-c">'
      + '<div class="logo">🔒</div><h1>' + C41.esc(title) + '</h1>'
      + '<div class="sub">' + sub + '</div>'
      + '<div class="err" id="mfa-err"></div>'
      + body
      + '<button class="btn full ghost" style="margin-top:8px" data-act="doLogout">로그아웃</button>'
      + '</div></div>';
  }
  function mfaErr(m) {
    var e = document.getElementById('mfa-err');
    if (e) { e.textContent = m; e.style.display = m ? 'block' : 'none'; }
    var b = document.getElementById('mfa-btn');
    if (b) { b.disabled = false; b.textContent = C41._mfaBtnLabel || '확인'; }
  }
  function codeInput(label) {
    return '<label for="mfa-code">' + C41.esc(label) + '</label>'
      + '<input id="mfa-code" type="text" inputmode="numeric" autocomplete="one-time-code" '
      + 'maxlength="6" placeholder="000000" '
      + 'style="text-align:center;letter-spacing:6px;font-size:22px;font-family:ui-monospace,Menlo,Consolas,monospace">';
  }
  // 여섯 자리를 다 치면 알아서 확인한다. 두 번 보내지 않도록 잠근다.
  function wireCode(submit) {
    var el = document.getElementById('mfa-code');
    if (!el) return;
    el.addEventListener('input', function () {
      el.value = el.value.replace(/\D/g, '').slice(0, 6);
      if (el.value.length === 6 && !C41._mfaBusy) submit();
    });
    el.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !C41._mfaBusy) submit(); });
    el.focus();
  }

  // 등록. 확인된 요소가 이미 있으면 여기 오지 않는다(mfaGate 가 challenge 로 보낸다).
  C41.renderMfaEnroll = function (onDone) {
    C41._mfaBtnLabel = '등록 완료';
    C41._mfaDone = onDone;
    var app = document.getElementById('app');
    app.innerHTML = mfaShell('2단계 인증 등록',
      '관리자 계정은 <b>모든 구역의 명단·출석·계정</b>을 다룹니다. 비밀번호 하나만으로 두기에는 위험이 큽니다.<br>'
      + '휴대폰 인증 앱(Google Authenticator, Authy, 1Password 등)으로 아래 QR을 찍으세요.',
      '<div id="mfa-body" class="desc">준비 중…</div>');
    (async function () {
      var sb = C41.sb;
      // 등록하다 만 요소가 쌓이면 등록 한도에 걸린다. 확인되지 않은 것만 먼저 치운다.
      try {
        var ls = await sb.auth.mfa.listFactors();
        var stale = (((ls.data || {}).all) || []).filter(function (f) { return f.status !== 'verified'; });
        for (var i = 0; i < stale.length; i++) await sb.auth.mfa.unenroll({ factorId: stale[i].id });
      } catch (e) { /* 못 치워도 등록은 시도한다 */ }

      var en = await sb.auth.mfa.enroll({ factorType: 'totp', friendlyName: '관리자 ' + C41.kstToday() });
      var box = document.getElementById('mfa-body');
      if (!box) return;
      if (en.error || !en.data || !en.data.totp) {
        box.innerHTML = '<div class="notice danger">등록을 시작하지 못했습니다: ' + C41.esc(C41.errMsg(en.error)) + '</div>'
          + '<button class="btn full" data-act="mfaRestart" style="margin-top:8px">다시 시도</button>';
        return;
      }
      var t = en.data.totp, qr = String(t.qr_code || '');
      C41._mfaFactorId = en.data.id;
      box.innerHTML =
        (/^data:image\/svg\+xml/.test(qr)
          ? '<img src="' + C41.esc(qr) + '" alt="QR 코드" width="200" height="200" '
            + 'style="display:block;margin:4px auto 10px;background:#fff;border-radius:10px;padding:8px">'
          : '')
        + '<div class="desc" style="text-align:center">QR을 못 읽으면 이 키를 직접 입력하세요<br>'
        + '<span class="pw" style="font-size:15px;letter-spacing:1px;display:inline-block;margin-top:6px">'
        + C41.esc(t.secret || '') + '</span></div>'
        + codeInput('인증 앱에 뜬 6자리 숫자')
        + '<button class="btn full" id="mfa-btn" data-act="doMfaVerify">등록 완료</button>';
      wireCode(function () { C41.doMfaVerify(onDone); });
    })();
  };

  // 등록은 돼 있고 이번 로그인에서 2단계를 아직 안 거쳤을 때
  C41.renderMfaChallenge = function (onDone) {
    C41._mfaBtnLabel = '확인';
    C41._mfaFactorId = null;
    C41._mfaDone = onDone;
    var app = document.getElementById('app');
    app.innerHTML = mfaShell('2단계 인증',
      '인증 앱에 뜬 6자리 숫자를 입력하세요.',
      codeInput('인증 번호') + '<button class="btn full" id="mfa-btn" data-act="doMfaVerify">확인</button>');
    wireCode(function () { C41.doMfaVerify(onDone); });
  };

  C41.doMfaVerify = async function (onDone) {
    if (C41._mfaBusy) return;
    onDone = onDone || C41._mfaDone;
    var el = document.getElementById('mfa-code'), btn = document.getElementById('mfa-btn');
    var code = el ? el.value.replace(/\D/g, '') : '';
    if (code.length !== 6) return mfaErr('6자리 숫자를 입력하세요');
    C41._mfaBusy = true;
    if (btn) { btn.disabled = true; btn.textContent = '확인 중…'; }
    mfaErr('');
    try {
      var fid = C41._mfaFactorId;
      if (!fid) {
        var ls = await C41.sb.auth.mfa.listFactors();
        var v = (((ls.data || {}).all) || []).filter(function (f) { return f.status === 'verified'; })[0];
        if (!v) { C41._mfaBusy = false; return mfaErr('등록된 인증 수단이 없습니다. 로그아웃 후 다시 시도하세요.'); }
        fid = v.id;
      }
      var r = await C41.sb.auth.mfa.challengeAndVerify({ factorId: fid, code: code });
      if (r.error) {
        C41._mfaBusy = false;
        if (el) { el.value = ''; el.focus(); }
        return mfaErr(/invalid|incorrect/i.test(String(r.error.message || ''))
          ? '번호가 맞지 않습니다. 인증 앱의 현재 번호를 다시 확인하세요.'
          : C41.errMsg(r.error));
      }
    } catch (e) {
      C41._mfaBusy = false;
      return mfaErr(C41.errMsg(e));
    }
    C41._mfaBusy = false;
    C41._mfaFactorId = null;
    C41.toast('2단계 인증 완료');
    if (onDone) await onDone();
  };

  /* ── 이벤트 위임 ───────────────────────────────────────────── */
  // #app 은 유지되고 innerHTML 만 바뀌므로 한 번만 등록한다.
  C41.bindActions = function (ACTIONS) {
    var app = document.getElementById('app');
    ACTIONS.doLogin = ACTIONS.doLogin || function () { C41.doLogin(); };
    ACTIONS.doChangePw = ACTIONS.doChangePw || function () { C41.doChangePw(); };
    ACTIONS.skipChangePw = ACTIONS.skipChangePw || function () { C41.skipChangePw(); };
    ACTIONS.doMfaVerify = ACTIONS.doMfaVerify || function () { C41.doMfaVerify(); };
    ACTIONS.mfaRestart = ACTIONS.mfaRestart || function () { C41.renderMfaEnroll(C41._mfaDone); };
    ACTIONS.openChangePw = ACTIONS.openChangePw || function () {
      C41.renderChangePw(C41._pwReturn || function () { window.location.reload(); }, { skippable: true });
    };
    app.addEventListener('click', function (e) {
      var el = e.target.closest('[data-act]');
      if (!el || !app.contains(el) || el.disabled) return;
      var fn = ACTIONS[el.getAttribute('data-act')];
      if (fn) fn(el, e);
    });
    app.addEventListener('change', function (e) {
      var el = e.target.closest('[data-change]');
      if (!el) return;
      var fn = ACTIONS[el.getAttribute('data-change')];
      if (fn) fn(el, e);
    });
    app.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      var el = e.target.closest('[data-enter]');
      if (!el) return;
      var fn = ACTIONS[el.getAttribute('data-enter')];
      if (fn) { e.preventDefault(); fn(el, e); }
    });
  };

  /* ── 유틸 ──────────────────────────────────────────────────── */
  C41.debounce = function (fn, ms) {
    var timers = {};
    return function (key) {
      var args = Array.prototype.slice.call(arguments, 1);
      clearTimeout(timers[key]);
      timers[key] = setTimeout(function () { delete timers[key]; fn.apply(null, [key].concat(args)); }, ms);
    };
  };
  C41.scrollTabIntoView = function () {
    requestAnimationFrame(function () { var a = document.querySelector('.tabs .on'); if (a && a.scrollIntoView) a.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'auto' }); });
  };
  // CSV 다운로드 (BOM 포함 → 엑셀에서 한글 깨짐 방지)
  C41.downloadCsv = function (filename, header, rows) {
    // 엑셀·리브레오피스는 =, +, -, @, 탭, CR 로 시작하는 셀을 **수식으로 실행한다.**
    // 이 CSV 에는 사람이 정한 이름(구역장·참석자 명단)이 실린다 — 이름에 =… 를 넣어 두면
    // 그걸 받아 여는 교역자 PC 에서 터진다. 앞에 작은따옴표를 붙여 글자로 묶는다.
    function cell(v) {
      v = v == null ? '' : String(v);
      if (/^[=+\-@\t\r]/.test(v)) v = "'" + v;
      return /[",\n\r\t]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    }
    var lines = [header.map(cell).join(',')].concat(rows.map(function (r) { return r.map(cell).join(','); }));
    var blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename;
    document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  };
  C41.downloadText = function (filename, text, mime) {
    var blob = new Blob([text], { type: (mime || 'text/plain') + ';charset=utf-8' });
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename;
    document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  };

  /* ── 백업: 값 → SQL 리터럴 ─────────────────────────────────────
     백업의 급소다. 따옴표 하나만 어긋나도 복구가 안 되는데, 그 사실은
     정작 복구하려는 순간에야 드러난다. 그래서 여기만은 테스트로 못 박아 둔다.
     · 문자열: 작은따옴표를 겹쳐 이스케이프. 백슬래시는 건드리지 않는다
       (Postgres 기본 standard_conforming_strings=on 에서 백슬래시는 평범한 글자다).
     · NULL/undefined → NULL,  숫자·불리언 → 그대로,  객체·배열 → jsonb 캐스트.
     · Date → ISO 문자열. */
  C41.sqlLit = function (v) {
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number') return isFinite(v) ? String(v) : 'NULL';
    if (v instanceof Date) return "'" + v.toISOString() + "'";
    if (typeof v === 'object') return "'" + JSON.stringify(v).replace(/'/g, "''") + "'::jsonb";
    return "'" + String(v).replace(/'/g, "''") + "'";
  };

  // 한 테이블을 INSERT 문으로. 열 이름은 행들의 합집합으로 잡아 누락을 막는다.
  // 되살릴 때 이미 있는 행은 건너뛴다 — 같은 파일을 두 번 돌려도 안전하다.
  C41.toInsertSql = function (table, rows, conflictCols) {
    if (!rows || !rows.length) return '-- ' + table + ': 0행\n';
    var cols = [];
    rows.forEach(function (r) {
      Object.keys(r).forEach(function (k) { if (cols.indexOf(k) < 0) cols.push(k); });
    });
    var quoted = cols.map(function (c) { return '"' + c.replace(/"/g, '""') + '"'; }).join(', ');
    var out = ['-- ' + table + ': ' + rows.length + '행',
               'INSERT INTO public."' + table + '" (' + quoted + ') VALUES'];
    var vals = rows.map(function (r) {
      return '  (' + cols.map(function (c) { return C41.sqlLit(r[c]); }).join(', ') + ')';
    });
    out.push(vals.join(',\n'));
    out.push('ON CONFLICT ' + (conflictCols && conflictCols.length
      ? '(' + conflictCols.map(function (c) { return '"' + c + '"'; }).join(', ') + ')' : '')
      + ' DO NOTHING;\n');
    return out.join('\n');
  };

  // opts.dismissable === false 면 바깥을 눌러도 닫히지 않는다.
  // 임시 비밀번호처럼 "닫으면 다시 볼 수 없는" 내용은 실수로 사라지면 안 된다.
  // 모달은 겹칠 수 있다(발급 결과 위에 실패 안내 등). 예전처럼 id='modal' 로 찾아 지우면
  // 겹친 순간 엉뚱한 쪽이 닫히거나, 위에 있는 모달의 닫기가 먹통이 된다.
  // 그래서 id 를 두지 않고, 만든 요소를 그대로 잡아 닫는다.
  C41.modal = function (html, opts) {
    opts = opts || {};
    var bg = document.createElement('div'); bg.className = 'modal-bg';
    bg.innerHTML = '<div class="modal">' + html + '</div>';
    bg.close = function () { if (bg.parentNode) bg.parentNode.removeChild(bg); };
    if (opts.dismissable !== false) bg.addEventListener('click', function (e) { if (e.target === bg) bg.close(); });
    document.body.appendChild(bg);
    return bg;
  };
  // 브라우저 confirm() 은 크롬이 "추가 대화상자 차단" 을 걸면 아무것도 띄우지 않은 채
  // false 를 돌려준다. 그 뒤로는 확인을 거치는 버튼이 전부 죽은 것처럼 보인다
  // — 계정을 스무 개 연달아 발급하는 화면에서는 그 상황이 실제로 생긴다.
  // 같은 역할을 모달로 대신한다. Promise<boolean>.
  C41.ask = function (title, body, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var h = '<h3>' + C41.esc(title) + '</h3>'
        + (body ? '<div class="desc" style="white-space:pre-wrap">' + C41.esc(body) + '</div>' : '')
        + '<div class="acts"><button class="btn sm ghost" data-act="askNo">취소</button>'
        + '<button class="btn sm' + (opts.danger ? ' danger' : '') + '" data-act="askYes">'
        + C41.esc(opts.ok || '확인') + '</button></div>';
      var bg = C41.modal(h, { dismissable: false });
      var done = function (v) { bg.close(); resolve(v); };
      bg.querySelector('[data-act="askNo"]').addEventListener('click', function () { done(false); });
      bg.querySelector('[data-act="askYes"]').addEventListener('click', function () { done(true); });
      bg.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') done(false);
        else if (e.key === 'Enter') done(true);
      });
      var f = bg.querySelector('[data-act="' + (opts.danger ? 'askNo' : 'askYes') + '"]');
      if (f && f.focus) f.focus();
    });
  };

  // 인자로 모달 요소를 주면 그것을, 안 주면 맨 위 모달을 닫는다.
  C41.closeModal = function (bg) {
    if (bg && bg.nodeType === 1 && bg.classList && bg.classList.contains('modal-bg')) {
      if (bg.parentNode) bg.parentNode.removeChild(bg);
      return;
    }
    var all = document.querySelectorAll('.modal-bg');
    if (all.length) all[all.length - 1].remove();
  };
  C41.blockFraming();

})();
