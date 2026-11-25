'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server');
const T = require('../lib/time');

const TZ = 'Europe/Moscow';
let app;
let base;
let dir;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jas-test-'));
  app = createApp({ dataDir: dir, timezone: TZ, adminEmails: '' });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(() => {
  app.server.close();
  app.store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function call(method, url, body, cookie) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  return { status: res.status, data, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}

// слот завтра в 10:00 — гарантированно в будущем
const tomorrow = () => T.addDays(T.wallAt(TZ).slice(0, 10), 1);
const booking = (over = {}) => ({
  room_id: 'alfa', start: `${tomorrow()}T10:00`, end: `${tomorrow()}T11:30`,
  name: 'Иван Петров', phone: '+7 900 123-45-67', member_type: 'resident', people: 3, ...over,
});

test('конфигурация отдаёт две комнаты', async () => {
  const { status, data } = await call('GET', '/api/config');
  assert.equal(status, 200);
  assert.deepEqual(data.rooms.map((r) => [r.id, r.capacity]), [['focus', 4], ['alfa', 8]]);
  assert.equal(data.slotMinutes, 30);
});

test('бронь создаётся, пересечение отклоняется, соседний слот — нет', async () => {
  const ok = await call('POST', '/api/bookings', booking());
  assert.equal(ok.status, 200);
  assert.match(ok.data.booking.code, /^[A-Z0-9]{6}$/);
  assert.ok(ok.data.token);

  const overlap = await call('POST', '/api/bookings', booking({ start: `${tomorrow()}T11:00`, end: `${tomorrow()}T12:00` }));
  assert.equal(overlap.status, 409);

  const adjacent = await call('POST', '/api/bookings', booking({ start: `${tomorrow()}T11:30`, end: `${tomorrow()}T12:00` }));
  assert.equal(adjacent.status, 200);

  const otherRoom = await call('POST', '/api/bookings', booking({ room_id: 'focus', people: 2 }));
  assert.equal(otherRoom.status, 200);

  const avail = await call('GET', `/api/availability?from=${tomorrow()}&to=${tomorrow()}`);
  assert.equal(avail.data.busy.length, 3);
  assert.equal(avail.data.busy[0].name, undefined, 'публичная доступность не раскрывает имена');
});

test('бронь через полночь работает', async () => {
  const d = tomorrow();
  const res = await call('POST', '/api/bookings', booking({ room_id: 'focus', start: `${d}T23:30`, end: `${T.addDays(d, 1)}T00:30`, people: 1 }));
  assert.equal(res.status, 200);
  const clash = await call('POST', '/api/bookings', booking({ room_id: 'focus', start: `${T.addDays(d, 1)}T00:00`, end: `${T.addDays(d, 1)}T01:00`, people: 1 }));
  assert.equal(clash.status, 409);
});

test('валидация: шаг 30 минут, прошлое, вместимость, контакты', async () => {
  const d = tomorrow();
  assert.equal((await call('POST', '/api/bookings', booking({ start: `${d}T15:15`, end: `${d}T16:00` }))).status, 400);
  assert.equal((await call('POST', '/api/bookings', booking({ start: `${T.addDays(d, -3)}T10:00`, end: `${T.addDays(d, -3)}T11:00` }))).status, 400);
  const tooMany = await call('POST', '/api/bookings', booking({ room_id: 'focus', start: `${d}T16:00`, end: `${d}T17:00`, people: 6 }));
  assert.equal(tooMany.status, 400);
  assert.ok(tooMany.data.errors.people);
  const noPhone = await call('POST', '/api/bookings', booking({ start: `${d}T16:00`, end: `${d}T17:00`, phone: '12' }));
  assert.ok(noPhone.data.errors.phone);
  const tooLong = await call('POST', '/api/bookings', booking({ start: `${d}T00:00`, end: `${d}T09:00` }));
  assert.equal(tooLong.status, 400);
});

test('отмена клиентом по токену и по телефону', async () => {
  const d = tomorrow();
  const a = await call('POST', '/api/bookings', booking({ start: `${d}T18:00`, end: `${d}T19:00` }));
  const wrong = await call('POST', '/api/bookings/cancel', { code: a.data.booking.code, token: 'nope' });
  assert.equal(wrong.status, 404);
  const ok = await call('POST', '/api/bookings/cancel', { code: `JAS-${a.data.booking.code}`, token: a.data.token });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.booking.status, 'cancelled');
  // слот освободился
  assert.equal((await call('POST', '/api/bookings', booking({ start: `${d}T18:00`, end: `${d}T19:00` }))).status, 200);

  const b = await call('POST', '/api/bookings', booking({ start: `${d}T20:00`, end: `${d}T21:00` }));
  const lookup = await call('POST', '/api/bookings/lookup', { code: b.data.booking.code.toLowerCase(), phone: '8 (900) 123 45 67' });
  assert.equal(lookup.status, 200);
  const byPhone = await call('POST', '/api/bookings/cancel', { code: b.data.booking.code, phone: '+79001234567' });
  assert.equal(byPhone.status, 200);
});

test('POST без JSON отклоняется (защита от CSRF)', async () => {
  const res = await fetch(`${base}/api/bookings`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'a=1' });
  assert.equal(res.status, 415);
});

