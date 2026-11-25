-- =====================================================================
-- JAS Coworking — бронирование переговорных Focus Room и Alfa
-- База Supabase (Postgres). Таблицы лежат в закрытой схеме `jas`,
-- наружу (через REST API Supabase) открыты только функции public.jas_*.
-- Время брони хранится как «настенное» время коворкинга (timestamp без пояса).
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;
create extension if not exists btree_gist with schema extensions;

create schema if not exists jas;
revoke all on schema jas from public, anon, authenticated;

-- ---------------------------------------------------------------- таблицы

create table jas.rooms (
  id          text primary key,
  name        text not null,
  capacity    int  not null check (capacity between 1 and 100),
  description text not null default '',
  sort        int  not null default 0
);

create table jas.settings (
  key   text primary key,
  value text not null
);

create table jas.bookings (
  id            bigint generated always as identity primary key,
  code          text not null unique,
  token         text not null,
  room_id       text not null references jas.rooms (id),
  start_at      timestamp not null,
  end_at        timestamp not null,
  name          text not null,
  phone         text not null default '',
  email         text not null default '',
  company       text not null default '',
  member_type   text not null check (member_type in ('resident', 'guest')),
  people        int  not null default 1,
  purpose       text not null default '',
  status        text not null default 'active' check (status in ('active', 'cancelled')),
  created_at    timestamptz not null default now(),
  created_by    text not null default 'client',
  cancelled_at  timestamptz,
  cancelled_by  text,
  cancel_reason text not null default '',
  check (end_at > start_at),
  -- двойная бронь невозможна даже при одновременных запросах
  constraint bookings_no_overlap exclude using gist (
    room_id extensions.gist_text_ops with =,
    tsrange(start_at, end_at, '[)') with &&
  ) where (status = 'active')
);
create index bookings_time_idx on jas.bookings (start_at, end_at);
create index bookings_created_idx on jas.bookings (created_at);

create table jas.admins (
  id            bigint generated always as identity primary key,
  email         text not null unique,
  name          text not null default '',
  pass_hash     text not null,
  created_at    timestamptz not null default now(),
  last_login_at timestamptz
);

create table jas.sessions (
  token_hash text primary key,
  admin_id   bigint not null references jas.admins (id) on delete cascade,
  expires_at timestamptz not null
);

create table jas.attempts (
  kind text not null,
  key  text not null,
  at   timestamptz not null default now()
);
create index attempts_idx on jas.attempts (kind, key, at);

-- ---------------------------------------------------------------- служебные функции

