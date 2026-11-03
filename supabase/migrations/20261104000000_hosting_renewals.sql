-- DomainDesk: hosting plan renewals
--
-- Lets a domain_renewals row record the renewal of either a domain or a
-- hosting plan, so both share one Renewals page, one status workflow and one
-- set of payment fields. Safe to run more than once. Does not delete or
-- rewrite any row: every existing renewal has a domain_id and no
-- hosting_plan_id, so it already satisfies the new rules.
--
-- Changes:
--   1. domain_renewals.hosting_plan_id (nullable, ON DELETE RESTRICT).
--   2. domain_renewals.domain_id becomes nullable.
--   3. A CHECK requiring exactly one target: a domain or a hosting plan.
--   4. dd_owner_only on domain_renewals is recreated so its WITH CHECK verifies
--      ownership of whichever target is set. USING is unchanged, and so is the
--      dashboard's permissive "Users manage their own renewals" policy.
--   5. The status column default becomes 'scheduled'. The old default
--      ('planned') is rejected by domain_renewals_status_check, so an insert
--      without a status failed. Existing rows are not touched.
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

-- 1. Hosting plan target ----------------------------------------------------

alter table public.domain_renewals add column if not exists hosting_plan_id uuid;

-- A hosting plan with renewal records cannot be deleted, so payment history is
-- never removed as a side effect; the app asks you to delete the renewals first.
alter table public.domain_renewals drop constraint if exists domain_renewals_hosting_plan_id_fkey;
alter table public.domain_renewals add constraint domain_renewals_hosting_plan_id_fkey
  foreign key (hosting_plan_id) references public.hosting_plans (id) on delete restrict;

-- 2. Domain target becomes optional -----------------------------------------

alter table public.domain_renewals alter column domain_id drop not null;

-- 3. Exactly one target -----------------------------------------------------
-- Validated immediately: fails (and rolls back everything) if any row has
-- neither or both targets.

alter table public.domain_renewals drop constraint if exists domain_renewals_one_target_check;
alter table public.domain_renewals add constraint domain_renewals_one_target_check
  check ((domain_id is null) <> (hosting_plan_id is null));

-- 4. Ownership of the target ------------------------------------------------
-- Same as the hardening migration's policy, except the linked-row check now
-- accepts an owned hosting plan as well as an owned domain.

drop policy if exists dd_owner_only on public.domain_renewals;
create policy dd_owner_only on public.domain_renewals
  as restrictive for all to public
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and (
      (
        domain_id is not null
        and hosting_plan_id is null
        and exists (
          select 1 from public.domains d
          where d.id = domain_id and d.user_id = (select auth.uid())
        )
      )
      or (
        hosting_plan_id is not null
        and domain_id is null
        and exists (
          select 1 from public.hosting_plans h
          where h.id = hosting_plan_id and h.user_id = (select auth.uid())
        )
      )
    )
  );

-- 5. Status default ---------------------------------------------------------
-- 'scheduled' is the app's starting status. Only affects future inserts that
-- omit status; no existing row changes.

alter table public.domain_renewals alter column status set default 'scheduled';

-- 6. Index ------------------------------------------------------------------
-- Domain renewals never set hosting_plan_id, so a partial index stays small.

create index if not exists domain_renewals_hosting_plan_id_idx
  on public.domain_renewals (hosting_plan_id) where hosting_plan_id is not null;

commit;
