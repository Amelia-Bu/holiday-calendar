(function () {
  'use strict';

  var WEEK_CN = ['一', '二', '三', '四', '五', '六', '日'];
  var map = new Map();

  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function iso(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parseISO(s) {
    var p = s.split('-');
    return new Date(+p[0], +p[1] - 1, +p[2]);
  }
  function addDays(d, n) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  }
  var LUNAR = (function () {
    var g = window.solarLunar || window.solarlunar;
    if (!g) return null;
    return g.default || g;
  })();

  function lunarOf(d) {
    if (!LUNAR) return null;
    var y = d.getFullYear();
    // 库的历法表只覆盖 1900–2100，超出会返回 -1，直接当作无数据
    if (y < 1900 || y > 2100) return null;
    try {
      var r = LUNAR.solar2lunar(y, d.getMonth() + 1, d.getDate());
      if (!r || typeof r.lMonth !== 'number' || r.lMonth < 1) return null;
      return r;
    } catch (e) {
      return null;
    }
  }

  // 农历节日表：键为「月-日」（闰月不计）
  var LUNAR_FEST = {
    '1-1': '春节',
    '1-15': '元宵',
    '2-2': '龙抬头',
    '3-3': '上巳',
    '5-5': '端午',
    '6-6': '天贶',
    '7-7': '七夕',
    '7-15': '中元',
    '8-15': '中秋',
    '9-9': '重阳',
    '10-1': '寒衣',
    '10-15': '下元',
    '12-8': '腊八',
    '12-23': '小年'
  };

  var festCache = new Map();

  function festivalOf(d, r) {
    if (!r || r.isLeap) return '';
    var key = iso(d);
    if (festCache.has(key)) return festCache.get(key);
    var name = '';
    // 除夕：次日为正月初一
    var nx = lunarOf(addDays(d, 1));
    if (nx && !nx.isLeap && nx.lMonth === 1 && nx.lDay === 1) {
      name = '除夕';
    } else {
      name = LUNAR_FEST[r.lMonth + '-' + r.lDay] || '';
    }
    festCache.set(key, name);
    return name;
  }

  // 公历固定节日（非放假的也标出来）
  var SOLAR_FEST = {
    '1-1': '元旦',
    '2-14': '情人节',
    '3-8': '妇女节',
    '3-12': '植树节',
    '4-1': '愚人节',
    '5-1': '劳动节',
    '5-4': '青年节',
    '6-1': '儿童节',
    '7-1': '建党节',
    '8-1': '建军节',
    '9-10': '教师节',
    '10-1': '国庆节',
    '12-24': '平安夜',
    '12-25': '圣诞节'
  };

  // 浮动公历节日：某月第 n 个星期 w（0 = 周日）
  var FLOAT_FEST = [
    { m: 5, w: 0, n: 2, name: '母亲节' },
    { m: 6, w: 0, n: 3, name: '父亲节' },
    { m: 11, w: 4, n: 4, name: '感恩节' }
  ];

  function solarFestOf(d) {
    var hit = SOLAR_FEST[(d.getMonth() + 1) + '-' + d.getDate()];
    if (hit) return hit;
    var dom = d.getDate();
    var dow = d.getDay();
    for (var i = 0; i < FLOAT_FEST.length; i++) {
      var f = FLOAT_FEST[i];
      if (f.m === d.getMonth() + 1 && f.w === dow && Math.ceil(dom / 7) === f.n) return f.name;
    }
    return '';
  }

  function lunarLabel(d) {
    var r = lunarOf(d);
    if (!r) return { text: '', cls: '' };
    if (r.isTerm && r.term) return { text: r.term, cls: 'term' };
    var f = festivalOf(d, r) || solarFestOf(d);
    if (f) return { text: f, cls: 'fest' };
    if (r.lDay === 1) return { text: (r.isLeap ? '闰' : '') + r.monthCn, cls: 'mon' };
    return { text: r.dayCn, cls: '' };
  }

  function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }

  // ---- 构建日期索引 ----
  (function build() {
    var H = window.HOLIDAYS || {};
    Object.keys(H).forEach(function (y) {
      H[y].forEach(function (h) {
        var start = parseISO(h.start);
        var end = parseISO(h.end);
        var total = Math.round((end - start) / 86400000) + 1;
        var cur = start;
        var i = 0;
        while (cur <= end) {
          i++;
          map.set(iso(cur), {
            type: 'rest', name: h.name, idx: i, total: total, memo: h.memo, url: h.url
          });
          cur = addDays(cur, 1);
        }
        (h.comp || []).forEach(function (c, ci, arr) {
          map.set(c, {
            type: 'work', name: h.name, idx: ci + 1, total: arr.length, memo: h.memo, url: h.url
          });
        });
      });
    });
  })();

  var today = new Date();
  var qm = new URLSearchParams(location.search).get('m');
  var state = {
    mode: 'day',                 // day | month | year
    view: { y: today.getFullYear(), m: today.getMonth() },
    selected: new Date(today.getFullYear(), today.getMonth(), today.getDate()),
    pickerYear: today.getFullYear(),
    yearBase: Math.floor(today.getFullYear() / 10) * 10
  };
  if (qm && /^\d{4}-\d{1,2}$/.test(qm)) {
    var qp = qm.split('-');
    state.view = { y: +qp[0], m: +qp[1] - 1 };
    state.selected = new Date(+qp[0], +qp[1] - 1, 1);
  }
  var qv = new URLSearchParams(location.search).get('v');
  if (qv === 'month' || qv === 'year') {
    state.mode = qv;
    state.pickerYear = state.view.y;
    state.yearBase = Math.floor(state.view.y / 10) * 10;
  }

  var gridEl = document.getElementById('grid');
  var detailEl = document.getElementById('detail');
  var titleEl = document.getElementById('title');
  var titleTextEl = document.getElementById('titleText');
  var pickerEl = document.getElementById('picker');
  var dayviewEl = document.getElementById('dayview');
  var footEl = document.getElementById('foot');

  function buildCell(date) {
    var cell = document.createElement('div');
    cell.className = 'cell';
    if (!date) return cell;

    cell.classList.add('has-day');
    var rec = map.get(iso(date));
    var dow = date.getDay();

    if (rec && rec.type === 'rest') cell.classList.add('rest');
    else if (rec && rec.type === 'work') cell.classList.add('work');
    else if (dow === 0 || dow === 6) cell.classList.add('weekend');

    if (sameDay(date, today)) cell.classList.add('today');
    if (sameDay(date, state.selected)) cell.classList.add('sel');

    var num = document.createElement('div');
    num.className = 'num';
    num.textContent = date.getDate();
    cell.appendChild(num);

    var lun = lunarLabel(date);
    if (lun.text) {
      var lunEl = document.createElement('div');
      lunEl.className = 'lun' + (lun.cls ? ' ' + lun.cls : '');
      lunEl.textContent = lun.text;
      cell.appendChild(lunEl);
    }

    if (rec) {
      var tag = document.createElement('div');
      tag.className = 'tag ' + (rec.type === 'rest' ? 'rest' : 'work');
      tag.textContent = rec.type === 'rest' ? '休' : '班';
      cell.appendChild(tag);
    }

    cell.addEventListener('click', function () {
      state.selected = date;
      state.view = { y: date.getFullYear(), m: date.getMonth() };
      render();
    });

    return cell;
  }

  function renderDetail() {
    var d = state.selected;
    var rec = map.get(iso(d));
    var dow = d.getDay();
    var isWeekend = dow === 0 || dow === 6;

    detailEl.innerHTML = '';

    var row1 = document.createElement('div');
    row1.className = 'd-row1';
    var dt = document.createElement('div');
    dt.className = 'd-date';
    dt.textContent = (d.getMonth() + 1) + '月' + d.getDate() + '日 星期' + WEEK_CN[(dow + 6) % 7];
    row1.appendChild(dt);

    var badge = document.createElement('span');
    badge.className = 'badge';

    var sub = document.createElement('div');
    sub.className = 'd-sub';

    var memo = document.createElement('div');
    memo.className = 'd-memo';

    if (rec && rec.type === 'rest') {
      badge.className = 'badge rest';
      badge.textContent = '休';
      sub.textContent = rec.name + ' · 第' + rec.idx + '天 / 共' + rec.total + '天';
      memo.textContent = rec.memo;
    } else if (rec && rec.type === 'work') {
      badge.className = 'badge work';
      badge.textContent = '班';
      sub.textContent = rec.name + ' 调休 · 这天要上班';
      memo.textContent = rec.memo;
    } else {
      badge = null;
      sub.textContent = isWeekend ? '周末休息' : '工作日';
      sub.classList.add('muted');
      memo.textContent = '';
    }

    if (badge) row1.appendChild(badge);
    detailEl.appendChild(row1);

    var lr = lunarOf(d);
    if (lr) {
      var lunLine = document.createElement('div');
      lunLine.className = 'd-lunar';
      var t = '农历' + (lr.isLeap ? '闰' : '') + lr.monthCn + lr.dayCn;
      var lf = festivalOf(d, lr);
      if (lf) t += ' · ' + lf;
      var sf = solarFestOf(d);
      if (sf && sf !== lf) t += ' · ' + sf;
      if (lr.term) t += ' · ' + lr.term;
      t += ' · ' + lr.gzYear + lr.animal + '年';
      lunLine.textContent = t;
      detailEl.appendChild(lunLine);
    }

    detailEl.appendChild(sub);

    if (memo.textContent) detailEl.appendChild(memo);

    if (rec && rec.url) {
      var link = document.createElement('a');
      link.className = 'd-link';
      link.textContent = '查看国务院通知';
      link.addEventListener('click', function () { window.nat.openUrl(rec.url); });
      detailEl.appendChild(link);
    }
  }

  function monthStats(y, m) {
    var days = new Date(y, m + 1, 0).getDate();
    var count = 0, name = '';
    for (var i = 1; i <= days; i++) {
      var rec = map.get(iso(new Date(y, m, i)));
      if (rec && rec.type === 'rest') {
        count++;
        if (!name) name = rec.name;
      }
    }
    return { rest: count, name: name };
  }

  function yearRestDays(y) {
    var total = 0;
    for (var m = 0; m < 12; m++) total += monthStats(y, m).rest;
    return total;
  }

  function fitHeight() {
    window.requestAnimationFrame(function () {
      var h = document.getElementById('flyout').getBoundingClientRect().height + 16;
      window.nat.setHeight(h);
    });
  }

  function tile(label, sub, cls) {
    var b = document.createElement('button');
    b.className = 'pm' + (cls ? ' ' + cls : '');
    var lb = document.createElement('span');
    lb.className = 'pm-label';
    lb.textContent = label;
    b.appendChild(lb);
    var sb = document.createElement('span');
    sb.className = 'pm-sub' + (sub && sub.rest ? ' rest' : '');
    sb.textContent = sub ? sub.text : ' ';
    b.appendChild(sb);
    return b;
  }

  function renderPicker() {
    var isMonth = state.mode === 'month';
    pickerEl.innerHTML = '';
    pickerEl.className = 'picker on ' + (isMonth ? 'months' : 'years');

    var now = new Date();
    var i, b;

    if (isMonth) {
      for (i = 0; i < 12; i++) {
        var st = monthStats(state.pickerYear, i);
        var cls = '';
        if (state.pickerYear === state.view.y && i === state.view.m) cls += ' active';
        if (state.pickerYear === now.getFullYear() && i === now.getMonth()) cls += ' now';
        b = tile((i + 1) + '月', st.name ? { text: st.name, rest: true } : null, cls);
        b.addEventListener('click', (function (mm) {
          return function () {
            state.view = { y: state.pickerYear, m: mm };
            var sel = state.selected;
            if (sel.getFullYear() !== state.pickerYear || sel.getMonth() !== mm) {
              state.selected = new Date(state.pickerYear, mm, 1);
            }
            state.mode = 'day';
            render();
          };
        })(i));
        pickerEl.appendChild(b);
      }
      footEl.textContent = '选择月份 · Esc 返回';
    } else {
      for (i = 0; i < 10; i++) {
        var y = state.yearBase + i;
        var has = Object.prototype.hasOwnProperty.call(window.HOLIDAYS || {}, String(y));
        var rest = has ? yearRestDays(y) : 0;
        var cls2 = '';
        if (y === state.pickerYear) cls2 += ' active';
        if (y === now.getFullYear()) cls2 += ' now';
        b = tile(String(y), has ? { text: '休 ' + rest + ' 天' } : { text: '未收录' }, cls2);
        b.addEventListener('click', (function (yy) {
          return function () {
            state.pickerYear = yy;
            state.mode = 'month';
            render();
          };
        })(y));
        pickerEl.appendChild(b);
      }
      footEl.textContent = '选择年份 · Esc 返回';
    }

    fitHeight();
  }

  function render() {
    var isDay = state.mode === 'day';
    dayviewEl.style.display = isDay ? '' : 'none';
    document.body.classList.toggle('picking', !isDay);

    if (isDay) {
      pickerEl.innerHTML = '';
      pickerEl.className = 'picker';
      titleTextEl.textContent = state.view.y + '年' + (state.view.m + 1) + '月';
      renderDay();
    } else if (state.mode === 'month') {
      titleTextEl.textContent = state.pickerYear + '年';
      renderPicker();
    } else {
      titleTextEl.textContent = state.yearBase + ' – ' + (state.yearBase + 9);
      renderPicker();
    }
  }

  function renderDay() {
    var y = state.view.y;
    var m = state.view.m;

    var first = new Date(y, m, 1);
    var lead = (first.getDay() + 6) % 7;
    var daysInMonth = new Date(y, m + 1, 0).getDate();

    var cells = [];
    var i;
    for (i = 0; i < lead; i++) cells.push(null);
    for (i = 1; i <= daysInMonth; i++) cells.push(new Date(y, m, i));
    while (cells.length % 7 !== 0) cells.push(null);

    gridEl.innerHTML = '';
    cells.forEach(function (d) { gridEl.appendChild(buildCell(d)); });

    renderDetail();

    var hasData = Object.prototype.hasOwnProperty.call(window.HOLIDAYS || {}, String(y));
    footEl.textContent = hasData
      ? '数据源：国务院办公厅 · ' + y + ' 年放假安排'
      : '数据源：国务院办公厅 · ' + y + ' 年安排尚未收录';

    fitHeight();
  }

  function goToday() {
    var n = new Date();
    today = new Date(n.getFullYear(), n.getMonth(), n.getDate());
    state.selected = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    state.view = { y: today.getFullYear(), m: today.getMonth() };
    state.pickerYear = today.getFullYear();
    state.yearBase = Math.floor(today.getFullYear() / 10) * 10;
    state.mode = 'day';
    render();
  }

  function cycleMode() {
    if (state.mode === 'day') {
      state.pickerYear = state.view.y;
      state.mode = 'month';
    } else if (state.mode === 'month') {
      state.yearBase = Math.floor(state.pickerYear / 10) * 10;
      state.mode = 'year';
    } else {
      state.mode = 'day';
    }
    render();
  }

  function step(dir) {
    if (state.mode === 'day') {
      var d = new Date(state.view.y, state.view.m + dir, 1);
      state.view = { y: d.getFullYear(), m: d.getMonth() };
      // 换月时选中日期也要跟过去，否则网格没有选中态、下方详情还停在旧月份
      var sel = state.selected;
      if (sel.getFullYear() !== d.getFullYear() || sel.getMonth() !== d.getMonth()) {
        var lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
        state.selected = new Date(d.getFullYear(), d.getMonth(), Math.min(sel.getDate(), lastDay));
      }
    } else if (state.mode === 'month') {
      state.pickerYear += dir;
    } else {
      state.yearBase += dir * 10;
    }
    render();
  }

  document.getElementById('prev').addEventListener('click', function () { step(-1); });
  document.getElementById('next').addEventListener('click', function () { step(1); });
  titleEl.addEventListener('click', cycleMode);

  document.getElementById('today').addEventListener('click', goToday);

  document.addEventListener('wheel', function (e) {
    if (Math.abs(e.deltaY) < 6) return;
    document.getElementById(e.deltaY > 0 ? 'next' : 'prev').click();
  }, { passive: true });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      if (state.mode !== 'day') { state.mode = 'day'; render(); }
      else { window.nat.hide(); }
    }
    else if (e.key === 'ArrowLeft') { document.getElementById('prev').click(); }
    else if (e.key === 'ArrowRight') { document.getElementById('next').click(); }
  });

  window.nat.onRefresh(goToday);

  render();
})();
