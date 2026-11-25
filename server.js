'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const T = require('./lib/time');
const { createStore, ConflictError, LimitError } = require('./lib/store');

const scrypt = promisify(crypto.scrypt);
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_ADMINS = 3;
const SESSION_DAYS = 14;
const COOKIE = 'jas_admin';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; '),
};

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/* ---------------------------------------------------------------- helpers */

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const digits = (s) => String(s || '').replace(/\D/g, '');
const str = (v, max) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, max) : '');
const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function phonesMatch(a, b) {
  const da = digits(a);
  const db = digits(b);
  if (da.length < 7 || db.length < 7) return false;
  return da.slice(-10) === db.slice(-10);
}

function normalizeCode(code) {
  return String(code || '').toUpperCase().replace(/^JAS[-\s]?/, '').replace(/[^A-Z0-9]/g, '');
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const [alg, saltHex, hashHex] = String(stored).split('$');
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  const hash = await scrypt(password, Buffer.from(saltHex, 'hex'), 64);
  const expected = Buffer.from(hashHex, 'hex');
  return expected.length === hash.length && crypto.timingSafeEqual(hash, expected);
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Простейший ограничитель частоты запросов в памяти процесса. */
function rateLimiter(limit, windowMs) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (arr.length >= limit) {
      hits.set(key, arr);
      throw new HttpError(429, 'Слишком много попыток. Попробуйте чуть позже.');
    }
    arr.push(now);
    hits.set(key, arr);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > windowMs) hits.delete(k);
  };
}

/* ---------------------------------------------------------------- app */

