/* Публичная страница: выбор комнаты, даты, слотов и оформление брони */
(function () {
  'use strict';

  const J = window.JAS;
  const { $, $$, esc } = J;
  const MY_KEY = 'jas.myBookings';
  const PROFILE_KEY = 'jas.profile';
  const ROOM_KEY = 'jas.room';
  const GROUPS = [['Ночь', 0], ['Утро', 6], ['День', 12], ['Вечер', 18]];

  const S = {
    cfg: null, rooms: [], busy: [], now: '', today: '',
    roomId: null, date: null, selStart: null, selEnd: null,
    memberType: 'resident', people: 1, submitting: false,
  };

  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const room = () => S.rooms.find((r) => r.id === S.roomId) || S.rooms[0];
  const people = (n) => `${n} ${J.plural(n, 'человека', 'человек', 'человек')}`; // «до 4 человек»
  const humans = (n) => `${n} ${J.plural(n, 'человек', 'человека', 'человек')}`; // «1 человек», «3 человека»

  init();

  /* ------------------------------------------------------------ старт */

  async function init() {
    $$('[data-icon]').forEach((el) => { el.innerHTML = J.ICONS[el.dataset.icon] || ''; });
    bindStatic();
    try {
      S.cfg = await J.api('/api/config');
    } catch (err) {
      $('.layout').innerHTML = `<div class="step"><div class="empty"><b>Не удалось загрузить расписание</b>${esc(err.message)}. Обновите страницу.</div></div>`;
      return;
    }
    S.rooms = S.cfg.rooms;
    S.now = S.cfg.now;
    S.today = S.cfg.today;
    S.date = S.today;
    const fromUrl = new URLSearchParams(location.search).get('room');
    const saved = J.storage.get(ROOM_KEY, null);
    S.roomId = [fromUrl, saved].find((id) => S.rooms.some((r) => r.id === id)) || S.rooms[0].id;
    $('#tzNote').textContent = `время коворкинга, ${tzLabel(S.cfg.timezone)}`;
    restoreProfile();
    renderAll();
    updateMyCount();
    await loadBusy();
    setInterval(loadBusy, 30000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) loadBusy(); });
  }

  function tzLabel(tz) {
    try {
      const part = new Intl.DateTimeFormat('ru-RU', { timeZone: tz, timeZoneName: 'shortOffset' })
        .formatToParts(new Date()).find((x) => x.type === 'timeZoneName');
      return part ? part.value : tz;
    } catch {
      return tz;
    }
  }

  async function loadBusy() {
    if (!S.cfg) return;
    try {
      const to = J.addDays(S.today, S.cfg.horizonDays + 1);
      const data = await J.api(`/api/availability?from=${S.today}&to=${to}`);
      S.busy = data.busy;
      S.now = data.now;
      const today = data.now.slice(0, 10);
      if (today !== S.today) {
        S.today = today;
        if (S.date < today) S.date = today;
      }
      if (S.selStart && (S.selStart < J.floorSlot(S.now) || !isFree(S.roomId, S.selStart, S.selEnd))) {
        clearSel(false);
        J.toast('Выбранное время только что заняли — выберите другое', 'err');
      }
      renderAll();
    } catch (err) {
      if (err.status === 0) J.toast('Нет соединения — расписание может быть неактуальным', 'err');
    }
  }

  /* ------------------------------------------------------------ доступность */

  function isFree(roomId, start, end) {
    return !S.busy.some((b) => b.room_id === roomId && b.start < end && b.end > start);
  }

  function dayLoad(roomId, date) {
    const from = `${date}T00:00`;
    const to = `${J.addDays(date, 1)}T00:00`;
    let min = 0;
    for (const b of S.busy) {
      if (b.room_id !== roomId || b.start >= to || b.end <= from) continue;
      min += J.diffMin(b.start < from ? from : b.start, b.end > to ? to : b.end);
    }
    return Math.min(1, min / 1440);
  }

  function roomNow(roomId) {
    const now = S.now;
    const mine = S.busy.filter((b) => b.room_id === roomId).sort((a, b) => (a.start < b.start ? -1 : 1));
    const cur = mine.find((b) => b.start <= now && b.end > now);
    if (cur) {
      let end = cur.end;
      for (let next = mine.find((b) => b.start === end); next; next = mine.find((b) => b.start === end)) end = next.end;
      return { busy: true, until: end };
    }
    const next = mine.find((b) => b.start > now);
    return { busy: false, next: next ? next.start : null };
  }

  function clockLabel(wall) {
    const today = S.now.slice(0, 10);
    const d = wall.slice(0, 10);
    if (d === today) return wall.slice(11);
    if (d === J.addDays(today, 1) && wall.endsWith('T00:00')) return '24:00';
    if (d === J.addDays(today, 1)) return `завтра ${wall.slice(11)}`;
    return `${J.fmtDate(d)}, ${wall.slice(11)}`;
  }

  function statusText(st) {
    if (st.busy) return `Занята до ${clockLabel(st.until)}`;
    if (st.next && st.next.slice(0, 10) === S.now.slice(0, 10)) return `Свободна до ${st.next.slice(11)}`;
    return 'Свободна сейчас';
  }

  /* ------------------------------------------------------------ рендер */

  function renderAll() {
    renderHero();
    renderRooms();
    renderDates();
    renderSlots();
    renderSummary();
  }

  function renderHero() {
    $('#heroStatus').innerHTML = S.rooms.map((r) => {
      const st = roomNow(r.id);
      return `<div class="hs-card">
        <span class="hs-dot">${J.roomPlan(r.id)}</span>
        <span><b>${esc(r.name)}</b><small>до ${people(r.capacity)}</small></span>
        <span class="hs-state ${st.busy ? 'busy' : 'free'}">${esc(statusText(st))}</span>
      </div>`;
    }).join('');
  }

  function renderRooms() {
    $('#rooms').innerHTML = S.rooms.map((r) => {
      const st = roomNow(r.id);
      return `<button type="button" class="room" role="radio" aria-checked="${r.id === S.roomId}" data-room="${esc(r.id)}">
        <span class="room-check">${J.ICONS.check}</span>
        ${J.roomPlan(r.id)}
        <span class="room-info">
          <span class="room-name">${esc(r.name)}</span>
          <span class="room-cap">${J.ICONS.people} до ${people(r.capacity)}</span>
          <span class="room-desc">${esc(r.description)}</span>
          <span class="pill ${st.busy ? 'pill-busy' : 'pill-free'}">${esc(statusText(st))}</span>
        </span>
      </button>`;
    }).join('');
  }

  function renderDates() {
    const count = Math.min(14, S.cfg.horizonDays + 1);
    const dates = Array.from({ length: count }, (_, i) => J.addDays(S.today, i));
    if (!dates.includes(S.date)) dates.push(S.date);
    const tomorrow = J.addDays(S.today, 1);
    $('#dates').innerHTML = dates.map((d) => {
      const p = J.dateParts(d);
      const top = d === S.today ? 'Сегодня' : d === tomorrow ? 'Завтра' : J.DOW_SHORT[p.dow];
      const load = Math.round(dayLoad(S.roomId, d) * 100);
      return `<button type="button" class="date${p.dow === 0 || p.dow === 6 ? ' weekend' : ''}" role="option"
          aria-selected="${d === S.date}" data-date="${d}" title="${esc(cap(J.fmtDate(d, { dow: true })))} · занято ${load}%">
        <span class="d-top">${top}</span><span class="d-num">${p.d}</span><span class="d-mon">${J.MONTHS_SHORT[p.m]}</span>
        <span class="d-load"><i style="width:${load}%"></i></span>
      </button>`;
    }).join('');
    const picker = $('#datePicker');
    picker.min = S.today;
    picker.max = J.addDays(S.today, S.cfg.horizonDays);
    picker.value = S.date;
    const sel = $('.date[aria-selected="true"]');
    if (sel && !renderDates.scrolled) {
      renderDates.scrolled = true;
      sel.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }

  function renderSlots() {
    const nowSlot = J.floorSlot(S.now);
    $('#slots').innerHTML = GROUPS.map(([label, h]) => {
      let cells = '';
      for (let i = 0; i < 12; i++) {
        const start = `${S.date}T${J.pad(h + Math.floor(i / 2))}:${i % 2 ? '30' : '00'}`;
        const end = J.addMin(start, 30);
        const past = start < nowSlot;
        const busy = !past && !isFree(S.roomId, start, end);
        const sel = !!S.selStart && start >= S.selStart && start < S.selEnd;
        const edge = sel && (start === S.selStart || end === S.selEnd);
        const cls = ['slot', past && 'past', busy && 'busy', sel && 'sel', sel && !edge && 'mid', start === nowSlot && 'now'].filter(Boolean).join(' ');
        const t = start.slice(11);
        const state = busy ? ', занято' : past ? ', время прошло' : sel ? ', выбрано' : '';
        cells += `<button type="button" class="${cls}" data-start="${start}"${past || busy ? ' disabled' : ''} aria-pressed="${sel}" aria-label="${t}${state}">${t}</button>`;
      }
      return `<div class="slot-group"><h3>${label} <span>${J.pad(h)}:00–${J.pad(h + 6)}:00</span></h3><div class="slot-grid">${cells}</div></div>`;
    }).join('');
  }

  function canExtend() {
    if (!S.selStart) return false;
    const next = J.addMin(S.selEnd, 30);
    return J.diffMin(S.selStart, next) <= S.cfg.maxDurationMin && isFree(S.roomId, S.selEnd, next);
  }

  function renderSummary() {
    const box = $('#summary');
    const btn = $('#submitBtn');
    const r = room();
    if (!S.selStart) {
      box.className = 'summary empty-sum';
      box.textContent = 'Выберите время в расписании — детали брони появятся здесь';
      btn.disabled = true;
      btn.textContent = 'Выберите время';
    } else {
      const dur = J.diffMin(S.selStart, S.selEnd);
      box.className = 'summary';
      box.innerHTML = `
        <div class="sum-room">${J.roomPlan(r.id)}<div>${esc(r.name)}<small>до ${people(r.capacity)}</small></div></div>
        <div class="sum-date">${esc(cap(J.fmtDate(S.selStart.slice(0, 10), { dow: true })))}</div>
        <div class="sum-time">
          <b>${J.fmtRange(S.selStart, S.selEnd)}</b>
          <div class="dur" role="group" aria-label="Длительность">
            <button type="button" data-dur="-1" aria-label="Уменьшить на 30 минут"${dur <= 30 ? ' disabled' : ''}>−</button>
            <span class="tnum">${J.fmtDur(dur)}</span>
            <button type="button" data-dur="1" aria-label="Увеличить на 30 минут"${canExtend() ? '' : ' disabled'}>+</button>
          </div>
        </div>`;
      btn.disabled = S.submitting;
      btn.textContent = S.submitting ? 'Бронируем…' : `Забронировать · ${J.fmtDur(dur)}`;
    }
    // ограничение по вместимости
    if (S.people > r.capacity) S.people = r.capacity;
    $('#people').textContent = S.people;
    $('#peopleMinus').disabled = S.people <= 1;
    $('#peoplePlus').disabled = S.people >= r.capacity;
    document.body.classList.toggle('has-selection', !!S.selStart);
    updateMobileBar();
  }

  /* ------------------------------------------------------------ выбор времени */

  function setSel(start, end) {
    S.selStart = start;
    S.selEnd = end;
    J.showFieldErrors($('#bookingForm'), {});
    renderSlots();
    renderSummary();
  }

  function clearSel(render = true) {
    S.selStart = null;
    S.selEnd = null;
    if (render) { renderSlots(); renderSummary(); }
  }

  function onSlot(start) {
    const end = J.addMin(start, 30);
    const max = S.cfg.maxDurationMin;
    if (!S.selStart) return setSel(start, end);
    if (start === S.selStart) return S.selEnd === end ? clearSel() : setSel(start, end);

    // второй клик: расширяем (или сужаем) выбор до нажатого слота
    const from = start < S.selStart ? start : S.selStart;
    const to = start < S.selStart ? S.selEnd : end;
    if (!isFree(S.roomId, from, to)) {
      J.toast('Между выбранными слотами есть занятое время');
      return setSel(start, end);
    }
    if (J.diffMin(from, to) > max) {
      J.toast(`Максимум ${J.fmtDur(max)} за одну бронь`);
      return setSel(start, end);
    }
    setSel(from, to);
  }

  function changeDuration(dir) {
    if (!S.selStart) return;
    if (dir < 0 && J.diffMin(S.selStart, S.selEnd) > 30) setSel(S.selStart, J.addMin(S.selEnd, -30));
    if (dir > 0) {
      if (canExtend()) setSel(S.selStart, J.addMin(S.selEnd, 30));
      else J.toast(J.diffMin(S.selStart, S.selEnd) >= S.cfg.maxDurationMin ? `Максимум ${J.fmtDur(S.cfg.maxDurationMin)} за одну бронь` : 'Дальше комната занята');
    }
  }

  /* ------------------------------------------------------------ события */

  function bindStatic() {
    $('#rooms').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-room]');
      if (!btn || btn.dataset.room === S.roomId) return;
      S.roomId = btn.dataset.room;
      J.storage.set(ROOM_KEY, S.roomId);
      if (S.selStart && !isFree(S.roomId, S.selStart, S.selEnd)) {
        clearSel(false);
        J.toast('В этой комнате выбранное время занято — выберите другое');
      }
      renderAll();
    });

    $('#dates').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-date]');
      if (!btn || btn.dataset.date === S.date) return;
      S.date = btn.dataset.date;
      clearSel(false);
      renderDates();
      renderSlots();
      renderSummary();
    });

    $('#datePicker').addEventListener('change', (e) => {
      const v = e.target.value;
      if (!v || v < S.today || v > J.addDays(S.today, S.cfg.horizonDays)) {
        J.toast(`Можно выбрать дату в пределах ${S.cfg.horizonDays} дней`);
        return;
      }
      S.date = v;
      clearSel(false);
      renderDates();
      renderSlots();
      renderSummary();
      const sel = $('.date[aria-selected="true"]');
      if (sel) sel.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
    });

    $('#slots').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-start]');
      if (btn && !btn.disabled) onSlot(btn.dataset.start);
    });

    $('#summary').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-dur]');
      if (btn) changeDuration(Number(btn.dataset.dur));
    });

    $('#memberType').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-value]');
      if (!btn) return;
      S.memberType = btn.dataset.value;
      $$('#memberType button').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
    });

    $('#peopleMinus').addEventListener('click', () => { S.people = Math.max(1, S.people - 1); renderSummary(); });
    $('#peoplePlus').addEventListener('click', () => { S.people = Math.min(room().capacity, S.people + 1); renderSummary(); });

    $('#bookingForm').addEventListener('submit', submit);
    $('#myBtn').addEventListener('click', openMine);
    $('#mbGo').addEventListener('click', () => {
      $('#bookingForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
      setTimeout(() => $('#f-name').focus({ preventScroll: true }), 400);
    });

    if ('IntersectionObserver' in window) {
      new IntersectionObserver((entries) => {
        updateMobileBar.formVisible = entries[0].isIntersecting;
        updateMobileBar();
      }, { threshold: 0.15 }).observe($('#bookingForm'));
    }
    window.addEventListener('resize', updateMobileBar);
  }

  function updateMobileBar() {
    const bar = $('#mobileBar');
    const show = !!S.selStart && window.innerWidth <= 900 && !updateMobileBar.formVisible;
    bar.hidden = !show;
    if (show) {
      $('#mbTime').textContent = `${J.fmtRange(S.selStart, S.selEnd)} · ${J.fmtDur(J.diffMin(S.selStart, S.selEnd))}`;
      $('#mbMeta').textContent = `${room().name}, ${J.fmtDate(S.selStart.slice(0, 10), { dow: true })}`;
    }
  }

  /* ------------------------------------------------------------ оформление */

  function restoreProfile() {
    const p = J.storage.get(PROFILE_KEY, {});
    if (p.name) $('#f-name').value = p.name;
    if (p.phone) $('#f-phone').value = p.phone;
    if (p.email) $('#f-email').value = p.email;
    if (p.company) $('#f-company').value = p.company;
    if (p.memberType === 'guest' || p.memberType === 'resident') {
      S.memberType = p.memberType;
      $$('#memberType button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === p.memberType)));
    }
  }

  function saveProfile() {
    J.storage.set(PROFILE_KEY, {
      name: $('#f-name').value.trim(),
      phone: $('#f-phone').value.trim(),
      email: $('#f-email').value.trim(),
      company: $('#f-company').value.trim(),
      memberType: S.memberType,
    });
  }

  async function submit(e) {
    e.preventDefault();
    if (!S.selStart || S.submitting) return;
    const form = $('#bookingForm');
    const body = {
      room_id: S.roomId,
      start: S.selStart,
      end: S.selEnd,
      name: $('#f-name').value,
      phone: $('#f-phone').value,
      email: $('#f-email').value,
      company: $('#f-company').value,
      member_type: S.memberType,
      people: S.people,
      purpose: $('#f-purpose').value,
    };
    const errors = {};
    if (body.name.trim().length < 2) errors.name = 'Укажите имя';
    const digits = body.phone.replace(/\D/g, '').length;
    if (digits < 7 || digits > 15) errors.phone = 'Укажите телефон';
    if (body.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(body.email.trim())) errors.email = 'Проверьте email';
    J.showFieldErrors(form, errors);
    if (Object.keys(errors).length) {
      const first = form.querySelector('.field.has-error .input');
      if (first) first.focus();
      return;
    }

    S.submitting = true;
    renderSummary();
    try {
      const res = await J.api('/api/bookings', { method: 'POST', body });
      saveMine(res.booking.code, res.token);
      saveProfile();
      $('#f-purpose').value = '';
      clearSel(false);
      S.submitting = false;
      showSuccess(res.booking);
      await loadBusy();
    } catch (err) {
      if (err.status === 400 && err.data && err.data.errors) J.showFieldErrors(form, err.data.errors);
      else J.toast(err.message, 'err');
      if (err.status === 409) { clearSel(false); await loadBusy(); }
    } finally {
      S.submitting = false;
      renderSummary();
    }
  }

  function showSuccess(b) {
    const m = J.modal(`
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="okTitle">
        <div class="success">
          <div class="success-icon">${J.ICONS.check}</div>
          <h3 id="okTitle">Бронь подтверждена</h3>
          <p>Ждём вас в JAS Coworking</p>
          <div class="code-box"><small>Код брони</small><b>JAS-${esc(b.code)}</b></div>
          <div class="success-details">
            <div>${esc(b.room_name)} · ${humans(b.people)}</div>
            <div>${esc(cap(J.fmtDate(b.start.slice(0, 10), { dow: true })))}, ${J.fmtRange(b.start, b.end)}</div>
            <span>Сохраните код — он нужен, чтобы отменить бронь с другого устройства.</span>
          </div>
        </div>
        <div class="modal-foot" style="justify-content:center;padding-top:18px">
          <button class="btn btn-ghost" type="button" data-ics>${J.ICONS.calendar} В календарь</button>
          <button class="btn btn-primary" type="button" data-close autofocus>Готово</button>
        </div>
      </div>`);
    m.el.querySelector('[data-ics]').addEventListener('click', () => J.downloadIcs(b));
  }

  /* ------------------------------------------------------------ «Мои брони» */

  function mineItems() {
    const items = J.storage.get(MY_KEY, []);
    return Array.isArray(items) ? items.filter((x) => x && x.code && x.token) : [];
  }

  function saveMine(code, token) {
    const items = mineItems().filter((x) => x.code !== code);
    items.unshift({ code, token });
    J.storage.set(MY_KEY, items.slice(0, 50));
    updateMyCount();
  }

  async function updateMyCount() {
    const items = mineItems();
    const badge = $('#myCount');
    if (!items.length) { badge.hidden = true; return; }
    try {
      const data = await J.api('/api/bookings/mine', { method: 'POST', body: { items } });
      const n = data.bookings.filter((b) => b.status === 'active' && b.end > data.now).length;
      badge.textContent = n;
      badge.hidden = n === 0;
    } catch {
      badge.hidden = true;
    }
  }

  function openMine() {
    const m = J.modal(`
      <aside class="drawer" role="dialog" aria-modal="true" aria-labelledby="mineTitle">
        <div class="drawer-head"><h3 id="mineTitle">Мои брони</h3><button class="close-btn" type="button" data-close aria-label="Закрыть">✕</button></div>
        <div class="drawer-body">
          <div id="mineList" class="drawer-body" style="padding:0"><div class="empty">Загрузка…</div></div>
          <h4>Найти бронь по коду</h4>
          <form class="lookup" id="lookupForm" novalidate>
            <div class="row">
              <input class="input" name="code" placeholder="Код, напр. JAS-7K3F9Q" autocomplete="off" aria-label="Код брони" required>
              <input class="input" name="phone" type="tel" inputmode="tel" placeholder="Телефон из брони" aria-label="Телефон" required>
            </div>
            <div class="field-error" id="lookupErr" style="margin-top:8px"></div>
            <button class="btn btn-blue btn-block" type="submit" style="margin-top:10px">${J.ICONS.search} Найти</button>
          </form>
        </div>
      </aside>`, { drawer: true, onClose: updateMyCount });

    const list = m.el.querySelector('#mineList');
    refreshMine(list);

    m.el.querySelector('#lookupForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      const err = m.el.querySelector('#lookupErr');
      err.textContent = '';
      try {
        const res = await J.api('/api/bookings/lookup', { method: 'POST', body: { code: f.elements.code.value, phone: f.elements.phone.value } });
        saveMine(res.booking.code, res.token);
        f.reset();
        J.toast('Бронь найдена и добавлена в список', 'ok');
        refreshMine(list);
      } catch (ex) {
        err.textContent = ex.message;
      }
    });

    list.addEventListener('click', async (e) => {
      const ics = e.target.closest('[data-ics]');
      if (ics) { J.downloadIcs(JSON.parse(ics.dataset.ics)); return; }
      const btn = e.target.closest('[data-cancel]');
      if (!btn) return;
      if (!btn.dataset.confirm) {
        btn.dataset.confirm = '1';
        btn.textContent = 'Точно отменить?';
        setTimeout(() => { if (btn.isConnected) { delete btn.dataset.confirm; btn.textContent = 'Отменить'; } }, 4000);
        return;
      }
      btn.disabled = true;
      const item = mineItems().find((x) => x.code === btn.dataset.cancel);
      try {
        await J.api('/api/bookings/cancel', { method: 'POST', body: { code: btn.dataset.cancel, token: item && item.token } });
        J.toast('Бронь отменена', 'ok');
        await refreshMine(list);
        loadBusy();
      } catch (ex) {
        J.toast(ex.message, 'err');
        btn.disabled = false;
      }
    });
  }

  async function refreshMine(list) {
    const items = mineItems();
    if (!items.length) {
      list.innerHTML = '<div class="empty"><b>Пока пусто</b>Здесь появятся брони, оформленные с этого устройства. Бронь с другого устройства можно найти по коду ниже.</div>';
      return;
    }
    let data;
    try {
      data = await J.api('/api/bookings/mine', { method: 'POST', body: { items } });
    } catch (err) {
      list.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
      return;
    }
    const now = data.now;
    const upcoming = data.bookings.filter((b) => b.status === 'active' && b.end > now).sort((a, b) => (a.start < b.start ? -1 : 1));
    const rest = data.bookings.filter((b) => !(b.status === 'active' && b.end > now)).sort((a, b) => (a.start > b.start ? -1 : 1));
    const card = (b) => {
      const active = b.status === 'active' && b.end > now;
      const ongoing = active && b.start <= now;
      const pill = b.status === 'cancelled' ? '<span class="pill pill-red">Отменена</span>'
        : !active ? '<span class="pill pill-muted">Завершена</span>'
          : ongoing ? '<span class="pill pill-busy">Идёт сейчас</span>' : '<span class="pill pill-free">Активна</span>';
      return `<div class="mb-card${active ? '' : ' inactive'}">
        <div class="mb-top"><b>${esc(b.room_name)}</b>${pill}</div>
        <div class="mb-when">${J.fmtRange(b.start, b.end)} · ${J.fmtDur(J.diffMin(b.start, b.end))}<small>${esc(cap(J.fmtDate(b.start.slice(0, 10), { dow: true })))}</small></div>
        <div class="mb-top"><span class="mb-code">JAS-${esc(b.code)}</span>
          ${active ? `<span class="mb-actions">
            <button class="btn btn-ghost btn-sm" type="button" data-ics="${esc(JSON.stringify(b))}">В календарь</button>
            <button class="btn btn-danger btn-sm" type="button" data-cancel="${esc(b.code)}">Отменить</button></span>` : ''}
        </div>
      </div>`;
    };
    list.innerHTML = (upcoming.length ? upcoming.map(card).join('') : '<div class="empty"><b>Нет предстоящих броней</b>Выберите время в расписании.</div>')
      + (rest.length ? `<h4>История</h4>${rest.slice(0, 20).map(card).join('')}` : '');
  }
})();