create function jas.random_code(len int) returns text
language sql volatile set search_path = '' as $$
  select string_agg(substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789', (get_byte(s.b, i) % 31) + 1, 1), '' order by i)
  from (select extensions.gen_random_bytes(len) as b) s, generate_series(0, len - 1) as i
$$;

create function jas.setting(k text) returns text
language sql stable set search_path = '' as $$
  select value from jas.settings where key = k
$$;

create function jas.tz() returns text
language sql stable set search_path = '' as $$
  select coalesce(jas.setting('timezone'), 'Europe/Moscow')
$$;

create function jas.now_wall() returns timestamp
language sql stable set search_path = '' as $$
  select date_trunc('minute', now() at time zone jas.tz())
$$;

create function jas.w(ts timestamp) returns text
language sql immutable set search_path = '' as $$
  select to_char(ts, 'YYYY-MM-DD"T"HH24:MI')
$$;

create function jas.utc(ts timestamp) returns text
language sql stable set search_path = '' as $$
  select to_char((ts at time zone jas.tz()) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS".000Z"')
$$;

create function jas.iso(t timestamptz) returns text
language sql immutable set search_path = '' as $$
  select case when t is null then null else to_char(t at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end
$$;

create function jas.parse_wall(s text) returns timestamp
language plpgsql stable set search_path = '' as $$
declare t timestamp;
begin
  if s is null or s !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$' then return null; end if;
  begin
    t := s::timestamp;
  exception when others then
    return null;
  end;
  if jas.w(t) <> s then return null; end if;
  return t;
end $$;

create function jas.parse_date(s text) returns date
language plpgsql stable set search_path = '' as $$
declare d date;
begin
  if s is null or s !~ '^\d{4}-\d{2}-\d{2}$' then return null; end if;
  begin
    d := s::date;
  exception when others then
    return null;
  end;
  if to_char(d, 'YYYY-MM-DD') <> s then return null; end if;
  return d;
end $$;

create function jas.norm_code(s text) returns text
language sql immutable set search_path = '' as $$
  select regexp_replace(regexp_replace(upper(coalesce(s, '')), '^JAS[-\s]?', ''), '[^A-Z0-9]', '', 'g')
$$;

create function jas.digits(s text) returns text
language sql immutable set search_path = '' as $$
  select regexp_replace(coalesce(s, ''), '\D', '', 'g')
$$;

create function jas.phones_match(a text, b text) returns boolean
language sql immutable set search_path = '' as $$
  select length(jas.digits(a)) >= 7 and length(jas.digits(b)) >= 7 and right(jas.digits(a), 10) = right(jas.digits(b), 10)
$$;

create function jas.clean(s text, max_len int) returns text
language sql immutable set search_path = '' as $$
  select left(regexp_replace(btrim(coalesce(s, '')), '\s+', ' ', 'g'), max_len)
$$;

create function jas.client_ip() returns text
language plpgsql stable set search_path = '' as $$
declare h json;
begin
  begin
    h := current_setting('request.headers', true)::json;
  exception when others then
    return 'unknown';
  end;
  return coalesce(
    nullif(btrim(split_part(h ->> 'x-forwarded-for', ',', 1)), ''),
    h ->> 'cf-connecting-ip', h ->> 'x-real-ip', 'unknown');
end $$;

-- Ошибка с HTTP-статусом: PostgREST превращает SQLSTATE 'PT409' в ответ 409.
create function jas.fail(status int, msg text, errors jsonb default null) returns void
language plpgsql set search_path = '' as $$
begin
  raise exception using errcode = 'PT' || status::text, message = msg, detail = coalesce(errors::text, '');
end $$;

-- «Мягкая» ошибка: транзакция не откатывается (нужно, чтобы засчитать неудачную попытку).
create function jas.soft_err(status int, msg text, errors jsonb default null) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object('_status', status, '_error', msg, 'errors', errors)
$$;

create function jas.too_many(k text, kk text, lim int, win interval) returns boolean
language sql stable set search_path = '' as $$
  select count(*) >= lim from jas.attempts where kind = k and key = kk and at > now() - win
$$;

create function jas.note(k text, kk text) returns void
language sql volatile set search_path = '' as $$
  delete from jas.attempts where at < now() - interval '1 day';
  insert into jas.attempts (kind, key) values (k, kk);
$$;

-- ---------------------------------------------------------------- представления в JSON

create function jas.room_name(rid text) returns text
language sql stable set search_path = '' as $$
  select coalesce((select name from jas.rooms where id = rid), rid)
$$;

create function jas.rooms_json() returns jsonb
language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'capacity', capacity, 'description', description) order by sort, id), '[]'::jsonb)
  from jas.rooms
$$;

create function jas.settings_json() returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'timezone', jas.tz(),
    'maxDurationMin', jas.setting('max_duration_min')::int,
    'horizonDays', jas.setting('horizon_days')::int)
$$;

create function jas.pub(b jas.bookings) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'code', b.code, 'room_id', b.room_id, 'room_name', jas.room_name(b.room_id),
    'start', jas.w(b.start_at), 'end', jas.w(b.end_at),
    'start_utc', jas.utc(b.start_at), 'end_utc', jas.utc(b.end_at),
    'name', b.name, 'member_type', b.member_type, 'people', b.people, 'status', b.status)
$$;

create function jas.adm(b jas.bookings) returns jsonb
language sql stable set search_path = '' as $$
  select jas.pub(b) || jsonb_build_object(
    'id', b.id, 'phone', b.phone, 'email', b.email, 'company', b.company, 'purpose', b.purpose,
    'created_at', jas.iso(b.created_at), 'created_by', b.created_by,
    'cancelled_at', jas.iso(b.cancelled_at), 'cancelled_by', b.cancelled_by, 'cancel_reason', b.cancel_reason)
$$;

create function jas.admin_json(a jas.admins) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('id', a.id, 'email', a.email, 'name', a.name,
    'created_at', jas.iso(a.created_at), 'last_login_at', jas.iso(a.last_login_at))
$$;

-- ---------------------------------------------------------------- сессии администратора

