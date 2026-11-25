/* Общие помощники для публичной страницы и кабинета администратора */
(function () {
  'use strict';

  const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  const DOW = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
  const DOW_SHORT = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

  const pad = (n) => String(n).padStart(2, '0');

  /* --- «настенное» время коворкинга: "YYYY-MM-DDTHH:MM" --- */
  function fromMin(min) {
    const d = new Date(min * 60000);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  }
  function toMin(wall) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(wall || '');
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 60000 : NaN;
  }
  const addMin = (wall, n) => fromMin(toMin(wall) + n);
  const addDays = (date, n) => fromMin(toMin(`${date}T00:00`) + n * 1440).slice(0, 10);
  const diffMin = (a, b) => toMin(b) - toMin(a);
  const floorSlot = (wall) => { const m = toMin(wall); return fromMin(m - (m % 30)); };
  const dateParts = (date) => { const d = new Date(toMin(`${date}T00:00`) * 60000); return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), dow: d.getUTCDay() }; };

  function fmtDate(date, { year = false, dow = false } = {}) {
    const p = dateParts(date);
    let s = `${p.d} ${MONTHS[p.m]}`;
    if (year) s += ` ${p.y}`;
    if (dow) s = `${DOW[p.dow]}, ${s}`;
    return s;
  }
  function fmtDur(min) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    if (!h) return `${m} мин`;
    return m ? `${h} ч ${m} мин` : `${h} ч`;
  }
  /** "14:00–16:00", если конец на следующий день — "23:00–01:00 (+1)". */
  function fmtRange(start, end) {
    const s = start.slice(11);
    const e = end.slice(11);
    const days = Math.round((toMin(`${end.slice(0, 10)}T00:00`) - toMin(`${start.slice(0, 10)}T00:00`)) / 1440);
    if (days === 1 && e === '00:00') return `${s}–24:00`;
    return days > 0 ? `${s}–${e} (+${days})` : `${s}–${e}`;
  }
  function plural(n, one, few, many) {
    const a = Math.abs(n) % 100;
    const b = a % 10;
    if (a > 10 && a < 20) return many;
    if (b > 1 && b < 5) return few;
    if (b === 1) return one;
    return many;
  }

  /* --- DOM --- */
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function toast(message, type = '') {
    let host = document.getElementById('toasts');
    if (!host) {
      host = document.createElement('div');
      host.id = 'toasts';
      host.className = 'toasts';
      document.body.appendChild(host);
    }
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.setAttribute('role', 'status');
    t.textContent = message;
    host.appendChild(t);
    setTimeout(() => { t.style.transition = 'opacity .3s'; t.style.opacity = '0'; }, 3600);
    setTimeout(() => t.remove(), 4000);
  }

  /** Модальное окно: возвращает {el, close}. */
  function modal(html, { drawer = false, onClose } = {}) {
    const overlay = document.createElement('div');
    overlay.className = `overlay${drawer ? ' drawer-overlay' : ''}`;
    overlay.innerHTML = html;
    const prevFocus = document.activeElement;
    const close = () => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      if (prevFocus && prevFocus.focus) prevFocus.focus();
      if (onClose) onClose();
    };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    overlay.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) close(); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    document.body.style.overflow = 'hidden';
    const focusable = overlay.querySelector('[autofocus], input, button:not(.close-btn), select, textarea');
    if (focusable) setTimeout(() => focusable.focus(), 30);
    return { el: overlay, close };
  }

  function showFieldErrors(form, errors = {}) {
    $$('.field.has-error', form).forEach((f) => f.classList.remove('has-error'));
    $$('[data-error]', form).forEach((e) => { e.textContent = ''; });
    for (const [key, msg] of Object.entries(errors)) {
      const err = form.querySelector(`[data-error="${key}"]`);
      if (err) {
        err.textContent = msg;
        const f = err.closest('.field');
        if (f) f.classList.add('has-error');
      }
    }
  }

  /* --- сеть --- */
  async function api(path, { method = 'GET', body } = {}) {
    const opts = { method, headers: { Accept: 'application/json' }, credentials: 'same-origin' };
    if (method !== 'GET') {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body || {});
    }
    let res;
    try {
      res = await fetch(path, opts);
    } catch {
      const err = new Error('Нет соединения с сервером');
      err.status = 0;
      throw err;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `Ошибка ${res.status}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  /* --- localStorage без падений (приватный режим и т.п.) --- */
  const storage = {
    get(key, fallback) {
      try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* недоступно */ }
    },
  };

  /** Скачать событие в календарь (.ics) */
  function downloadIcs(b) {
    const stamp = (iso) => iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const lines = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//JAS Coworking//Booking//RU', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
      'BEGIN:VEVENT',
      `UID:${b.code}@jas-coworking`,
      `DTSTAMP:${stamp(new Date().toISOString())}`,
      `DTSTART:${stamp(b.start_utc)}`,
      `DTEND:${stamp(b.end_utc)}`,
      `SUMMARY:Переговорная ${b.room_name} — JAS Coworking`,
      `DESCRIPTION:Код брони: JAS-${b.code}`,
      `LOCATION:JAS Coworking\\, ${b.room_name}`,
      'END:VEVENT', 'END:VCALENDAR',
    ];
    const blob = new Blob([lines.join('\r\n')], { type: 'text/calendar;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `jas-${b.code}.ics`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  /* --- иконки и схемы комнат (вид сверху) --- */
  const ICONS = {
    people: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="3"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>',
    download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    left: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>',
    right: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>',
    grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
    settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/></svg>',
    phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.08 4.18 2 2 0 0 1 4.06 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.1 9.9a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/></svg>',
    logout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/></svg>',
  };

  function roomPlan(roomId) {
    if (roomId === 'focus') {
      return `<svg viewBox="0 0 120 90" aria-hidden="true">
        <rect x="4" y="4" width="112" height="82" rx="14" fill="#fff4ea"/>
        <rect x="40" y="27" width="40" height="36" rx="8" fill="#f26a0a"/>
        <circle cx="60" cy="17" r="7" fill="#0a1a9e"/><circle cx="60" cy="73" r="7" fill="#0a1a9e"/>
        <circle cx="29" cy="45" r="7" fill="#0a1a9e"/><circle cx="91" cy="45" r="7" fill="#0a1a9e"/>
      </svg>`;
    }
    const chairs = [32, 52, 72, 92].map((x) => `<circle cx="${x}" cy="20" r="6.5" fill="#f26a0a"/><circle cx="${x}" cy="70" r="6.5" fill="#f26a0a"/>`).join('');
    return `<svg viewBox="0 0 124 90" aria-hidden="true">
      <rect x="4" y="4" width="116" height="82" rx="14" fill="#eaf0ff"/>
      <rect x="22" y="31" width="80" height="28" rx="10" fill="#0a3fe6"/>
      ${chairs}
    </svg>`;
  }

  /* Клик по скрытому <input type="date"> открывает системный календарь */
  document.addEventListener('click', (e) => {
    const input = e.target.closest('input[type="date"]');
    if (input && input.showPicker && getComputedStyle(input).opacity === '0') {
      try { input.showPicker(); } catch { /* браузер не поддерживает */ }
    }
  });

  window.JAS = {
    MONTHS, MONTHS_SHORT, DOW, DOW_SHORT, pad, toMin, fromMin, addMin, addDays, diffMin, floorSlot, dateParts,
    fmtDate, fmtDur, fmtRange, plural, esc, $, $$, toast, modal, showFieldErrors, api, storage, downloadIcs, ICONS, roomPlan,
  };
})();