test('администраторы: максимум 3, вход, доступ к броням', async () => {
  const anon = await call('GET', '/api/admin/bookings');
  assert.equal(anon.status, 401);

  const cookies = [];
  for (let i = 1; i <= 3; i++) {
    const r = await call('POST', '/api/admin/register', { email: `admin${i}@jas.test`, name: `Админ ${i}`, password: 'secret-pass' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.ok(r.cookie.startsWith('jas_admin='));
    cookies.push(r.cookie);
  }
  const fourth = await call('POST', '/api/admin/register', { email: 'admin4@jas.test', password: 'secret-pass' });
  assert.equal(fourth.status, 403);

  const st = await call('GET', '/api/admin/status');
  assert.equal(st.data.adminsCount, 3);
  assert.equal(st.data.registrationOpen, false);

  const badLogin = await call('POST', '/api/admin/login', { email: 'admin1@jas.test', password: 'wrong-pass' });
  assert.equal(badLogin.status, 401);
  const login = await call('POST', '/api/admin/login', { email: 'ADMIN1@jas.test', password: 'secret-pass' });
  assert.equal(login.status, 200);

  const list = await call('GET', `/api/admin/bookings?from=${tomorrow()}&to=${T.addDays(tomorrow(), 1)}`, undefined, login.cookie);
  assert.equal(list.status, 200);
  assert.ok(list.data.bookings.length >= 4);
  assert.ok(list.data.bookings[0].phone, 'администратор видит контакты');

  const csv = await call('GET', `/api/admin/export.csv?from=${tomorrow()}&to=${tomorrow()}`, undefined, login.cookie);
  assert.equal(csv.status, 200);
  assert.match(csv.data, /Иван Петров/);

  // освободить место → регистрация снова открыта
  const admins = await call('GET', '/api/admin/admins', undefined, login.cookie);
  const third = admins.data.admins.find((a) => a.email === 'admin3@jas.test');
  assert.equal((await call('POST', `/api/admin/admins/${third.id}/remove`, {}, login.cookie)).status, 200);
  assert.equal((await call('GET', '/api/admin/overview', undefined, cookies[2])).status, 401, 'сессия удалённого админа недействительна');
  assert.equal((await call('POST', '/api/admin/register', { email: 'new@jas.test', password: 'secret-pass' })).status, 200);

  // админ создаёт и отменяет бронь
  const created = await call('POST', '/api/admin/bookings', { room_id: 'focus', start: `${tomorrow()}T07:00`, end: `${tomorrow()}T08:00`, name: 'Гость по звонку', member_type: 'guest' }, login.cookie);
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const cancelled = await call('POST', `/api/admin/bookings/${created.data.booking.id}/cancel`, { reason: 'тест' }, login.cookie);
  assert.equal(cancelled.data.booking.status, 'cancelled');
  assert.equal(cancelled.data.booking.cancelled_by, 'admin1@jas.test');

  const logout = await call('POST', '/api/admin/logout', {}, login.cookie);
  assert.equal(logout.status, 200);
  assert.equal((await call('GET', '/api/admin/overview', undefined, login.cookie)).status, 401);
});

test('настройки: часовой пояс и вместимость', async () => {
  const login = await call('POST', '/api/admin/login', { email: 'admin1@jas.test', password: 'secret-pass' });
  const bad = await call('PUT', '/api/admin/settings', { timezone: 'Mars/Base', maxDurationMin: 45, horizonDays: 0 }, login.cookie);
  assert.equal(bad.status, 400);
  const ok = await call('PUT', '/api/admin/settings', {
    timezone: 'Asia/Almaty', maxDurationMin: 240, horizonDays: 14,
    rooms: [{ id: 'focus', name: 'Focus Room', capacity: 3, description: 'Тихая' }],
  }, login.cookie);
  assert.equal(ok.status, 200);
  assert.equal(ok.data.settings.timezone, 'Asia/Almaty');
  assert.equal(ok.data.rooms.find((r) => r.id === 'focus').capacity, 3);
});

test('время: перевод настенного времени в UTC', () => {
  assert.equal(T.wallToUtc('2026-11-26T14:00', 'Europe/Moscow'), '2026-11-26T11:00:00.000Z');
  assert.equal(T.wallToUtc('2026-11-26T14:00', 'Asia/Almaty'), '2026-11-26T09:00:00.000Z');
  assert.equal(T.addMinutes('2026-12-31T23:30', 60), '2027-01-01T00:30');
  assert.ok(Number.isNaN(T.toMin('2026-02-30T10:00')));
});
