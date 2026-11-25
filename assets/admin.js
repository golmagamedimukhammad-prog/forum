/* Кабинет администратора JAS Coworking */
(function () {
  'use strict';

  const J = window.JAS;
  const { $, $$, esc } = J;

  const A = {
    me: null, settings: null, rooms: [], now: '', today: '',
    view: 'overview', schedDate: null, seenMaxId: 0, timer: null, booted: false,
    list: { preset: 'next30', from: '', to: '', room: '', status: 'active', type: '', q: '', rows: [] },
  };

  const TZ_LIST = [
    'Europe/Kaliningrad', 'Europe/Moscow', 'Europe/Minsk', 'Europe/Istanbul', 'Europe/Samara', 'Asia/Dubai', 'Asia/Baku',
    'Asia/Tbilisi', 'Asia/Yerevan', 'Asia/Yekaterinburg', 'Asia/Tashkent', 'Asia/Almaty', 'Asia/Bishkek', 'Asia/Omsk',
    'Asia/Novosibirsk', 'Asia/Krasnoyarsk', 'Asia/Irkutsk', 'Asia/Vladivostok', 'Europe/Kyiv', 'Europe/Berlin', 'Europe/London', 'UTC',
  ];
  const TZ_NAMES = {
    'Europe/Kaliningrad': 'Калининград', 'Europe/Moscow': 'Москва', 'Europe/Minsk': 'Минск', 'Europe/Istanbul': 'Стамбул',
    'Europe/Samara': 'Самара', 'Asia/Dubai': 'Дубай', 'Asia/Baku': 'Баку', 'Asia/Tbilisi': 'Тбилиси', 'Asia/Yerevan': 'Ереван',
    'Asia/Yekaterinburg': 'Екатеринбург', 'Asia/Tashkent': 'Ташкент', 'Asia/Almaty': 'Алматы, Астана', 'Asia/Bishkek': 'Бишкек',
    'Asia/Omsk': 'Омск', 'Asia/Novosibirsk': 'Новосибирск', 'Asia/Krasnoyarsk': 'Красноярск', 'Asia/Irkutsk': 'Иркутск',
    'Asia/Vladivostok': 'Владивосток', 'Europe/Kyiv': 'Киев', 'Europe/Berlin': 'Берлин', 'Europe/London': 'Лондон', UTC: 'UTC',
  };

  const VIEWS = {
    overview: { title: 'Обзор', sub: () => `${cap(J.fmtDate(A.today, { dow: true }))} · сейчас ${A.now.slice(11)}`, load: loadOverview },
    schedule: { title: 'Расписание', sub: () => 'Нажмите на свободную ячейку, чтобы добавить бронь', load: loadSchedule },
    bookings: { title: 'Все брони', sub: () => 'Поиск, фильтры и выгрузка в Excel (CSV)', load: loadBookings },
    admins: { title: 'Администраторы', sub: () => 'Доступ к кабинету — максимум 3 email', load: loadAdmins, static: true },
    settings: { title: 'Настройки', sub: () => 'Правила бронирования и параметры комнат', load: loadSettings, static: true },
  };

  /* ------------------------------------------------------------ утилиты */

  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const roomById = (id) => A.rooms.find((r) => r.id === id) || { id, name: id, capacity: 0 };
  const colorCls = (id) => (id === 'focus' ? 'focus' : 'alfa');
  const roomTag = (id) => `<span class="room-tag ${colorCls(id)}">${esc(roomById(id).name)}</span>`;
  const typeTag = (t) => `<span class="type-tag ${t === 'guest' ? 'guest' : 'resident'}">${t === 'guest' ? 'Гость' : 'Резидент'}</span>`;
  const initials = (s) => (s || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  const humans = (n) => `${n} ${J.plural(n, 'человек', 'человека', 'человек')}`;
  const hrs = (min) => (min % 60 ? (min / 60).toFixed(1).replace('.', ',') : String(min / 60));

  function dayLabel(date) {
    if (date === A.today) return 'Сегодня';
    if (date === J.addDays(A.today, 1)) return 'Завтра';
    if (date === J.addDays(A.today, -1)) return 'Вчера';
    const p = J.dateParts(date);
    return `${J.DOW_SHORT[p.dow]}, ${p.d} ${J.MONTHS_SHORT[p.m]}`;
  }

  function fmtInstant(iso, withYear = false) {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleString('ru-RU', {
        timeZone: A.settings.timezone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', ...(withYear ? { year: 'numeric' } : {}),
      });
    } catch {
      return iso;
    }
  }

  function ago(iso) {
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'только что';
    if (s < 3600) { const m = Math.floor(s / 60); return `${m} ${J.plural(m, 'минуту', 'минуты', 'минут')} назад`; }
    if (s < 86400) { const h = Math.floor(s / 3600); return `${h} ${J.plural(h, 'час', 'часа', 'часов')} назад`; }
    return fmtInstant(iso);
  }

  function tzLabel(tz) {
    let off = '';
    try {
      const p = new Intl.DateTimeFormat('ru-RU', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(new Date()).find((x) => x.type === 'timeZoneName');
      off = p ? p.value : '';
    } catch { /* неизвестный пояс */ }
    return `${TZ_NAMES[tz] || tz}${off ? ` (${off})` : ''}`;
  }

  /** Минуты брони внутри интервала [from, to). */
  function minutesWithin(b, from, to) {
    const s = b.start > from ? b.start : from;
    const e = b.end < to ? b.end : to;
    return s < e ? J.diffMin(s, e) : 0;
  }

  async function api(path, opts) {
    try {
      return await J.api(path, opts);
    } catch (err) {
      if (err.status === 401) {
        stopTimer();
        showAuth(await J.api('/api/admin/status').catch(() => ({ maxAdmins: 3, adminsCount: 0 })));
        J.toast('Сессия истекла — войдите снова', 'err');
      }
      throw err;
    }
  }

  /* ------------------------------------------------------------ вход */

  boot();

  async function boot() {
    $$('[data-icon]').forEach((el) => { el.innerHTML = J.ICONS[el.dataset.icon] || ''; });
    bindAuth();
    let st;
    try {
      st = await J.api('/api/admin/status');
    } catch (err) {
      document.body.innerHTML = `<div class="empty" style="padding:80px 20px"><b>Сервер недоступен</b>${esc(err.message)}</div>`;
      return;
    }
    if (st.me) enterApp();
    else showAuth(st);
  }

  function showAuth(st) {
    $('#appScreen').hidden = true;
    $('#authScreen').hidden = false;
    const free = Math.max(0, st.maxAdmins - st.adminsCount);
    const dots = Array.from({ length: st.maxAdmins }, (_, i) => `<i class="${i < st.adminsCount ? 'on' : ''}"></i>`).join('');
    const seats = $('#seats');
    seats.className = `seats${free ? '' : ' full'}`;
    seats.innerHTML = `<div class="seats-row"><b>Зарегистрировано ${st.adminsCount} из ${st.maxAdmins}</b><span class="seat-dots">${dots}</span></div>
      <p>${free
    ? `Свободно ${free} ${J.plural(free, 'место', 'места', 'мест')}. Кабинет доступен максимум для ${st.maxAdmins} email. Для регистрации нужен код приглашения.`
    : 'Все места заняты. Чтобы добавить новый email, действующий администратор должен освободить место в разделе «Администраторы».'}</p>`;
    $('#regFields').hidden = !free;
    switchTab(st.adminsCount === 0 ? 'register' : 'login');
  }

  function switchTab(tab) {
    $$('.auth-tabs button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tab === tab)));
    $('#loginForm').hidden = tab !== 'login';
    $('#registerForm').hidden = tab !== 'register';
    const first = $(tab === 'login' ? '#l-email' : '#r-invite');
    if (first && !$('#authScreen').hidden) setTimeout(() => first.focus(), 30);
  }

  function bindAuth() {
    $('.auth-tabs').addEventListener('click', (e) => {
      const b = e.target.closest('[data-tab]');
      if (b) switchTab(b.dataset.tab);
    });

    const submitAuth = (formSel, url, fields) => async (e) => {
      e.preventDefault();
      const form = $(formSel);
      const btn = form.querySelector('.auth-submit');
      const body = Object.fromEntries(fields.map((f) => [f, form.elements[f].value]));
      J.showFieldErrors(form, {});
      btn.disabled = true;
      try {
        await J.api(url, { method: 'POST', body });
        form.reset();
        enterApp();
      } catch (err) {
        J.showFieldErrors(form, { form: err.message, ...((err.data && err.data.errors) || {}) });
        if (err.status === 403 && url.endsWith('register')) J.api('/api/admin/status').then(showAuth).catch(() => {});
      } finally {
        btn.disabled = false;
      }
    };
    $('#loginForm').addEventListener('submit', submitAuth('#loginForm', '/api/admin/login', ['email', 'password']));
    $('#registerForm').addEventListener('submit', submitAuth('#registerForm', '/api/admin/register', ['invite', 'name', 'email', 'password']));
  }

  /* ------------------------------------------------------------ кабинет */

  async function enterApp() {
    let ov;
    try {
      ov = await J.api('/api/admin/overview');
    } catch (err) {
      J.toast(err.message, 'err');
      return;
    }
    applyMeta(ov);
    $('#authScreen').hidden = true;
    $('#appScreen').hidden = false;
    $('#meName').textContent = A.me.name || 'Администратор';
    $('#meEmail').textContent = A.me.email;
    $('#meAvatar').textContent = initials(A.me.name || A.me.email);
    A.schedDate = A.schedDate || A.today;

    if (!A.booted) {
      A.booted = true;
      window.addEventListener('hashchange', route);
      document.addEventListener('visibilitychange', () => { if (!document.hidden && A.me) tick(); });
      $('#logoutBtn').addEventListener('click', logout);
      $('#newBookingBtn').addEventListener('click', () => openNewBooking({}));
      $('#view').addEventListener('click', onViewClick);
      $('#view').addEventListener('keydown', (e) => {
        if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-open][tabindex]')) { e.preventDefault(); onViewClick(e); }
      });
    }
    try {
      const recent = await api('/api/admin/bookings/recent');
      A.seenMaxId = recent.bookings.reduce((m, b) => Math.max(m, b.id), 0);
    } catch { /* не критично */ }
    route();
    setSync(true);
    stopTimer();
    A.timer = setInterval(tick, 30000);
  }

  function applyMeta(ov) {
    A.me = ov.me;
    A.settings = ov.settings;
    A.rooms = ov.rooms;
    A.now = ov.now;
    A.today = ov.today;
  }

  function stopTimer() {
    if (A.timer) clearInterval(A.timer);
    A.timer = null;
  }

  async function logout() {
    stopTimer();
    try { await J.api('/api/admin/logout', { method: 'POST' }); } catch { /* всё равно выходим */ }
    A.me = null;
    history.replaceState(null, '', location.pathname);
    showAuth(await J.api('/api/admin/status'));
  }

  function route() {
    const v = location.hash.slice(1);
    A.view = VIEWS[v] ? v : 'overview';
    $$('#nav a').forEach((a) => {
      if (a.dataset.view === A.view) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    $('#viewTitle').textContent = VIEWS[A.view].title;
    $('#viewSub').textContent = VIEWS[A.view].sub();
    $('#view').innerHTML = '<div class="panel"><div class="empty">Загрузка…</div></div>';
    VIEWS[A.view].load();
  }

  async function tick() {
    try {
      applyMeta(await api('/api/admin/overview'));
      $('#viewSub').textContent = VIEWS[A.view].sub();
      await checkNew();
      if (!VIEWS[A.view].static) await VIEWS[A.view].load({ silent: true });
      setSync(true);
    } catch (err) {
      if (err.status !== 401) setSync(false);
    }
  }

  function setSync(ok) {
    const el = $('#syncNote');
    el.classList.toggle('off', !ok);
    el.textContent = ok ? `Обновлено в ${A.now.slice(11)}` : 'Нет связи с сервером';
  }

  async function checkNew() {
    const { bookings } = await api('/api/admin/bookings/recent');
    const fresh = bookings.filter((b) => b.id > A.seenMaxId && b.created_by === 'client').reverse();
    for (const b of fresh.slice(-3)) {
      J.toast(`Новая бронь: ${roomById(b.room_id).name}, ${dayLabel(b.start.slice(0, 10)).toLowerCase()} ${J.fmtRange(b.start, b.end)} — ${b.name}`, 'ok');
    }
    A.seenMaxId = bookings.reduce((m, b) => Math.max(m, b.id), A.seenMaxId);
  }

  /** Делегирование кликов внутри текущего раздела. */
  const BOOKING_CACHE = new Map();
  function remember(list) { list.forEach((b) => BOOKING_CACHE.set(String(b.id), b)); return list; }

  function onViewClick(e) {
    const open = e.target.closest('[data-open]');
    if (open) { const b = BOOKING_CACHE.get(open.dataset.open); if (b) openDetail(b); return; }
    const cell = e.target.closest('[data-new-room]');
    if (cell) openNewBooking({ room: cell.dataset.newRoom, start: cell.dataset.newStart });
  }

  /* ------------------------------------------------------------ обзор */

  async function loadOverview() {
    const to = J.addDays(A.today, 6);
    const [data, recent] = await Promise.all([
      api(`/api/admin/bookings?from=${A.today}&to=${to}&status=active`),
      api('/api/admin/bookings/recent'),
    ]).catch((err) => { renderError(err); return []; });
    if (!data) return;
    const list = remember(data.bookings);
    remember(recent.bookings);
    const now = A.now;
    const dayFrom = `${A.today}T00:00`;
    const dayTo = `${J.addDays(A.today, 1)}T00:00`;
    const weekTo = `${J.addDays(A.today, 7)}T00:00`;

    // KPI
    const todayList = list.filter((b) => b.start < dayTo && b.end > dayFrom);
    const todayMin = todayList.reduce((s, b) => s + minutesWithin(b, dayFrom, dayTo), 0);
    const loadPct = (roomId) => Math.round(todayList.filter((b) => b.room_id === roomId).reduce((s, b) => s + minutesWithin(b, dayFrom, dayTo), 0) / 1440 * 100);
    const totalPct = Math.round(todayMin / (1440 * Math.max(1, A.rooms.length)) * 100);
    const weekMin = list.reduce((s, b) => s + minutesWithin(b, dayFrom, weekTo), 0);
    const residents = list.filter((b) => b.member_type === 'resident').length;
    const guests = list.length - residents;
    const upcomingToday = todayList.filter((b) => b.start > now).length;

    // карточки «сейчас»
    const nowCards = A.rooms.map((r) => {
      const mine = list.filter((b) => b.room_id === r.id).sort((a, b) => (a.start < b.start ? -1 : 1));
      const cur = mine.find((b) => b.start <= now && b.end > now);
      const next = mine.find((b) => b.start > now);
      let body;
      if (cur) {
        body = `<button type="button" class="linkish now-who" data-open="${cur.id}">
          <div class="lbl">Сейчас · до ${cur.end.slice(11)}</div>
          <div class="who">${esc(cur.name)}</div>
          <div class="meta">${esc([cur.company, humans(cur.people), cur.phone].filter(Boolean).join(' · '))}</div></button>`;
      } else if (next) {
        body = `<button type="button" class="linkish now-who" data-open="${next.id}">
          <div class="lbl">Следующая · ${esc(dayLabel(next.start.slice(0, 10)).toLowerCase())} ${J.fmtRange(next.start, next.end)}</div>
          <div class="who">${esc(next.name)}</div>
          <div class="meta">${esc([next.company, humans(next.people)].filter(Boolean).join(' · '))}</div></button>`;
      } else {
        body = '<div class="now-who"><div class="lbl">Ближайшие 7 дней</div><div class="who">Броней нет</div></div>';
      }
      return `<div class="now-card ${colorCls(r.id)}">
        ${J.roomPlan(r.id).replace('<svg', '<svg class="plan"')}
        <div class="now-top"><b>${esc(r.name)}</b><span class="now-state ${cur ? 'busy' : 'free'}">${cur ? 'Занята' : 'Свободна'}</span></div>
        <div class="cap">до ${humans(r.capacity)}</div>
        ${body}
      </div>`;
    }).join('');

    // ближайшие
    const upcoming = list.filter((b) => b.end > now).sort((a, b) => (a.start < b.start ? -1 : 1)).slice(0, 8);
    const upcomingHtml = upcoming.length ? upcoming.map(bookingRow).join('') : '<div class="empty"><b>Нет предстоящих броней</b>На ближайшие 7 дней пока ничего не забронировано.</div>';

    // неделя
    let maxMin = 240;
    const days = Array.from({ length: 7 }, (_, i) => J.addDays(A.today, i)).map((d) => {
      const f = `${d}T00:00`;
      const t = `${J.addDays(d, 1)}T00:00`;
      const per = A.rooms.map((r) => ({ id: r.id, min: list.filter((b) => b.room_id === r.id).reduce((s, b) => s + minutesWithin(b, f, t), 0) }));
      per.forEach((p) => { maxMin = Math.max(maxMin, p.min); });
      return { d, per };
    });
    const weekHtml = days.map(({ d, per }) => {
      const p = J.dateParts(d);
      const bars = per.map((x) => `<span class="wbar ${colorCls(x.id)}" style="height:${Math.max(2, Math.round(x.min / maxMin * 100))}%" title="${esc(roomById(x.id).name)}: ${hrs(x.min)} ч"></span>`).join('');
      const total = per.reduce((s, x) => s + x.min, 0);
      return `<div class="wday${d === A.today ? ' today' : ''}"><div class="wbars">${bars}</div>
        <div class="wlabel">${d === A.today ? 'Сег.' : J.DOW_SHORT[p.dow]} ${p.d}<small>${hrs(total)} ч</small></div></div>`;
    }).join('');

    // лента новых броней
    const feed = recent.bookings.slice(0, 8).map((b) => `
      <div class="feed-item${b.status === 'cancelled' ? ' cancelled' : ''}" data-open="${b.id}" role="button" tabindex="0">
        <span class="dot"></span>
        <div><b>${esc(b.name)}</b> ${b.status === 'cancelled' ? '<span class="pill pill-red" style="height:20px;font-size:11px">отменена</span>' : ''}
          <small>${esc(roomById(b.room_id).name)} · ${esc(dayLabel(b.start.slice(0, 10)))}, ${J.fmtRange(b.start, b.end)}</small>
          <small>создана ${esc(ago(b.created_at))}${b.created_by !== 'client' ? ' · администратором' : ''}</small></div>
      </div>`).join('') || '<div class="empty">Броней ещё не было</div>';

    $('#view').innerHTML = `
      <div class="now-grid">${nowCards}</div>
      <div class="kpis">
        <div class="panel kpi"><div class="lbl">Броней сегодня</div><div class="val">${todayList.length}</div><div class="sub">${upcomingToday ? `<b>${upcomingToday}</b> ещё впереди` : 'на сегодня больше нет'}</div></div>
        <div class="panel kpi"><div class="lbl">Загрузка сегодня</div><div class="val">${totalPct}%</div><div class="sub">${A.rooms.map((r) => `${esc(r.name)} ${loadPct(r.id)}%`).join(' · ')}</div></div>
        <div class="panel kpi"><div class="lbl">Броней на 7 дней</div><div class="val">${list.length}</div><div class="sub">${hrs(weekMin)} ч забронировано</div></div>
        <div class="panel kpi"><div class="lbl">Резиденты / гости</div><div class="val">${residents} / ${guests}</div><div class="sub">за ближайшие 7 дней</div></div>
      </div>
      <div class="two-col">
        <section class="panel">
          <div class="panel-head"><h2>Ближайшие брони</h2><a class="btn btn-ghost btn-sm" href="#bookings">Все брони</a></div>
          <div class="panel-body blist">${upcomingHtml}</div>
        </section>
        <div style="display:grid;gap:20px">
          <section class="panel">
            <div class="panel-head"><h2>Загрузка на неделю</h2>
              <div class="chart-legend">${A.rooms.map((r) => `<span><i style="background:${r.id === 'focus' ? 'var(--orange)' : 'var(--blue)'}"></i>${esc(r.name)}</span>`).join('')}</div></div>
            <div class="panel-body"><div class="week">${weekHtml}</div></div>
          </section>
          <section class="panel">
            <div class="panel-head"><h2>Последние действия</h2><span class="muted">новые брони и отмены</span></div>
            <div class="panel-body">${feed}</div>
          </section>
        </div>
      </div>`;
  }

  function bookingRow(b) {
    const d = b.start.slice(0, 10);
    return `<button type="button" class="brow" data-open="${b.id}">
      <span class="btime">${J.fmtRange(b.start, b.end)}<small>${esc(dayLabel(d))}</small></span>
      <span class="bwho"><b>${esc(b.name)}${typeTag(b.member_type)}</b><small>${esc([b.company, humans(b.people), b.purpose].filter(Boolean).join(' · '))}</small></span>
      ${roomTag(b.room_id)}
    </button>`;
  }

  function renderError(err) {
    if (err.status === 401) return;
    $('#view').innerHTML = `<div class="panel"><div class="empty"><b>Не удалось загрузить данные</b>${esc(err.message)}</div></div>`;
  }

  /* ------------------------------------------------------------ расписание */

  const ROW = 30;

  async function loadSchedule({ silent } = {}) {
    const date = A.schedDate;
    let data;
    try {
      data = await api(`/api/admin/bookings?from=${date}&to=${date}&status=active`);
    } catch (err) {
      if (!silent) renderError(err);
      return;
    }
    remember(data.bookings);
    const panel = $('#schedPanel');
    const prevScroll = panel ? $('.timeline', panel).scrollTop : null;

    const dayFrom = `${date}T00:00`;
    const dayTo = `${J.addDays(date, 1)}T00:00`;
    const nowSlot = J.floorSlot(A.now);
    const times = Array.from({ length: 48 }, (_, i) => `${J.pad(Math.floor(i / 2))}:${i % 2 ? '30' : '00'}`);

    const nowLine = (first) => (date === A.today
      ? `<div class="tl-now${first ? ' dot' : ''}" style="top:${J.diffMin(dayFrom, A.now) / 30 * ROW}px"></div>` : '');
    const cols = A.rooms.map((r, idx) => {
      const cells = times.map((t, i) => {
        const start = `${date}T${t}`;
        const past = start < nowSlot;
        return past
          ? `<div class="tl-cell past${i % 2 ? '' : ' hour'}"></div>`
          : `<div class="tl-cell${i % 2 ? '' : ' hour'}" data-new-room="${esc(r.id)}" data-new-start="${start}" title="Добавить бронь: ${esc(r.name)}, ${t}"></div>`;
      }).join('');
      const events = data.bookings.filter((b) => b.room_id === r.id).map((b) => {
        const s = b.start < dayFrom ? dayFrom : b.start;
        const e = b.end > dayTo ? dayTo : b.end;
        const top = J.diffMin(dayFrom, s) / 30 * ROW;
        const h = J.diffMin(s, e) / 30 * ROW - 3;
        const ended = b.end <= A.now;
        const meta = [b.company, humans(b.people)].filter(Boolean).join(' · ');
        const inner = h < ROW * 1.5
          ? `<b>${J.fmtRange(b.start, b.end)} · ${esc(b.name)}</b>`
          : `<b>${esc(b.name)}</b><span>${J.fmtRange(b.start, b.end)} · ${b.member_type === 'guest' ? 'гость' : 'резидент'}</span>${h > ROW * 2.5 && meta ? `<span>${esc(meta)}</span>` : ''}`;
        return `<button type="button" class="tl-event ${colorCls(r.id)}${ended ? ' ended' : ''}" style="top:${top + 1}px;height:${h}px" data-open="${b.id}">${inner}</button>`;
      }).join('');
      return `<div class="tl-col">${cells}${events}${nowLine(idx === 0)}</div>`;
    }).join('');

    const heads = A.rooms.map((r) => {
      const n = data.bookings.filter((b) => b.room_id === r.id);
      const min = n.reduce((s, b) => s + minutesWithin(b, dayFrom, dayTo), 0);
      return `<div class="tl-head">${roomTag(r.id)}<small>${n.length} ${J.plural(n.length, 'бронь', 'брони', 'броней')} · ${hrs(min)} ч</small></div>`;
    }).join('');

    const html = `
      <section class="panel" id="schedPanel">
        <div class="panel-head" style="padding-bottom:14px">
          <div class="toolbar">
            <div class="date-nav">
              <button class="btn btn-ghost btn-icon" type="button" data-sched="-1" aria-label="Предыдущий день">${J.ICONS.left}</button>
              <span class="label">${esc(cap(J.fmtDate(date, { dow: true })))}</span>
              <button class="btn btn-ghost btn-icon" type="button" data-sched="1" aria-label="Следующий день">${J.ICONS.right}</button>
            </div>
            <button class="btn btn-ghost btn-sm" type="button" data-sched="today"${date === A.today ? ' disabled' : ''}>Сегодня</button>
            <label class="btn btn-ghost btn-sm date-input">${J.ICONS.calendar} Выбрать дату<input type="date" id="schedPick" value="${date}"></label>
          </div>
          <span class="muted">${data.bookings.length ? '' : 'На этот день броней нет'}</span>
        </div>
        <div class="timeline" style="--row:${ROW}px;--cols:${A.rooms.length}">
          <div class="tl-head corner"></div>${heads}
          <div class="tl-times">${times.map((t) => `<div class="tl-time">${t.endsWith(':00') ? t : ''}</div>`).join('')}</div>
          ${cols}
        </div>
      </section>`;
    $('#view').innerHTML = html;

    const tl = $('#schedPanel .timeline');
    if (prevScroll !== null && silent) tl.scrollTop = prevScroll;
    else {
      const focusMin = date === A.today ? Math.max(0, J.diffMin(dayFrom, A.now) - 90) : 8 * 60;
      tl.scrollTop = focusMin / 30 * ROW;
    }
    $('#schedPanel').addEventListener('click', (e) => {
      const b = e.target.closest('[data-sched]');
      if (!b) return;
      const v = b.dataset.sched;
      A.schedDate = v === 'today' ? A.today : J.addDays(A.schedDate, Number(v));
      loadSchedule();
    });
    $('#schedPick').addEventListener('change', (e) => {
      if (/^\d{4}-\d{2}-\d{2}$/.test(e.target.value)) { A.schedDate = e.target.value; loadSchedule(); }
    });
  }

  /* ------------------------------------------------------------ список броней */

  const PRESETS = [
    ['today', 'Сегодня', () => [A.today, A.today]],
    ['tomorrow', 'Завтра', () => [J.addDays(A.today, 1), J.addDays(A.today, 1)]],
    ['next7', '7 дней', () => [A.today, J.addDays(A.today, 6)]],
    ['next30', '30 дней', () => [A.today, J.addDays(A.today, 29)]],
    ['past30', 'Прошедшие 30 дней', () => [J.addDays(A.today, -30), J.addDays(A.today, -1)]],
  ];

  async function loadBookings({ silent } = {}) {
    const L = A.list;
    if (!L.from) [L.from, L.to] = PRESETS.find((p) => p[0] === L.preset)[2]();
    if (!silent || !$('#bkPanel')) renderBookingsShell();
    const qs = new URLSearchParams({ from: L.from, to: L.to, status: L.status });
    if (L.room) qs.set('room', L.room);
    try {
      const data = await api(`/api/admin/bookings?${qs}`);
      L.rows = remember(data.bookings);
      renderBookingsTable();
    } catch (err) {
      if (!silent) renderError(err);
    }
  }

  function renderBookingsShell() {
    const L = A.list;
    const opt = (v, label, cur) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(label)}</option>`;
    $('#view').innerHTML = `
      <section class="panel" id="bkPanel">
        <div class="panel-head">
          <div class="presets" style="margin:0">${PRESETS.map(([id, label]) => `<button type="button" class="chip" data-preset="${id}" aria-pressed="${L.preset === id}">${label}</button>`).join('')}</div>
          <a class="btn btn-ghost btn-sm" id="csvBtn" href="#">${J.ICONS.download} Выгрузить CSV</a>
        </div>
        <div class="panel-body">
          <div class="filters" id="filters">
            <div class="field"><label for="ff-from">С</label><input class="input" type="date" id="ff-from" value="${L.from}"></div>
            <div class="field"><label for="ff-to">По</label><input class="input" type="date" id="ff-to" value="${L.to}"></div>
            <div class="field"><label for="ff-room">Комната</label><select class="select" id="ff-room">${opt('', 'Все', L.room)}${A.rooms.map((r) => opt(r.id, r.name, L.room)).join('')}</select></div>
            <div class="field"><label for="ff-status">Статус</label><select class="select" id="ff-status">${opt('active', 'Активные', L.status)}${opt('cancelled', 'Отменённые', L.status)}${opt('all', 'Все', L.status)}</select></div>
            <div class="field"><label for="ff-type">Клиент</label><select class="select" id="ff-type">${opt('', 'Все', L.type)}${opt('resident', 'Резиденты', L.type)}${opt('guest', 'Гости', L.type)}</select></div>
            <div class="field search"><label for="ff-q">Поиск</label>${J.ICONS.search}<input class="input" id="ff-q" placeholder="Имя, телефон, email, компания, код" value="${esc(L.q)}"></div>
          </div>
          <div class="count-note" id="bkCount" style="margin:16px 0 6px"></div>
          <div class="table-wrap" id="bkTable"><div class="empty">Загрузка…</div></div>
        </div>
      </section>`;

    const refetch = () => loadBookings({ silent: true });
    $('#bkPanel .presets').addEventListener('click', (e) => {
      const b = e.target.closest('[data-preset]');
      if (!b) return;
      L.preset = b.dataset.preset;
      [L.from, L.to] = PRESETS.find((p) => p[0] === L.preset)[2]();
      $('#ff-from').value = L.from;
      $('#ff-to').value = L.to;
      $$('#bkPanel [data-preset]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      refetch();
    });
    const onDate = () => {
      const f = $('#ff-from').value;
      const t = $('#ff-to').value;
      if (!f || !t) return;
      L.from = f;
      L.to = t < f ? f : t;
      L.preset = '';
      $$('#bkPanel [data-preset]').forEach((x) => x.setAttribute('aria-pressed', 'false'));
      refetch();
    };
    $('#ff-from').addEventListener('change', onDate);
    $('#ff-to').addEventListener('change', onDate);
    $('#ff-room').addEventListener('change', (e) => { L.room = e.target.value; refetch(); });
    $('#ff-status').addEventListener('change', (e) => { L.status = e.target.value; refetch(); });
    $('#ff-type').addEventListener('change', (e) => { L.type = e.target.value; renderBookingsTable(); });
    let t;
    $('#ff-q').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { L.q = e.target.value; renderBookingsTable(); }, 150); });
    $('#csvBtn').addEventListener('click', (e) => {
      e.preventDefault();
      exportCsv();
    });
  }

  function filteredRows() {
    const L = A.list;
    const q = L.q.trim().toLowerCase();
    const qDigits = q.replace(/\D/g, '');
    return L.rows.filter((b) => {
      if (L.type && b.member_type !== L.type) return false;
      if (!q) return true;
      const hay = [b.name, b.email, b.company, b.purpose, `jas-${b.code}`, b.code].join(' ').toLowerCase();
      return hay.includes(q) || (qDigits.length >= 3 && b.phone.replace(/\D/g, '').includes(qDigits));
    });
  }

  /** Выгрузка текущей выборки в CSV (открывается в Excel, разделитель «;»). */
  function exportCsv() {
    const rows = filteredRows();
    if (!rows.length) { J.toast('Нет броней для выгрузки'); return; }
    const cell = (v) => {
      let s = String(v ?? '');
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // защита от формул
      return `"${s.replace(/"/g, '""')}"`;
    };
    const head = ['Код', 'Комната', 'Дата', 'Начало', 'Окончание', 'Длительность (мин)', 'Имя', 'Телефон', 'Email', 'Компания',
      'Статус клиента', 'Человек', 'Цель', 'Статус брони', 'Создана', 'Кем создана', 'Отменена', 'Кем отменена', 'Причина отмены'];
    const lines = [head.map(cell).join(';')];
    for (const b of rows) {
      lines.push([
        `JAS-${b.code}`, roomById(b.room_id).name, b.start.slice(0, 10), b.start.slice(11), b.end.replace('T', ' '),
        J.diffMin(b.start, b.end), b.name, b.phone, b.email, b.company, b.member_type === 'guest' ? 'Гость' : 'Резидент',
        b.people, b.purpose, b.status === 'active' ? 'Активна' : 'Отменена', fmtInstant(b.created_at, true),
        b.created_by === 'client' ? 'клиент' : b.created_by, fmtInstant(b.cancelled_at, true),
        b.cancelled_by === 'client' ? 'клиент' : (b.cancelled_by || ''), b.cancel_reason,
      ].map(cell).join(';'));
    }
    const blob = new Blob([`﻿${lines.join('\r\n')}\r\n`], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `jas-bookings-${A.list.from}_${A.list.to}.csv`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  function renderBookingsTable() {
    const L = A.list;
    const rows = filteredRows();
    const hours = rows.filter((b) => b.status === 'active').reduce((s, b) => s + J.diffMin(b.start, b.end), 0);
    $('#bkCount').textContent = `${rows.length} ${J.plural(rows.length, 'бронь', 'брони', 'броней')} · ${hrs(hours)} ч · период ${J.fmtDate(L.from)} — ${J.fmtDate(L.to)}`;
    if (!rows.length) {
      $('#bkTable').innerHTML = '<div class="empty"><b>Ничего не найдено</b>Измените период или фильтры.</div>';
      return;
    }
    $('#bkTable').innerHTML = `<table class="data">
      <thead><tr><th>Дата и время</th><th>Комната</th><th>Клиент</th><th>Контакты</th><th>Чел.</th><th>Цель</th><th>Код · статус</th></tr></thead>
      <tbody>${rows.map((b) => {
    const ended = b.end <= A.now;
    const status = b.status === 'cancelled' ? '<span class="pill pill-red">Отменена</span>'
      : ended ? '<span class="pill pill-muted">Прошла</span>'
        : b.start <= A.now ? '<span class="pill pill-busy">Идёт</span>' : '<span class="pill pill-free">Активна</span>';
    return `<tr class="${b.status}" data-open="${b.id}" tabindex="0">
          <td><span class="td-strong strike">${J.fmtRange(b.start, b.end)}</span><span class="td-sub">${esc(dayLabel(b.start.slice(0, 10)))} · ${J.fmtDur(J.diffMin(b.start, b.end))}</span></td>
          <td>${roomTag(b.room_id)}</td>
          <td><b>${esc(b.name)}</b>${typeTag(b.member_type)}<span class="td-sub">${esc(b.company)}</span></td>
          <td><span class="td-strong">${esc(b.phone)}</span><span class="td-sub">${esc(b.email)}</span></td>
          <td class="tnum">${b.people}</td>
          <td style="max-width:220px">${esc(b.purpose)}</td>
          <td><span class="code">JAS-${esc(b.code)}</span><div style="margin-top:4px">${status}</div></td>
        </tr>`;
  }).join('')}</tbody></table>`;
  }

  /* ------------------------------------------------------------ администраторы */

  async function loadAdmins() {
    let data;
    try {
      data = await api('/api/admin/admins');
    } catch (err) {
      renderError(err);
      return;
    }
    const seats = Array.from({ length: data.maxAdmins }, (_, i) => data.admins[i]);
    const regUrl = new URL('admin.html', location.href).href;
    const free = data.maxAdmins - data.admins.length;
    $('#view').innerHTML = `
      <section class="panel">
        <div class="panel-head"><h2>Код приглашения</h2><span class="muted">нужен для регистрации нового администратора</span></div>
        <div class="panel-body invite">
          <span class="invite-code">${esc(data.inviteCode)}</span>
          <button class="btn btn-ghost btn-sm" type="button" data-copy="${esc(data.inviteCode)}">Скопировать код</button>
          <button class="btn btn-ghost btn-sm" type="button" id="newInvite">Сменить код</button>
          <p class="muted" style="flex-basis:100%;font-size:13px">${free > 0
    ? `Передайте код и ссылку <b>${esc(regUrl)}</b> тому, кого хотите сделать администратором. После регистрации код можно сменить.`
    : 'Все места заняты — пока не освободите место, код не сработает.'}</p>
        </div>
      </section>
      <section class="panel">
        <div class="panel-head"><h2>Доступ к кабинету</h2><span class="muted">${data.admins.length} из ${data.maxAdmins} мест занято</span></div>
        <div class="panel-body">
          <div class="admins-list">${seats.map((a) => (a ? `
            <div class="admin-row">
              <span class="avatar">${esc(initials(a.name || a.email))}</span>
              <span><b>${esc(a.name || 'Без имени')}${a.id === A.me.id ? ' <span class="pill pill-blue">это вы</span>' : ''}</b>
                <small>${esc(a.email)}</small>
                <small>Зарегистрирован ${esc(fmtInstant(a.created_at, true))}${a.last_login_at ? ` · последний вход ${esc(ago(a.last_login_at))}` : ''}</small></span>
              ${a.id === A.me.id ? '' : `<button class="btn btn-danger btn-sm" type="button" data-remove="${a.id}">Освободить место</button>`}
            </div>` : `
            <div class="admin-row empty-seat">
              <span class="avatar">+</span>
              <span><b>Свободное место</b><small>Новый администратор регистрируется сам по адресу <b>${esc(regUrl)}</b> (вкладка «Регистрация», с кодом приглашения).</small></span>
              <button class="btn btn-ghost btn-sm" type="button" data-copy="${esc(regUrl)}">Скопировать ссылку</button>
            </div>`)).join('')}
          </div>
          <p class="hint-box" style="margin:16px 0 0">Регистрация автоматически закрывается, когда заняты все ${data.maxAdmins} места. Удалённый администратор сразу теряет доступ, а место освобождается для нового email.</p>
        </div>
      </section>`;

    $('#view').querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(b.dataset.copy); J.toast('Скопировано', 'ok'); } catch { J.toast(b.dataset.copy); }
    }));
    $('#newInvite').addEventListener('click', async (e) => {
      const b = e.currentTarget;
      if (!b.dataset.confirm) {
        b.dataset.confirm = '1';
        b.textContent = 'Старый код перестанет работать — сменить?';
        setTimeout(() => { if (b.isConnected) { delete b.dataset.confirm; b.textContent = 'Сменить код'; } }, 4000);
        return;
      }
      b.disabled = true;
      try {
        await api('/api/admin/invite', { method: 'POST' });
        J.toast('Новый код приглашения создан', 'ok');
        loadAdmins();
      } catch (err) {
        J.toast(err.message, 'err');
        b.disabled = false;
      }
    });
    $('#view').querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', async () => {
      if (!b.dataset.confirm) {
        b.dataset.confirm = '1';
        b.textContent = 'Точно удалить?';
        setTimeout(() => { if (b.isConnected) { delete b.dataset.confirm; b.textContent = 'Освободить место'; } }, 4000);
        return;
      }
      b.disabled = true;
      try {
        await api(`/api/admin/admins/${b.dataset.remove}/remove`, { method: 'POST' });
        J.toast('Администратор удалён, место освобождено', 'ok');
        loadAdmins();
      } catch (err) {
        J.toast(err.message, 'err');
        b.disabled = false;
      }
    }));
  }

  /* ------------------------------------------------------------ настройки */

  function loadSettings() {
    const s = A.settings;
    const tzs = TZ_LIST.includes(s.timezone) ? TZ_LIST : [s.timezone, ...TZ_LIST];
    const durations = Array.from({ length: 48 }, (_, i) => (i + 1) * 30);
    $('#view').innerHTML = `
      <form class="panel" id="settingsForm" novalidate>
        <div class="panel-head"><h2>Правила бронирования</h2></div>
        <div class="panel-body">
          <div class="settings-grid">
            <div class="field"><label for="s-tz">Часовой пояс коворкинга</label>
              <select class="select" id="s-tz">${tzs.map((tz) => `<option value="${esc(tz)}"${tz === s.timezone ? ' selected' : ''}>${esc(tzLabel(tz))}</option>`).join('')}</select>
              <div class="field-error" data-error="timezone"></div></div>
            <div class="field"><label for="s-max">Максимум на одну бронь</label>
              <select class="select" id="s-max">${durations.map((m) => `<option value="${m}"${m === s.maxDurationMin ? ' selected' : ''}>${J.fmtDur(m)}</option>`).join('')}</select>
              <div class="field-error" data-error="maxDurationMin"></div></div>
            <div class="field"><label for="s-horizon">Бронировать вперёд, дней</label>
              <input class="input" id="s-horizon" type="number" min="1" max="365" value="${s.horizonDays}">
              <div class="field-error" data-error="horizonDays"></div></div>
          </div>
          <p class="hint-box" style="margin:16px 0 0">Бронирование работает 24/7 с шагом 30 минут. Все времена показываются в часовом поясе коворкинга — у гостей и в кабинете одинаково.</p>
        </div>
        <div class="panel-head" style="padding-top:4px"><h2>Комнаты</h2></div>
        <div class="panel-body">
          <div class="room-settings">${A.rooms.map((r) => `
            <div class="room-set" data-room="${esc(r.id)}">
              ${roomTag(r.id)}
              <div class="form-grid">
                <div class="field"><label>Название</label><input class="input" name="name" value="${esc(r.name)}" maxlength="40"><div class="field-error" data-error="room_${esc(r.id)}_name"></div></div>
                <div class="field"><label>Мест</label><input class="input" name="capacity" type="number" min="1" max="100" value="${r.capacity}"><div class="field-error" data-error="room_${esc(r.id)}_capacity"></div></div>
                <div class="field span-2"><label>Описание для гостей</label><input class="input" name="description" value="${esc(r.description)}" maxlength="200"></div>
              </div>
            </div>`).join('')}
          </div>
        </div>
        <div class="modal-foot" style="padding:0 20px 20px;justify-content:flex-start"><button class="btn btn-blue" type="submit">Сохранить настройки</button></div>
      </form>`;

    $('#settingsForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const btn = form.querySelector('[type=submit]');
      const body = {
        timezone: $('#s-tz').value,
        maxDurationMin: Number($('#s-max').value),
        horizonDays: Number($('#s-horizon').value),
        rooms: $$('.room-set', form).map((el) => ({
          id: el.dataset.room,
          name: el.querySelector('[name=name]').value,
          capacity: Number(el.querySelector('[name=capacity]').value),
          description: el.querySelector('[name=description]').value,
        })),
      };
      J.showFieldErrors(form, {});
      btn.disabled = true;
      try {
        const res = await api('/api/admin/settings', { method: 'PUT', body });
        A.settings = res.settings;
        A.rooms = res.rooms;
        applyMeta(await api('/api/admin/overview'));
        J.toast('Настройки сохранены', 'ok');
      } catch (err) {
        if (err.data && err.data.errors) J.showFieldErrors(form, err.data.errors);
        J.toast(err.message, 'err');
      } finally {
        btn.disabled = false;
      }
    });
  }

  /* ------------------------------------------------------------ карточка брони */

  function openDetail(b) {
    const active = b.status === 'active';
    const ended = b.end <= A.now;
    const statusText = !active ? 'Отменена' : ended ? 'Завершена' : b.start <= A.now ? 'Идёт сейчас' : 'Активна';
    const createdBy = b.created_by === 'client' ? 'клиентом на сайте' : `администратором ${b.created_by}`;
    const cancelledBy = b.cancelled_by === 'client' ? 'клиентом' : b.cancelled_by ? `администратором ${b.cancelled_by}` : '';
    const row = (k, v) => (v ? `<dt>${k}</dt><dd>${v}</dd>` : '');
    const m = J.modal(`
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="dTitle">
        <div class="modal-head"><h3 id="dTitle">Бронь JAS-${esc(b.code)}</h3><button class="close-btn" type="button" data-close aria-label="Закрыть">✕</button></div>
        <div class="modal-body detail">
          <div class="detail-hero ${colorCls(b.room_id)}">
            <b>${esc(roomById(b.room_id).name)} · ${J.fmtRange(b.start, b.end)}</b>
            <span>${esc(cap(J.fmtDate(b.start.slice(0, 10), { dow: true })))} · ${J.fmtDur(J.diffMin(b.start, b.end))}</span>
          </div>
          <dl class="dl">
            ${row('Статус', `<span class="pill ${!active ? 'pill-red' : ended ? 'pill-muted' : 'pill-free'}">${statusText}</span>`)}
            ${row('Клиент', `${esc(b.name)} ${typeTag(b.member_type)}`)}
            ${row('Компания', esc(b.company))}
            ${row('Телефон', b.phone ? `<a href="tel:${esc(b.phone.replace(/[^\d+]/g, ''))}">${esc(b.phone)}</a>` : '')}
            ${row('Email', b.email ? `<a href="mailto:${esc(b.email)}">${esc(b.email)}</a>` : '')}
            ${row('Человек', String(b.people))}
            ${row('Цель', esc(b.purpose))}
            ${row('Создана', `${esc(fmtInstant(b.created_at, true))}, ${esc(createdBy)}`)}
            ${!active ? row('Отменена', `${esc(fmtInstant(b.cancelled_at, true))}${cancelledBy ? `, ${esc(cancelledBy)}` : ''}${b.cancel_reason ? ` — «${esc(b.cancel_reason)}»` : ''}`) : ''}
          </dl>
          ${active && !ended ? `
          <div class="field" id="cancelBox" hidden>
            <label for="cancelReason">Причина отмены <span class="opt">— необязательно</span></label>
            <input class="input" id="cancelReason" maxlength="200" placeholder="Например: клиент попросил по телефону">
          </div>` : ''}
        </div>
        <div class="modal-foot">
          ${active && !ended ? '<button class="btn btn-danger" type="button" id="cancelBtn">Отменить бронь</button>' : ''}
          <button class="btn btn-ghost" type="button" data-close>Закрыть</button>
        </div>
      </div>`);

    const btn = m.el.querySelector('#cancelBtn');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      const box = m.el.querySelector('#cancelBox');
      if (box.hidden) {
        box.hidden = false;
        btn.textContent = 'Подтвердить отмену';
        m.el.querySelector('#cancelReason').focus();
        return;
      }
      btn.disabled = true;
      try {
        await api(`/api/admin/bookings/${b.id}/cancel`, { method: 'POST', body: { reason: m.el.querySelector('#cancelReason').value } });
        m.close();
        J.toast('Бронь отменена — слот снова свободен', 'ok');
        VIEWS[A.view].load({ silent: true });
      } catch (err) {
        J.toast(err.message, 'err');
        btn.disabled = false;
      }
    });
  }

  /* ------------------------------------------------------------ новая бронь (администратор) */

  function openNewBooking({ room, start }) {
    const nowSlot = J.floorSlot(A.now);
    const date = start ? start.slice(0, 10) : (A.view === 'schedule' ? A.schedDate : A.today);
    let time = start ? start.slice(11) : (date === A.today ? J.addMin(nowSlot, 30).slice(11) : '10:00');
    if (date === A.today && `${date}T${time}` < nowSlot) time = nowSlot.slice(11);
    const times = Array.from({ length: 48 }, (_, i) => `${J.pad(Math.floor(i / 2))}:${i % 2 ? '30' : '00'}`);
    const durations = Array.from({ length: 48 }, (_, i) => (i + 1) * 30);
    const roomId = room || (A.rooms[0] && A.rooms[0].id);

    const m = J.modal(`
      <form class="modal" role="dialog" aria-modal="true" aria-labelledby="nTitle" id="newForm" novalidate style="width:min(620px,100%)">
        <div class="modal-head"><h3 id="nTitle">Новая бронь</h3><button class="close-btn" type="button" data-close aria-label="Закрыть">✕</button></div>
        <div class="modal-body">
          <div class="form-grid">
            <div class="field"><label for="n-room">Комната</label>
              <select class="select" id="n-room">${A.rooms.map((r) => `<option value="${esc(r.id)}"${r.id === roomId ? ' selected' : ''}>${esc(r.name)} · до ${r.capacity} чел.</option>`).join('')}</select></div>
            <div class="field"><label for="n-date">Дата</label><input class="input" id="n-date" type="date" value="${date}" min="${A.today}"></div>
            <div class="field"><label for="n-start">Начало</label>
              <select class="select" id="n-start">${times.map((t) => `<option${t === time ? ' selected' : ''}>${t}</option>`).join('')}</select></div>
            <div class="field"><label for="n-dur">Длительность</label>
              <select class="select" id="n-dur">${durations.map((d) => `<option value="${d}"${d === 60 ? ' selected' : ''}>${J.fmtDur(d)}</option>`).join('')}</select></div>
            <div class="field-error span-2" data-error="time"></div>
            <div class="field"><label for="n-name">Имя клиента</label><input class="input" id="n-name" maxlength="80"><div class="field-error" data-error="name"></div></div>
            <div class="field"><label for="n-phone">Телефон <span class="opt">— желательно</span></label><input class="input" id="n-phone" type="tel" maxlength="32"><div class="field-error" data-error="phone"></div></div>
            <div class="field"><label for="n-email">Email <span class="opt">— необязательно</span></label><input class="input" id="n-email" type="email" maxlength="120"><div class="field-error" data-error="email"></div></div>
            <div class="field"><label for="n-type">Клиент</label><select class="select" id="n-type"><option value="resident">Резидент</option><option value="guest">Гость</option></select></div>
            <div class="field"><label for="n-company">Компания <span class="opt">— необязательно</span></label><input class="input" id="n-company" maxlength="100"></div>
            <div class="field"><label for="n-people">Человек</label><input class="input" id="n-people" type="number" min="1" max="100" value="1"><div class="field-error" data-error="people"></div></div>
            <div class="field span-2"><label for="n-purpose">Комментарий <span class="opt">— необязательно</span></label><input class="input" id="n-purpose" maxlength="300"></div>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" type="button" data-close>Отмена</button>
          <button class="btn btn-primary" type="submit">Создать бронь</button>
        </div>
      </form>`);

    const form = m.el.querySelector('#newForm');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const s = `${form.querySelector('#n-date').value}T${form.querySelector('#n-start').value}`;
      const body = {
        room_id: form.querySelector('#n-room').value,
        start: s,
        end: J.addMin(s, Number(form.querySelector('#n-dur').value)),
        name: form.querySelector('#n-name').value,
        phone: form.querySelector('#n-phone').value,
        email: form.querySelector('#n-email').value,
        member_type: form.querySelector('#n-type').value,
        company: form.querySelector('#n-company').value,
        people: Number(form.querySelector('#n-people').value),
        purpose: form.querySelector('#n-purpose').value,
      };
      const btn = form.querySelector('[type=submit]');
      J.showFieldErrors(form, {});
      btn.disabled = true;
      try {
        const res = await api('/api/admin/bookings', { method: 'POST', body });
        A.seenMaxId = Math.max(A.seenMaxId, res.booking.id);
        m.close();
        J.toast(`Бронь JAS-${res.booking.code} создана`, 'ok');
        VIEWS[A.view].load({ silent: true });
      } catch (err) {
        if (err.data && err.data.errors) J.showFieldErrors(form, err.data.errors);
        else J.showFieldErrors(form, { time: err.message });
        btn.disabled = false;
      }
    });
  }
})();
