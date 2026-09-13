/* ═══════════════════════════════════════════════════════════════
   대시보드 — 교역자·관리자(전체) + 구역장(자기 구역)
   · 주간 현황: 구역별 항목 집계 + KPI + 순위 + CSV
   · 추이: 최근 12주 구역×주차 출석률 히트맵 + 전체 추이 차트 (v_parish_week)
   · 구역 상세: 구역원×주차 출석 격자 (v_member_week)
   ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  var sb = C41.init(), esc = C41.esc;
  var TREND_WEEKS = 12, DETAIL_WEEKS = 8;
  var COLLAPSE = { 3: '구역봉사', 3.5: '봉사팀봉사' }; // 세부 항목을 한 열로 묶는 그룹

  var D = { access: null, ready: false, loading: false, week: '', weeks: [], tab: 'week',
            parishes: [], rows: null, pw: [], selParish: '', detail: null, detailWeeks: [],
            // null = 전체(교역자·관리자), '4133' 같은 값 = 그 구역만(구역장)
            scope: null };

  /* ── 데이터 ─────────────────────────────────────────────────── */
  async function loadParishes() {
    var r = await sb.from('parishes').select('*').order('id');
    D.parishes = (r.data || []).filter(function (p) { return p.active !== false; }).sort(function (a, b) { return (C41.n(a.sort_order) - C41.n(b.sort_order)) || String(a.id).localeCompare(String(b.id)); });
    // 구역장은 자기 구역만 본다. parishes 는 이름만 담은 표라 RLS 가 막지 않으므로
    // (구역원 화면이 자기 구역 이름을 읽어야 한다) 여기서 좁힌다.
    // ★ 실제 자료(reports·members·분석 뷰)는 RLS 가 이미 구역으로 가른다 —
    //   이 필터는 화면 정리이지 방벽이 아니다.
    if (D.scope) D.parishes = D.parishes.filter(function (p) { return p.id === D.scope; });
    if (r.error) C41.toast('구역 목록 실패: ' + C41.errMsg(r.error));
  }
  async function loadWeek() {
    D.loading = true; render();
    var r = await sb.from('reports').select('*').eq('report_date', D.week).neq('state', 'Delete');
    if (r.error) C41.toast('조회 실패: ' + C41.errMsg(r.error));
    D.rows = r.data || [];
    var tw = trendWeeks();
    var t = await sb.from('v_parish_week').select('*').gte('report_date', tw[0]).lte('report_date', D.week).order('report_date');
    D.pw = t.error ? [] : (t.data || []);
    if (t.error) D.pwError = C41.errMsg(t.error);
    D.loading = false; render();
    var done = calc(); var n = D.parishes.filter(function (p) { return done[p.id].n > 0; }).length;
    C41.toast(n ? n + '개 구역 입력 완료' : '입력된 구역 없음');
  }
  async function loadDetail() {
    if (!D.selParish) { D.detail = null; return; }
    var weeks = C41.lastMeetings(D.weeks, D.week, DETAIL_WEEKS), from = weeks[0];
    var r = await sb.from('v_member_week').select('*').eq('parish_id', D.selParish).gte('report_date', from).lte('report_date', D.week).order('report_date');
    var m = await sb.from('members').select('*').eq('parish_id', D.selParish).order('created_at');
    if (r.error || m.error) { C41.toast('상세 조회 실패: ' + C41.errMsg(r.error || m.error)); D.detail = null; return; }
    D.detailWeeks = weeks;
    // 체크리스트와 같은 순서로 보여야 나란히 놓고 볼 수 있다.
    D.detail = { members: C41.sortMembers((m.data || []).filter(function (x) { return x.state !== 'Delete'; })), rows: r.data || [] };
  }

  /* ── 집계 ─────────────────────────────────────────────────── */
  function tableCols() {
    var cols = [], seen = {};
    C41.items.forEach(function (it) {
      if (it.key === 'attendance' || it.leader_only) return;
      if (COLLAPSE[it.grp]) { if (!seen[it.grp]) { seen[it.grp] = { key: 'g' + it.grp, label: COLLAPSE[it.grp], type: 'multi', keys: [], points: it.points }; cols.push(seen[it.grp]); } seen[it.grp].keys.push(it.key); return; }
      cols.push({ key: it.key, label: it.label, type: it.type, keys: [it.key], points: it.points, cap: it.cap, unit: it.unit });
    });
    return cols;
  }
  function rowScore(row) { return row.total_score != null ? C41.n(row.total_score) : C41.score(row, C41.itemsFor(row.role)); }
  function calc() {
    var cols = tableCols(), r = {};
    D.parishes.forEach(function (p) { r[p.id] = { n: 0, leader: '', lAtt: 0, lFu: 0, lBible: 0, bibleList: [], items: {}, total: 0, att: [] }; cols.forEach(function (c) { r[p.id].items[c.key] = { cnt: 0, sum: 0, sc: 0 }; }); });
    (D.rows || []).forEach(function (row) {
      var a = r[String(row.parish_id)]; if (!a) return;
      a.n++; a.total += rowScore(row);
      if (row.role === '구역장') { a.leader = row.member_name; if (row.attendance === 'O') a.lAtt = 1; if (row.followup_meeting === 'O') a.lFu = 1; a.lBible = C41.n(row.bible_read); }
      if (row.attendance === 'O') a.att.push(row.member_name);
      if (C41.n(row.bible_read) > 0) a.bibleList.push(C41.n(row.bible_read));
      cols.forEach(function (c) {
        var it = a.items[c.key];
        if (c.type === 'multi') { var on = c.keys.filter(function (k) { return row[k] === 'O'; }); if (on.length) { it.cnt++; it.sc += on.length * c.points; } }
        else if (c.type === 'c') { if (row[c.key] === 'O') { it.cnt++; it.sc += c.points; } }
        else { var v = C41.n(row[c.key]); if (v > 0) { it.cnt++; it.sum += v; it.sc += C41.itemScore(C41.items.filter(function (x) { return x.key === c.key; })[0], v); } }
      });
    });
    // 참석자 이름도 가나다순으로. 화면 표와 CSV 가 같은 순서를 쓴다.
    Object.keys(r).forEach(function (k) { r[k].att.sort(C41.byName); });
    return r;
  }
  function pwIndex() { var ix = {}; D.pw.forEach(function (x) { ix[x.parish_id + '|' + String(x.report_date).slice(0, 10)] = x; }); return ix; }
  // 구역모임은 매주가 아니다. 달력주로 거꾸로 세면 방학 구간이 0 으로 채워진다 — C41.lastMeetings 를 쓴다.
  function trendWeeks() { return C41.lastMeetings(D.weeks, D.week, TREND_WEEKS); }

  /* ── 렌더 ─────────────────────────────────────────────────── */
  function render() {
    var sy = window.scrollY;
    _render();
    requestAnimationFrame(function () { fitChart(); window.scrollTo(0, sy); });
  }
  // 그래프는 그려 놓고 **실제 폭을 재서 한 번 더 그린다.**
  // viewBox 를 고정해 두고 width:100% 로 늘이면 글자까지 같이 확대된다 —
  // 1990px 화면에서 축 글자가 30px 이 됐다(2026-09-13 제보). viewBox 를 픽셀 폭에 맞추면 1:1 이 된다.
  function fitChart() {
    var box = document.getElementById('trend-svg');
    if (!box || !D.series) return;
    var w = Math.min(960, Math.round(box.clientWidth));   // 넓은 화면에서 무한정 늘리지 않는다
    if (!w || Math.abs(w - (D.chartW || 0)) < 8) return;
    D.chartW = w;
    box.innerHTML = svgChart(D.series, w);
  }
  var fitTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(fitTimer);
    fitTimer = setTimeout(function () { D.chartW = 0; fitChart(); }, 150);
  });
  function rateClass(p) { return p >= 80 ? 'r3' : p >= 60 ? 'r2' : p >= 40 ? 'r1' : 'r0'; }

  function headerHtml() {
    return '<div class="hd"><div><h1>' + esc(C41.cfg.APP_NAME || '구역보고서') + ' 대시보드</h1><p>' + esc(C41.weekLabelLong(D.week)) + ' 주일 · ' + esc(C41.kstNowLabel()) + '</p><div class="who">' + esc(C41.roleLabel(D.access.role)) + (D.scope ? ' · ' + esc(D.scope) + '구역' : '') + '</div></div>'
      + '<div class="acts">'
      + (D.scope ? '<a class="btn icon" href="church-checklist.html" title="체크리스트" aria-label="체크리스트"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg></a>' : '')
      + ((D.scope || D.access.isPastor) ? '' : '<a class="btn icon" href="church-admin.html" title="관리" aria-label="관리"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"/></svg></a>')
      + '<button class="btn icon" data-act="doLogout" title="로그아웃" aria-label="로그아웃"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/></svg></button></div></div>';
  }
  function tabsHtml() {
    var h = '<div class="tabs">'; D.weeks.forEach(function (w) { h += '<button class="' + (w.k === D.week ? 'on' : '') + (w.future ? ' future' : '') + '" data-act="setWeek" data-w="' + esc(w.k) + '">' + esc(w.l) + '</button>'; }); return h + '</div>';
  }
  function segHtml() {
    return '<div class="seg" style="max-width:520px"><button class="' + (D.tab === 'week' ? 'on' : '') + '" data-act="setTab" data-t="week">주간 현황</button><button class="' + (D.tab === 'trend' ? 'on' : '') + '" data-act="setTab" data-t="trend">추이</button><button class="' + (D.tab === 'parish' ? 'on' : '') + '" data-act="setTab" data-t="parish">구역 상세</button></div>';
  }

  function weekTabHtml() {
    var ag = calc(), cols = tableCols(), P = D.parishes, ix = pwIndex();
    var done = P.filter(function (p) { return ag[p.id].n > 0; }), tAtt = 0, tScore = 0, tActive = 0;
    P.forEach(function (p) { tAtt += ag[p.id].att.length; tScore += ag[p.id].total; var v = ix[p.id + '|' + D.week]; tActive += v ? C41.n(v.active_members) : 0; });
    var prevW = C41.addDays(D.week, -7), prevScore = 0, prevAtt = 0, hasPrev = false;
    P.forEach(function (p) { var v = ix[p.id + '|' + prevW]; if (v) { hasPrev = true; prevScore += C41.n(v.total_score); prevAtt += C41.n(v.attended_cnt); } });
    var h = '<div class="ctrl"><button class="btn sm" data-act="reload">🔄 새로고침</button><button class="btn sm ghost" data-act="csv">⬇ CSV</button>'
      + (D.scope
          ? '<span class="info">' + esc(D.scope) + '구역 · 입력 <b style="color:var(--danger)">' + (done.length ? '완료' : '없음') + '</b></span></div>'
          : '<span class="info">총 <b>' + P.length + '</b>개 구역 중 <b style="color:var(--danger)">' + done.length + '</b>개 입력</span></div>');
    var missing = P.filter(function (p) { return ag[p.id].n === 0; });
    if (missing.length) {
      h += D.scope
        ? '<div class="notice">이 주차는 아직 입력이 없습니다.</div>'
        : '<div class="notice">미입력 구역: ' + esc(missing.map(function (p) { return p.name || p.id; }).join(', ')) + '</div>';
    }
    if (D.pwError) h += '<div class="notice info">추이 뷰(v_parish_week)를 읽지 못했습니다: ' + esc(D.pwError) + ' — sql/003 적용 여부를 확인하세요.</div>';
    h += '<div class="cards">'
      + (D.scope ? '' : '<div class="cd"><div class="v">' + done.length + '<span style="font-size:14px;color:var(--muted)">/' + P.length + '</span></div><div class="l">입력 구역</div></div>')
      + '<div class="cd"><div class="v">' + tAtt + (tActive ? '<span style="font-size:14px;color:var(--muted)">/' + tActive + '</span>' : '') + '</div><div class="l">출석' + (tActive ? ' (' + C41.pct(tAtt, tActive) + '%)' : '') + '</div>' + (hasPrev ? '<div class="d ' + (tAtt >= prevAtt ? 'up' : 'down') + '">전주 대비 ' + (tAtt - prevAtt >= 0 ? '+' : '') + (tAtt - prevAtt) + '</div>' : '') + '</div>'
      + '<div class="cd"><div class="v">' + C41.fmt(tScore) + '</div><div class="l">총점</div>' + (hasPrev ? '<div class="d ' + (tScore >= prevScore ? 'up' : 'down') + '">전주 대비 ' + (tScore - prevScore >= 0 ? '+' : '') + C41.fmt(tScore - prevScore) + '</div>' : '') + '</div>'
      // '본인 직접 입력 %' 카드는 뺐다. 4133 이 구역 공용 아이디로 바뀌면서(sql/012)
      // 구역원 입력은 전부 entered_by='parish' 가 되어 이 값이 늘 0% 가 된다 —
      // "아무도 스스로 안 한다"는 거짓 인상만 준다.
      + '</div>';
    if (!D.rows || !D.rows.length) return h + '<div class="msg">이 주차에 입력된 데이터가 없습니다</div>';

    h += '<div class="tw"><table class="rt"><tr><th rowspan="2" class="nm">구역</th><th rowspan="2">구역장</th><th class="y" colspan="3">구역장</th><th rowspan="2">출석<br>인원</th><th rowspan="2">재적</th><th rowspan="2">출석률</th>';
    cols.forEach(function (c) { h += '<th colspan="2">' + esc(c.label) + '<br>(' + (c.type === 'n' ? c.unit + '당' + c.points : c.points) + ')</th>'; });
    h += '<th rowspan="2" style="background:#1e2a1f">합계</th><th rowspan="2">참석자</th></tr><tr><th class="sub">출석</th><th class="sub">후속</th><th class="sub">성경</th>';
    cols.forEach(function (c) { h += '<th class="sub">' + (c.type === 'n' ? c.unit : '인원') + '</th><th class="sub">점수</th>'; });
    h += '</tr>';
    var tot = { lAtt: 0, lFu: 0, lBible: 0, att: 0, active: 0 }; cols.forEach(function (c) { tot[c.key] = { cnt: 0, sum: 0, sc: 0 }; });
    P.forEach(function (p) {
      var d = ag[p.id], v = ix[p.id + '|' + D.week], active = v ? C41.n(v.active_members) : 0, rate = active ? C41.pct(d.att.length, active) : null;
      tot.lAtt += d.lAtt; tot.lFu += d.lFu; tot.lBible += d.lBible > 0 ? 1 : 0; tot.att += d.att.length; tot.active += active;
      h += '<tr><td class="nm"><a href="church-checklist.html?parish=' + esc(p.id) + '">' + esc(p.id) + '</a></td><td style="font-size:12px">' + esc(d.leader) + '</td>'
        + '<td>' + (d.lAtt ? '<span class="o">O</span>' : '<span class="z">-</span>') + '</td><td>' + (d.lFu ? '<span class="o">O</span>' : '<span class="z">-</span>') + '</td><td>' + (d.lBible > 0 ? '<span class="o">O</span>' : '<span class="z">-</span>') + '</td>'
        + '<td>' + (d.att.length ? '<span class="v">' + d.att.length + '</span>' : '<span class="z">0</span>') + '</td><td>' + (active || '<span class="z">-</span>') + '</td>'
        + '<td class="rate ' + (rate == null ? '' : rateClass(rate)) + '">' + (rate == null ? '<span class="z">-</span>' : rate + '%') + '</td>';
      cols.forEach(function (c) {
        var it = d.items[c.key]; tot[c.key].cnt += it.cnt; tot[c.key].sum += it.sum; tot[c.key].sc += it.sc;
        var first = c.type === 'n' ? it.sum : it.cnt;
        h += '<td>' + (first > 0 ? '<span class="v">' + first + '</span>' : '<span class="z">0</span>') + '</td><td>' + (it.sc > 0 ? '<span class="v">' + C41.fmt(it.sc) + '</span>' : '<span class="z">0</span>') + '</td>';
      });
      h += '<td class="sc">' + (d.total > 0 ? C41.fmt(d.total) : '') + '</td><td class="att">' + esc(d.att.join(', ')) + '</td></tr>';
    });
    h += '<tr class="tr"><td class="nm">합계</td><td>' + P.filter(function (p) { return ag[p.id].leader; }).length + '</td><td>' + tot.lAtt + '</td><td>' + tot.lFu + '</td><td>' + tot.lBible + '</td><td>' + tot.att + '</td><td>' + (tot.active || '-') + '</td><td>' + (tot.active ? C41.pct(tot.att, tot.active) + '%' : '-') + '</td>';
    cols.forEach(function (c) { h += '<td>' + (c.type === 'n' ? tot[c.key].sum : tot[c.key].cnt) + '</td><td>' + C41.fmt(tot[c.key].sc) + '</td>'; });
    h += '<td class="sc">' + C41.fmt(tScore) + '</td><td></td></tr></table></div>';
    h += '<div class="rt-note">구역 번호를 누르면 해당 구역 체크리스트로 이동합니다. 재적·출석률은 현재 명단 기준입니다.</div>';

    if (D.scope) return h;   // 구역이 하나뿐이면 순위는 뜻이 없다
    var sorted = P.slice().sort(function (a, b) { return ag[b.id].total - ag[a.id].total; }), mx = sorted.length ? Math.max(1, ag[sorted[0].id].total) : 1;
    h += '<div class="bs"><div class="bs-t">총점 순위</div>';
    sorted.forEach(function (p) { var sc = ag[p.id].total, pct = Math.round(sc / mx * 100); h += '<div class="br"><span class="br-l">' + esc(p.id) + '</span><div class="br-bg"><div class="br-f" style="width:' + pct + '%"></div></div><span class="br-v">' + C41.fmt(sc) + '</span></div>'; });
    h += '</div>';
    return h;
  }

  function trendTabHtml() {
    var W = trendWeeks(), ix = pwIndex(), P = D.parishes;
    if (!D.pw.length) return '<div class="msg">추이 데이터가 없습니다' + (D.pwError ? '<br><small>' + esc(D.pwError) + '</small>' : '') + '</div>';
    // 전체 추이 (출석률, 총점)
    // 분모에는 그 주차에 입력이 있는 구역의 재적만 넣는다.
    // v_parish_week 는 parishes × v_weeks CROSS JOIN 이라 입력이 0건인 구역도 행이 나오고,
    // 그것까지 더하면 전체 출석률이 개별 구역 행보다 늘 낮게 나온다(히트맵의 '-' 와 어긋남).
    var series = W.map(function (w) {
      var att = 0, act = 0, sc = 0, ent = 0;
      P.forEach(function (p) {
        var v = ix[p.id + '|' + w];
        if (!v || !C41.n(v.entered_cnt)) return;
        att += C41.n(v.attended_cnt); act += C41.n(v.active_members); sc += C41.n(v.total_score); ent += 1;
      });
      return { w: w, rate: act ? Math.round(att / act * 100) : 0, att: att, score: sc, entered: ent };
    });
    D.series = series;
    var h = '<div class="chart"><div class="t">전체 출석률(%)과 총점 — 최근 모임 ' + W.length + '회</div>'
      + '<div id="trend-svg">' + svgChart(series, D.chartW) + '</div><div class="legend"><span><i style="background:var(--viz-line)"></i>출석률 %</span><span><i style="background:var(--viz-bar)"></i>총점</span></div></div>';
    // 히트맵: 구역 × 주차 출석률
    h += '<div class="tw"><table class="rt"><tr><th class="nm">구역</th>';
    W.forEach(function (w) { h += '<th>' + esc(C41.weekLabel(w)) + '</th>'; }); h += '<th>평균</th></tr>';
    P.forEach(function (p) {
      var sum = 0, n = 0; h += '<tr><td class="nm"><a href="church-checklist.html?parish=' + esc(p.id) + '">' + esc(p.id) + '</a></td>';
      W.forEach(function (w) { var v = ix[p.id + '|' + w]; if (!v || !C41.n(v.entered_cnt)) { h += '<td class="z">-</td>'; return; } var r = C41.pct(C41.n(v.attended_cnt), C41.n(v.active_members)); sum += r; n++; h += '<td class="rate ' + rateClass(r) + '" title="' + esc(v.attended_cnt + '/' + v.active_members + '명 · ' + C41.fmt(v.total_score) + '점') + '">' + r + '</td>'; });
      var avg = n ? Math.round(sum / n) : null; h += '<td class="rate ' + (avg == null ? '' : rateClass(avg)) + '">' + (avg == null ? '-' : avg + '%') + '</td></tr>';
    });
    h += '<tr class="tr"><td class="nm">전체</td>'; series.forEach(function (s) { h += '<td class="rate ' + rateClass(s.rate) + '">' + s.rate + '</td>'; }); h += '<td></td></tr>';
    h += '<tr><td class="nm">입력 구역</td>'; series.forEach(function (s) { h += '<td>' + s.entered + '/' + P.length + '</td>'; }); h += '<td></td></tr>';
    h += '</table></div><div class="rt-note">셀 값은 출석률(%) = 출석 인원 ÷ 현재 재적. 색이 진할수록 출석률이 높습니다: '
      + ['40 미만', '40~59', '60~79', '80 이상'].map(function (lbl, i) {
          return '<span class="badge" style="background:var(--rate-' + i + ');color:var(--rate-ink)">' + lbl + '</span>';
        }).join(' ') + '</div>';
    return h;
  }
  // 폭을 인자로 받는다. **viewBox 를 실제 픽셀 폭과 같게** 두어야 글자가 확대되지 않는다.
  // 고정 viewBox(640) 를 width:100% 로 늘이면 배율만큼 글자도 커진다 — 1990px 화면에서 30px 이 됐다.
  function svgChart(series, width) {
    var W = Math.max(280, Math.round(width || 640));
    var H = W < 560 ? 200 : 260;                       // 높이는 픽셀 고정. 넓다고 세로로 늘어날 이유가 없다
    var padL = 34, padR = 48, padT = 16, padB = 30, n = series.length;
    var iw = W - padL - padR, ih = H - padT - padB;
    var maxS = Math.max(1, Math.max.apply(null, series.map(function (s) { return s.score; })));
    function x(i) { return padL + (n > 1 ? i * iw / (n - 1) : iw / 2); }
    function yR(r) { return padT + ih - r / 100 * ih; }
    function yS(s) { return padT + ih - s / maxS * ih; }
    // 날짜가 겹칠 만큼 좁으면 건너뛰며 찍는다 (마지막 주차는 항상 찍는다)
    var gap = n > 1 ? iw / (n - 1) : iw;
    var step = Math.max(1, Math.ceil(38 / Math.max(1, gap)));
    var h = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" role="img" aria-label="출석률과 총점 추이">';
    [0, 25, 50, 75, 100].forEach(function (g) {
      h += '<line x1="' + padL + '" x2="' + (W - padR) + '" y1="' + yR(g) + '" y2="' + yR(g) + '" stroke="var(--viz-grid)" stroke-width="1"/>'
        + '<text x="' + (padL - 6) + '" y="' + (yR(g) + 4) + '" font-size="11" text-anchor="end" fill="var(--muted)">' + g + '</text>';
    });
    var bw = Math.min(26, Math.max(6, gap * 0.5));
    series.forEach(function (s, i) {
      h += '<rect x="' + (x(i) - bw / 2) + '" y="' + yS(s.score) + '" width="' + bw + '" height="' + (padT + ih - yS(s.score)) + '" fill="var(--viz-bar)" opacity=".7">'
        + '<title>' + esc(C41.weekLabel(s.w) + ' 총점 ' + C41.fmt(s.score)) + '</title></rect>';
    });
    h += '<polyline fill="none" stroke="var(--viz-line)" stroke-width="2.5" points="' + series.map(function (s, i) { return x(i) + ',' + yR(s.rate); }).join(' ') + '"/>';
    series.forEach(function (s, i) {
      h += '<circle cx="' + x(i) + '" cy="' + yR(s.rate) + '" r="3.5" fill="var(--viz-line)">'
        + '<title>' + esc(C41.weekLabel(s.w) + ' 출석률 ' + s.rate + '% (' + s.att + '명)') + '</title></circle>';
      if (i % step === 0 || i === n - 1) {
        h += '<text x="' + x(i) + '" y="' + (H - 10) + '" font-size="12" text-anchor="middle" fill="var(--muted)">' + esc(C41.weekLabel(s.w)) + '</text>';
      }
    });
    h += '<text x="' + (W - padR + 6) + '" y="' + (padT + 10) + '" font-size="11" fill="var(--muted)">' + C41.fmt(maxS) + '점</text>';
    return h + '</svg>';
  }

  // 어떻게 로그인하는 사람인가. 2026-09 부터 구역원은 구역 공용 아이디를 쓰고
  // 개인 계정은 잠겨 있다(sql/012). user_id 가 남아 있다고 '있음' 이라 적으면
  // 구역장이 "개인 아이디로도 들어갈 수 있구나" 로 읽는다 — 실제로는 못 들어간다.
  function loginBadge(m) {
    if (m.role === '구역원') return '<span class="badge gray">공용</span>';
    return m.user_id ? '<span class="badge ok">개인</span>' : '<span class="badge gray">없음</span>';
  }
  function parishTabHtml() {
    var h;
    if (D.scope) {
      h = '<div class="ctrl"><span class="info"><b>' + esc(D.scope) + '</b>구역</span>'
        + '<a class="btn sm ghost" href="church-checklist.html">체크리스트 열기</a></div>';
    } else {
      h = '<div class="ctrl"><label for="sel-parish" style="font-weight:700">구역</label><select id="sel-parish" data-change="selParish" style="min-height:40px;border:2px solid var(--line);border-radius:9px;padding:0 10px;background:var(--card);color:var(--ink)"><option value="">선택</option>';
      D.parishes.forEach(function (p) { h += '<option value="' + esc(p.id) + '"' + (p.id === D.selParish ? ' selected' : '') + '>' + esc(p.id + (p.name && p.name !== p.id + '구역' ? ' ' + p.name : '')) + '</option>'; });
      h += '</select>' + (D.selParish ? '<a class="btn sm ghost" href="church-checklist.html?parish=' + esc(D.selParish) + '">체크리스트 열기</a>' : '') + '</div>';
    }
    if (!D.selParish) return h + '<div class="msg">구역을 선택하면 구역원별 최근 ' + DETAIL_WEEKS + '주 출석과 점수를 보여줍니다</div>';
    if (!D.detail) return h + '<div class="msg">불러오는 중...</div>';
    var W = D.detailWeeks, ix = {}; D.detail.rows.forEach(function (r) { ix[r.member_id + '|' + String(r.report_date).slice(0, 10)] = r; });
    h += '<div class="tw"><table class="rt"><tr><th class="nm">이름</th><th>직책</th><th>번호</th><th>로그인</th>';
    W.forEach(function (w) { h += '<th>' + esc(C41.weekLabel(w)) + '</th>'; }); h += '<th>출석</th><th>점수</th></tr>';
    var colAtt = {}; W.forEach(function (w) { colAtt[w] = 0; });
    D.detail.members.forEach(function (m) {
      var att = 0, sc = 0;
      h += '<tr><td class="nm">' + esc(m.name) + '</td><td>' + (m.role !== '구역원' ? '<span class="badge">' + esc(m.role) + '</span>' : '') + '</td><td style="font-size:12px">' + esc(m.member_code || '-') + '</td><td>' + loginBadge(m) + '</td>';
      W.forEach(function (w) { var r = ix[m.id + '|' + w]; if (!r) { h += '<td class="z">·</td>'; return; } sc += C41.n(r.total_score); if (r.attendance === 'O') { att++; colAtt[w]++; h += '<td class="o" title="' + esc(C41.enteredLabel(r.entered_by) + ' 입력 · ' + r.total_score + '점') + '">O</td>'; } else h += '<td class="z" title="' + esc(C41.enteredLabel(r.entered_by) + ' 입력') + '">-</td>'; });
      h += '<td class="v">' + att + '/' + W.length + '</td><td class="sc">' + C41.fmt(sc) + '</td></tr>';
    });
    h += '<tr class="tr"><td class="nm">출석 인원</td><td></td><td></td><td></td>'; W.forEach(function (w) { h += '<td>' + colAtt[w] + '</td>'; }); h += '<td colspan="2"></td></tr></table></div>';
    h += '<div class="rt-note">· = 미입력, - = 결석. 셀에 마우스를 올리면 입력자와 점수가 보입니다.</div>';
    return h;
  }

  function _render() {
    var app = document.getElementById('app');
    if (!D.ready) { C41.renderLogin({ subtitle: '교역자 · 구역장 대시보드' }); return; }
    var h = headerHtml() + tabsHtml() + segHtml();
    if (D.loading) { app.innerHTML = h + '<div class="msg">불러오는 중...</div>'; C41.scrollTabIntoView(); return; }
    if (D.tab === 'week') h += weekTabHtml(); else if (D.tab === 'trend') h += trendTabHtml(); else h += parishTabHtml();
    app.innerHTML = h; C41.scrollTabIntoView();
  }

  function exportCsv() {
    var ag = calc(), cols = tableCols(), ix = pwIndex();
    var header = ['주차', '구역', '구역장', '구역장출석', '후속모임', '출석인원', '재적', '출석률%'];
    cols.forEach(function (c) { header.push(c.label + (c.type === 'n' ? '(' + c.unit + ')' : '(인원)')); header.push(c.label + '(점수)'); });
    header.push('합계', '참석자');
    var rows = D.parishes.map(function (p) {
      var d = ag[p.id], v = ix[p.id + '|' + D.week], active = v ? C41.n(v.active_members) : '';
      var r = [D.week, p.id, d.leader, d.lAtt ? 'O' : '', d.lFu ? 'O' : '', d.att.length, active, active ? C41.pct(d.att.length, active) : ''];
      cols.forEach(function (c) { r.push(c.type === 'n' ? d.items[c.key].sum : d.items[c.key].cnt); r.push(d.items[c.key].sc); });
      r.push(d.total, d.att.join(' ')); return r;
    });
    C41.downloadCsv('구역보고서_' + D.week + '.csv', header, rows);
  }

  async function onAuth(user) {
    D.access = await C41.getAccess(user);
    // 대시보드를 볼 수 있는 사람: 교역자·관리자(전체)와 구역장(자기 구역).
    // 권찰·구역원은 입력 화면으로 보낸다.
    D.scope = C41.dashboardScope(D.access);
    if (D.scope === false) { window.location.href = 'church-checklist.html'; return; }
    // 2단계 인증은 관리자에게만 건다(mfaGate 가 판단한다). 구역장은 그대로 지나간다.
    if (!(await C41.mfaGate(D.access, function () { return onAuth(user); }))) return;
    D.ready = true; D.loading = true; render();
    await C41.loadItems(); D.weeks = await C41.loadWeeks(); D.week = C41.pickWeek(D.weeks);   // 읽기 화면이라 입력 기간은 따지지 않는다
    await loadParishes();
    if (D.scope) D.selParish = D.scope;      // 고를 것이 하나뿐이다
    await loadWeek();
  }
  C41._onAuth = onAuth;

  var ACTIONS = {
    doLogout: async function () { await C41.signOut(); D.ready = false; render(); },
    reload: function () { loadWeek(); },
    csv: function () { exportCsv(); },
    setWeek: function (el) { D.week = el.getAttribute('data-w'); D.detail = null; loadWeek().then(function () { if (D.tab === 'parish' && D.selParish) loadDetail().then(render); }); },
    setTab: function (el) { D.tab = el.getAttribute('data-t'); render(); if (D.tab === 'parish' && D.selParish && !D.detail) loadDetail().then(render); },
    selParish: function (el) { D.selParish = el.value; D.detail = null; render(); loadDetail().then(render); }
  };
  C41.bindActions(ACTIONS);

  (async function () {
    var r = await sb.auth.getSession();
    if (r.data && r.data.session) await onAuth(r.data.session.user); else C41.renderLogin({ subtitle: '교역자 · 구역장 대시보드' });
    // 로그아웃 뒤 뒤로 가기로 이 화면이 되살아나면 세션을 다시 확인하고 새로 읽는다
    C41.guardRestore(function () { location.reload(); });
    sb.auth.onAuthStateChange(function (ev) { if (ev === 'SIGNED_OUT' && D.ready) { D.ready = false; render(); } });
  })();
})();
