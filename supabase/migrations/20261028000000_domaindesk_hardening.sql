-- DomainDesk: ownership + data-integrity hardening
--
-- Safe to run more than once. Does not delete or modify any existing rows.
-- Run in Supabase Dashboard → SQL Editor. Review supabase/checks/inspect_schema.sql
-- output first if you have existing data or custom constraints.
--
-- What it adds:
--   1. user_id defaults to auth.uid() and is required on all three tables.
--   2. RESTRICTIVE RLS policies, layered on top of your existing policies, so that
--      even an overly broad permissive policy can never expose another user's rows,
--      and a row can only link to a client/domain owned by the same user.
--   3. CHECK constraints for status values (matching the app), currency codes and
--      non-negative money.
--   4. updated_at maintenance and indexes for the app's queries.

begin;

-- 1. Ownership column -------------------------------------------------------

alter table public.clients         alter column user_id set default auth.uid();
alter table public.domains         alter column user_id set default auth.uid();
alter table public.domain_renewals alter column user_id set default auth.uid();

-- Fails (and rolls back everything) if any existing row has a NULL user_id.
alter table public.clients         alter column user_id set not null;
alter table public.domains         alter column user_id set not null;
alter table public.domain_renewals alter column user_id set not null;

alter table public.clients         enable row level security;
alter table public.domains         enable row level security;
alter table public.domain_renewals enable row level security;

-- 2. Restrictive policies ---------------------------------------------------
-- Restrictive policies are AND-ed with the permissive ones you already have.
-- They apply to every role (anon gets nothing: auth.uid() is NULL).

drop policy if exists dd_owner_only on public.clients;
create policy dd_owner_only on public.clients
  as restrictive for all to public
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists dd_owner_only on public.domains;
create policy dd_owner_only on public.domains
  as restrictive for all to public
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and (
      client_id is null
      or exists (
        select 1 from public.clients c
        where c.id = client_id and c.user_id = (select auth.uid())
      )
    )
  );

drop policy if exists dd_owner_only on public.domain_renewals;
create policy dd_owner_only on public.domain_renewals
  as restrictive for all to public
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.domains d
      where d.id = domain_id and d.user_id = (select auth.uid())
    )
  );

-- 3. Value constraints ------------------------------------------------------
-- Status lists match the app (src/data/options.ts). These replace the original
-- dashboard constraints (domains also allowed 'pending'/'expired'; renewals used
-- 'planned'/'renewed' instead of 'scheduled'), which rejected the app's values.
-- Validated immediately: if any existing row violates a rule, the whole
-- migration fails and rolls back rather than leaving bad data unchecked.

alter table public.domains drop constraint if exists domains_status_check;
alter table public.domains add constraint domains_status_check
  check (status is null or status in ('active', 'transferred', 'cancelled'));

alter table public.domain_renewals drop constraint if exists domain_renewals_status_check;
alter table public.domain_renewals add constraint domain_renewals_status_check
  check (status is null or status in ('scheduled', 'invoiced', 'paid', 'cancelled'));

alter table public.domain_renewals drop constraint if exists domain_renewals_currency_check;
alter table public.domain_renewals add constraint domain_renewals_currency_check
  check (currency is null or currency ~ '^[A-Z]{3}$');

alter table public.domain_renewals drop constraint if exists domain_renewals_amounts_check;
alter table public.domain_renewals add constraint domain_renewals_amounts_check
  check (coalesce(registrar_cost, 0) >= 0 and coalesce(client_charge, 0) >= 0);

-- 4. updated_at + indexes ---------------------------------------------------

create or replace function public.dd_set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists dd_set_updated_at on public.clients;
create trigger dd_set_updated_at before update on public.clients
  for each row execute function public.dd_set_updated_at();

drop trigger if exists dd_set_updated_at on public.domains;
create trigger dd_set_updated_at before update on public.domains
  for each row execute function public.dd_set_updated_at();

create index if not exists clients_user_id_idx          on public.clients (user_id);
create index if not exists domains_user_id_idx          on public.domains (user_id);
create index if not exists domains_client_id_idx        on public.domains (client_id);
create index if not exists domain_renewals_user_id_idx  on public.domain_renewals (user_id);
create index if not exists domain_renewals_domain_id_idx on public.domain_renewals (domain_id);

commit;