create function jas.try_me(p jsonb) returns jas.admins
language sql stable set search_path = '' as $$
  select a.* from jas.sessions s join jas.admins a on a.id = s.admin_id
  where s.token_hash = encode(extensions.digest(coalesce(p ->> 'token', ''), 'sha256'), 'hex')
    and s.expires_at > now()
$$;

create function jas.me(p jsonb) returns jas.admins
language plpgsql stable set search_path = '' as $$
declare a jas.admins;
begin
  a := jas.try_me(p);
  if a.id is null then perform jas.fail(401, 'Требуется вход администратора'); end if;
  return a;
end $$;

create function jas.start_session(a jas.admins) returns jsonb
language plpgsql volatile set search_path = '' as $$
declare tok text := encode(extensions.gen_random_bytes(32), 'hex');
begin
  delete from jas.sessions where expires_at <= now();
  insert into jas.sessions (token_hash, admin_id, expires_at)
  values (encode(extensions.digest(tok, 'sha256'), 'hex'), a.id, now() + interval '14 days');
  update jas.admins set last_login_at = now() where id = a.id returning * into a;
  return jsonb_build_object('me', jas.admin_json(a), 'token', tok);
end $$;

create function jas.admins_payload() returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'maxAdmins', 3,
    'inviteCode', jas.setting('invite_code'),
    'admins', coalesce((select jsonb_agg(jas.admin_json(a) order by a.id) from jas.admins a), '[]'::jsonb))
$$;

-- ---------------------------------------------------------------- проверка и создание брони

create function jas.check_booking(p jsonb, is_admin boolean) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  errs     jsonb := '{}'::jsonb;
  r        jas.rooms;
  s        timestamp := jas.parse_wall(p ->> 'start');
  e        timestamp := jas.parse_wall(p ->> 'end');
  now_w    timestamp := jas.now_wall();
  max_dur  int := case when is_admin then 1440 else jas.setting('max_duration_min')::int end;
  horizon  int := jas.setting('horizon_days')::int;
  dur      int;
  nm       text := jas.clean(p ->> 'name', 80);
  ph       text := jas.clean(p ->> 'phone', 32);
  ph_len   int  := length(jas.digits(p ->> 'phone'));
  em       text := lower(jas.clean(p ->> 'email', 120));
  mt       text := p ->> 'member_type';
  ppl      int;
begin
  select * into r from jas.rooms where id = p ->> 'room_id';
  if r.id is null then errs := errs || jsonb_build_object('room_id', 'Выберите комнату'); end if;

  if s is null or e is null or extract(minute from s)::int % 30 <> 0 or extract(minute from e)::int % 30 <> 0 then
    errs := errs || jsonb_build_object('time', 'Выберите время с шагом 30 минут');
  else
    dur := (extract(epoch from (e - s)) / 60)::int;
    if dur < 30 then
      errs := errs || jsonb_build_object('time', 'Минимальная длительность — 30 минут');
    elsif dur > max_dur then
      errs := errs || jsonb_build_object('time', format('Максимальная длительность брони — %s ч', trim_scale(max_dur / 60.0)));
    elsif s < date_bin('30 minutes', now_w, timestamp '2000-01-01') then
      errs := errs || jsonb_build_object('time', 'Нельзя забронировать время в прошлом');
    elsif not is_admin and s::date > now_w::date + horizon then
      errs := errs || jsonb_build_object('time', format('Бронировать можно не дальше чем на %s дн. вперёд', horizon));
    end if;
  end if;

  if length(nm) < 2 then errs := errs || jsonb_build_object('name', 'Укажите имя'); end if;
  if (not is_admin or ph <> '') and (ph_len < 7 or ph_len > 15) then
    errs := errs || jsonb_build_object('phone', 'Укажите телефон');
  end if;
  if em <> '' and em !~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$' then errs := errs || jsonb_build_object('email', 'Проверьте email'); end if;
  if mt is null or mt not in ('resident', 'guest') then
    errs := errs || jsonb_build_object('member_type', 'Выберите: резидент или гость');
  end if;

  ppl := case when coalesce(p ->> 'people', '') ~ '^\d{1,3}$' then (p ->> 'people')::int else 1 end;
  if ppl < 1 then ppl := 1; end if;
  if r.id is not null and ppl > r.capacity then
    errs := errs || jsonb_build_object('people', format('В «%s» максимум %s чел.', r.name, r.capacity));
  end if;

  if errs <> '{}'::jsonb then perform jas.fail(400, 'Проверьте данные формы', errs); end if;

  return jsonb_build_object(
    'room_id', r.id, 'start', jas.w(s), 'end', jas.w(e), 'name', nm, 'phone', ph, 'email', em,
    'company', jas.clean(p ->> 'company', 100), 'member_type', mt, 'people', ppl,
    'purpose', left(btrim(coalesce(p ->> 'purpose', '')), 300));
