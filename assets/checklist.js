/* ═══════════════════════════════════════════════════════════════
   체크리스트 — 구역원(본인) / 구역장·권찰(구역 전체) / 관리자(?parish=XXXX)
   · 항목을 누르면 그 구역원의 행만 즉시 저장한다 (행 단위 PATCH, 전체 덮어쓰기 없음)
   · 총점·입력자(entered_by)는 서버 트리거가 계산한다. 화면 점수는 미리보기.
   ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  var sb = C41.init(), esc = C41.esc;

  var S = {
    access: null, ready: false, loading: false, adminMode: false,
    pid: '', pname: '', week: '', weeks: [], editable: true,
    members: [],          // [{id, name, role, member_code, user_id}]
    rows: {},             // member_id -> reports 행 (DB 형태, id 포함)
    dirty: {}, dirtyWeek: {}, inflight: {}, pending: {}, status: {}, lastSaved: null, loadedAt: 0,
    expanded: null, view: 'list', addingMember: false, myMemberId: null
  };

  /* ── 데이터 ─────────────────────────────────────────────────── */
  async function loadMembers() {
    var r = await sb.from('members').select('*').eq('parish_id', S.pid).order('created_at');
    if (r.error) { C41.toast('구역원 조회 실패: ' + C41.errMsg(r.error)); S.members = []; return; }
    // 구역장 → 권찰 → 구역원(가나다순). 순서는 C41.sortMembers 한곳에서 정한다.
    S.allMembers = r.data || [];   // 삭제된 사람 포함 — 이름 중복 판정에 쓴다
    S.members = C41.sortMembers(S.allMembers.filter(function (m) { return m.state !== 'Delete'; }));
    S.myMemberId = S.access.member_id && S.members.some(function (m) { return m.id === S.access.member_id; }) ? S.access.member_id : null;
  }
  async function loadWeek() {
    S.loading = true; render();
    var r = await sb.from('reports').select('*').eq('report_date', S.week).eq('parish_id', S.pid);
    S.rows = {}; S.dirty = {}; S.dirtyWeek = {}; S.status = {};
    if (r.error) C41.toast('조회 실패: ' + C41.errMsg(r.error));
    (r.data || []).forEach(function (row) {
      if (row.state === 'Delete') return;
      var mid = row.member_id;
      if (!mid) { // 마이그레이션 전 행(이름만 있음) — 이름으로 연결
        var m = S.members.filter(function (x) { return x.name === row.member_name; })[0]; if (!m) return; mid = m.id; row.member_id = mid;
      }
      S.rows[mid] = row;
    });
    S.editable = C41.canEditWeek(S.access, S.week);
    S.loadedAt = Date.now();
    S.loading = false; render();
  }
  function rowOf(mid) {
    if (!S.rows[mid]) { var m = memberById(mid); S.rows[mid] = Object.assign(C41.emptyRow(), { member_id: mid, member_name: m ? m.name : '', role: m ? m.role : '구역원' }); }
    return S.rows[mid];
  }
  function memberById(mid) { for (var i = 0; i < S.members.length; i++) if (S.members[i].id === mid) return S.members[i]; return null; }
  function memberIdx(mid) { for (var i = 0; i < S.members.length; i++) if (S.members[i].id === mid) return i; return -1; }
  function canEditMember(mid) {
    if (!S.editable) return false;
    if (S.access.isAdmin || S.access.isStaff) return true;
    return S.access.isMember && mid === S.myMemberId;
  }

  /* ── 저장 (행 단위, 디바운스) ──────────────────────────────── */
  // 타이머를 직접 들고 있는 이유: 주차를 옮기기 전에 대기 중인 저장을 강제로 내보내야 한다.
  // C41.debounce 에는 취소·flush 수단이 없다.
  var saveTimers = {};
  function scheduleSave(mid) {
    clearTimeout(saveTimers[mid]);
    saveTimers[mid] = setTimeout(function () { delete saveTimers[mid]; persist(mid); }, 450);
  }
  function flushSaves() {
    var ids = Object.keys(saveTimers);
    ids.forEach(function (mid) { clearTimeout(saveTimers[mid]); delete saveTimers[mid]; });
    return Promise.all(ids.map(function (mid) { return persist(mid); }));
  }
  // 전송 중인 요청까지 끝나기를 기다린다. 다 끝났으면 true.
  async function waitIdle(ms) {
    var t0 = Date.now();
    while (hasUnsaved() && Date.now() - t0 < ms) await new Promise(function (r) { setTimeout(r, 100); });
    return !hasUnsaved();
  }

  function setVal(mid, key, val) {
    if (!canEditMember(mid)) { C41.toast(S.editable ? '본인 항목만 수정할 수 있습니다' : '입력 기간이 지난 주차입니다'); return false; }
    var row = rowOf(mid); row[key] = val;
    S.dirty[mid] = S.dirty[mid] || {}; S.dirty[mid][key] = val;
    S.dirtyWeek[mid] = S.week;   // 이 수정이 어느 주차의 것인지 붙잡아 둔다
    setStatus(mid, 'saving'); scheduleSave(mid);
    updateRowInfo(mid); updateSummary();
    return true;
  }

  async function persist(mid) {
    if (S.inflight[mid]) { S.pending[mid] = true; return; }
    var patch = S.dirty[mid]; if (!patch) return;
    // ★ 이 수정이 만들어진 주차와 지금 화면의 주차가 다르면 보내지 않는다.
    //   S.rows 와 row.id 는 이미 새 주차의 것이어서, 그대로 보내면 엉뚱한 주차에 기록된다.
    //   주차 이동 전 flushSaves() 가 비우므로 정상 경로에서는 여기 오지 않는다(최후의 방어선).
    var wk = S.dirtyWeek[mid] || S.week;
    if (wk !== S.week) {
      setStatus(mid, 'error', C41.weekLabel(wk) + ' 주차 입력이 저장되지 않았습니다. 그 주차로 돌아가 다시 입력해 주세요.');
      return;
    }
    delete S.dirty[mid]; delete S.dirtyWeek[mid]; S.inflight[mid] = true;
    var row = rowOf(mid), r;
    if (row.id) {
      r = await sb.from('reports').update(patch).eq('id', row.id).select().single();
      if (r.error && r.error.code === 'PGRST116') r.error = { message: '권한이 없거나 입력 기간이 지났습니다', code: 'RLS' };
    } else {
      var full = Object.assign(C41.emptyRow(), row, patch, { report_date: wk, parish_id: S.pid, member_id: mid, state: 'Insert', recorded_by: S.access.role });
      delete full.id; delete full.total_score; delete full.updated_at; delete full.updated_by; delete full.entered_by; delete full.recorded_at;
      r = await sb.from('reports').insert(full).select().single();
      if (r.error && r.error.code === '23505') { // 다른 사람이 먼저 만든 행 → id 를 찾아 PATCH 로 전환
        var q = await sb.from('reports').select('id').eq('report_date', wk).eq('member_id', mid).maybeSingle();
        if (q.data) { row.id = q.data.id; r = await sb.from('reports').update(patch).eq('id', row.id).select().single(); }
      }
    }
    S.inflight[mid] = false;
    if (r.error) {
      S.dirty[mid] = Object.assign(patch, S.dirty[mid] || {});
      S.dirtyWeek[mid] = wk;
      setStatus(mid, 'error', C41.errMsg(r.error));
      return;
    }
    // 서버 결과(총점, 입력자, id) 반영. 그 사이 새로 바뀐 값은 로컬이 우선.
    Object.assign(row, r.data); if (S.dirty[mid]) Object.assign(row, S.dirty[mid]);
    S.lastSaved = new Date();
    setStatus(mid, S.dirty[mid] ? 'saving' : 'saved');
    updateRowInfo(mid); updateSummary();
    if (S.pending[mid]) { S.pending[mid] = false; persist(mid); }
  }
  function retryAll() { Object.keys(S.dirty).forEach(function (mid) { setStatus(mid, 'saving'); persist(mid); }); }
  function hasUnsaved() { return Object.keys(S.dirty).length > 0 || Object.keys(S.inflight).some(function (k) { return S.inflight[k]; }); }
  window.addEventListener('beforeunload', function (e) { if (hasUnsaved()) { e.preventDefault(); e.returnValue = ''; } });

  /* ── 부분 갱신 ─────────────────────────────────────────────── */
  function setStatus(mid, st, msg) {
    S.status[mid] = st;
    var i = memberIdx(mid), el = document.getElementById('st-' + i);
    if (el) { el.className = 'badge ' + (st === 'saved' ? 'ok' : st === 'error' ? 'danger' : 'warn'); el.textContent = st === 'saved' ? '저장됨' : st === 'error' ? '실패' : '저장 중'; el.title = msg || ''; }
    updateGlobalStatus(msg);
  }
  function updateGlobalStatus(msg) {
    var el = document.getElementById('gstatus'); if (!el) return;
    var errs = Object.keys(S.status).filter(function (k) { return S.status[k] === 'error'; }).length;
    var saving = Object.keys(S.status).filter(function (k) { return S.status[k] === 'saving'; }).length;
    if (errs) el.innerHTML = '<span class="st-error">저장 실패 ' + errs + '건' + (msg ? ' · ' + esc(msg) : '') + '</span> <button class="btn sm ghost" data-act="retryAll">재시도</button>';
    else if (saving) el.innerHTML = '<span class="st-saving">저장 중…</span>';
    else if (S.lastSaved) el.innerHTML = '<span class="st-saved">✓ 저장됨 ' + String(S.lastSaved.getHours()).padStart(2, '0') + ':' + String(S.lastSaved.getMinutes()).padStart(2, '0') + '</span>';
    else el.textContent = S.editable ? '항목을 누르면 바로 저장됩니다' : '조회만 가능한 주차입니다';
  }
  function updateRowInfo(mid) {
    var i = memberIdx(mid); if (i < 0) return;
    var m = S.members[i], row = S.rows[mid], items = C41.itemsFor(m.role), sc = C41.score(row, items), fc = C41.filledCount(row, items);
    var mi = document.getElementById('mi-' + i), ms = document.getElementById('ms-' + i), ck = document.getElementById('ck-' + i), big = document.getElementById('big-' + i);
    if (mi) mi.textContent = rowInfoText(m, row, fc, sc);
    if (ms) { ms.textContent = sc > 0 ? sc : ''; ms.style.display = sc > 0 ? '' : 'none'; }
    if (ck) ck.classList.toggle('on', row && row.attendance === 'O');
    if (big) { big.classList.toggle('on', row && row.attendance === 'O'); big.textContent = row && row.attendance === 'O' ? '✓ 출석했습니다' : '이번 주 출석 체크'; }
    var rowEl = document.getElementById('row-' + i); if (rowEl) rowEl.classList.toggle('missing', !(row && row.id));
  }
  function rowInfoText(m, row, fc, sc) {
    var parts = [];
    if (fc > 0) parts.push(fc + '개 항목 · ' + sc + '점');
    if (row && row.id && row.entered_by && row.entered_by !== 'legacy') parts.push(C41.enteredLabel(row.entered_by) + ' 입력');
    if (!(row && row.id)) parts.push('미입력');
    return parts.join(' · ');
  }
  function updateSummary() {
    var M = S.members, ac = 0, ts = 0, att = [];
    M.forEach(function (m) { var r = S.rows[m.id]; if (r && r.attendance === 'O') { ac++; att.push(m.name); } ts += C41.score(r, C41.itemsFor(m.role)); });
    var a = document.getElementById('s-ac'), t = document.getElementById('s-ts'), at = document.getElementById('s-att'), miss = document.getElementById('s-miss');
    if (a) a.textContent = ac; if (t) t.textContent = C41.fmt(ts);
    if (at) { at.innerHTML = att.length ? '<b>참석: </b>' + esc(att.join(', ')) : ''; at.style.display = att.length ? 'block' : 'none'; }
    if (miss) { var n = M.filter(function (m) { return !(S.rows[m.id] && S.rows[m.id].id); }).length; miss.textContent = n ? '미입력 ' + n + '명' : '전원 입력'; miss.className = 'badge ' + (n ? 'warn' : 'ok'); }
  }

  /* ── 조작 ─────────────────────────────────────────────────── */
  function toggleAtt(mid) { var row = rowOf(mid); setVal(mid, 'attendance', row.attendance === 'O' ? 'X' : 'O'); }
  function toggleItem(mid, key) {
    var row = rowOf(mid), nv = row[key] === 'O' ? 'X' : 'O';
    if (!setVal(mid, key, nv)) return;
    var el = document.getElementById('tb-' + memberIdx(mid) + '-' + esc(key));
    if (el) { el.classList.toggle('on', nv === 'O'); el.textContent = nv === 'O' ? 'O' : 'X'; }
  }
  function numAdj(mid, key, d) {
    var row = rowOf(mid), it = C41.items.filter(function (x) { return x.key === key; })[0];
    var v = Math.max(0, C41.n(row[key]) + d); if (it && it.max_value != null) v = Math.min(v, it.max_value);
    if (!setVal(mid, key, v)) return;
    var el = document.getElementById('ni-' + memberIdx(mid) + '-' + esc(key)); if (el) el.value = v;
  }
  function numSet(mid, key, raw) {
    var it = C41.items.filter(function (x) { return x.key === key; })[0];
    var v = Math.max(0, C41.n(raw)); if (it && it.max_value != null && v > it.max_value) { v = it.max_value; C41.toast('최대 ' + it.max_value + it.unit); }
    if (!setVal(mid, key, v)) return;
    var el = document.getElementById('ni-' + memberIdx(mid) + '-' + esc(key)); if (el && String(el.value) !== String(v)) el.value = v;
  }
  async function addMember() {
    var ne = document.getElementById('add-name'), re = document.getElementById('add-role'); if (!ne) return;
    var name = ne.value.trim(), role = re ? re.value : '구역원';
    if (!name) return C41.toast('이름을 입력하세요');
    if (!/^[가-힣a-zA-Z0-9 ]{1,20}$/.test(name)) return C41.toast('이름은 한글·영문·숫자 20자 이내');
    // S.members 는 삭제된 사람을 걸러 낸 목록이라 '뺀 사람 이름'을 못 본다 — 원본으로 확인한다.
    var dup = C41.findByName(S.allMembers || S.members, name);
    if (dup.live) return C41.toast('이미 등록된 이름입니다');
    if (dup.gone && !await C41.ask('예전에 있던 이름입니다',
        name + ' 님은 전에 명단에서 빠진 적이 있습니다.\n\n'
        + '같은 분이면 교역자에게 복구를 요청하세요 — 지난 출석 기록이 이어집니다.\n'
        + '다른 분이면 그대로 추가하셔도 됩니다.',
        { ok: '그대로 추가' })) return;
    var r = await sb.from('members').insert({ parish_id: S.pid, name: name, role: role }).select('*').single();
    if (r.error) return C41.toast('추가 실패: ' + C41.errMsg(r.error));
    S.members.push(r.data); S.addingMember = false; C41.toast(name + ' 추가됨 (번호 ' + (r.data.member_code || '-') + ')'); render();
  }
  async function delMember(mid) {
    var m = memberById(mid); if (!m) return;
    // 명단 수정은 구역장·권찰·관리자 (sql/013 의 members_update 와 같은 범위).
    // 구역 공용 계정은 제외 — 구역원 전원이 함께 쓰는 계정이다.
    if (!C41.canEditRoster(S.access)) return C41.toast('명단은 구역장·권찰이 본인 번호로 로그인해서 바꿉니다');
    if (!await C41.ask('명단에서 빼기', m.name + ' 님을 명단에서 뺄까요?\n출석 이력은 보존되며 관리자가 복구할 수 있습니다.', { ok: '빼기', danger: true })) return;
    var r = await sb.from('members').update({ state: 'Delete' }, { count: 'exact' }).eq('id', mid);
    if (r.error) return C41.toast('삭제 실패: ' + C41.errMsg(r.error));
    if (r.count === 0) return C41.toast('삭제 권한이 없습니다');
    S.members = S.members.filter(function (x) { return x.id !== mid; }); delete S.rows[mid]; S.expanded = null;
    // 이 화면은 관리자 전용 Edge Function 을 부를 수 없어 로그인 계정 자체는 남는다.
    // 서버(can_write_report)가 명단에서 빠진 구역원의 쓰기를 막고 로그인 시 안내가 뜨지만,
    // 계정을 완전히 없애려면 교역자가 관리 화면에서 정리해야 한다.
    C41.toast(m.name + ' 삭제됨 (이력 보존)' + (m.user_id ? ' · 로그인 계정 정리는 교역자에게 요청하세요' : ''), m.user_id ? 4200 : 2400);
    render();
  }
  async function setWeek(k) {
    if (k === S.week || S.loading) return;
    // 주차를 바꾸기 전에 대기 중인 저장을 먼저 내보낸다.
    // 안 그러면 450ms 디바운스에 걸려 있던 입력이 "새로 고른 주차"에 기록된다.
    await flushSaves();
    if (!(await waitIdle(5000))) {
      if (!await C41.ask('저장되지 않은 입력', '아직 저장되지 않은 입력이 있습니다.\n지금 다른 주차로 이동하면 그 입력은 사라집니다.', { ok: '이동', danger: true })) return;
      S.dirty = {}; S.dirtyWeek = {};
    }
    S.week = k; S.expanded = S.access.isMember ? S.myMemberId : null; await loadWeek();
  }

  /* ── 렌더 ─────────────────────────────────────────────────── */
  function render() { var sy = window.scrollY; _render(); requestAnimationFrame(function () { window.scrollTo(0, sy); }); }

  function headerHtml() {
    var who = S.access.isAdmin ? '관리자' : (S.access.member_name ? S.access.member_name + ' · ' : '') + C41.roleLabel(S.access.role);
    var acts = '<div class="acts">'
      + (!S.adminMode && S.access.role === 'leader'
          ? '<button class="btn icon" data-act="backToDashboard" title="우리 구역 현황" aria-label="우리 구역 현황"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/></svg></button>'
          : '')
      + (S.adminMode ? '<button class="btn icon" data-act="backToDashboard" title="대시보드로" aria-label="대시보드로"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M19 12H5M12 19l-7-7 7-7"/></svg></button>' : '')
      + '<button class="btn icon" data-act="reload" title="새로고침" aria-label="새로고침"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 12a9 9 0 11-2.6-6.4M21 3v6h-6"/></svg></button>'
      + '<button class="btn icon" data-act="doLogout" title="로그아웃" aria-label="로그아웃"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/></svg></button>'
      + '</div>';
    return '<div class="hd"><div><h1>' + esc(S.pname) + '</h1><p>' + esc(C41.weekLabelLong(S.week)) + ' 주일 · ' + esc(C41.kstNowLabel()) + '</p><div class="who">' + esc(who) + '</div></div>' + acts + '</div>';
  }
  function tabsHtml() {
    var h = '<div class="tabs" id="tabbar">';
    S.weeks.forEach(function (w) { h += '<button class="' + (w.k === S.week ? 'on' : '') + (w.future ? ' future' : '') + '" data-act="setWeek" data-w="' + esc(w.k) + '">' + esc(w.l) + '</button>'; });
    return h + '</div>';
  }
  function itemsHtml(m, mi, row, editable) {
    var h = '', items = C41.itemsFor(m.role), dis = editable ? '' : ' disabled';
    C41.groups(items).forEach(function (g) {
      var its = items.filter(function (it) { return it.grp === g.g && it.key !== 'attendance'; }); if (!its.length) return;
      h += '<div class="gh">' + esc(g.label) + '</div>';
      its.forEach(function (it) {
        var sub = it.type === 'n' ? (it.unit + '당 ' + it.points + '점' + (it.cap != null ? ' · 최대 ' + it.cap + '점' : '')) : (it.points + '점');
        h += '<div class="ir"><div class="il">' + esc(it.label) + '<span>' + esc(sub) + '</span></div>';
        if (it.type === 'c') h += '<button class="tb' + (row[it.key] === 'O' ? ' on' : '') + '" id="tb-' + mi + '-' + esc(it.key) + '" data-act="toggleItem" data-mid="' + esc(m.id) + '" data-k="' + esc(it.key) + '"' + dis + ' aria-pressed="' + (row[it.key] === 'O') + '">' + (row[it.key] === 'O' ? 'O' : 'X') + '</button>';
        else h += '<div class="nw"><button class="pm" data-act="numAdj" data-mid="' + esc(m.id) + '" data-k="' + esc(it.key) + '" data-d="-1"' + dis + ' aria-label="감소">−</button>'
          + '<input class="ni" id="ni-' + mi + '-' + esc(it.key) + '" type="number" inputmode="numeric" min="0"' + (it.max_value != null ? ' max="' + it.max_value + '"' : '') + ' value="' + (C41.n(row[it.key]) || '') + '" placeholder="0" data-change="numSet" data-mid="' + esc(m.id) + '" data-k="' + esc(it.key) + '"' + dis + '>'
          + '<button class="pm" data-act="numAdj" data-mid="' + esc(m.id) + '" data-k="' + esc(it.key) + '" data-d="1"' + dis + ' aria-label="증가">+</button></div>';
        h += '</div>';
      });
    });
    return h;
  }
  function rowHtml(m, mi) {
    var row = S.rows[m.id] || C41.emptyRow(), items = C41.itemsFor(m.role), sc = C41.score(row, items), fc = C41.filledCount(row, items);
    var open = S.expanded === m.id, isMe = m.id === S.myMemberId, editable = canEditMember(m.id), st = S.status[m.id];
    var h = '<div class="mr' + (open ? ' open' : '') + (isMe ? ' me' : '') + (row.id ? '' : ' missing') + '" id="row-' + mi + '">';
    h += '<div class="mc" data-act="toggle" data-mid="' + esc(m.id) + '">';
    h += '<div class="ck' + (row.attendance === 'O' ? ' on' : '') + '" id="ck-' + mi + '" data-act="toggleAtt" data-mid="' + esc(m.id) + '" role="checkbox" aria-checked="' + (row.attendance === 'O') + '" aria-label="' + esc(m.name) + ' 출석"><svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M5 13l4 4L19 7" stroke="#fff" stroke-width="3" stroke-linecap="round"/></svg></div>';
    h += '<div class="mn">' + esc(m.name) + (m.role !== '구역원' ? '<span class="badge">' + esc(m.role) + '</span>' : '') + (isMe ? '<span class="badge info">나</span>' : '')
      + '<span class="badge ' + (st === 'saved' ? 'ok' : st === 'error' ? 'danger' : 'warn') + '" id="st-' + mi + '"' + (st ? '' : ' hidden') + '>' + (st === 'saved' ? '저장됨' : st === 'error' ? '실패' : '저장 중') + '</span>'
      + '<small id="mi-' + mi + '">' + esc(rowInfoText(m, row, fc, sc)) + '</small></div>';
    h += '<span class="sc" id="ms-' + mi + '" style="display:' + (sc > 0 ? '' : 'none') + '">' + (sc > 0 ? sc : '') + '</span>';
    h += '<svg class="arr" width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M6 9l6 6 6-6" stroke="#8a8578" stroke-width="2" stroke-linecap="round"/></svg></div>';
    h += '<div class="dt">' + itemsHtml(m, mi, row, editable);
    if (C41.canEditRoster(S.access)) h += '<div class="rowtools"><button class="btn sm danger" data-act="delMember" data-mid="' + esc(m.id) + '">명단에서 빼기</button></div>';
    h += '</div></div>';
    return h;
  }
  function myCardHtml(m, mi) {
    var row = S.rows[m.id] || C41.emptyRow(), editable = canEditMember(m.id), items = C41.itemsFor(m.role), sc = C41.score(row, items), fc = C41.filledCount(row, items), st = S.status[m.id];
    var h = '<div class="mr open me" id="row-' + mi + '"><div class="mc" style="cursor:default"><div class="mn" style="font-size:18px">' + esc(m.name) + (m.role !== '구역원' ? '<span class="badge">' + esc(m.role) + '</span>' : '')
      + '<span class="badge ' + (st === 'saved' ? 'ok' : st === 'error' ? 'danger' : 'warn') + '" id="st-' + mi + '"' + (st ? '' : ' hidden') + '>' + (st === 'saved' ? '저장됨' : st === 'error' ? '실패' : '저장 중') + '</span>'
      + '<small id="mi-' + mi + '">' + esc(rowInfoText(m, row, fc, sc)) + '</small></div><span class="sc" id="ms-' + mi + '" style="display:' + (sc > 0 ? '' : 'none') + '">' + (sc > 0 ? sc : '') + '</span></div>';
    h += '<div class="dt" style="display:block"><button class="tb big' + (row.attendance === 'O' ? ' on' : '') + '" id="big-' + mi + '" data-act="toggleAtt" data-mid="' + esc(m.id) + '"' + (editable ? '' : ' disabled') + ' aria-pressed="' + (row.attendance === 'O') + '">' + (row.attendance === 'O' ? '✓ 출석했습니다' : '이번 주 출석 체크') + '</button>';
    h += itemsHtml(m, mi, row, editable) + '</div></div>';
    return h;
  }
  function summaryHtml() {
    var M = S.members, h = '<div class="sv">', ts = 0;
    var order = C41.items.slice().sort(function (a, b) { return (a.key === 'attendance' ? -1 : b.key === 'attendance' ? 1 : a.leader_only ? -1 : b.leader_only ? 1 : 0); });
    order.forEach(function (it) {
      var cnt = 0, sum = 0;
      M.forEach(function (m) { if (it.leader_only && m.role !== '구역장') return; var r = S.rows[m.id]; if (!r) return; var v = r[it.key]; if (it.type === 'c' ? v === 'O' : C41.n(v) > 0) { cnt++; sum += C41.itemScore(it, v); } });
      ts += sum;
      h += '<div class="sr"><div><div class="sn">' + esc(it.label) + (it.leader_only ? ' <span class="badge gray">구역장</span>' : '') + '</div><div class="sm">' + cnt + '명</div></div><div><div class="sv2">' + C41.fmt(sum) + '</div><div class="sv3">점</div></div></div>';
    });
    h += '<div class="sr total"><div class="sn" style="font-size:16px">합계</div><div class="sv2" style="font-size:22px">' + C41.fmt(ts) + '점</div></div></div>';
    return h;
  }
  function reportHtml() {
    var M = S.members, cols = C41.items.filter(function (i) { return i.key !== 'attendance'; }), ts = 0;
    var h = '<div class="tw"><table class="rt"><tr><th class="nm">이름</th><th>출석<br>(20)</th>';
    cols.forEach(function (c) { h += '<th' + (c.leader_only ? ' style="background:#5a4f3a"' : '') + '>' + esc(c.label) + '<br>(' + (c.type === 'n' ? c.unit + '당' + c.points + (c.cap != null ? '/최대' + c.cap : '') : c.points) + ')</th>'; });
    h += '<th style="background:#1e2a1f">합계</th></tr>';
    var tot = {}; cols.forEach(function (c) { tot[c.key] = 0; }); var attN = 0;
    M.forEach(function (m) {
      var r = S.rows[m.id] || C41.emptyRow(), sc = C41.score(r, C41.itemsFor(m.role)); ts += sc;
      h += '<tr><td class="nm">' + esc(m.name) + '</td>' + (r.attendance === 'O' ? '<td class="o">O</td>' : '<td class="z">-</td>'); if (r.attendance === 'O') attN++;
      cols.forEach(function (c) {
        if (c.leader_only && m.role !== '구역장') { h += '<td class="z" style="background:var(--line)"></td>'; return; }
        if (c.type === 'c') { var on = r[c.key] === 'O'; if (on) tot[c.key]++; h += on ? '<td class="o">O</td>' : '<td class="z">-</td>'; }
        else { var v = C41.n(r[c.key]); tot[c.key] += v; h += v > 0 ? '<td class="v">' + v + '</td>' : '<td class="z">0</td>'; }
      });
      h += '<td class="sc">' + (sc > 0 ? sc : '') + '</td></tr>';
    });
    h += '<tr class="tr"><td class="nm">합계</td><td>' + attN + '</td>';
    cols.forEach(function (c) { h += '<td>' + tot[c.key] + '</td>'; });
    h += '<td class="sc">' + C41.fmt(ts) + '</td></tr></table></div>';
    return h;
  }

  function _render() {
    var app = document.getElementById('app');
    if (!S.ready) { C41.renderLogin(); return; }
    var h = headerHtml() + tabsHtml();
    if (S.loading) { app.innerHTML = h + '<div class="msg">불러오는 중...</div>'; C41.scrollTabIntoView(); return; }
    var M = S.members, ac = 0, ts = 0, att = [];
    M.forEach(function (m) { var r = S.rows[m.id]; if (r && r.attendance === 'O') { ac++; att.push(m.name); } ts += C41.score(r, C41.itemsFor(m.role)); });
    h += C41.pwNoticeHtml(S.access);
    if (!S.editable) h += '<div class="notice">이 주차는 입력 기간이 지나 조회만 가능합니다. 수정이 필요하면 구역장 또는 교역자에게 요청하세요.</div>';
    if (S.access.isMember && !S.myMemberId) h += '<div class="notice danger">이 계정에 연결된 구역원 정보가 없습니다. 관리자에게 문의하세요.</div>';
    if (C41.itemsSource !== 'db') h += '<div class="notice info">점수 항목을 서버에서 읽지 못해 기본값을 사용합니다.</div>';
    var missN = M.filter(function (m) { return !(S.rows[m.id] && S.rows[m.id].id); }).length;
    h += '<div class="sum"><div><div class="n" id="s-ac">' + ac + '</div><div class="l">출석 / ' + M.length + '</div></div><div class="dv"></div><div><div class="n" id="s-ts">' + C41.fmt(ts) + '</div><div class="l">총점</div></div>'
      + (S.access.isMember ? '' : '<div class="dv"></div><div><span class="badge ' + (missN ? 'warn' : 'ok') + '" id="s-miss" style="font-size:13px;padding:6px 10px">' + (missN ? '미입력 ' + missN + '명' : '전원 입력') + '</span></div>') + '</div>';
    h += '<div class="att-bar" id="s-att" style="display:' + (att.length ? 'block' : 'none') + '"><b>참석: </b>' + esc(att.join(', ')) + '</div>';
    h += '<div class="status"><span id="gstatus"></span><span></span></div>';
    h += '<div class="seg"><button class="' + (S.view === 'list' ? 'on' : '') + '" data-act="setView" data-v="list">' + (S.access.isMember ? '내 체크' : '입력') + '</button><button class="' + (S.view === 'summary' ? 'on' : '') + '" data-act="setView" data-v="summary">요약</button><button class="' + (S.view === 'report' ? 'on' : '') + '" data-act="setView" data-v="report">보고서</button></div>';
    if (S.view === 'list') {
      if (S.access.isMember) {
        var idx = memberIdx(S.myMemberId);
        if (idx >= 0) h += myCardHtml(M[idx], idx);
      } else {
        h += '<div class="lh"><span>출석 체크 + 상세 입력</span><span>이름을 누르면 펼쳐집니다</span></div>';
        M.forEach(function (m, mi) { h += rowHtml(m, mi); });
        if (C41.canEditRoster(S.access)) {
          h += '<div class="add-area">' + (S.addingMember
            // 직책은 곧 시스템 권한이다(구역장→구역 전체 쓰기). 그래서 지정은 교역자만 한다.
            // 서버 트리거도 같은 규칙이라, 여기서 고르게 두면 42501 로 튕길 뿐이다.
            ? '<div class="form"><input id="add-name" placeholder="이름" maxlength="20" data-enter="addMember" style="flex:2">'
              + (S.access.isAdmin
                 ? '<select id="add-role"><option value="구역원">구역원</option><option value="구역장">구역장</option><option value="권찰">권찰</option></select>'
                 : '<input type="hidden" id="add-role" value="구역원">')
              + '<button class="btn sm" data-act="addMember">추가</button><button class="btn sm ghost" data-act="hideAdd">취소</button></div>'
            : '<button class="add-btn" data-act="showAdd">+ 구역원 추가</button>') + '</div>';
        }
      }
    }
    if (S.view === 'summary') h += summaryHtml();
    if (S.view === 'report') h += reportHtml();
    app.innerHTML = h;
    updateGlobalStatus(); C41.scrollTabIntoView();
    if (S.addingMember) { var ne = document.getElementById('add-name'); if (ne) ne.focus(); }
  }

  /* ── 인증 흐름 ─────────────────────────────────────────────── */
  // pwJustChanged: 비밀번호를 막 바꾸고 돌아온 경우. 메타데이터 전파가 늦어도
  //                변경 화면으로 되돌아가지 않게 하는 안전장치다(무한 반복 방지).
  async function onAuth(user, pwJustChanged) {
    S.access = await C41.getAccess(user);
    var a = S.access;
    if (!a.role) { await C41.signOut(); S.ready = false; C41.renderLogin({ err: '로그인 정보가 만료되었습니다. 아이디와 비밀번호로 다시 로그인해 주세요. (반복되면 관리자에게 문의)' }); return; }
    // 비밀번호 변경은 권유지 의무가 아니다(기본 비밀번호를 모두 같이 쓰는 운영).
    // 처음 로그인 때 한 번 권하고, "나중에" 를 고르면 다시 막지 않는다 — 대신 배너가 남는다.
    C41._pwReturn = function (updatedUser) { return onAuth(updatedUser || user, true); };
    if (!pwJustChanged && C41.pwPromptNeeded(a)) {
      C41.renderChangePw(C41._pwReturn, { skippable: true });
      return;
    }
    if (a.memberRemoved) {
      await C41.signOut(); S.ready = false;
      C41.renderLogin({ err: '명단에서 제외된 계정입니다. 구역장 또는 교역자에게 문의하세요.' });
      return;
    }
    // 교역자는 읽기 전용이라 이 화면에서 할 수 있는 일이 없다(구역도 지정돼 있지 않다).
    // 그냥 두면 빈 화면을 보게 되므로 대시보드로 보낸다.
    if (a.isPastor) { window.location.href = 'church-dashboard.html'; return; }
    var qp = new URLSearchParams(window.location.search), pid = qp.get('parish');
    if (a.isAdmin) {
      if (pid && /^\d{4}$/.test(pid)) { S.pid = pid; S.adminMode = true; }
      else { window.location.href = 'church-dashboard.html'; return; }
      var pr = await sb.from('parishes').select('*').eq('id', S.pid).maybeSingle();
      S.pname = (pr.data && pr.data.name ? pr.data.name : S.pid + '구역') + ' (관리자)';
    } else {
      if (!a.parish_id) { await C41.signOut(); S.ready = false; C41.renderLogin({ err: '이 계정에 구역이 지정되어 있지 않습니다. 관리자에게 문의하세요.' }); return; }
      S.pid = a.parish_id; S.adminMode = false;
      S.pname = a.parish_name || a.display_name || (S.pid + '구역');
    }
    S.ready = true; S.loading = true; render();
    await C41.loadItems();
    S.weeks = await C41.loadWeeks();
    S.week = C41.pickWeek(S.weeks, a);
    await loadMembers();
    S.expanded = a.isMember ? S.myMemberId : null;
    await loadWeek();
  }
  C41._onAuth = onAuth;

  var ACTIONS = {
    doLogout: async function () {
      if (hasUnsaved() && !await C41.ask('저장 중인 항목이 있습니다', '지금 로그아웃하면 저장되지 않은 입력은 사라집니다.', { ok: '로그아웃', danger: true })) return;
      await C41.signOut(); S.ready = false; S.pid = ''; render();
    },
    backToDashboard: function () { window.location.href = 'church-dashboard.html'; },
    reload: async function () { if (hasUnsaved()) return C41.toast('저장이 끝난 뒤 새로고침하세요'); await loadMembers(); await loadWeek(); C41.toast('새로고침 완료'); },
    retryAll: function () { retryAll(); },
    setWeek: function (el) { setWeek(el.getAttribute('data-w')); },
    setView: function (el) { S.view = el.getAttribute('data-v'); render(); },
    toggle: function (el) { var mid = el.getAttribute('data-mid'); S.expanded = S.expanded === mid ? null : mid; render(); },
    toggleAtt: function (el, e) { e.stopPropagation(); toggleAtt(el.getAttribute('data-mid')); },
    toggleItem: function (el) { toggleItem(el.getAttribute('data-mid'), el.getAttribute('data-k')); },
    numAdj: function (el) { numAdj(el.getAttribute('data-mid'), el.getAttribute('data-k'), parseInt(el.getAttribute('data-d'), 10)); },
    numSet: function (el) { numSet(el.getAttribute('data-mid'), el.getAttribute('data-k'), el.value); },
    showAdd: function () { S.addingMember = true; render(); },
    hideAdd: function () { S.addingMember = false; render(); },
    addMember: function () { addMember(); },
    delMember: function (el) { delMember(el.getAttribute('data-mid')); }
  };
  C41.bindActions(ACTIONS);

  // 화면을 오래 열어 둔 사이 다른 사람이 입력했을 수 있다. 돌아왔을 때 조용히 다시 읽어
  // 숫자 +/- 가 낡은 로컬 값에서 계산되는 것을 막는다(남의 입력을 되돌리는 경로).
  function refreshIfStale() {
    if (!S.ready || S.loading || hasUnsaved()) return;
    if (!S.loadedAt || Date.now() - S.loadedAt < 30000) return;
    loadWeek();
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden) refreshIfStale(); });
  window.addEventListener('focus', refreshIfStale);

  (async function () {
    var r = await sb.auth.getSession();
    if (r.data && r.data.session) await onAuth(r.data.session.user); else C41.renderLogin();
    // 로그아웃 뒤 뒤로 가기로 이 화면이 되살아나면 세션을 다시 확인하고 새로 읽는다
    C41.guardRestore(function () { location.reload(); });
    sb.auth.onAuthStateChange(function (ev) { if (ev === 'SIGNED_OUT' && S.ready) { S.ready = false; render(); } });
  })();
})();
