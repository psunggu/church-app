/* ═══════════════════════════════════════════════════════════════
   관리 화면 — 교역자/관리자 전용
   · 구역원·계정: 명단 관리, 개인 계정 발급/초기화/권한/비활성화 (Edge Function admin-users)
   · 구역: 추가/이름/활성
   · 점수 항목: 배점·상한·활성 (score_items)
   · 설정: 입력 허용 기간, 학기
   서버 측 강제: 모든 쓰기는 RLS(is_admin) 와 Edge Function 의 JWT 검증이 막는다. 화면은 UX 일 뿐이다.
   ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  var sb = C41.init(), esc = C41.esc;
  var A = { access: null, ready: false, tab: 'members', parishes: [], selParish: '', members: [], showDeleted: false, editing: null, items: [], settings: [], terms: [], weeks: [], weeksError: '', busy: false, staff: [], staffError: '' };

  /* ── Edge Function ─────────────────────────────────────────── */
  async function callAdmin(body) {
    var r = await sb.functions.invoke('admin-users', { body: body });
    if (r.error) {
      // supabase-js 는 비-2xx 를 전부 "non-2xx status code" 한 문장으로 뭉뚱그린다.
      // 실제 구분은 context.status 로만 된다 (예전 구현은 메시지 문자열만 봐서 미배포를 못 잡았다).
      var msg = r.error.message || String(r.error);
      var status = (r.error.context && r.error.context.status) || 0;
      try {
        if (r.error.context && typeof r.error.context.json === 'function') {
          var j = await r.error.context.json();
          if (j && j.error) msg = j.error;
        }
      } catch (e) { /* 본문이 JSON 이 아니면 원문 유지 */ }
      if (status === 404) msg = 'Edge Function(admin-users)이 배포되지 않았습니다 (docs/RUNBOOK.md 1-3 참고)';
      else if (status === 401) msg = '세션이 만료되었습니다. 다시 로그인해 주세요.';
      else if (!status && /Failed to send|Failed to fetch|NetworkError/i.test(msg)) msg = 'Edge Function 에 연결할 수 없습니다 (네트워크 또는 미배포)';
      var err = new Error(msg); err.status = status; throw err;
    }
    if (r.data && r.data.error) throw new Error(r.data.error);
    return r.data || {};
  }

  // 토스트는 2.4초 뒤 사라지고 뒤이은 성공 토스트에 덮인다.
  // 놓치면 데이터가 어긋난 채 남는 실패는 모달로 남긴다.
  function noteModal(title, body) {
    var bg = C41.modal('<h3>' + esc(title) + '</h3><div class="desc" style="white-space:pre-wrap">' + esc(body) + '</div>'
      + '<div class="acts"><button class="btn sm" data-act="closeNote">확인</button></div>', { dismissable: false });
    bg.querySelector('[data-act="closeNote"]').addEventListener('click', function () { bg.close(); });
  }

  /* ── 데이터 ─────────────────────────────────────────────────── */
  async function loadParishes() {
    var r = await sb.from('parishes').select('*').order('id');
    if (r.error) C41.toast('구역 조회 실패: ' + C41.errMsg(r.error));
    A.parishes = (r.data || []).sort(function (a, b) { return (C41.n(a.sort_order) - C41.n(b.sort_order)) || String(a.id).localeCompare(String(b.id)); });
    // 처음 열 때는 활성 구역을 고른다. 비활성 구역이 목록 앞에 있으면
    // (아직 구역원이 없어 감춰 둔 구역) 빈 화면으로 열려 매번 다시 고르게 된다.
    if (!A.selParish && A.parishes.length) {
      var firstActive = A.parishes.filter(function (p) { return p.active !== false; })[0];
      A.selParish = (firstActive || A.parishes[0]).id;
    }
  }
  async function loadMembers() {
    if (!A.selParish) { A.members = []; return; }
    var r = await sb.from('members').select('*').eq('parish_id', A.selParish).order('created_at');
    if (r.error) C41.toast('구역원 조회 실패: ' + C41.errMsg(r.error));
    // 다른 화면과 같은 순서 + 삭제된 사람은 맨 아래 (여기서만 삭제된 행도 보여준다)
    A.members = C41.sortMembers(r.data || [], { deletedLast: true });
  }
  async function loadItems() { var r = await sb.from('score_items').select('*').order('sort_order'); A.items = r.error ? [] : (r.data || []); if (r.error) C41.toast('점수 항목 조회 실패: ' + C41.errMsg(r.error)); }
  async function loadSettings() {
    var r = await sb.from('app_settings').select('*').order('key'); A.settings = r.error ? [] : (r.data || []);
    var t = await sb.from('terms').select('*').order('start_date', { ascending: false }); A.terms = t.error ? [] : (t.data || []);
    var w = await sb.from('term_weeks').select('*').order('report_date'); A.weeks = w.error ? [] : (w.data || []);
    A.weeksError = w.error ? C41.errMsg(w.error) : '';
  }

  /* ── 구역원 · 계정 ─────────────────────────────────────────── */
  function memberById(id) { return A.members.filter(function (m) { return m.id === id; })[0]; }
  async function addMember() {
    var ne = document.getElementById('add-name'), re = document.getElementById('add-role');
    var name = ne.value.trim(), role = re.value;
    if (!/^[가-힣a-zA-Z0-9 ]{1,20}$/.test(name)) return C41.toast('이름은 한글·영문·숫자 20자 이내');
    // 서버는 23505 로 막기만 하고 화면에는 "이미 존재하는 항목입니다" 라고만 뜬다. 여기서 미리 가른다.
    var dup = C41.findByName(A.members, name);
    if (dup.live) return C41.toast('이미 등록된 이름입니다 (번호 ' + (dup.live.member_code || '-') + ')');
    if (dup.gone) {
      // 015 이후 같은 이름을 새로 넣을 수 있다. 하지만 대개는 그분이 돌아온 것이고,
      // 새 행을 만들면 지난 출석 기록이 끊어진다.
      if (!await C41.ask('예전에 있던 이름입니다',
          name + ' 님은 ' + (String(dup.gone.deleted_at || '').slice(0, 10) || '전에') + ' 명단에서 빠졌습니다.\n\n'
          + '같은 분이면 [되살리기] — 지난 출석 기록이 그대로 이어집니다.\n'
          + '다른 분이면 취소하고 구분되는 이름으로 적어 주세요 (예: ' + name + 'B).',
          { ok: '되살리기' })) return;
      await setState(dup.gone.id, 'Insert');
      return;
    }
    var r = await sb.from('members').insert({ parish_id: A.selParish, name: name, role: role }).select().single();
    if (r.error) return C41.toast(leaderDupMsg(r.error, role, null) || '추가 실패: ' + C41.errMsg(r.error), 4500);
    C41.toast(name + ' 추가됨 (번호 ' + r.data.member_code + ')'); await loadMembers(); render();
  }
  async function saveEdit(id) {
    var ne = document.getElementById('ed-name'), re = document.getElementById('ed-role');
    var name = ne.value.trim(), role = re.value;
    if (!/^[가-힣a-zA-Z0-9 ]{1,20}$/.test(name)) return C41.toast('이름은 한글·영문·숫자 20자 이내');
    var r = await sb.from('members').update({ name: name, role: role }, { count: 'exact' }).eq('id', id);
    if (r.error) {
      var dup = leaderDupMsg(r.error, role, id);
      if (dup) return noteModal('구역장은 구역당 1명입니다', dup);
      return C41.toast('수정 실패: ' + C41.errMsg(r.error));
    }
    if (r.count === 0) return C41.toast('수정 권한이 없습니다');
    // 시스템 권한(app_metadata.role)은 직책에서 유도한다 — 계정이 있으면 함께 맞춘다.
    var m = memberById(id), warn = '';
    if (m && m.user_id && m.role !== role) {
      try { await callAdmin({ action: 'set_role', member_id: id, role: sysRoleOf(role) }); }
      catch (e) { warn = e.message; }
    }
    A.editing = null; await loadMembers(); render();
    if (warn) {
      noteModal('직책은 바뀌었지만 권한 동기화에 실패했습니다',
        warn + '\n\n' + name + ' 님의 로그인 권한이 아직 이전 직책 기준입니다.\n목록의 "권한 동기화" 버튼으로 다시 맞출 수 있습니다.');
    } else {
      C41.toast(m && m.user_id && m.role !== role ? '직책·권한 변경됨 (본인 재로그인 필요)' : '수정됨');
    }
  }
  // 직책 ↔ app_metadata 불일치, 구역 이동 후 parish_id 갱신을 한 번에 맞춘다.
  // role 을 보내지 않으면 서버가 현재 직책에서 유도한다.
  async function syncRole(id) {
    var m = memberById(id); if (!m) return;
    busy(true);
    try { await callAdmin({ action: 'set_role', member_id: id }); C41.toast(m.name + ' 권한 동기화됨 (본인 재로그인 필요)'); }
    catch (e) { noteModal('권한 동기화 실패', e.message); }
    busy(false);
  }
  async function unlinkAccount(id) {
    var m = memberById(id); if (!m) return;
    if (!await C41.ask('계정 연결 해제', m.name + ' 님의 끊어진 계정 연결을 해제할까요?\n(로그인 계정이 이미 사라진 경우에만 됩니다)', { ok: '해제', danger: true })) return;
    busy(true);
    try { var d = await callAdmin({ action: 'unlink_account', member_id: id }); C41.toast(d.note || '연결 해제됨'); }
    catch (e) { noteModal('연결 해제 실패', e.message); }
    busy(false);
    await loadMembers(); render();
  }
  function sysRoleOf(memberRole) { return memberRole === '구역장' ? 'leader' : memberRole === '권찰' ? 'assistant' : 'member'; }
  function currentLeader() { return A.members.filter(function (m) { return m.role === '구역장' && m.state !== 'Delete'; })[0]; }
  // 구역당 구역장은 1명이다(sql/007 의 부분 유니크 인덱스). 23505 를 그대로 보여주면 원인을 알 수 없다.
  function leaderDupMsg(err, role, selfId) {
    if (!err || err.code !== '23505' || role !== '구역장') return '';
    var cur = currentLeader();
    if (cur && cur.id === selfId) return '';
    return (cur ? cur.name + ' 님이 이미 ' + A.selParish + ' 구역장입니다.' : '이 구역에는 이미 구역장이 있습니다.')
      + '\n\n구역장은 구역당 1명입니다. 인수인계하려면 먼저 그분의 직책을 구역원으로 바꾼 뒤 다시 시도하세요.';
  }
  async function setState(id, state) {
    var m = memberById(id); if (!m) return;
    var removing = state === 'Delete';
    if (removing && !await C41.ask('명단에서 빼기', m.name + ' 님을 명단에서 뺄까요?\n출석 이력은 그대로 남고, 나중에 복구할 수 있습니다.', { ok: '빼기', danger: true })) return;
    var r = await sb.from('members').update({ state: state }, { count: 'exact' }).eq('id', id);
    if (r.error) return C41.toast('실패: ' + C41.errMsg(r.error));
    if (r.count === 0) return C41.toast('권한이 없습니다');
    var warn = '';
    if (m.user_id) {
      try { await callAdmin({ action: 'set_active', member_id: id, active: !removing }); }
      catch (e) { warn = e.message; }
    }
    await loadMembers(); render();
    if (warn) {
      noteModal(removing ? '명단에서는 뺐지만 계정 잠금에 실패했습니다' : '복구했지만 계정 활성화에 실패했습니다',
        warn + '\n\n' + m.name + ' 님의 로그인 계정 상태가 그대로입니다.\n같은 버튼을 다시 누르거나, 필요하면 "계정 삭제"를 쓰세요.');
    } else {
      C41.toast(removing ? '명단에서 뺐습니다' : '복구했습니다');
    }
  }
  async function createAccount(id) {
    var m = memberById(id); if (!m) return;
    if (!m.member_code) return C41.toast('구역원 번호가 없습니다 (sql/003 적용 필요)');
    busy(true);
    var failed = '';
    try { var d = await callAdmin({ action: 'create_account', member_id: id, role: sysRoleOf(m.role) }); showCredentials([{ name: m.name, login_id: d.login_id, password: d.password }]); }
    catch (e) { failed = e.message; }
    busy(false);
    // 실패해도 목록을 다시 읽는다 — 서버가 끊어진 연결을 정리했을 수 있어
    // 화면의 "계정 있음/없음" 배지가 낡은 채로 남으면 다음 조치를 잘못 고르게 된다.
    await loadMembers(); render();
    if (failed) noteModal('계정 발급 실패', m.name + ' — ' + failed);
  }
  async function createAll() {
    var targets = A.members.filter(function (m) { return m.state !== 'Delete' && !m.user_id && m.member_code; });
    if (!targets.length) return C41.toast('발급할 구역원이 없습니다');
    if (!await C41.ask('계정 일괄 발급',
        targets.length + '명의 계정을 한 번에 발급합니다.\n\n' + targets.map(function (t) { return '· ' + t.name; }).join('\n')
        + '\n\n' + (defaultPw()
            ? '설정대로라면 비밀번호는 모두 ' + defaultPw() + ' 입니다. 발급 결과 화면에서 실제 값을 확인하세요.'
            : '임시 비밀번호는 발급 직후 한 번만 보여집니다. 바로 복사하거나 CSV 로 저장하세요.'),
        { ok: targets.length + '명 발급' })) return;
    busy(true); var out = [], fail = [];
    for (var i = 0; i < targets.length; i++) {
      try { var d = await callAdmin({ action: 'create_account', member_id: targets[i].id, role: sysRoleOf(targets[i].role) }); out.push({ name: targets[i].name, login_id: d.login_id, password: d.password }); }
      catch (e) { fail.push(targets[i].name + ': ' + e.message); }
    }
    busy(false); await loadMembers(); render();
    if (out.length) showCredentials(out, fail);
    else noteModal('계정 발급 실패 (' + fail.length + '명 전원)', fail.join('\n'));
  }
  // app_settings.default_password 를 읽어 둔다(교역자만 읽힌다). 비어 있으면 무작위 운영.
  function defaultPw() {
    var r = A.settings.filter(function (x) { return x.key === 'default_password'; })[0];
    return r && r.value ? String(r.value).trim() : '';
  }
  async function resetAllPw() {
    var targets = A.members.filter(function (m) { return m.state !== 'Delete' && m.user_id; });
    if (!targets.length) return C41.toast('계정이 있는 구역원이 없습니다');
    var dp = defaultPw();
    if (!await C41.ask('비밀번호 전체 초기화',
        targets.length + '명의 비밀번호를 ' + (dp ? '설정된 기본값(' + dp + ')으로' : '새 무작위 값으로') + ' 되돌립니다.\n'
        + '스스로 바꾼 사람의 비밀번호도 함께 되돌아갑니다.',
        { ok: targets.length + '명 초기화', danger: true })) return;
    busy(true); var out = [], fail = [];
    for (var i = 0; i < targets.length; i++) {
      try { var d = await callAdmin({ action: 'reset_password', member_id: targets[i].id }); out.push({ name: targets[i].name, login_id: d.login_id, password: d.password }); }
      catch (e) { fail.push(targets[i].name + ': ' + e.message); }
    }
    busy(false); await loadMembers(); render();
    if (out.length) showCredentials(out, fail);
    else noteModal('초기화 실패 (' + fail.length + '명 전원)', fail.join('\n'));
  }
  async function resetPw(id) {
    var m = memberById(id); if (!m) return;
    if (!await C41.ask('비밀번호 초기화', m.name + ' 님의 비밀번호를 초기화할까요?\n새 임시 비밀번호가 발급되고, 기존 비밀번호는 쓸 수 없게 됩니다.', { ok: '초기화', danger: true })) return;
    busy(true);
    var failed = '';
    try { var d = await callAdmin({ action: 'reset_password', member_id: id }); showCredentials([{ name: m.name, login_id: d.login_id, password: d.password }]); }
    catch (e) { failed = e.message; }
    busy(false);
    await loadMembers(); render();
    if (failed) noteModal('비밀번호 초기화 실패', m.name + ' — ' + failed);
  }
  async function deleteAccount(id) {
    var m = memberById(id); if (!m) return;
    if (!await C41.ask('로그인 계정 삭제', m.name + ' 님의 로그인 계정을 삭제할까요?\n명단과 출석 이력은 남습니다. 다시 발급할 수 있습니다.', { ok: '계정 삭제', danger: true })) return;
    busy(true);
    var failed = '', note = '';
    try { var d = await callAdmin({ action: 'delete_account', member_id: id }); note = d.note || '계정 삭제됨'; }
    catch (e) { failed = e.message; }
    busy(false);
    await loadMembers(); render();
    if (failed) noteModal('계정 삭제 실패', m.name + ' — ' + failed);
    else C41.toast(note);
  }
  // 설정에는 기본 비밀번호가 있는데 서버가 다른 값을 돌려줬다면,
  // Edge Function 이 아직 그 설정을 모르는 버전이라는 뜻이다(배포 누락).
  // 화면이 "모두 같은 기본 비밀번호입니다" 라고 잘못 말하지 않도록 여기서 잡는다.
  // (실제 값을 주석에 적지 말 것 — 이 파일은 공개 저장소로 그대로 배포된다.)
  function defaultPwMismatch(list) {
    var dp = defaultPw();
    if (!dp || !list.length) return '';
    if (list.every(function (c) { return c.password === dp; })) return '';
    return '설정의 기본 비밀번호(' + dp + ')가 적용되지 않았습니다. 서버(Edge Function admin-users)가 '
         + '아직 이전 버전이라 사람마다 다른 비밀번호가 발급됐습니다.\n'
         + '위에 보이는 값이 실제 비밀번호이니 지금은 반드시 복사하거나 CSV 로 저장하세요.\n'
         + '서버를 배포한 뒤 "비밀번호 전체 초기화" 를 다시 누르면 모두 ' + dp + ' 으로 맞춰집니다.';
  }

  // 임시 비밀번호는 서버에 평문으로 남지 않으므로 이 모달이 유일한 사본이다.
  // 바깥 클릭으로 닫히면 한 구역 전체를 다시 초기화해야 하므로 dismissable:false 로 둔다.
  function showCredentials(list, fail) {
    var dp = defaultPw();
    var allDefault = !!dp && list.every(function (c) { return c.password === dp; });
    var h = '<h3>로그인 정보 (' + list.length + '명)</h3>'
      + (allDefault
        ? '<div class="desc">비밀번호는 모두 <b>' + esc(dp) + '</b> 입니다. 언제든 이 화면에서 다시 확인할 수 있으니 급히 적어 두지 않아도 됩니다.<br>'
          + '각자 로그인한 뒤 본인만 아는 비밀번호로 바꾸도록 안내해 주세요.</div>'
        : '<div class="desc">닫으면 다시 볼 수 없습니다. <b>먼저 복사하거나 CSV 로 내려받으세요.</b><br>'
          + '본인에게 직접 전달하고, 첫 로그인 때 비밀번호를 바꾸도록 안내하세요. 전달이 끝나면 사본을 지우세요.</div>');
    list.forEach(function (c) {
      h += '<div class="li"><span class="nm">' + esc(c.name) + '</span>'
        + '<span class="meta">아이디 <b>' + esc(c.login_id) + '</b></span>'
        + '<span class="pw" style="font-size:18px;padding:6px 10px;margin:0">' + esc(c.password) + '</span></div>';
    });
    if (fail && fail.length) {
      h += '<div class="notice danger" style="white-space:pre-wrap">발급 실패 ' + fail.length + '건\n' + esc(fail.join('\n')) + '</div>';
    }
    h += '<div class="notice danger" id="creds-warn" hidden></div>';
    h += '<div class="acts"><button class="btn sm ghost" data-act="copyCreds">복사</button>'
      + '<button class="btn sm ghost" data-act="csvCreds">CSV 저장</button>'
      + '<button class="btn sm" data-act="closeCreds">닫기</button></div>';
    var bg = C41.modal(h, { dismissable: false });
    function asText() {
      return list.map(function (c) { return c.name + '\t아이디 ' + c.login_id + '\t비밀번호 ' + c.password; }).join('\n');
    }
    // 확인을 브라우저 confirm() 에 맡기면 안 된다. 크롬은 한 페이지가 대화상자를 거듭 띄우면
    // "추가 대화상자 차단" 을 걸고, 그 뒤 confirm() 은 아무것도 띄우지 않은 채 false 를 돌려준다.
    // 이 모달은 dismissable:false 라 닫기가 유일한 출구이므로 그 순간 갇힌다.
    // 확인은 모달 안에서 두 번 누르는 것으로 받는다 — 브라우저가 막을 수 없다.
    var copied = allDefault, armed = false;   // 기본값 운영이면 다시 볼 수 있으니 바로 닫힌다
    var warn = bg.querySelector('#creds-warn');
    var closeBtn = bg.querySelector('[data-act="closeCreds"]');
    function markSaved() {
      copied = true; armed = false; warn.hidden = true;
      closeBtn.textContent = '닫기'; closeBtn.classList.remove('danger');
    }
    bg.querySelector('[data-act="copyCreds"]').addEventListener('click', function () {
      if (navigator.clipboard) navigator.clipboard.writeText(asText()).then(function () { markSaved(); C41.toast('복사됨'); }, function () { C41.toast('복사 실패 — 직접 선택해 복사하세요'); });
      else C41.toast('이 브라우저에서는 직접 선택해 복사하세요');
    });
    bg.querySelector('[data-act="csvCreds"]').addEventListener('click', function () {
      C41.downloadCsv('임시비밀번호_' + (A.selParish || 'all') + '.csv', ['이름', '아이디', '임시비밀번호'],
        list.map(function (c) { return [c.name, c.login_id, c.password]; }));
      markSaved();
    });
    var mismatch = defaultPwMismatch(list);
    if (mismatch) {
      warn.hidden = false; warn.style.whiteSpace = 'pre-wrap'; warn.textContent = mismatch;
      copied = false;   // 이때는 "한 번 더" 확인을 되살린다 — 이 값들은 정말 다시 못 본다
    }
    closeBtn.addEventListener('click', function () {
      if (copied || armed) return bg.close();
      armed = true;
      closeBtn.textContent = '저장 없이 닫기';
      closeBtn.classList.add('danger');
      warn.hidden = false;
      warn.textContent = '아직 복사도 CSV 저장도 하지 않았습니다. 한 번 더 누르면 이 비밀번호는 다시 볼 수 없습니다.';
    });
  }
  // render() 가 #app 을 통째로 다시 그리면 disabled 가 풀린다.
  // 그래서 상태를 A.busy 에 두고, 렌더 직후 applyBusy() 로 다시 입힌다.
  function applyBusy() {
    document.querySelectorAll('#app button, #app select, #app input').forEach(function (x) { x.disabled = A.busy; });
  }
  function busy(b) { A.busy = b; applyBusy(); }

  /* ── 구역 ──────────────────────────────────────────────────── */
  async function addParish() {
    var id = document.getElementById('p-id').value.trim(), name = document.getElementById('p-name').value.trim();
    if (!/^\d{4}$/.test(id)) return C41.toast('구역 ID는 4자리 숫자');
    if (!name) name = id + '구역';
    var r = await sb.from('parishes').insert({ id: id, name: name, district_id: id.slice(0, 2), sort_order: parseInt(id, 10) });
    if (r.error) {
      if (r.error.code === '23503') { var d = await sb.from('districts').insert({ id: id.slice(0, 2), name: id.slice(0, 2) + '교구' }); if (!d.error) r = await sb.from('parishes').insert({ id: id, name: name, district_id: id.slice(0, 2), sort_order: parseInt(id, 10) }); }
      if (r.error) return C41.toast('추가 실패: ' + C41.errMsg(r.error));
    }
    C41.toast(name + ' 추가됨'); await loadParishes(); render();
  }
  async function toggleParish(id, active) {
    var r = await sb.from('parishes').update({ active: active }, { count: 'exact' }).eq('id', id);
    if (r.error || r.count === 0) return C41.toast('실패: ' + (r.error ? C41.errMsg(r.error) : '권한 없음'));
    await loadParishes(); render();
  }
  async function renameParish(id) {
    var name = document.getElementById('pn-' + id).value.trim(); if (!name) return;
    var r = await sb.from('parishes').update({ name: name }, { count: 'exact' }).eq('id', id);
    if (r.error || r.count === 0) return C41.toast('실패: ' + (r.error ? C41.errMsg(r.error) : '권한 없음'));
    C41.toast('저장됨'); await loadParishes(); render();
  }

  /* ── 점수 항목 · 설정 ─────────────────────────────────────── */
  async function saveItem(key) {
    var g = function (f) { var el = document.getElementById('it-' + f + '-' + key); return el ? el : null; };
    var patch = { label: g('label').value.trim(), points: C41.n(g('points').value), active: g('active').checked, sort_order: C41.n(g('sort').value) };
    var capEl = g('cap'); if (capEl) patch.cap = capEl.value === '' ? null : C41.n(capEl.value);
    if (!patch.label) return C41.toast('이름을 입력하세요');
    var r = await sb.from('score_items').update(patch, { count: 'exact' }).eq('key', key);
    if (r.error || r.count === 0) return C41.toast('실패: ' + (r.error ? C41.errMsg(r.error) : '권한 없음'));
    C41.toast('저장됨 — 기존 보고서 총점은 다음 수정 때 재계산됩니다'); await loadItems(); render();
  }
  async function saveSetting(key) {
    var v = document.getElementById('set-' + key).value.trim();
    var r = await sb.from('app_settings').update({ value: v, updated_at: new Date().toISOString() }, { count: 'exact' }).eq('key', key);
    if (r.error || r.count === 0) return C41.toast('실패: ' + (r.error ? C41.errMsg(r.error) : '권한 없음'));
    C41.toast('저장됨'); await loadSettings(); render();
  }
  // 구역모임 날짜. 일요일만 받는다 — report_date 는 주차 식별자이고 화면·집계가 전부 그 전제로 돈다.
  async function addTermWeek(termId) {
    var el = document.getElementById('tw-' + termId); if (!el || !el.value) return C41.toast('날짜를 고르세요');
    var d = el.value;
    if (new Date(d + 'T00:00:00Z').getUTCDay() !== 0) return C41.toast('일요일만 등록할 수 있습니다');
    var t = A.terms.filter(function (x) { return x.id === termId; })[0];
    if (t && (d < t.start_date || d > t.end_date)) {
      if (!await C41.ask('학기 기간 밖 날짜', '이 날짜는 학기 기간(' + t.start_date + ' ~ ' + t.end_date + ') 밖입니다.\n그래도 모임일로 추가할까요?', { ok: '추가' })) return;
    }
    var r = await sb.from('term_weeks').upsert({ term_id: termId, report_date: d, active: true }, { onConflict: 'term_id,report_date' });
    if (r.error) return C41.toast('추가 실패: ' + C41.errMsg(r.error));
    C41.toast(C41.weekLabel(d) + ' 모임일 추가됨'); await loadSettings(); render();
  }
  async function toggleTermWeek(termId, d) {
    var w = A.weeks.filter(function (x) { return x.term_id === termId && x.report_date === d; })[0]; if (!w) return;
    var next = !(w.active !== false);
    if (!next && !await C41.ask('주차 끄기', C41.weekLabel(d) + ' 을 주차 탭에서 뺄까요?\n이미 입력된 보고서가 있으면 그 주차는 계속 보입니다.', { ok: '끄기', danger: true })) return;
    var r = await sb.from('term_weeks').update({ active: next }, { count: 'exact' }).eq('term_id', termId).eq('report_date', d);
    if (r.error) return C41.toast('실패: ' + C41.errMsg(r.error));
    if (r.count === 0) return C41.toast('권한이 없습니다');
    C41.toast(C41.weekLabel(d) + (next ? ' 켜짐' : ' 꺼짐')); await loadSettings(); render();
  }
  async function addTerm() {
    var id = document.getElementById('t-id').value.trim(), name = document.getElementById('t-name').value.trim(), s = document.getElementById('t-start').value, e = document.getElementById('t-end').value;
    if (!id || !name || !s || !e) return C41.toast('모든 칸을 입력하세요');
    var r = await sb.from('terms').insert({ id: id, name: name, start_date: s, end_date: e });
    if (r.error) return C41.toast('추가 실패: ' + C41.errMsg(r.error));
    C41.toast('학기 추가됨'); await loadSettings(); render();
  }

  /* ── 렌더 ─────────────────────────────────────────────────── */
  function render() { var sy = window.scrollY; _render(); requestAnimationFrame(function () { window.scrollTo(0, sy); }); }
  function headerHtml() {
    return '<div class="hd"><div><h1>관리</h1><p>구역 · 구역원 · 계정 · 점수 항목</p><div class="who">' + esc(C41.roleLabel(A.access.role)) + '</div></div>'
      + '<div class="acts"><a class="btn icon" href="church-dashboard.html" title="대시보드" aria-label="대시보드"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M19 12H5M12 19l-7-7 7-7"/></svg></a>'
      + '<button class="btn icon" data-act="doLogout" title="로그아웃" aria-label="로그아웃"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/></svg></button></div></div>';
  }
  function segHtml() {
    var t = [['members', '구역원·계정'], ['parishes', '구역'], ['items', '점수 항목'], ['settings', '설정']], h = '<div class="seg">';
    t.forEach(function (x) { h += '<button class="' + (A.tab === x[0] ? 'on' : '') + '" data-act="setTab" data-t="' + x[0] + '">' + x[1] + '</button>'; });
    return h + '</div>';
  }
  function membersHtml() {
    var h = '<div class="panel"><h2>구역원 · 계정</h2><div class="desc">구역원을 등록하고 개인 로그인 계정을 발급합니다. 아이디는 구역원 번호(6자리), 비밀번호는 발급 시 한 번만 표시됩니다.</div>';
    h += '<div class="form" style="margin-bottom:10px"><select id="sel-parish" data-change="selParish">';
    A.parishes.forEach(function (p) { h += '<option value="' + esc(p.id) + '"' + (p.id === A.selParish ? ' selected' : '') + '>' + esc(p.id + ' ' + p.name + (p.active === false ? ' (비활성)' : '')) + '</option>'; });
    h += '</select><button class="btn sm" data-act="createAll">계정 없는 구역원 전체 발급</button>'
      + '<button class="btn sm ghost danger" data-act="resetAllPw">비밀번호 전체 초기화</button>'
      + '<label style="font-size:13px;color:var(--muted)"><input type="checkbox" data-change="toggleDeleted"' + (A.showDeleted ? ' checked' : '') + '> 삭제된 구역원 보기</label></div>';
    var live = A.members.filter(function (m) { return m.state !== 'Delete'; }), del = A.members.filter(function (m) { return m.state === 'Delete'; });
    var ld = currentLeader();
    h += '<div class="notice' + (ld ? ' info' : '') + '" style="margin:0 0 10px">'
       + (ld ? '구역장: <b>' + esc(ld.name) + '</b> (구역 전체 입력·수정·명단 관리)'
             : '이 구역에는 <b>구역장이 없습니다.</b> 한 명을 구역장으로 지정하세요. 구역장은 구역당 1명입니다.')
       + '</div>';
    h += '<div class="list">';
    live.forEach(function (m) { h += memberLi(m); });
    if (A.showDeleted) del.forEach(function (m) { h += memberLi(m); });
    if (!live.length) h += '<div class="msg">구역원이 없습니다</div>';
    h += '</div>';
    h += '<div class="form" style="margin-top:12px"><input id="add-name" placeholder="이름" maxlength="20" data-enter="addMember"><select id="add-role"><option value="구역원">구역원</option><option value="구역장">구역장</option><option value="권찰">권찰</option></select><button class="btn sm" data-act="addMember">+ 구역원 추가</button></div>';
    h += '<div class="desc" style="margin-top:8px">계정 발급 후 본인이 첫 로그인 때 비밀번호를 바꿉니다. 직책을 바꾸면 시스템 권한도 함께 바뀌며, 본인이 다시 로그인해야 적용됩니다.<br>구역장·권찰은 구역 전체를 입력·수정하고 명단도 고칠 수 있습니다. 직책 지정은 교역자만 합니다. 구역장은 구역당 1명입니다.' + (A.showDeleted && del.length ? ' 삭제된 구역원 ' + del.length + '명.' : '') + '</div></div>';
    return h;
  }
  function memberLi(m) {
    var deleted = m.state === 'Delete';
    if (A.editing === m.id) {
      return '<div class="li"><div class="form" style="width:100%"><input id="ed-name" value="' + esc(m.name) + '" maxlength="20" data-enter="saveEdit" data-id="' + esc(m.id) + '"><select id="ed-role">'
        + ['구역원', '구역장', '권찰'].map(function (r) { return '<option value="' + r + '"' + (m.role === r ? ' selected' : '') + '>' + r + '</option>'; }).join('')
        + '</select><button class="btn sm" data-act="saveEdit" data-id="' + esc(m.id) + '">저장</button><button class="btn sm ghost" data-act="cancelEdit">취소</button></div></div>';
    }
    var h = '<div class="li' + (deleted ? ' deleted' : '') + '"><span class="nm">' + esc(m.name) + (m.role !== '구역원' ? '<span class="badge">' + esc(m.role) + '</span>' : '') + '</span>';
    h += '<span class="meta">번호 <b>' + esc(m.member_code || '-') + '</b> · ' + (m.user_id ? '<span class="badge ok">계정 있음</span>' : '<span class="badge gray">계정 없음</span>') + (deleted ? ' · <span class="badge danger">삭제됨</span> ' + esc(String(m.deleted_at || '').slice(0, 10)) : '') + '</span>';
    h += '<span class="acts">';
    if (!deleted) {
      h += '<button class="btn sm ghost" data-act="edit" data-id="' + esc(m.id) + '">수정</button>';
      if (m.user_id) {
        // 시스템 권한은 직책에서 유도한다(별도 선택 없음) — 둘이 어긋나 있으면 "권한 동기화"로 맞춘다.
        h += '<button class="btn sm ghost" data-act="resetPw" data-id="' + esc(m.id) + '">비번 초기화</button>'
          + '<button class="btn sm ghost" data-act="syncRole" data-id="' + esc(m.id) + '" title="직책·구역을 로그인 권한에 다시 반영합니다">권한 동기화</button>'
          + '<button class="btn sm ghost" data-act="unlinkAccount" data-id="' + esc(m.id) + '" title="로그인 계정이 이미 사라졌을 때 연결만 해제합니다">연결 해제</button>'
          + '<button class="btn sm danger" data-act="deleteAccount" data-id="' + esc(m.id) + '">계정 삭제</button>';
      } else h += '<button class="btn sm" data-act="createAccount" data-id="' + esc(m.id) + '">계정 발급</button>';
      h += '<button class="btn sm danger" data-act="setState" data-id="' + esc(m.id) + '" data-s="Delete">명단에서 빼기</button>';
    } else h += '<button class="btn sm" data-act="setState" data-id="' + esc(m.id) + '" data-s="Insert">복구</button>';
    return h + '</span></div>';
  }
  function parishesHtml() {
    var h = '<div class="panel"><h2>구역</h2><div class="desc">구역 ID는 4자리(교구 2자리 + 구역 2자리). 비활성 구역은 대시보드에서 숨겨집니다.</div><div class="list">';
    A.parishes.forEach(function (p) {
      h += '<div class="li' + (p.active === false ? ' deleted' : '') + '"><span class="nm">' + esc(p.id) + '</span><span class="meta" style="display:flex;gap:6px;align-items:center"><input id="pn-' + esc(p.id) + '" value="' + esc(p.name) + '" style="min-height:36px;border:2px solid var(--line);border-radius:8px;padding:0 8px;background:var(--card);color:var(--ink);max-width:180px" data-enter="renameParish" data-id="' + esc(p.id) + '"><button class="btn sm ghost" data-act="renameParish" data-id="' + esc(p.id) + '">저장</button> <span class="badge gray">' + esc(p.district_id || '-') + '교구</span></span>'
        + '<span class="acts">' + (p.active === false ? '<button class="btn sm" data-act="toggleParish" data-id="' + esc(p.id) + '" data-a="1">활성화</button>' : '<button class="btn sm danger" data-act="toggleParish" data-id="' + esc(p.id) + '" data-a="0">비활성화</button>') + '</span></div>';
    });
    h += '</div><div class="form" style="margin-top:12px"><input id="p-id" placeholder="구역 ID (예: 4152)" maxlength="4" inputmode="numeric" style="max-width:160px"><input id="p-name" placeholder="이름 (예: 4152구역)" maxlength="30" data-enter="addParish"><button class="btn sm" data-act="addParish">+ 구역 추가</button></div></div>';
    return h;
  }
  function itemsHtml() {
    if (!A.items.length) return '<div class="panel"><h2>점수 항목</h2><div class="notice">score_items 테이블을 읽지 못했습니다. sql/003 적용 여부를 확인하세요.</div></div>';
    var h = '<div class="panel"><h2>점수 항목</h2><div class="desc">배점·상한·표시 여부를 바꿉니다. 새 항목 추가는 reports 컬럼 추가가 함께 필요하므로 SQL로 합니다(docs/RUNBOOK.md). 바뀐 배점은 이후 저장되는 보고서부터 적용됩니다.</div><div class="tw"><table class="rt"><tr><th class="nm">항목</th><th>키</th><th>그룹</th><th>유형</th><th>배점</th><th>최대점수</th><th>정렬</th><th>사용</th><th></th></tr>';
    A.items.forEach(function (it) {
      var k = esc(it.key);
      h += '<tr><td class="nm"><input id="it-label-' + k + '" value="' + esc(it.label) + '" style="width:150px;min-height:32px;border:1px solid var(--line);border-radius:6px;padding:0 6px;background:var(--card);color:var(--ink)"></td><td style="font-size:11px;color:var(--muted)">' + k + '</td><td style="font-size:12px">' + esc(it.grp_label) + '</td><td>' + (it.type === 'n' ? esc(it.unit || '') + '당' : 'O/X') + (it.leader_only ? '<br><span class="badge gray">구역장</span>' : '') + '</td>'
        + '<td><input id="it-points-' + k + '" type="number" min="0" value="' + C41.n(it.points) + '" style="width:64px;min-height:32px;text-align:center;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--ink)"></td>'
        + '<td>' + (it.type === 'n' ? '<input id="it-cap-' + k + '" type="number" min="0" placeholder="없음" value="' + (it.cap == null ? '' : it.cap) + '" style="width:64px;min-height:32px;text-align:center;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--ink)">' : '<span class="z">-</span>') + '</td>'
        + '<td><input id="it-sort-' + k + '" type="number" value="' + C41.n(it.sort_order) + '" style="width:56px;min-height:32px;text-align:center;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--ink)"></td>'
        + '<td><input id="it-active-' + k + '" type="checkbox"' + (it.active ? ' checked' : '') + '></td>'
        + '<td><button class="btn sm ghost" data-act="saveItem" data-k="' + esc(k) + '">저장</button></td></tr>';
    });
    return h + '</table></div></div>';
  }
  /* ── 백업 ──────────────────────────────────────────────────────
     Free 플랜에는 Supabase 자동 백업이 없다. 그래서 교역자가 직접 내려받는다.
     두 파일을 함께 준다:
       · .json  사람이·도구가 읽는 원본 (분석·확인용)
       · .sql   SQL Editor 에 그대로 붙여 되살리는 파일 (ON CONFLICT DO NOTHING 이라 두 번 돌려도 안전)
     스키마는 git 의 sql/*.sql 에 있으므로 여기서는 **자료만** 받는다.
     auth 계정(비밀번호 해시·2단계 비밀키)은 받지 않는다 — 계정은 member_code 로 다시 발급하면 된다. */
  var BACKUP_TABLES = [
    // 되살릴 때의 순서다(참조 먼저). 두 번째 값은 중복 판정 키.
    ['districts',    ['id']],
    ['parishes',     ['id']],
    ['terms',        ['id']],
    ['term_weeks',   ['term_id', 'report_date']],
    ['score_items',  ['key']],
    ['app_settings', ['key']],
    ['members',      ['id']],
    ['reports',      ['id']],
    ['report_audit', ['id']],
  ];

  // PostgREST 는 한 번에 주는 행 수에 상한이 있다. 끝까지 훑는다.
  async function fetchAll(table) {
    var out = [], from = 0, PAGE = 1000;
    for (;;) {
      var r = await sb.from(table).select('*').range(from, from + PAGE - 1);
      if (r.error) throw new Error(table + ': ' + C41.errMsg(r.error));
      var got = r.data || [];
      out = out.concat(got);
      if (got.length < PAGE) return out;
      from += PAGE;
      if (from > 200000) throw new Error(table + ': 행이 너무 많습니다(20만 초과)');
    }
  }

  async function backupAll() {
    if (!await C41.ask('백업 내려받기',
        '모든 구역의 자료를 두 파일로 내려받습니다.\n\n'
        + '· JSON — 원본 그대로\n'
        + '· SQL  — SQL Editor 에 붙여 되살리는 파일\n\n'
        + '⚠ 두 파일에는 구역원 실명과 출석·봉사 기록이 들어 있습니다.\n'
        + '공유 폴더나 메신저에 그냥 두지 마세요.',
        { ok: '내려받기' })) return;

    busy(true);
    var data = {}, counts = {}, failed = [];
    for (var i = 0; i < BACKUP_TABLES.length; i++) {
      var name = BACKUP_TABLES[i][0];
      try { data[name] = await fetchAll(name); counts[name] = data[name].length; }
      catch (e) { failed.push(e.message); counts[name] = '실패'; }
    }
    busy(false);

    if (!Object.keys(data).length) return noteModal('백업 실패', failed.join('\n'));

    var stamp = C41.kstToday();
    var meta = {
      app: 'church_check', kind: 'full-backup', format: 1,
      exported_at: new Date().toISOString(),
      exported_by: (A.access && A.access.display_name) || 'admin',
      note: '스키마는 저장소의 sql/*.sql 에 있습니다. auth 계정은 포함하지 않습니다.',
      counts: counts,
      failed: failed,
    };
    C41.downloadText('church_check_backup_' + stamp + '.json',
      JSON.stringify({ meta: meta, tables: data }, null, 1), 'application/json');

    var sql = ['-- church_check 백업 복구용 — ' + stamp,
      '-- 먼저 저장소의 sql/001 과 003~010 을 적용해 스키마를 만든 뒤 이 파일을 붙여 넣으세요.',
      '-- 이미 있는 행은 건너뜁니다(ON CONFLICT DO NOTHING). 두 번 돌려도 안전합니다.',
      '-- 트리거가 총점을 다시 계산하므로 total_score 는 그대로 두어도 맞춰집니다.',
      ''];
    BACKUP_TABLES.forEach(function (t) {
      if (data[t[0]]) sql.push(C41.toInsertSql(t[0], data[t[0]], t[1]));
    });
    C41.downloadText('church_check_restore_' + stamp + '.sql', sql.join('\n'), 'text/plain');

    var rows = Object.keys(counts).map(function (k) {
      return '<div class="li"><span class="nm">' + esc(k) + '</span><span class="meta">'
        + esc(String(counts[k])) + '행</span></div>';
    }).join('');
    var bg = C41.modal('<h3>백업 완료 — ' + esc(stamp) + '</h3>'
      + '<div class="desc">두 파일이 내려받기 폴더에 저장됐습니다.<br>'
      + '<b>church_check_backup_' + esc(stamp) + '.json</b><br>'
      + '<b>church_check_restore_' + esc(stamp) + '.sql</b></div>'
      + rows
      + (failed.length ? '<div class="notice danger" style="white-space:pre-wrap">읽지 못한 표 '
          + failed.length + '개\n' + esc(failed.join('\n')) + '</div>' : '')
      + '<div class="notice">실명과 출석 기록이 들어 있습니다. 개인 저장소나 암호가 걸린 곳에 두세요.</div>'
      + '<div class="acts"><button class="btn sm" data-act="closeNote">확인</button></div>', { dismissable: false });
    bg.querySelector('[data-act="closeNote"]').addEventListener('click', function () { bg.close(); });
  }

  /* ── 교역자 · 관리자 계정 ──────────────────────────────────────
     구역원과 달리 명단에 속하지 않으므로 Edge Function 의 전용 액션을 쓴다.
     여기서 만든 계정은 role=admin 이고, 2단계 인증을 마치기 전에는
     sql/010 의 is_admin() 이 aal2 를 요구하므로 서버가 모든 자료를 막는다. */
  async function loadStaff() {
    try { var d = await callAdmin({ action: 'list_staff' }); A.staff = d.staff || []; A.staffError = ''; }
    catch (e) { A.staff = []; A.staffError = '계정 목록을 읽지 못했습니다: ' + e.message; }
  }
  async function addStaff() {
    var idEl = document.getElementById('staff-id'), pwEl = document.getElementById('staff-pw');
    var roleEl = document.getElementById('staff-role');
    var id = (idEl.value || '').trim().toLowerCase(), pw = pwEl.value || '';
    var role = roleEl ? roleEl.value : 'pastor';
    if (!/^[a-z][a-z0-9]{2,19}$/.test(id)) return C41.toast('아이디는 영문 소문자로 시작하는 3~20자');
    if (pw.length < 8) return C41.toast('비밀번호는 8자 이상');
    if (!await C41.ask(role === 'admin' ? '관리자 계정 발급' : '교역자 계정 발급',
        '아이디 ' + id + ' 로 ' + (role === 'admin' ? '관리자' : '교역자') + ' 계정을 만듭니다.\n\n'
        + (role === 'admin'
            ? '이 계정은 모든 구역의 명단·출석·계정을 다룹니다.\n첫 로그인 때 2단계 인증 등록 화면이 뜨고, 등록 전에는 자료가 보이지 않습니다.'
            : '이 계정은 전 구역 현황을 보기만 합니다. 명단·계정·설정은 바꿀 수 없습니다.\n2단계 인증은 요구하지 않습니다.'),
        { ok: '발급', danger: role === 'admin' })) return;
    busy(true);
    var failed = '';
    try { await callAdmin({ action: 'create_staff_account', login_id: id, password: pw, role: role }); }
    catch (e) { failed = e.message; }
    busy(false);
    pwEl.value = '';                       // 비밀번호를 화면에 남겨 두지 않는다
    if (failed) return noteModal('계정 발급 실패', failed);
    idEl.value = '';
    await loadStaff(); render();
    noteModal((role === 'admin' ? '관리자' : '교역자') + ' 계정을 만들었습니다',
      '아이디: ' + id + '\n\n'
      + '본인에게 아이디와 비밀번호를 직접 전달하세요.\n'
      + (role === 'admin'
          ? '첫 로그인 때 2단계 인증(휴대폰 인증 앱) 등록 화면이 뜹니다. 등록을 마쳐야 자료가 보입니다.'
          : '로그인하면 바로 대시보드가 열립니다. 2단계 인증은 필요 없습니다.'));
  }

  function settingsHtml() {
    function setRow(s) {
      return '<label>' + esc(s.note || s.key) + '</label><span class="form"><input id="set-' + esc(s.key) + '" value="' + esc(s.value) + '" style="max-width:200px" data-enter="saveSetting" data-k="' + esc(s.key) + '"><button class="btn sm ghost" data-act="saveSetting" data-k="' + esc(s.key) + '">저장</button></span>';
    }
    var pwSet = A.settings.filter(function (s) { return s.key === 'default_password'; });
    var rest = A.settings.filter(function (s) { return s.key !== 'default_password'; });

    var h = '<div class="panel"><h2>입력 허용 기간</h2><div class="desc">오늘 기준 며칠 전 주차까지 입력할 수 있는지. 관리자는 제한이 없습니다.</div><div class="kv">';
    if (!A.settings.length) h += '<span></span><span class="notice">app_settings 를 읽지 못했습니다 (sql/003 필요)</span>';
    rest.forEach(function (s) { h += setRow(s); });
    h += '</div></div>';

    h += '<div class="panel"><h2>백업</h2>'
      + '<div class="desc">Supabase 무료 플랜에는 자동 백업이 없습니다. <b>한 달에 한 번</b> 직접 받아 두세요.<br>'
      + 'JSON(원본)과 SQL(복구용) 두 파일을 함께 내려받습니다. 스키마는 저장소에 있으므로 자료만 받습니다.</div>'
      + '<div class="form"><button class="btn sm" data-act="backupAll">백업 내려받기</button></div>'
      + '<div class="notice">받은 파일에는 구역원 실명과 출석·봉사 기록이 들어 있습니다. '
      + '공유 폴더나 메신저에 그냥 두지 마세요.</div></div>';

    h += '<div class="panel"><h2>기본 비밀번호</h2>'
      + '<div class="desc">계정을 발급하거나 초기화할 때 주는 비밀번호입니다. '
      + '<b>비워 두면</b> 예전처럼 사람마다 서로 다른 무작위 비밀번호가 만들어집니다. (6자 이상)</div>';
    if (pwSet.length && pwSet[0].value) {
      h += '<div class="notice danger">지금은 모두가 <b>' + esc(pwSet[0].value) + '</b> 를 씁니다. '
         + '아이디가 구역원 번호라 이 값은 쉽게 짐작됩니다 — 주소를 아는 사람이면 누구나 다른 사람 이름으로 '
         + '출석·점수를 보고 고칠 수 있습니다. 각자 비밀번호를 바꾸도록 안내해 주세요.</div>';
    }
    h += '<div class="kv">';
    if (!pwSet.length) h += '<span></span><span class="notice">기본 비밀번호 설정이 없습니다 (sql/008 필요). 지금은 무작위로 발급됩니다.</span>';
    pwSet.forEach(function (s) { h += setRow(s); });
    h += '</div></div>';
    h += '<div class="panel"><h2>학기와 구역모임 날짜</h2><div class="desc">주차 탭에는 <b>등록된 모임 날짜</b>만 나타납니다. 구역모임은 매주가 아니므로 실제 모이는 일요일만 넣으세요.<br>모임 날짜를 하나도 넣지 않은 학기는 기간 안의 모든 일요일이 자동으로 잡힙니다. 이미 보고서가 있는 날짜는 끄더라도 계속 보입니다.</div>';
    if (A.weeksError) h += '<div class="notice">모임 날짜를 읽지 못했습니다: ' + esc(A.weeksError) + ' — sql/006 적용 여부를 확인하세요.</div>';
    A.terms.forEach(function (t) {
      var ws = A.weeks.filter(function (w) { return w.term_id === t.id; });
      var on = ws.filter(function (w) { return w.active !== false; });
      h += '<div class="li" style="flex-direction:column;align-items:stretch;gap:8px">';
      h += '<div><span class="nm">' + esc(t.name) + '</span><span class="meta">' + esc(t.id) + ' · ' + esc(t.start_date) + ' ~ ' + esc(t.end_date)
         + ' · <b>모임 ' + on.length + '회</b>' + (ws.length ? '' : ' <span class="badge warn">자동(매주)</span>') + '</span></div>';
      if (ws.length) {
        h += '<div style="display:flex;flex-wrap:wrap;gap:5px">';
        ws.forEach(function (w) {
          var act = w.active !== false;
          h += '<button class="btn sm ' + (act ? 'ghost' : 'danger') + '" data-act="toggleTermWeek" data-t="' + esc(t.id) + '" data-d="' + esc(w.report_date)
             + '" title="' + (act ? '이 날짜를 주차 탭에서 빼려면 누르세요' : '다시 켜려면 누르세요') + '">'
             + esc(C41.weekLabel(w.report_date)) + (act ? '' : ' (꺼짐)') + '</button>';
        });
        h += '</div>';
      }
      h += '<div class="form"><input type="date" id="tw-' + esc(t.id) + '" style="max-width:170px">'
         + '<button class="btn sm" data-act="addTermWeek" data-t="' + esc(t.id) + '">+ 모임 날짜 추가</button></div>';
      h += '</div>';
    });
    h += '<div class="form" style="margin-top:12px"><input id="t-id" placeholder="ID (예: 2027-1)" style="max-width:120px"><input id="t-name" placeholder="이름 (예: 2027년 1학기)"><input id="t-start" type="date" style="max-width:160px"><input id="t-end" type="date" style="max-width:160px"><button class="btn sm" data-act="addTerm">+ 학기 추가</button></div></div>';
    h += '<div class="panel"><h2>교역자 · 관리자 계정</h2>'
      + '<div class="desc">전체 구역을 보고 관리하는 계정입니다. 만들면 <b>첫 로그인 때 2단계 인증 등록 화면</b>이 뜨고, '
      + '등록을 마치기 전에는 서버(RLS)가 모든 자료를 막습니다.</div>';
    if (A.staffError) h += '<div class="notice danger">' + esc(A.staffError) + '</div>';
    if (A.staff && A.staff.length) {
      A.staff.forEach(function (u) {
        h += '<div class="li"><span class="nm">' + esc(u.login_id) + '</span>'
          + '<span class="meta">' + esc(C41.roleLabel(u.role))
          + ' · 마지막 로그인 ' + esc(u.last_sign_in_at ? String(u.last_sign_in_at).slice(0, 10) : '없음') + '</span>'
          + (u.role === 'pastor'
              ? '<span class="badge">읽기 전용</span>'
              : '<span class="badge ' + (u.mfa === true ? 'ok' : u.mfa === null ? 'warn' : 'danger') + '">'
                + (u.mfa === true ? '2단계 ✓' : u.mfa === null ? '2단계 확인불가' : '2단계 미등록') + '</span>')
          + '</div>';
      });
    }
    h += '<div class="form" style="margin-top:10px">'
      + '<input id="staff-id" placeholder="아이디 (예: admin41)" maxlength="20" style="max-width:200px" autocomplete="off">'
      + '<input id="staff-pw" type="password" placeholder="비밀번호 (8자 이상)" maxlength="72" style="max-width:220px" autocomplete="new-password">'
      + '<select id="staff-role"><option value="pastor">교역자 (대시보드만)</option><option value="admin">관리자 (전권)</option></select>'
      + '<button class="btn sm" data-act="addStaff">계정 발급</button></div>'
      + '<div class="desc"><b>교역자</b>는 전 구역 현황을 보기만 합니다 — 명단·계정·설정을 바꿀 수 없어 2단계 인증을 요구하지 않습니다.<br>'
      + '<b>관리자</b>는 계정 발급까지 하는 전권이라 <b>2단계 인증이 필수</b>입니다.<br>'
      + '아이디는 영문 소문자로 시작하는 3~20자입니다. 숫자만으로는 만들 수 없습니다 '
      + '(구역 번호·구역원 번호와 겹치기 때문입니다).</div></div>';
    return h;
  }
  function _render() {
    var app = document.getElementById('app');
    if (!A.ready) { C41.renderLogin({ subtitle: '관리자 화면' }); return; }
    var h = headerHtml() + segHtml();
    if (A.tab === 'members') h += membersHtml(); else if (A.tab === 'parishes') h += parishesHtml(); else if (A.tab === 'items') h += itemsHtml(); else h += settingsHtml();
    app.innerHTML = h;
    applyBusy();   // 대량 발급 중에 목록이 다시 그려져도 잠금이 풀리지 않게 한다
  }

  async function onAuth(user) {
    A.access = await C41.getAccess(user);
    if (!A.access.isAdmin) { window.location.href = 'church-checklist.html'; return; }
    // 이 화면은 모든 구역의 명단·계정을 다룬다. 2단계를 통과하지 못하면 그리지 않는다.
    // mfaGate 가 false 를 주면 등록·확인 화면을 이미 그린 상태이고, 통과하면 여기를 다시 부른다.
    if (!(await C41.mfaGate(A.access, function () { return onAuth(user); }))) return;
    A.ready = true; render();
    await loadParishes(); await loadMembers(); await loadItems(); await loadSettings(); render();
  }
  C41._onAuth = onAuth;

  var ACTIONS = {
    doLogout: async function () { await C41.signOut(); A.ready = false; render(); },
    setTab: function (el) {
      A.tab = el.getAttribute('data-t'); A.editing = null; render();
      // 교역자 계정 목록은 Edge Function 호출이라 설정 탭을 열 때만 읽는다.
      if (A.tab === 'settings' && !A.staff.length && !A.staffError) loadStaff().then(render);
    },
    selParish: async function (el) { A.selParish = el.value; A.editing = null; await loadMembers(); render(); },
    toggleDeleted: function (el) { A.showDeleted = el.checked; render(); },
    createAll: function () { createAll(); },
    resetAllPw: function () { resetAllPw(); },
    backupAll: function () { backupAll(); },
    addStaff: function () { addStaff(); },
    addMember: function () { addMember(); },
    edit: function (el) { A.editing = el.getAttribute('data-id'); render(); var ne = document.getElementById('ed-name'); if (ne) ne.focus(); },
    cancelEdit: function () { A.editing = null; render(); },
    saveEdit: function (el) { saveEdit(el.getAttribute('data-id')); },
    setState: function (el) { setState(el.getAttribute('data-id'), el.getAttribute('data-s')); },
    createAccount: function (el) { createAccount(el.getAttribute('data-id')); },
    resetPw: function (el) { resetPw(el.getAttribute('data-id')); },
    syncRole: function (el) { syncRole(el.getAttribute('data-id')); },
    unlinkAccount: function (el) { unlinkAccount(el.getAttribute('data-id')); },
    deleteAccount: function (el) { deleteAccount(el.getAttribute('data-id')); },
    addParish: function () { addParish(); },
    toggleParish: function (el) { toggleParish(el.getAttribute('data-id'), el.getAttribute('data-a') === '1'); },
    renameParish: function (el) { renameParish(el.getAttribute('data-id')); },
    saveItem: function (el) { saveItem(el.getAttribute('data-k')); },
    saveSetting: function (el) { saveSetting(el.getAttribute('data-k')); },
    addTerm: function () { addTerm(); },
    addTermWeek: function (el) { addTermWeek(el.getAttribute('data-t')); },
    toggleTermWeek: function (el) { toggleTermWeek(el.getAttribute('data-t'), el.getAttribute('data-d')); }
  };
  C41.bindActions(ACTIONS);

  (async function () {
    var r = await sb.auth.getSession();
    if (r.data && r.data.session) await onAuth(r.data.session.user); else C41.renderLogin({ subtitle: '관리자 화면' });
    // 로그아웃 뒤 뒤로 가기로 이 화면이 되살아나면 세션을 다시 확인하고 새로 읽는다
    // (관리 화면은 구역원 번호·임시 비밀번호 모달까지 그대로 복원된다)
    C41.guardRestore(function () { location.reload(); });
    sb.auth.onAuthStateChange(function (ev) { if (ev === 'SIGNED_OUT' && A.ready) { A.ready = false; render(); } });
  })();
})();
