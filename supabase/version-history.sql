-- LiturgyForge: version history for services (liturgies) and shared data
-- (Planner, templates, rosters). Paste into Supabase → SQL Editor → Run.
-- Safe to run more than once.
--
-- Before a row changes or is deleted, its old version is copied into a
-- history table — at most once per 5 minutes per service/key, but always
-- when a save makes the content noticeably smaller (a likely wipe) or
-- deletes it. History older than 90 days is pruned. If archiving ever
-- fails, the save itself still goes through.

-- ---------- Services ----------
create table if not exists public.liturgy_history (
  id bigserial primary key,
  service_date text not null,
  data jsonb,
  updated_at timestamptz,
  archived_at timestamptz not null default now(),
  change text not null
);
create index if not exists liturgy_history_date_idx on public.liturgy_history (service_date, archived_at desc);
alter table public.liturgy_history enable row level security;
drop policy if exists "Signed-in users can read liturgy history" on public.liturgy_history;
create policy "Signed-in users can read liturgy history" on public.liturgy_history
  for select to authenticated using (true);

create or replace function public.archive_liturgy_version() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and old.data::jsonb is not distinct from new.data::jsonb then
    return new;
  end if;
  begin
    if tg_op = 'DELETE'
       or length(new.data::text) < length(old.data::text) * 0.9
       or not exists (
         select 1 from liturgy_history h
         where h.service_date = old.service_date::text
           and h.archived_at > now() - interval '5 minutes')
    then
      insert into liturgy_history (service_date, data, updated_at, change)
      values (old.service_date::text, old.data::jsonb, old.updated_at::timestamptz, lower(tg_op));
    end if;
    delete from liturgy_history
    where service_date = old.service_date::text and archived_at < now() - interval '90 days';
  exception when others then
    null; -- never block a save because history failed
  end;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

drop trigger if exists liturgies_archive on public.liturgies;
create trigger liturgies_archive before update or delete on public.liturgies
  for each row execute function public.archive_liturgy_version();

-- ---------- Shared data (Planner, templates, rosters, …) ----------
create table if not exists public.shared_data_history (
  id bigserial primary key,
  key text not null,
  data jsonb,
  updated_at timestamptz,
  archived_at timestamptz not null default now(),
  change text not null
);
create index if not exists shared_data_history_key_idx on public.shared_data_history (key, archived_at desc);
alter table public.shared_data_history enable row level security;
drop policy if exists "Signed-in users can read shared data history" on public.shared_data_history;
create policy "Signed-in users can read shared data history" on public.shared_data_history
  for select to authenticated using (true);

create or replace function public.archive_shared_data_version() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and old.data::jsonb is not distinct from new.data::jsonb then
    return new;
  end if;
  begin
    if tg_op = 'DELETE'
       or length(new.data::text) < length(old.data::text) * 0.9
       or not exists (
         select 1 from shared_data_history h
         where h.key = old.key
           and h.archived_at > now() - interval '5 minutes')
    then
      insert into shared_data_history (key, data, updated_at, change)
      values (old.key, old.data::jsonb, old.updated_at::timestamptz, lower(tg_op));
    end if;
    delete from shared_data_history
    where key = old.key and archived_at < now() - interval '90 days';
  exception when others then
    null; -- never block a save because history failed
  end;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

drop trigger if exists shared_data_archive on public.shared_data;
create trigger shared_data_archive before update or delete on public.shared_data
  for each row execute function public.archive_shared_data_version();

-- ---------- Baseline: snapshot everything as it is right now ----------
insert into public.liturgy_history (service_date, data, updated_at, change)
select service_date::text, data::jsonb, updated_at::timestamptz, 'baseline' from public.liturgies;
insert into public.shared_data_history (key, data, updated_at, change)
select key, data::jsonb, updated_at::timestamptz, 'baseline' from public.shared_data;
