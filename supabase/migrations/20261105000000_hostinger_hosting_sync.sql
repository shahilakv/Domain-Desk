-- DomainDesk: import hosting plans from Hostinger
--
-- Safe to run more than once. Adds nullable columns, two unique indexes and one
-- function; it does not delete or rewrite existing rows and does not create,
-- drop or change any policy. The existing hosting_plans / domains policies
-- (owner only, linked rows must belong to the same user) cover everything here.
--
-- Requires 20261103000000_hosting_plans.sql.
-- Run in Supabase Dashboard → SQL Editor after reviewing it.

begin;

-- 0. Dependencies -----------------------------------------------------------

do $$
begin
  if to_regclass('public.hosting_plans') is null then
    raise exception 'Apply 20261103000000_hosting_plans.sql first (public.hosting_plans is missing).';
  end if;
end;
$$;

-- 1. Hostinger reference columns -------------------------------------------
-- Set only for plans imported from (or linked to) Hostinger; manual plans keep
-- them null. Written by dd_sync_hostinger_plan below, never by the plan form.

alter table public.hosting_plans add column if not exists hostinger_order_id        text;        -- GET /api/hosting/v1/orders id
alter table public.hosting_plans add column if not exists hostinger_subscription_id text;        -- the order's billing subscription id
alter table public.hosting_plans add column if not exists provider_status           text;        -- raw Hostinger order status
alter table public.hosting_plans add column if not exists last_synced_at            timestamptz;

alter table public.hosting_plans drop constraint if exists hosting_plans_hostinger_ids_check;
alter table public.hosting_plans add constraint hosting_plans_hostinger_ids_check check (
  (hostinger_order_id is null or hostinger_order_id ~ '^[0-9]{1,20}$')
  and (hostinger_subscription_id is null or length(hostinger_subscription_id) between 1 and 100)
  and (provider_status is null or length(provider_status) <= 50)
);

-- 2. One plan per Hostinger order / subscription per user --------------------
-- Makes repeated imports race-safe: a second insert for the same order fails
-- instead of creating a duplicate plan.

create unique index if not exists hosting_plans_user_hostinger_order_key
  on public.hosting_plans (user_id, hostinger_order_id) where hostinger_order_id is not null;

create unique index if not exists hosting_plans_user_hostinger_subscription_key
  on public.hosting_plans (user_id, hostinger_subscription_id) where hostinger_subscription_id is not null;

-- 3. Save one Hostinger plan and its domain links in one transaction ---------
-- SECURITY INVOKER: every statement runs as the caller, so RLS applies exactly
-- as for direct API writes; the explicit user_id filters are a second line of
-- defence. Any error rolls back the plan and its links together.
--
-- Rules (the Edge Function decides the values; this function only writes them):
--   * Matched by hostinger_order_id. If none, p_link_plan_id may name one of
--     the caller's manual plans (no Hostinger id yet) to link instead of
--     creating a new plan.
--   * A new plan gets provider 'Hostinger' and p_plan_name.
--   * An existing plan never has provider, plan_name, client_id,
--     client_charge or notes changed. NULL parameters keep the stored value,
--     so a missing Hostinger field never clears anything; start_date is only
--     filled when empty.
--   * p_domain_ids are linked only if they belong to the caller and are not
--     on any plan yet: a domain already on another plan is never moved.

create or replace function public.dd_sync_hostinger_plan(
  p_order_id        text,
  p_subscription_id text,
  p_link_plan_id    uuid,
  p_plan_name       text,
  p_start_date      date,
  p_renewal_date    date,
  p_hosting_cost    numeric,
  p_currency        text,
  p_auto_renew      boolean,
  p_status          text,
  p_provider_status text,
  p_domain_ids      uuid[]
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_uid     uuid := (select auth.uid());
  v_id      uuid;
  v_outcome text;
  v_linked  integer;
begin
  if v_uid is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;
  if p_order_id is null or p_order_id !~ '^[0-9]{1,20}$' then
    raise exception 'Invalid Hostinger order id.' using errcode = '22023';
  end if;

  select h.id into v_id
  from public.hosting_plans h
  where h.user_id = v_uid and h.hostinger_order_id = p_order_id
  for update;

  if v_id is null and p_link_plan_id is not null then
    select h.id into v_id
    from public.hosting_plans h
    where h.id = p_link_plan_id and h.user_id = v_uid and h.hostinger_order_id is null
    for update;
    if v_id is null then
      raise exception 'The hosting plan to link was not found, or is already linked to Hostinger.' using errcode = 'P0002';
    end if;
    v_outcome := 'linked';
  end if;

  if v_id is null then
    insert into public.hosting_plans (
      user_id, provider, plan_name, start_date, renewal_date, hosting_cost, currency,
      auto_renew, status, hostinger_order_id, hostinger_subscription_id, provider_status, last_synced_at
    )
    values (
      v_uid, 'Hostinger', coalesce(nullif(btrim(p_plan_name), ''), 'Hostinger hosting'), p_start_date, p_renewal_date,
      p_hosting_cost, p_currency, coalesce(p_auto_renew, false), coalesce(p_status, 'active'),
      p_order_id, p_subscription_id, p_provider_status, now()
    )
    returning id into v_id;
    v_outcome := 'inserted';
  else
    update public.hosting_plans h set
      hostinger_order_id        = p_order_id,
      hostinger_subscription_id = coalesce(p_subscription_id, h.hostinger_subscription_id),
      start_date                = coalesce(h.start_date, p_start_date),
      renewal_date              = coalesce(p_renewal_date, h.renewal_date),
      hosting_cost              = coalesce(p_hosting_cost, h.hosting_cost),
      currency                  = coalesce(p_currency, h.currency),
      auto_renew                = coalesce(p_auto_renew, h.auto_renew),
      status                    = coalesce(p_status, h.status),
      provider_status           = coalesce(p_provider_status, h.provider_status),
      last_synced_at            = now()
    where h.id = v_id and h.user_id = v_uid;
    v_outcome := coalesce(v_outcome, 'updated');
  end if;

  update public.domains d
  set hosting_plan_id = v_id
  where d.id = any (coalesce(p_domain_ids, '{}'))
    and d.user_id = v_uid
    and d.hosting_plan_id is null;
  get diagnostics v_linked = row_count;

  return jsonb_build_object('plan_id', v_id, 'outcome', v_outcome, 'linked', v_linked);
end;
$$;

revoke all on function public.dd_sync_hostinger_plan(text, text, uuid, text, date, date, numeric, text, boolean, text, text, uuid[]) from public, anon;
grant execute on function public.dd_sync_hostinger_plan(text, text, uuid, text, date, date, numeric, text, boolean, text, text, uuid[]) to authenticated;

commit;
