-- TCG Market accounts: paste this whole file into Supabase → SQL Editor → Run.
-- Each table has row-level security, so a signed-in person can only see and change their own rows.

create table if not exists public.collection (
  id         text primary key,                       -- id made by the site
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  card_key   text not null,
  qty        integer not null check (qty between 1 and 999),
  paid       numeric(10,2) not null check (paid >= 0),
  bought     date,
  source     text check (char_length(source) <= 40),
  created_at timestamptz not null default now()
);

create table if not exists public.watch (
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  card_key   text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, card_key)
);

create table if not exists public.alerts (
  id         text primary key,
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  card_key   text not null,
  kind       text not null check (kind in ('below', 'above')),
  price      numeric(10,2) not null check (price > 0),
  created_at timestamptz not null default now(),
  emailed_at timestamptz                             -- set by the daily email job
);

create table if not exists public.settings (
  user_id      uuid primary key default auth.uid() references auth.users on delete cascade,
  email_alerts boolean not null default true
);

-- keep the free database tidy: at most 500 rows per person per table
create or replace function public.limit_rows() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from (select 1 from public.collection where user_id = new.user_id
        union all select 1 from public.alerts where user_id = new.user_id
        union all select 1 from public.watch where user_id = new.user_id) t) >= 1500 then
    raise exception 'Too many saved items on this account';
  end if;
  return new;
end $$;

do $$ declare t text; begin
  foreach t in array array['collection', 'watch', 'alerts', 'settings'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "own rows" on public.%I', t);
    execute format('create policy "own rows" on public.%I for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid())', t);
  end loop;
  foreach t in array array['collection', 'watch', 'alerts'] loop
    execute format('drop trigger if exists limit_rows on public.%I', t);
    execute format('create trigger limit_rows before insert on public.%I for each row execute function public.limit_rows()', t);
  end loop;
end $$;

create index if not exists alerts_open on public.alerts (emailed_at) where emailed_at is null;