end $$;

create function jas.insert_booking(d jsonb, by_whom text, conflict_msg text) returns jas.bookings
language plpgsql volatile set search_path = '' as $$
declare b jas.bookings;
begin
  for i in 1..8 loop
    begin
      insert into jas.bookings (code, token, room_id, start_at, end_at, name, phone, email, company, member_type, people, purpose, created_by)
      values (jas.random_code(6), encode(extensions.gen_random_bytes(24), 'hex'), d ->> 'room_id',
              (d ->> 'start')::timestamp, (d ->> 'end')::timestamp, d ->> 'name', d ->> 'phone', d ->> 'email',
              d ->> 'company', d ->> 'member_type', (d ->> 'people')::int, d ->> 'purpose', by_whom)
      returning * into b;
      return b;
    exception
      when exclusion_violation then
        perform jas.fail(409, conflict_msg);
      when unique_violation then
        null; -- совпал код брони — пробуем другой
    end;
  end loop;
  perform jas.fail(500, 'Не удалось создать бронь, попробуйте ещё раз');
  return b;
end $$;

-- =====================================================================
-- ПУБЛИЧНЫЕ ФУНКЦИИ (вызываются со страницы бронирования)
-- =====================================================================

create function public.jas_config(p jsonb default '{}'::jsonb) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'timezone', jas.tz(),
    'now', jas.w(jas.now_wall()),
    'today', to_char(jas.now_wall(), 'YYYY-MM-DD'),
    'slotMinutes', 30,
    'maxDurationMin', jas.setting('max_duration_min')::int,
    'horizonDays', jas.setting('horizon_days')::int,
    'rooms', jas.rooms_json())
$$;

