-- iFlow Docs — user profiles and print counter.
--
-- Run this once in the Supabase SQL editor (Dashboard > SQL Editor > New query).
-- It is safe to run again: everything is create-if-missing / replace.
--
-- What it stores, per signed-in user, and nothing else:
--   name, email and photo link (copied from the Google account),
--   how many documents they sent to the print dialog, and how many print jobs.
-- Their integration files are never uploaded; the site reads them in the browser.
--
-- Design rule: the browser can READ its own profile row but cannot WRITE to the
-- table at all. Every write goes through the two functions below, which act only
-- on the caller's own row and validate their input. That is what stops someone
-- from opening the browser console and setting their own counter to 999999.

create table if not exists public.profiles (
  id                uuid primary key references auth.users (id) on delete cascade,
  email             text,
  full_name         text,
  avatar_url        text,
  documents_printed integer not null default 0 check (documents_printed >= 0),
  print_jobs        integer not null default 0 check (print_jobs >= 0),
  last_printed_at   timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- Supabase grants new tables to anon/authenticated by default. Take all of that
-- away, then give back exactly one thing: reading your own row.
revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;

drop policy if exists "read own profile" on public.profiles;
create policy "read own profile"
  on public.profiles
  for select
  to authenticated
  using (id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- ensure_profile: create the caller's profile on first sign-in, refresh it after.
-- The email comes from auth.users (trusted), never from the browser.
-- ---------------------------------------------------------------------------
create or replace function public.ensure_profile(
  p_full_name  text default null,
  p_avatar_url text default null
)
returns public.profiles
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  rec public.profiles;
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  insert into public.profiles (id, email, full_name, avatar_url)
  select
    u.id,
    u.email,
    left(coalesce(nullif(p_full_name, ''),  u.raw_user_meta_data ->> 'full_name', u.raw_user_meta_data ->> 'name'), 200),
    left(coalesce(nullif(p_avatar_url, ''), u.raw_user_meta_data ->> 'avatar_url', u.raw_user_meta_data ->> 'picture'), 500)
  from auth.users u
  where u.id = uid
  on conflict (id) do update
    set email      = excluded.email,
        full_name  = coalesce(public.profiles.full_name, excluded.full_name),
        avatar_url = coalesce(excluded.avatar_url, public.profiles.avatar_url),
        updated_at = now()
  returning * into rec;

  if rec.id is null then
    raise exception 'user not found' using errcode = '28000';
  end if;
  return rec;
end;
$$;

-- ---------------------------------------------------------------------------
-- record_print: add to the caller's counters. One call = one print job.
-- The count per call is bounded so a single request cannot inflate the total.
-- ---------------------------------------------------------------------------
create or replace function public.record_print(p_documents integer)
returns public.profiles
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  rec public.profiles;
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_documents is null or p_documents < 1 or p_documents > 100 then
    raise exception 'document count must be between 1 and 100' using errcode = '22023';
  end if;

  -- A profile may not exist yet (first print before the first ensure_profile).
  perform public.ensure_profile();

  update public.profiles
     set documents_printed = documents_printed + p_documents,
         print_jobs        = print_jobs + 1,
         last_printed_at   = now(),
         updated_at        = now()
   where id = uid
  returning * into rec;

  return rec;
end;
$$;

-- Functions are executable by everyone by default; only signed-in users may call these.
revoke all on function public.ensure_profile(text, text) from public, anon;
revoke all on function public.record_print(integer)      from public, anon;
grant execute on function public.ensure_profile(text, text) to authenticated;
grant execute on function public.record_print(integer)      to authenticated;
