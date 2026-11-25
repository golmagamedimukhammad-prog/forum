'use strict';

/*
 * Время в системе хранится как «настенное» время коворкинга без часового пояса:
 * строка вида "2026-11-26T14:30". Такие строки сортируются лексикографически,
 * поэтому проверка пересечений — обычное сравнение строк.
 */

const SLOT_MIN = 30;
const WALL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const pad = (n) => String(n).padStart(2, '0');

function fromMin(min) {
  const d = new Date(min * 60000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

function toMin(wall) {
  if (typeof wall !== 'string') return NaN;
  const m = WALL_RE.exec(wall);
  if (!m) return NaN;
  const min = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 60000;
  return fromMin(min) === wall ? min : NaN;
}

const isWall = (s) => !Number.isNaN(toMin(s));
const isDate = (s) => typeof s === 'string' && DATE_RE.test(s) && isWall(`${s}T00:00`);
const addMinutes = (wall, n) => fromMin(toMin(wall) + n);
const addDays = (date, n) => fromMin(toMin(`${date}T00:00`) + n * 1440).slice(0, 10);
const diffMinutes = (a, b) => toMin(b) - toMin(a);
const isSlotAligned = (wall) => toMin(wall) % SLOT_MIN === 0;

function isTimeZone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const fmtCache = new Map();
/** Текущее настенное время в часовом поясе tz. */
function wallAt(tz, date = new Date()) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
    fmtCache.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  const h = p.hour === '24' ? '00' : p.hour;
  return `${p.year}-${p.month}-${p.day}T${h}:${p.minute}`;
}

function floorSlot(wall) {
  const m = toMin(wall);
  return fromMin(m - (((m % SLOT_MIN) + SLOT_MIN) % SLOT_MIN));
}

/** Настенное время коворкинга → ISO-время в UTC (для календаря .ics). */
function wallToUtc(wall, tz) {
  const guess = toMin(wall) * 60000;
  const offsetAt = (ms) => toMin(wallAt(tz, new Date(ms))) - Math.floor(ms / 60000);
  const off1 = offsetAt(guess);
  let utc = guess - off1 * 60000;
  const off2 = offsetAt(utc);
  if (off2 !== off1) utc = guess - off2 * 60000;
  return new Date(utc).toISOString();
}

module.exports = {
  SLOT_MIN, toMin, fromMin, isWall, isDate, addMinutes, addDays, diffMinutes,
  isSlotAligned, isTimeZone, wallAt, floorSlot, wallToUtc,
};
