/*
 * Подключение к базе Supabase.
 * Ключ ниже — публичный (publishable): его можно хранить в коде сайта.
 * Доступ к данным защищён на стороне базы: наружу открыты только функции jas_*,
 * а контакты клиентов отдаются лишь администраторам после входа.
 */
window.JAS_CONFIG = {
  supabaseUrl: 'https://dfnnmvrogidhhjpyxcqd.supabase.co',
  supabaseKey: 'sb_publishable_-60QjIPl8ZmjLgb2-8jKIA__jWVXHp0',
};