create function public.jas_availability(p jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  today   date := jas.now_wall()::date;
  horizon int  := jas.setting('horizon_days')::int;
  f date;
  t date;
begin
  f := coalesce(jas.parse_date(p ->> 'from'), today);
  t := coalesce(jas.parse_date(p ->> 'to'), f);
  if t < f then t := f; end if;
  if t - f > horizon + 2 then t := f + horizon + 2; end if;
  return jsonb_build_object(
    'now', jas.w(jas.now_wall()),
    'from', to_char(f, 'YYYY-MM-DD'),
    'to', to_char(t, 'YYYY-MM-DD'),
    'busy', coalesce((
      select jsonb_agg(jsonb_build_object('room_id', room_id, 'start', jas.w(start_at), 'end', jas.w(end_at)) order by start_at)
      from jas.bookings
      where status = 'active' and start_at < (t + 1)::timestamp and end_at > f::timestamp), '[]'::jsonb));
end $$;

create function public.jas_create_booking(p jsonb default '{}'::jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare d jsonb; b jas.bookings;
begin
  d := jas.check_booking(p, false);
  if (select count(*) from jas.bookings
      where jas.digits(phone) = jas.digits(d ->> 'phone') and created_at > now() - interval '1 day') >= 20 then
    perform jas.fail(429, 'Слишком много броней с этого номера за сутки. Свяжитесь с администратором.');
  end if;
  b := jas.insert_booking(d, 'client', 'Это время уже кто-то забронировал. Выберите другое.');
  return jsonb_build_object('booking', jas.pub(b), 'token', b.token);
end $$;

create function public.jas_my_bookings(p jsonb default '{}'::jsonb) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'now', jas.w(jas.now_wall()),
    'bookings', coalesce(jsonb_agg(jas.pub(b)), '[]'::jsonb))
  from jas.bookings b
  join (
    select jas.norm_code(x ->> 'code') as code, x ->> 'token' as token
    from jsonb_array_elements(case when jsonb_typeof(p -> 'items') = 'array' then p -> 'items' else '[]'::jsonb end)
         with ordinality as e(x, n)
    where n <= 60
  ) i on i.code = b.code and i.token = b.token
$$;

create function public.jas_lookup_booking(p jsonb default '{}'::jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare b jas.bookings;
begin
  if jas.too_many('lookup', jas.client_ip(), 30, interval '15 minutes') then
    return jas.soft_err(429, 'Слишком много попыток. Попробуйте через 15 минут.');
  end if;
  select * into b from jas.bookings where code = jas.norm_code(p ->> 'code');
  if b.id is null or not jas.phones_match(b.phone, p ->> 'phone') then
    perform jas.note('lookup', jas.client_ip());
    return jas.soft_err(404, 'Бронь не найдена. Проверьте код и телефон.');
  end if;
  return jsonb_build_object('booking', jas.pub(b), 'token', b.token);
end $$;

create function public.jas_cancel_booking(p jsonb default '{}'::jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare b jas.bookings;
begin
  if jas.too_many('lookup', jas.client_ip(), 30, interval '15 minutes') then
    return jas.soft_err(429, 'Слишком много попыток. Попробуйте через 15 минут.');
  end if;
  select * into b from jas.bookings where code = jas.norm_code(p ->> 'code');
  if b.id is null or not (
       (coalesce(p ->> 'token', '') <> '' and b.token = p ->> 'token')
       or jas.phones_match(b.phone, p ->> 'phone')) then
    perform jas.note('lookup', jas.client_ip());
    return jas.soft_err(404, 'Бронь не найдена');
  end if;
  if b.status <> 'active' then perform jas.fail(409, 'Бронь уже отменена'); end if;
  if b.end_at <= jas.now_wall() then perform jas.fail(409, 'Бронь уже завершилась'); end if;
  update jas.bookings set status = 'cancelled', cancelled_at = now(), cancelled_by = 'client'
  where id = b.id returning * into b;
  return jsonb_build_object('booking', jas.pub(b));
end $$;

-- =====================================================================
-- КАБИНЕТ АДМИНИСТРАТОРА
-- =====================================================================

create function public.jas_admin_status(p jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare a jas.admins; n int;
begin
  a := jas.try_me(p);
  select count(*) into n from jas.admins;
  return jsonb_build_object(
    'maxAdmins', 3, 'adminsCount', n, 'registrationOpen', n < 3, 'inviteRequired', true,
    'me', case when a.id is null then null else jas.admin_json(a) end);
end $$;

create function public.jas_admin_register(p jsonb default '{}'::jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  em   text := lower(jas.clean(p ->> 'email', 120));
  nm   text := jas.clean(p ->> 'name', 80);
  pw   text := coalesce(p ->> 'password', '');
  errs jsonb := '{}'::jsonb;
  a    jas.admins;
begin
  if jas.too_many('register', jas.client_ip(), 10, interval '1 hour') then
    return jas.soft_err(429, 'Слишком много попыток. Попробуйте через час.');
  end if;
  if em !~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$' then errs := errs || jsonb_build_object('email', 'Укажите корректный email'); end if;
  if length(pw) < 8 then errs := errs || jsonb_build_object('password', 'Минимум 8 символов');
  elsif length(pw) > 200 then errs := errs || jsonb_build_object('password', 'Слишком длинный пароль');
  end if;
  if errs <> '{}'::jsonb then perform jas.fail(400, 'Проверьте данные', errs); end if;

  lock table jas.admins in share row exclusive mode; -- не даём превысить лимит при одновременной регистрации
  if (select count(*) from jas.admins) >= 3 then
    perform jas.fail(403, 'Регистрация закрыта: уже зарегистрировано 3 администратора');
  end if;
  if jas.norm_code(p ->> 'invite') <> jas.norm_code(jas.setting('invite_code')) then
    perform jas.note('register', jas.client_ip());
    return jas.soft_err(403, 'Неверный код приглашения', jsonb_build_object('invite', 'Неверный код приглашения'));
  end if;
  if exists (select 1 from jas.admins where email = em) then
    perform jas.fail(409, 'Этот email уже зарегистрирован — войдите');
  end if;

  insert into jas.admins (email, name, pass_hash)
  values (em, nm, extensions.crypt(pw, extensions.gen_salt('bf', 10)))
  returning * into a;
  return jas.start_session(a);
end $$;

create function public.jas_admin_login(p jsonb default '{}'::jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare em text := lower(jas.clean(p ->> 'email', 120)); a jas.admins;
begin
  if jas.too_many('login', em, 10, interval '15 minutes') then
    return jas.soft_err(429, 'Слишком много попыток входа. Попробуйте через 15 минут.');
  end if;
  select * into a from jas.admins where email = em;
  if a.id is null or a.pass_hash <> extensions.crypt(left(coalesce(p ->> 'password', ''), 200), a.pass_hash) then
    perform jas.note('login', em);
    return jas.soft_err(401, 'Неверный email или пароль');
  end if;
  delete from jas.attempts where kind = 'login' and key = em;
  return jas.start_session(a);
end $$;

create function public.jas_admin_logout(p jsonb default '{}'::jsonb) returns jsonb
language sql volatile security definer set search_path = '' as $$
  delete from jas.sessions where token_hash = encode(extensions.digest(coalesce(p ->> 'token', ''), 'sha256'), 'hex');
  select jsonb_build_object('ok', true);
$$;

create function public.jas_admin_overview(p jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare a jas.admins := jas.me(p);
begin
  return jsonb_build_object(
    'me', jas.admin_json(a),
    'settings', jas.settings_json(),
    'rooms', jas.rooms_json(),
    'now', jas.w(jas.now_wall()),
    'today', to_char(jas.now_wall(), 'YYYY-MM-DD'),
    'maxAdmins', 3,
    'adminsCount', (select count(*) from jas.admins));
end $$;

create function public.jas_admin_bookings(p jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  a  jas.admins := jas.me(p);
  f  date := coalesce(jas.parse_date(p ->> 'from'), jas.now_wall()::date);
  t  date := coalesce(jas.parse_date(p ->> 'to'), f);
  st text := case when p ->> 'status' in ('active', 'cancelled') then p ->> 'status' else 'all' end;
  rm text := nullif(p ->> 'room', '');
begin
  if t < f then t := f; end if;
  if t - f > 400 then t := f + 400; end if;
  return jsonb_build_object(
    'from', to_char(f, 'YYYY-MM-DD'),
    'to', to_char(t, 'YYYY-MM-DD'),
    'now', jas.w(jas.now_wall()),
    'bookings', coalesce((
      select jsonb_agg(jas.adm(b) order by b.start_at, b.room_id)
      from jas.bookings b
      where b.start_at < (t + 1)::timestamp and b.end_at > f::timestamp
        and (st = 'all' or b.status = st)
        and (rm is null or b.room_id = rm)), '[]'::jsonb));
end $$;

create function public.jas_admin_recent(p jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare a jas.admins := jas.me(p);
begin
  return jsonb_build_object('bookings', coalesce((
    select jsonb_agg(jas.adm(b) order by b.id desc)
    from jas.bookings b
    where b.id in (select id from jas.bookings order by id desc limit 15)), '[]'::jsonb));
end $$;

create function public.jas_admin_create_booking(p jsonb default '{}'::jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare a jas.admins := jas.me(p); d jsonb; b jas.bookings;
begin
  d := jas.check_booking(p, true);
  b := jas.insert_booking(d, a.email, 'В это время комната уже занята');
  return jsonb_build_object('booking', jas.adm(b));
end $$;

create function public.jas_admin_cancel_booking(p jsonb default '{}'::jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare a jas.admins := jas.me(p); b jas.bookings;
begin
  if coalesce(p ->> 'id', '') !~ '^\d{1,18}$' then perform jas.fail(404, 'Бронь не найдена'); end if;
  select * into b from jas.bookings where id = (p ->> 'id')::bigint;
  if b.id is null then perform jas.fail(404, 'Бронь не найдена'); end if;
  if b.status <> 'active' then perform jas.fail(409, 'Бронь уже отменена'); end if;
  update jas.bookings
  set status = 'cancelled', cancelled_at = now(), cancelled_by = a.email,
      cancel_reason = left(btrim(coalesce(p ->> 'reason', '')), 200)
  where id = b.id returning * into b;
  return jsonb_build_object('booking', jas.adm(b));
end $$;

create function public.jas_admin_admins(p jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare a jas.admins := jas.me(p);
begin
  return jas.admins_payload();
end $$;

create function public.jas_admin_remove_admin(p jsonb default '{}'::jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare a jas.admins := jas.me(p); target bigint;
begin
  if coalesce(p ->> 'id', '') !~ '^\d{1,18}$' then perform jas.fail(404, 'Администратор не найден'); end if;
  target := (p ->> 'id')::bigint;
  if target = a.id then perform jas.fail(400, 'Нельзя удалить самого себя'); end if;
  if not exists (select 1 from jas.admins where id = target) then perform jas.fail(404, 'Администратор не найден'); end if;
  delete from jas.admins where id = target;
  return jas.admins_payload();
end $$;

create function public.jas_admin_new_invite(p jsonb default '{}'::jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare a jas.admins := jas.me(p);
begin
  update jas.settings set value = jas.random_code(4) || '-' || jas.random_code(4) where key = 'invite_code';
  return jas.admins_payload();
end $$;

create function public.jas_admin_save_settings(p jsonb default '{}'::jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  a    jas.admins := jas.me(p);
  errs jsonb := '{}'::jsonb;
  tz   text := jas.clean(p ->> 'timezone', 64);
  maxd text := coalesce(p ->> 'maxDurationMin', '');
  hor  text := coalesce(p ->> 'horizonDays', '');
  r    jsonb;
  rid  text;
  cap  text;
begin
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = tz) then
    errs := errs || jsonb_build_object('timezone', 'Неизвестный часовой пояс');
  end if;
  if maxd !~ '^\d{1,4}$' or maxd::int < 30 or maxd::int > 1440 or maxd::int % 30 <> 0 then
    errs := errs || jsonb_build_object('maxDurationMin', 'От 30 минут до 24 часов, шаг 30 минут');
  end if;
  if hor !~ '^\d{1,3}$' or hor::int < 1 or hor::int > 365 then
    errs := errs || jsonb_build_object('horizonDays', 'От 1 до 365 дней');
  end if;
  for r in select * from jsonb_array_elements(case when jsonb_typeof(p -> 'rooms') = 'array' then p -> 'rooms' else '[]'::jsonb end) loop
    rid := r ->> 'id';
    continue when not exists (select 1 from jas.rooms where id = rid);
    cap := coalesce(r ->> 'capacity', '');
    if jas.clean(r ->> 'name', 40) = '' then errs := errs || jsonb_build_object('room_' || rid || '_name', 'Укажите название'); end if;
    if cap !~ '^\d{1,3}$' or cap::int < 1 or cap::int > 100 then
      errs := errs || jsonb_build_object('room_' || rid || '_capacity', 'От 1 до 100');
    end if;
  end loop;
  if errs <> '{}'::jsonb then perform jas.fail(400, 'Проверьте настройки', errs); end if;

  update jas.settings set value = tz where key = 'timezone';
  update jas.settings set value = maxd where key = 'max_duration_min';
  update jas.settings set value = hor where key = 'horizon_days';
  for r in select * from jsonb_array_elements(case when jsonb_typeof(p -> 'rooms') = 'array' then p -> 'rooms' else '[]'::jsonb end) loop
    update jas.rooms
    set name = jas.clean(r ->> 'name', 40), capacity = (r ->> 'capacity')::int, description = jas.clean(r ->> 'description', 200)
    where id = r ->> 'id';
  end loop;
  return jsonb_build_object('settings', jas.settings_json(), 'rooms', jas.rooms_json());
end $$;

-- ---------------------------------------------------------------- права

revoke all on all tables in schema jas from public, anon, authenticated;
revoke all on all functions in schema jas from public, anon, authenticated;

do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'jas\_%'
  loop
    execute format('revoke all on function %s from public', f.sig);
    execute format('grant execute on function %s to anon, authenticated', f.sig);
  end loop;
end $$;

-- ---------------------------------------------------------------- начальные данные

insert into jas.rooms (id, name, capacity, description, sort) values
  ('focus', 'Focus Room', 4, 'Компактная тихая комната для звонков, интервью и работы в фокусе.', 1),
  ('alfa',  'Alfa',       8, 'Большая переговорная на 8 мест для встреч, презентаций и воркшопов.', 2);

insert into jas.settings (key, value) values
  ('timezone', 'Europe/Moscow'),
  ('max_duration_min', '480'),
  ('horizon_days', '30'),
  ('invite_code', jas.random_code(4) || '-' || jas.random_code(4));
