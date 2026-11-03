-- DomainDesk: ownership type + registrar sync metadata (Hostinger import)
--
-- Safe to run more than once. Only adds nullable columns, constraints and
-- indexes; it does not delete or rewrite existing rows. RLS is untouched: the
-- dd_owner_only policies from 20261028000000_domaindesk_hardening.sql keep
-- applying to every column added here.
--
-- Run in Supabase Dashboard → SQL Editor after reviewing it.

begin;

-- 1. Who owns the registration --------------------------------------------
-- 'agency' = registered in your own registrar account, 'client' = the client's
-- account. The live database already has this column (text NOT NULL default
-- 'client' with the same CHECK), in which case "add column if not exists" is a
-- no-op and the CHECK is recreated unchanged. On a fresh database it is added
-- as nullable text.

alter table public.domains add column if not exists ownership_type text;

alter table public.domains drop constraint if exists domains_ownership_type_check;
alter table public.domains add constraint domains_ownership_type_check
  check (ownership_type is null or ownership_type in ('agency', 'client'));

-- 2. Provider sync metadata ------------------------------------------------
-- Written only by the hostinger-import Edge Function (running as the signed-in
-- user). Manual fields (client_id, notes, status, auto_renew) are never touched
-- by a sync.

alter table public.domains add column if not exists provider            text;        -- e.g. 'hostinger'
alter table public.domains add column if not exists provider_domain_id  text;        -- Hostinger portfolio id
alter table public.domains add column if not exists provider_status     text;        -- raw status, e.g. 'active', 'expired'
alter table public.domains add column if not exists registered_date     date;        -- registration date from the provider
alter table public.domains add column if not exists last_synced_at      timestamptz;

alter table public.domains drop constraint if exists domains_provider_check;
alter table public.domains add constraint domains_provider_check
  check (provider is null or provider in ('hostinger'));

create index if not exists domains_user_provider_idx on public.domains (user_id, provider);

-- 3. One row per domain per user -------------------------------------------
-- Makes repeated imports race-safe. Matches the app's normalisation
-- (lower-cased, no trailing dot). Skipped with a NOTICE if duplicates already
-- exist — find them with the query below, merge them, and re-run this file.
--
--   select user_id, lower(rtrim(domain_name, '.')) as name, count(*)
--   from public.domains group by 1, 2 having count(*) > 1;

do $$
begin
  if exists (
    select 1 from public.domains
    group by user_id, lower(rtrim(domain_name, '.'))
    having count(*) > 1
  ) then
    raise notice 'domains_user_domain_name_key not created: duplicate domain names exist for a user.';
  else
    create unique index if not exists domains_user_domain_name_key
      on public.domains (user_id, lower(rtrim(domain_name, '.')));
  end if;
end;
$$;

commit;