function createApp(options = {}) {
  const cfg = {
    dataDir: options.dataDir || process.env.DATA_DIR || path.join(__dirname, 'data'),
    defaultTimezone: options.timezone || process.env.TIMEZONE || 'Europe/Moscow',
    adminEmails: (options.adminEmails ?? process.env.ADMIN_EMAILS ?? '')
      .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    trustProxy: options.trustProxy ?? /^(1|true|yes)$/i.test(process.env.TRUST_PROXY || ''),
    cookieSecure: options.cookieSecure ?? /^(1|true|yes)$/i.test(process.env.COOKIE_SECURE || ''),
  };
  if (!T.isTimeZone(cfg.defaultTimezone)) cfg.defaultTimezone = 'Europe/Moscow';

  const store = createStore({ dataDir: cfg.dataDir, defaultTimezone: cfg.defaultTimezone });
  const limits = {
    booking: rateLimiter(20, 60 * 60 * 1000),
    lookup: rateLimiter(40, 15 * 60 * 1000),
    login: rateLimiter(10, 15 * 60 * 1000),
    register: rateLimiter(6, 60 * 60 * 1000),
  };

  const nowWall = () => T.wallAt(store.settings().timezone);

  /* ---------- представления ---------- */

  function roomName(id) {
    const r = store.room(id);
    return r ? r.name : id;
  }

  function publicBooking(b, tz) {
    return {
      code: b.code,
      room_id: b.room_id,
      room_name: roomName(b.room_id),
      start: b.start_at,
      end: b.end_at,
      start_utc: T.wallToUtc(b.start_at, tz),
      end_utc: T.wallToUtc(b.end_at, tz),
      name: b.name,
      member_type: b.member_type,
      people: b.people,
      status: b.status,
    };
  }

  function adminBooking(b, tz) {
    return {
      id: b.id,
      ...publicBooking(b, tz),
      phone: b.phone,
      email: b.email,
      company: b.company,
      purpose: b.purpose,
      created_at: b.created_at,
      created_by: b.created_by,
      cancelled_at: b.cancelled_at,
      cancelled_by: b.cancelled_by,
      cancel_reason: b.cancel_reason,
    };
  }

  function adminView(a) {
    return { id: a.id, email: a.email, name: a.name, created_at: a.created_at, last_login_at: a.last_login_at };
  }

  /* ---------- валидация брони ---------- */

  function validateBooking(body, { isAdmin }) {
    const settings = store.settings();
    const errors = {};
    const room = store.room(String(body.room_id || ''));
    if (!room) errors.room_id = 'Выберите комнату';

    const start = String(body.start || '');
    const end = String(body.end || '');
    let timeError = '';
    if (!T.isWall(start) || !T.isWall(end) || !T.isSlotAligned(start) || !T.isSlotAligned(end)) {
      timeError = 'Выберите время с шагом 30 минут';
    } else {
      const dur = T.diffMinutes(start, end);
      const maxDur = isAdmin ? 24 * 60 : settings.maxDurationMin;
      const now = T.wallAt(settings.timezone);
      if (dur < T.SLOT_MIN) timeError = 'Минимальная длительность — 30 минут';
      else if (dur > maxDur) timeError = `Максимальная длительность брони — ${maxDur / 60} ч`;
      else if (start < T.floorSlot(now)) timeError = 'Нельзя забронировать время в прошлом';
      else if (!isAdmin && start.slice(0, 10) > T.addDays(now.slice(0, 10), settings.horizonDays)) {
        timeError = `Бронировать можно не дальше чем на ${settings.horizonDays} дн. вперёд`;
      }
    }
    if (timeError) errors.time = timeError;

    const name = str(body.name, 80);
    if (name.length < 2) errors.name = 'Укажите имя';

    const phone = str(body.phone, 32);
    const phoneDigits = digits(phone).length;
    if (!isAdmin || phone) {
      if (phoneDigits < 7 || phoneDigits > 15) errors.phone = 'Укажите телефон';
    }

    const email = str(body.email, 120).toLowerCase();
    if (email && !EMAIL_RE.test(email)) errors.email = 'Проверьте email';

    const memberType = body.member_type === 'guest' ? 'guest' : body.member_type === 'resident' ? 'resident' : '';
    if (!memberType) errors.member_type = 'Выберите: резидент или гость';

    let people = Number.parseInt(body.people, 10);
    if (!Number.isFinite(people) || people < 1) people = 1;
    if (room && people > room.capacity) errors.people = `В «${room.name}» максимум ${room.capacity} чел.`;

    if (Object.keys(errors).length) throw new HttpError(400, 'Проверьте данные формы', { errors });

    return {
      room_id: room.id, start_at: start, end_at: end, name, phone, email,
      company: str(body.company, 100), member_type: memberType, people, purpose: text(body.purpose, 300),
    };
  }

  /* ---------- маршрутизация ---------- */

  const routes = [];
  const route = (method, pattern, handler, opts = {}) => {
    const re = new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`);
    routes.push({ method, re, handler, ...opts });
  };

  function requireAdmin(ctx) {
    if (!ctx.admin) throw new HttpError(401, 'Требуется вход администратора');
    return ctx.admin;
  }

  function parseRange(query, maxDays) {
    const settings = store.settings();
    const today = T.wallAt(settings.timezone).slice(0, 10);
    const from = T.isDate(query.get('from')) ? query.get('from') : today;
    let to = T.isDate(query.get('to')) ? query.get('to') : from;
    if (to < from) to = from;
    if (T.diffMinutes(`${from}T00:00`, `${to}T00:00`) / 1440 > maxDays) to = T.addDays(from, maxDays);
    return { from, to, fromWall: `${from}T00:00`, toWall: `${T.addDays(to, 1)}T00:00` };
  }

  /* --- публичное API --- */

  route('GET', '/api/config', () => {
    const settings = store.settings();
    const now = T.wallAt(settings.timezone);
    return {
      timezone: settings.timezone,
      now,
      today: now.slice(0, 10),
      slotMinutes: T.SLOT_MIN,
      maxDurationMin: settings.maxDurationMin,
      horizonDays: settings.horizonDays,
      rooms: store.rooms(),
    };
  });

  route('GET', '/api/availability', (ctx) => {
    const settings = store.settings();
    const range = parseRange(ctx.query, settings.horizonDays + 2);
    return {
      now: T.wallAt(settings.timezone),
      from: range.from,
      to: range.to,
      busy: store.busy(range.fromWall, range.toWall).map((b) => ({ room_id: b.room_id, start: b.start_at, end: b.end_at })),
    };
  });

  route('POST', '/api/bookings', (ctx) => {
    limits.booking(ctx.ip);
    const data = validateBooking(ctx.body, { isAdmin: false });
    try {
      const b = store.createBooking({ ...data, created_by: 'client' });
      return { booking: publicBooking(b, store.settings().timezone), token: b.token };
    } catch (err) {
      if (err instanceof ConflictError) throw new HttpError(409, 'Это время уже кто-то забронировал. Выберите другое.');
      throw err;
    }
  });

  route('POST', '/api/bookings/mine', (ctx) => {
    const items = Array.isArray(ctx.body.items) ? ctx.body.items.slice(0, 60) : [];
    const tz = store.settings().timezone;
    const out = [];
    for (const it of items) {
      const b = store.bookingByCode(normalizeCode(it && it.code));
      if (b && safeEqual(b.token, it.token || '')) out.push(publicBooking(b, tz));
    }
    return { bookings: out, now: T.wallAt(tz) };
  });

  route('POST', '/api/bookings/lookup', (ctx) => {
    limits.lookup(ctx.ip);
    const b = store.bookingByCode(normalizeCode(ctx.body.code));
    if (!b || !phonesMatch(b.phone, ctx.body.phone)) throw new HttpError(404, 'Бронь не найдена. Проверьте код и телефон.');
    return { booking: publicBooking(b, store.settings().timezone), token: b.token };
  });

  route('POST', '/api/bookings/cancel', (ctx) => {
    limits.lookup(ctx.ip);
    const b = store.bookingByCode(normalizeCode(ctx.body.code));
    const authorized = b && ((ctx.body.token && safeEqual(b.token, ctx.body.token)) || phonesMatch(b.phone, ctx.body.phone));
    if (!authorized) throw new HttpError(404, 'Бронь не найдена');
    if (b.status !== 'active') throw new HttpError(409, 'Бронь уже отменена');
    if (b.end_at <= nowWall()) throw new HttpError(409, 'Бронь уже завершилась');
    const updated = store.cancelBooking(b.id, 'client');
    return { booking: publicBooking(updated, store.settings().timezone) };
  });

  /* --- администратор: доступ --- */

  route('GET', '/api/admin/status', (ctx) => {
    const count = store.countAdmins();
    return {
      maxAdmins: MAX_ADMINS,
      adminsCount: count,
      registrationOpen: count < MAX_ADMINS,
      restrictedEmails: cfg.adminEmails.length > 0,
      me: ctx.admin ? adminView(ctx.admin) : null,
    };
  });

  async function startSession(ctx, admin) {
    const token = crypto.randomBytes(32).toString('base64url');
    const maxAge = SESSION_DAYS * 24 * 3600;
    store.createSession(sha256(token), admin.id, Date.now() + maxAge * 1000);
    store.touchAdmin(admin.id);
    store.purgeSessions();
    ctx.setCookie(`${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${ctx.secure ? '; Secure' : ''}`);
  }

  route('POST', '/api/admin/register', async (ctx) => {
    limits.register(ctx.ip);
    const email = str(ctx.body.email, 120).toLowerCase();
    const name = str(ctx.body.name, 80);
    const password = typeof ctx.body.password === 'string' ? ctx.body.password : '';
    const errors = {};
    if (!EMAIL_RE.test(email)) errors.email = 'Укажите корректный email';
    if (password.length < 8) errors.password = 'Минимум 8 символов';
    if (password.length > 200) errors.password = 'Слишком длинный пароль';
    if (Object.keys(errors).length) throw new HttpError(400, 'Проверьте данные', { errors });
    if (cfg.adminEmails.length && !cfg.adminEmails.includes(email)) {
      throw new HttpError(403, 'Этот email не входит в список разрешённых для регистрации администраторов');
    }
    if (store.countAdmins() >= MAX_ADMINS) throw new HttpError(403, `Регистрация закрыта: уже зарегистрировано ${MAX_ADMINS} администратора`);
    const passHash = await hashPassword(password);
    let admin;
    try {
      admin = store.createAdmin({ email, name, passHash, maxAdmins: MAX_ADMINS });
    } catch (err) {
      if (err instanceof LimitError) throw new HttpError(403, `Регистрация закрыта: уже зарегистрировано ${MAX_ADMINS} администратора`);
      if (err instanceof ConflictError) throw new HttpError(409, 'Этот email уже зарегистрирован — войдите');
      throw err;
    }
    await startSession(ctx, admin);
    return { me: adminView(admin) };
  });

  route('POST', '/api/admin/login', async (ctx) => {
    limits.login(ctx.ip);
    const email = str(ctx.body.email, 120).toLowerCase();
    const password = typeof ctx.body.password === 'string' ? ctx.body.password.slice(0, 200) : '';
    const admin = store.adminByEmail(email);
    const ok = admin ? await verifyPassword(password, admin.pass_hash) : (await hashPassword(password), false);
    if (!ok) throw new HttpError(401, 'Неверный email или пароль');
    await startSession(ctx, admin);
    return { me: adminView(admin) };
  });

  route('POST', '/api/admin/logout', (ctx) => {
    if (ctx.sessionHash) store.deleteSession(ctx.sessionHash);
    ctx.setCookie(`${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    return { ok: true };
  });

  /* --- администратор: данные --- */

  route('GET', '/api/admin/overview', (ctx) => {
    const me = requireAdmin(ctx);
    const settings = store.settings();
    const now = T.wallAt(settings.timezone);
    return {
      me: adminView(me),
      settings,
      rooms: store.rooms(),
      now,
      today: now.slice(0, 10),
      maxAdmins: MAX_ADMINS,
      adminsCount: store.countAdmins(),
    };
  });

  route('GET', '/api/admin/bookings', (ctx) => {
    requireAdmin(ctx);
    const tz = store.settings().timezone;
    const range = parseRange(ctx.query, 400);
    const status = ['active', 'cancelled', 'all'].includes(ctx.query.get('status')) ? ctx.query.get('status') : 'all';
    const rows = store.listBookings({ fromWall: range.fromWall, toWall: range.toWall, roomId: ctx.query.get('room') || '', status });
    return { from: range.from, to: range.to, now: T.wallAt(tz), bookings: rows.map((b) => adminBooking(b, tz)) };
  });

  route('GET', '/api/admin/bookings/recent', (ctx) => {
    requireAdmin(ctx);
    const tz = store.settings().timezone;
    return { bookings: store.recentBookings(15).map((b) => adminBooking(b, tz)) };
  });

  route('POST', '/api/admin/bookings', (ctx) => {
    const me = requireAdmin(ctx);
    const data = validateBooking(ctx.body, { isAdmin: true });
    try {
      const b = store.createBooking({ ...data, created_by: me.email });
      return { booking: adminBooking(b, store.settings().timezone) };
    } catch (err) {
      if (err instanceof ConflictError) throw new HttpError(409, 'В это время комната уже занята');
      throw err;
    }
  });

  route('POST', '/api/admin/bookings/:id/cancel', (ctx) => {
    const me = requireAdmin(ctx);
    const b = store.bookingById(Number(ctx.params.id));
    if (!b) throw new HttpError(404, 'Бронь не найдена');
    if (b.status !== 'active') throw new HttpError(409, 'Бронь уже отменена');
    const updated = store.cancelBooking(b.id, me.email, text(ctx.body.reason, 200));
    return { booking: adminBooking(updated, store.settings().timezone) };
  });

  route('GET', '/api/admin/export.csv', (ctx) => {
    requireAdmin(ctx);
    const range = parseRange(ctx.query, 400);
    const status = ['active', 'cancelled', 'all'].includes(ctx.query.get('status')) ? ctx.query.get('status') : 'all';
    const rows = store.listBookings({ fromWall: range.fromWall, toWall: range.toWall, roomId: ctx.query.get('room') || '', status });
    const cell = (v) => {
      let s = String(v ?? '');
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // защита от формул в Excel
      return `"${s.replace(/"/g, '""')}"`;
    };
    const head = ['Код', 'Комната', 'Дата', 'Начало', 'Окончание', 'Длительность (мин)', 'Имя', 'Телефон', 'Email',
      'Компания', 'Статус клиента', 'Человек', 'Цель', 'Статус брони', 'Создана (UTC)', 'Кем создана', 'Отменена (UTC)', 'Кем отменена', 'Причина отмены'];
    const lines = [head.map(cell).join(';')];
    for (const b of rows) {
      lines.push([
        `JAS-${b.code}`, roomName(b.room_id), b.start_at.slice(0, 10), b.start_at.slice(11), b.end_at.replace('T', ' '),
        T.diffMinutes(b.start_at, b.end_at), b.name, b.phone, b.email, b.company,
        b.member_type === 'resident' ? 'Резидент' : 'Гость', b.people, b.purpose,
        b.status === 'active' ? 'Активна' : 'Отменена', b.created_at, b.created_by, b.cancelled_at || '', b.cancelled_by || '', b.cancel_reason,
      ].map(cell).join(';'));
    }
    return {
      raw: `﻿${lines.join('\r\n')}\r\n`,
      type: 'text/csv; charset=utf-8',
      headers: { 'Content-Disposition': `attachment; filename="jas-bookings-${range.from}_${range.to}.csv"` },
    };
  });

  route('GET', '/api/admin/admins', (ctx) => {
    requireAdmin(ctx);
    return { maxAdmins: MAX_ADMINS, admins: store.listAdmins().map(adminView) };
  });

  route('POST', '/api/admin/admins/:id/remove', (ctx) => {
    const me = requireAdmin(ctx);
    const id = Number(ctx.params.id);
    if (id === me.id) throw new HttpError(400, 'Нельзя удалить самого себя');
    if (!store.adminById(id)) throw new HttpError(404, 'Администратор не найден');
    store.deleteAdmin(id);
    return { maxAdmins: MAX_ADMINS, admins: store.listAdmins().map(adminView) };
  });

  route('PUT', '/api/admin/settings', (ctx) => {
    requireAdmin(ctx);
    const b = ctx.body;
    const errors = {};
    const timezone = str(b.timezone, 64);
    if (!T.isTimeZone(timezone)) errors.timezone = 'Неизвестный часовой пояс';
    const maxDurationMin = Number(b.maxDurationMin);
    if (!Number.isInteger(maxDurationMin) || maxDurationMin < 30 || maxDurationMin > 1440 || maxDurationMin % 30) {
      errors.maxDurationMin = 'От 30 минут до 24 часов, шаг 30 минут';
    }
    const horizonDays = Number(b.horizonDays);
    if (!Number.isInteger(horizonDays) || horizonDays < 1 || horizonDays > 365) errors.horizonDays = 'От 1 до 365 дней';
    const rooms = [];
    for (const r of Array.isArray(b.rooms) ? b.rooms : []) {
      const existing = store.room(String(r.id || ''));
      if (!existing) continue;
      const name = str(r.name, 40);
      const capacity = Number(r.capacity);
      if (!name) errors[`room_${existing.id}_name`] = 'Укажите название';
      if (!Number.isInteger(capacity) || capacity < 1 || capacity > 100) errors[`room_${existing.id}_capacity`] = 'От 1 до 100';
      rooms.push({ id: existing.id, name, capacity, description: str(r.description, 200) });
    }
    if (Object.keys(errors).length) throw new HttpError(400, 'Проверьте настройки', { errors });
    store.saveSettings({ timezone, maxDurationMin, horizonDays, rooms });
    return { settings: store.settings(), rooms: store.rooms() };
  });

  /* ---------- обработчик запросов ---------- */

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 64 * 1024) throw new HttpError(413, 'Слишком большой запрос');
      chunks.push(chunk);
    }
    if (!size) return {};
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      throw new HttpError(400, 'Некорректный JSON');
    }
  }

  function send(res, status, body, type = 'application/json; charset=utf-8', headers = {}) {
    const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...headers });
    res.end(payload);
  }

  function serveStatic(req, res, pathname) {
    let rel = pathname;
    if (rel === '/' || rel === '/index.html') rel = '/index.html';
    else if (rel === '/admin' || rel === '/admin/') rel = '/admin.html';
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden', 'text/plain; charset=utf-8');
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return send(res, 404, 'Страница не найдена', 'text/plain; charset=utf-8');
      const ext = path.extname(file).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Length': st.size,
        'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
        ...SECURITY_HEADERS,
      });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    });
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);

    if (!pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed' });
      return serveStatic(req, res, pathname);
    }

    const cookieHeaders = [];
    try {
      const match = routes.find((r) => r.method === req.method && r.re.test(pathname));
      if (!match) throw new HttpError(404, 'Не найдено');

      if (req.method !== 'GET') {
        // Защита от CSRF: принимаем только JSON (кросс-доменная форма не может его отправить без CORS)
        const ctype = String(req.headers['content-type'] || '');
        if (!ctype.startsWith('application/json')) throw new HttpError(415, 'Ожидается application/json');
      }

      const forwarded = cfg.trustProxy ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
      const cookies = parseCookies(req.headers.cookie);
      const sessionHash = cookies[COOKIE] ? sha256(cookies[COOKIE]) : null;
      const ctx = {
        params: match.re.exec(pathname).groups || {},
        query: url.searchParams,
        body: req.method === 'GET' ? {} : await readBody(req),
        ip: forwarded || req.socket.remoteAddress || 'unknown',
        secure: cfg.cookieSecure || (cfg.trustProxy && req.headers['x-forwarded-proto'] === 'https'),
        sessionHash,
        admin: sessionHash ? store.sessionAdmin(sessionHash) : null,
        setCookie: (c) => cookieHeaders.push(c),
      };

      const result = await match.handler(ctx);
      const extra = cookieHeaders.length ? { 'Set-Cookie': cookieHeaders } : {};
      if (result && result.raw !== undefined) return send(res, 200, result.raw, result.type, { ...extra, ...result.headers });
      return send(res, 200, result ?? { ok: true }, undefined, extra);
    } catch (err) {
      const extra = cookieHeaders.length ? { 'Set-Cookie': cookieHeaders } : {};
      if (err instanceof HttpError) return send(res, err.status, { error: err.message, ...err.extra }, undefined, extra);
      console.error(err);
      return send(res, 500, { error: 'Внутренняя ошибка сервера' }, undefined, extra);
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error(err);
      if (!res.headersSent) send(res, 500, { error: 'Внутренняя ошибка сервера' });
    });
  });

  return { server, store, config: cfg };
}

if (require.main === module) {
  const { server, store, config } = createApp();
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '0.0.0.0';
  server.listen(port, host, () => {
    const s = store.settings();
    console.log(`JAS Booking запущен: http://localhost:${port}  (админка: http://localhost:${port}/admin)`);
    console.log(`Данные: ${config.dataDir} · часовой пояс: ${s.timezone} · админов: ${store.countAdmins()}/${MAX_ADMINS}`);
    if (!config.adminEmails.length && store.countAdmins() < MAX_ADMINS) {
      console.log('Внимание: регистрация администраторов открыта. Задайте ADMIN_EMAILS, чтобы ограничить список почт.');
    }
  });
  const shutdown = () => server.close(() => { store.close(); process.exit(0); });
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { createApp };
