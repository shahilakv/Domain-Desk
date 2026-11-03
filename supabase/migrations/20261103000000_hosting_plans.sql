-- DomainDesk: hosting plans
--
-- Safe to run more than once. Adds one table, one nullable column, one policy
-- on domains and one function; it does not delete or rewrite existing rows and
-- does not modify any existing policy. Follows the ownership model of
-- 20261028000000_domaindesk_hardening.sql (user_id = auth.uid(), RLS, a
-- restrictive owner-only policy that also checks linked rows).
--
-- Requires 20261028000000_domaindesk_hardening.sql (for dd_set_updated_at).
-- Run in Supabase Dashboard → SQL Editor after reviewing it.

begin;

-- 0. Dependencies -----------------------------------------------------------

do $$
begin
  if to_regprocedure('public.dd_set_updated_at()') is null then
    raise exception 'Apply 20261028000000_domaindesk_hardening.sql first (public.dd_set_updated_at() is missing).';
  end if;
end;
$$;

-- 1. Table ------------------------------------------------------------------

create table if not exists public.hosting_plans (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users (id) on delete cascade,
  -- A client with hosting plans cannot be deleted; the app asks you to
  -- reassign or delete the plans first.
  client_id      uuid references public.clients (id) on delete restrict,
  provider       text not null,
  plan_name      text not null,
  start_date     date,
  renewal_date   date,
  hosting_cost   numeric(12, 2),   -- what the provider charges us
  client_charge  numeric(12, 2),   -- what we bill the client
  currency       text,
  auto_renew     boolean not null default false,
  status         text not null default 'active',
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz,

  constraint hosting_plans_provider_check  check (length(btrim(provider)) between 1 and 200),
  constraint hosting_plans_plan_name_check check (length(btrim(plan_name)) between 1 and 200),
  -- Status list matches the app (src/data/options.ts).
  constraint hosting_plans_status_check    check (status in ('active', 'suspended', 'cancelled')),
  constraint hosting_plans_currency_check  check (currency is null or currency ~ '^[A-Z]{3}$'),
  constraint hosting_plans_amounts_check   check (coalesce(hosting_cost, 0) >= 0 and coalesce(client_charge, 0) >= 0),
  constraint hosting_plans_dates_check     check (start_date is null or renewal_date is null or renewal_date >= start_date)
);

-- 2. Domains covered by a plan ----------------------------------------------
-- One plan covers many domains; a domain is on at most one plan. Deleting a
-- plan only unlinks its domains (in the same statement), it never deletes them.

alter table public.domains
  add column if not exists hosting_plan_id uuid references public.hosting_plans (id) on delete set null;

-- 3. Row Level Security -----------------------------------------------------

alter table public.hosting_plans enable row level security;

revoke all on public.hosting_plans from anon;
grant select, insert, update, delete on public.hosting_plans to authenticated;

-- Permissive policy: a new table has no dashboard-created policies, and a
-- restrictive policy alone grants nothing.
drop policy if exists dd_owner_access on public.hosting_plans;
create policy dd_owner_access on public.hosting_plans
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- Restrictive policy, same pattern as the other tables: owner only, and the
-- client must belong to the same user.
drop policy if exists dd_owner_only on public.hosting_plans;
create policy dd_owner_only on public.hosting_plans
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

-- domains: the existing dd_owner_only policy is left exactly as it is. This
-- extra restrictive policy is AND-ed with it and only adds one rule: a domain
-- can link to a hosting plan of the same user. USING (true) adds no read
-- restriction; the existing policies still decide which rows are visible.
drop policy if exists dd_hosting_plan_owner on public.domains;
create policy dd_hosting_plan_owner on public.domains
  as restrictive for all to public
  using (true)
  with check (
    hosting_plan_id is null
    or exists (
      select 1 from public.hosting_plans h
      where h.id = hosting_plan_id and h.user_id = (select auth.uid())
    )
  );

-- 4. Save a plan and its domain links in one transaction --------------------
-- SECURITY INVOKER: every statement runs as the caller, so RLS applies as for
-- direct API writes. The explicit user_id filters and checks are a second line
-- of defence. p_domain_ids is the complete set of domains the plan should
-- cover; others currently on the plan are unlinked. Any error rolls back the
-- plan and link changes together.

create or replace function public.dd_save_hosting_plan(
  p_id            uuid,
  p_provider      text,
  p_plan_name     text,
  p_client_id     uuid,
  p_start_date    date,
  p_renewal_date  date,
  p_hosting_cost  numeric,
  p_client_charge numeric,
  p_currency      text,
  p_auto_renew    boolean,
  p_status        text,
  p_notes         text,
  p_domain_ids    uuid[]
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_uid     uuid := (select auth.uid());
  v_id      uuid;
  v_domains uuid[] := coalesce(p_domain_ids, '{}');
begin
  if v_uid is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;

  if p_id is null then
    insert into public.hosting_plans (
      user_id, provider, plan_name, client_id, start_date, renewal_date,
      hosting_cost, client_charge, currency, auto_renew, status, notes
    ) values (
      v_uid, p_provider, p_plan_name, p_client_id, p_start_date, p_renewal_date,
      p_hosting_cost, p_client_charge, p_currency, coalesce(p_auto_renew, false), coalesce(p_status, 'active'), p_notes
    )
    returning id into v_id;
  else
    update public.hosting_plans set
      provider = p_provider,
      plan_name = p_plan_name,
      client_id = p_client_id,
      start_date = p_start_date,
      renewal_date = p_renewal_date,
      hosting_cost = p_hosting_cost,
      client_charge = p_client_charge,
      currency = p_currency,
      auto_renew = coalesce(p_auto_renew, false),
      status = coalesce(p_status, 'active'),
      notes = p_notes
    where id = p_id and user_id = v_uid
    returning id into v_id;

    if v_id is null then
      raise exception 'Hosting plan not found. It may have been deleted.' using errcode = 'P0002';
    end if;
  end if;

  -- Every requested domain must exist and belong to the caller.
  if exists (
    select 1 from unnest(v_domains) as req(id)
    where not exists (
      select 1 from public.domains d where d.id = req.id and d.user_id = v_uid
    )
  ) then
    raise exception 'One or more selected domains were not found. Reload and try again.' using errcode = 'P0002';
  end if;

  update public.domains set hosting_plan_id = null
  where user_id = v_uid and hosting_plan_id = v_id and not (id = any (v_domains));

  update public.domains set hosting_plan_id = v_id
  where user_id = v_uid and id = any (v_domains) and hosting_plan_id is distinct from v_id;

  return v_id;
end;
$$;

revoke all on function public.dd_save_hosting_plan(uuid, text, text, uuid, date, date, numeric, numeric, text, boolean, text, text, uuid[]) from public, anon;
grant execute on function public.dd_save_hosting_plan(uuid, text, text, uuid, date, date, numeric, numeric, text, boolean, text, text, uuid[]) to authenticated;

-- 5. updated_at + indexes ---------------------------------------------------

drop trigger if exists dd_set_updated_at on public.hosting_plans;
create trigger dd_set_updated_at before update on public.hosting_plans
  for each row execute function public.dd_set_updated_at();

-- Matches the app's query: filter by user_id, order by renewal_date.
create index if not exists hosting_plans_user_renewal_idx on public.hosting_plans (user_id, renewal_date);
create index if not exists hosting_plans_client_id_idx    on public.hosting_plans (client_id);
create index if not exists domains_hosting_plan_id_idx    on public.domains (hosting_plan_id) where hosting_plan_id is not null;

commit;
