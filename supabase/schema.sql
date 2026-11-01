-- =====================================================================
-- Play Padel – foglalási adatbázis (Supabase / PostgreSQL)
--
-- Futtatás: Supabase Dashboard → SQL Editor → New query → ezt a fájlt
-- bemásolni → Run. Többször is lefuttatható (idempotens).
--
-- Biztonsági modell:
--   * A bookings táblát a böngésző NEM tudja közvetlenül olvasni/írni
--     (RLS bekapcsolva, policy nincs) – így a nevek és telefonszámok
--     nem szivárognak ki.
--   * A weboldal csak két függvényt hívhat:
--       get_busy_slots(dátum)  → csak pálya + kezdés/vége (személyes adat nélkül)
--       create_booking(...)    → ellenőrzött foglalás létrehozása
--   * Az ütközést maga az adatbázis zárja ki (EXCLUDE megkötés): egy
--     pályára egy időben akkor sem kerülhet két foglalás, ha két ember
--     ugyanabban a pillanatban kattint.
-- =====================================================================

create extension if not exists btree_gist;

create table if not exists public.bookings (
  id          bigint generated always as identity primary key,
  court       text        not null check (court in ('piros', 'zold', 'lila')),
  start_at    timestamptz not null,
  end_at      timestamptz not null,
  name        text        not null check (char_length(name) between 2 and 80),
  phone       text        not null check (phone ~ '^\+?[0-9 ()/-]{7,20}$'),
  status      text        not null default 'confirmed' check (status in ('confirmed', 'cancelled')),
  created_at  timestamptz not null default now(),
  constraint bookings_time_order check (end_at > start_at),
  -- Egy pályán ne lehessen két, időben átfedő érvényes foglalás.
  constraint bookings_no_overlap exclude using gist (
    court with =,
    tstzrange(start_at, end_at, '[)') with &&
  ) where (status = 'confirmed')
);

create index if not exists bookings_start_idx on public.bookings (start_at);

alter table public.bookings enable row level security;
revoke all on public.bookings from anon, authenticated;


-- ---------------------------------------------------------------------
-- Foglaltság egy adott napra (budapesti idő szerint).
-- Csak pályát és időpontot ad vissza, személyes adatot nem.
-- ---------------------------------------------------------------------
create or replace function public.get_busy_slots(p_date date)
returns table (court text, start_time time, end_time time)
language sql
stable
security definer
set search_path = ''
as $$
  select b.court,
         (b.start_at at time zone 'Europe/Budapest')::time,
         (b.end_at   at time zone 'Europe/Budapest')::time
  from public.bookings b
  where b.status = 'confirmed'
    and b.start_at < ((p_date + 1)::timestamp at time zone 'Europe/Budapest')
    and b.end_at   > ( p_date::timestamp      at time zone 'Europe/Budapest')
  order by 1, 2;
$$;


-- ---------------------------------------------------------------------
-- Foglalás létrehozása ellenőrzésekkel.
-- Hibakódok (a PostgREST HTTP státuszként adja vissza):
--   PT400 → 400 hibás adat,  PT409 → 409 az időpont már foglalt
-- ---------------------------------------------------------------------
create or replace function public.create_booking(
  p_court   text,
  p_date    date,
  p_start   time,
  p_minutes int,
  p_name    text,
  p_phone   text
)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_open_min  int := case when extract(isodow from p_date) in (6, 7) then 8 * 60 else 7 * 60 end;
  v_close_min int := 22 * 60;
  v_start_min int := extract(hour from p_start)::int * 60 + extract(minute from p_start)::int;
  v_start     timestamptz := (p_date + p_start) at time zone 'Europe/Budapest';
  v_end       timestamptz := v_start + make_interval(mins => p_minutes);
  v_name      text := btrim(p_name);
  v_phone     text := btrim(p_phone);
  v_digits    text := regexp_replace(btrim(p_phone), '[^0-9]', '', 'g');
  v_id        bigint;
begin
  if p_court is null or p_court not in ('piros', 'zold', 'lila') then
    raise exception 'Ismeretlen pálya.' using errcode = 'PT400';
  end if;

  if p_minutes is null or p_minutes not in (60, 90, 120) then
    raise exception 'Az időtartam 1, 1,5 vagy 2 óra lehet.' using errcode = 'PT400';
  end if;

  if extract(minute from p_start)::int not in (0, 30) or extract(second from p_start) <> 0 then
    raise exception 'Foglalni csak egész vagy fél órától lehet.' using errcode = 'PT400';
  end if;

  if v_start_min < v_open_min or v_start_min + p_minutes > v_close_min then
    raise exception 'A foglalás a nyitvatartási időn kívülre esik.' using errcode = 'PT400';
  end if;

  if v_start <= now() then
    raise exception 'Múltbeli időpontra nem lehet foglalni.' using errcode = 'PT400';
  end if;

  if p_date > (now() at time zone 'Europe/Budapest')::date + 60 then
    raise exception 'Legfeljebb 60 nappal előre lehet foglalni.' using errcode = 'PT400';
  end if;

  -- Egyszerű visszaélés elleni védelem: egy telefonszámhoz legfeljebb 3 jövőbeli foglalás.
  if (select count(*) from public.bookings b
       where b.status = 'confirmed'
         and b.end_at > now()
         and regexp_replace(b.phone, '[^0-9]', '', 'g') = v_digits) >= 3 then
    raise exception 'Ehhez a telefonszámhoz már 3 aktív foglalás tartozik.' using errcode = 'PT400';
  end if;

  begin
    insert into public.bookings (court, start_at, end_at, name, phone)
    values (p_court, v_start, v_end, v_name, v_phone)
    returning id into v_id;
  exception
    when exclusion_violation then
      raise exception 'Ez az időpont időközben már foglalt lett.' using errcode = 'PT409';
    when check_violation then
      raise exception 'Kérjük, adj meg érvényes nevet és telefonszámot.' using errcode = 'PT400';
  end;

  return v_id;
end;
$$;


-- Jogosultságok: a weboldal (anon) csak ezt a két függvényt hívhatja.
revoke execute on function public.get_busy_slots(date) from public;
revoke execute on function public.create_booking(text, date, time, int, text, text) from public;
grant execute on function public.get_busy_slots(date) to anon, authenticated;
grant execute on function public.create_booking(text, date, time, int, text, text) to anon, authenticated;
