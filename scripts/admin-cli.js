'use strict';

/*
 * Управление администраторами из консоли сервера (например, если забыли пароль).
 *   npm run admin -- list
 *   npm run admin -- remove admin@example.com
 */

const path = require('node:path');
const { createStore } = require('../lib/store');

const [cmd, arg] = process.argv.slice(2);
const store = createStore({
  dataDir: process.env.DATA_DIR || path.join(__dirname, '..', 'data'),
  defaultTimezone: process.env.TIMEZONE || 'Europe/Moscow',
});

try {
  if (cmd === 'list') {
    const admins = store.listAdmins();
    if (!admins.length) console.log('Администраторов пока нет — регистрация открыта.');
    for (const a of admins) console.log(`${a.id}\t${a.email}\t${a.name || '—'}\tсоздан ${a.created_at}`);
    console.log(`Всего: ${admins.length} из 3`);
  } else if (cmd === 'remove' && arg) {
    const a = store.adminByEmail(arg.trim().toLowerCase());
    if (!a) {
      console.error(`Администратор ${arg} не найден`);
      process.exitCode = 1;
    } else {
      store.deleteAdmin(a.id);
      console.log(`Удалён ${a.email}. Место освобождено — можно зарегистрироваться заново на /admin.`);
    }
  } else {
    console.log('Использование:\n  npm run admin -- list\n  npm run admin -- remove <email>');
  }
} finally {
  store.close();
}
