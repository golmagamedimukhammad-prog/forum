'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rooms (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  capacity    INTEGER NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  sort        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS bookings (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code          TEXT NOT NULL UNIQUE,
  token         TEXT NOT NULL,
  room_id       TEXT NOT NULL REFERENCES rooms(id),
  start_at      TEXT NOT NULL,
  end_at        TEXT NOT NULL,
  name          TEXT NOT NULL,
  phone         TEXT NOT NULL DEFAULT '',
  email         TEXT NOT NULL DEFAULT '',
  company       TEXT NOT NULL DEFAULT '',
  member_type   TEXT NOT NULL CHECK (member_type IN ('resident', 'guest')),
  people        INTEGER NOT NULL DEFAULT 1,
  purpose       TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  created_at    TEXT NOT NULL,
  created_by    TEXT NOT NULL DEFAULT 'client',
  cancelled_at  TEXT,
  cancelled_by  TEXT,
  cancel_reason TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_bookings_room_time ON bookings (room_id, status, start_at, end_at);
CREATE INDEX IF NOT EXISTS idx_bookings_time ON bookings (start_at, end_at);

CREATE TABLE IF NOT EXISTS admins (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL DEFAULT '',
  pass_hash     TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  admin_id   INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const DEFAULT_ROOMS = [
  { id: 'focus', name: 'Focus Room', capacity: 4, description: 'Компактная тихая комната для звонков, интервью и работы в фокусе.', sort: 1 },
  { id: 'alfa', name: 'Alfa', capacity: 8, description: 'Большая переговорная на 8 мест для встреч, презентаций и воркшопов.', sort: 2 },
];

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function makeCode(len = 6) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

class ConflictError extends Error {}
class LimitError extends Error {}

function createStore({ dataDir, defaultTimezone }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'jas-booking.sqlite'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);

  const seedRoom = db.prepare('INSERT OR IGNORE INTO rooms (id, name, capacity, description, sort) VALUES (?, ?, ?, ?, ?)');
  for (const r of DEFAULT_ROOMS) seedRoom.run(r.id, r.name, r.capacity, r.description, r.sort);
  const seedSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  seedSetting.run('timezone', defaultTimezone);
  seedSetting.run('max_duration_min', '480');
  seedSetting.run('horizon_days', '30');

  function tx(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  const q = {
    settings: db.prepare('SELECT key, value FROM settings'),
    setSetting: db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
    rooms: db.prepare('SELECT id, name, capacity, description FROM rooms ORDER BY sort, id'),
    room: db.prepare('SELECT id, name, capacity, description FROM rooms WHERE id = ?'),
    updateRoom: db.prepare('UPDATE rooms SET name = ?, capacity = ?, description = ? WHERE id = ?'),
    busy: db.prepare(`SELECT room_id, start_at, end_at FROM bookings
                      WHERE status = 'active' AND start_at < ? AND end_at > ? ORDER BY start_at`),
    conflict: db.prepare(`SELECT id FROM bookings
                          WHERE room_id = ? AND status = 'active' AND start_at < ? AND end_at > ? LIMIT 1`),
    insertBooking: db.prepare(`INSERT INTO bookings
      (code, token, room_id, start_at, end_at, name, phone, email, company, member_type, people, purpose, created_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    bookingById: db.prepare('SELECT * FROM bookings WHERE id = ?'),
    bookingByCode: db.prepare('SELECT * FROM bookings WHERE code = ?'),
    cancelBooking: db.prepare(`UPDATE bookings SET status = 'cancelled', cancelled_at = ?, cancelled_by = ?, cancel_reason = ?
                               WHERE id = ? AND status = 'active'`),
    recentBookings: db.prepare('SELECT * FROM bookings ORDER BY id DESC LIMIT ?'),
    countAdmins: db.prepare('SELECT COUNT(*) AS n FROM admins'),
    adminByEmail: db.prepare('SELECT * FROM admins WHERE email = ?'),
    adminById: db.prepare('SELECT * FROM admins WHERE id = ?'),
    listAdmins: db.prepare('SELECT id, email, name, created_at, last_login_at FROM admins ORDER BY id'),
    insertAdmin: db.prepare('INSERT INTO admins (email, name, pass_hash, created_at) VALUES (?, ?, ?, ?)'),
    deleteAdmin: db.prepare('DELETE FROM admins WHERE id = ?'),
    touchAdmin: db.prepare('UPDATE admins SET last_login_at = ? WHERE id = ?'),
    insertSession: db.prepare('INSERT INTO sessions (token_hash, admin_id, expires_at) VALUES (?, ?, ?)'),
    sessionAdmin: db.prepare(`SELECT a.id, a.email, a.name, a.created_at, a.last_login_at FROM sessions s
                              JOIN admins a ON a.id = s.admin_id WHERE s.token_hash = ? AND s.expires_at > ?`),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    deleteAdminSessions: db.prepare('DELETE FROM sessions WHERE admin_id = ?'),
    purgeSessions: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
  };

  return {
    ConflictError,
    LimitError,

    /* ---------- настройки и комнаты ---------- */
    settings() {
      const s = Object.fromEntries(q.settings.all().map((r) => [r.key, r.value]));
      return {
        timezone: s.timezone,
        maxDurationMin: Number(s.max_duration_min),
        horizonDays: Number(s.horizon_days),
      };
    },
    saveSettings({ timezone, maxDurationMin, horizonDays, rooms }) {
      tx(() => {
        q.setSetting.run('timezone', timezone);
        q.setSetting.run('max_duration_min', String(maxDurationMin));
        q.setSetting.run('horizon_days', String(horizonDays));
        for (const r of rooms || []) q.updateRoom.run(r.name, r.capacity, r.description, r.id);
      });
    },
    rooms: () => q.rooms.all(),
    room: (id) => q.room.get(id),

    /* ---------- бронирования ---------- */
    busy: (fromWall, toWall) => q.busy.all(toWall, fromWall),

    createBooking(b) {
      return tx(() => {
        if (q.conflict.get(b.room_id, b.end_at, b.start_at)) throw new ConflictError('Время уже занято');
        const token = crypto.randomBytes(24).toString('base64url');
        for (let attempt = 0; attempt < 8; attempt++) {
          const code = makeCode();
          if (q.bookingByCode.get(code)) continue;
          const res = q.insertBooking.run(
            code, token, b.room_id, b.start_at, b.end_at, b.name, b.phone, b.email, b.company,
            b.member_type, b.people, b.purpose, new Date().toISOString(), b.created_by || 'client',
          );
          return q.bookingById.get(Number(res.lastInsertRowid));
        }
        throw new Error('Не удалось сгенерировать код брони');
      });
    },
    bookingById: (id) => q.bookingById.get(id),
    bookingByCode: (code) => q.bookingByCode.get(code),
    cancelBooking(id, by, reason = '') {
      q.cancelBooking.run(new Date().toISOString(), by, reason, id);
      return q.bookingById.get(id);
    },
    listBookings({ fromWall, toWall, roomId, status }) {
      const where = ['start_at < ?', 'end_at > ?'];
      const params = [toWall, fromWall];
      if (roomId) { where.push('room_id = ?'); params.push(roomId); }
      if (status && status !== 'all') { where.push('status = ?'); params.push(status); }
      return db.prepare(`SELECT * FROM bookings WHERE ${where.join(' AND ')} ORDER BY start_at, room_id LIMIT 5000`).all(...params);
    },
    recentBookings: (limit = 15) => q.recentBookings.all(limit),

    /* ---------- администраторы ---------- */
    countAdmins: () => q.countAdmins.get().n,
    adminByEmail: (email) => q.adminByEmail.get(email),
    adminById: (id) => q.adminById.get(id),
    listAdmins: () => q.listAdmins.all(),
    createAdmin({ email, name, passHash, maxAdmins }) {
      return tx(() => {
        if (q.countAdmins.get().n >= maxAdmins) throw new LimitError('Достигнут лимит администраторов');
        if (q.adminByEmail.get(email)) throw new ConflictError('Этот email уже зарегистрирован');
        const res = q.insertAdmin.run(email, name, passHash, new Date().toISOString());
        return q.adminById.get(Number(res.lastInsertRowid));
      });
    },
    deleteAdmin(id) {
      tx(() => {
        q.deleteAdminSessions.run(id);
        q.deleteAdmin.run(id);
      });
    },
    touchAdmin: (id) => q.touchAdmin.run(new Date().toISOString(), id),

    /* ---------- сессии ---------- */
    createSession: (tokenHash, adminId, expiresAt) => q.insertSession.run(tokenHash, adminId, expiresAt),
    sessionAdmin: (tokenHash) => q.sessionAdmin.get(tokenHash, Date.now()),
    deleteSession: (tokenHash) => q.deleteSession.run(tokenHash),
    purgeSessions: () => q.purgeSessions.run(Date.now()),

    close: () => db.close(),
  };
}

module.exports = { createStore, ConflictError, LimitError };
