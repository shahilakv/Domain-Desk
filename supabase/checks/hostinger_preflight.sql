-- DomainDesk: Hostinger import preflight (READ-ONLY)
--
-- Run before:
--   supabase/migrations/20261028000000_domaindesk_hardening.sql
--   supabase/migrations/20261102000000_hostinger_import.sql
--
-- This file is ONE select statement that returns a single report table, because
-- the Supabase SQL Editor only displays the result of the last statement.
-- Run it in Dashboard → SQL Editor (as the default postgres role). It reads
-- catalog views and table rows only; it writes nothing.
--
-- Notes on reading the file:
--   * Words such as 'INSERT', 'UPDATE' and 'DELETE' appear only as string
--     literals: they are the policy command names stored in pg_policies.
--   * query_to_xml() is used only to run a read-only count against
--     domains.ownership_type when that column exists, so the report doesn't
--     error on databases where it doesn't.
--
-- Columns in the result:
--   check_no     section.item (1 = hardening status … 9 = keys/constraints)
--   status       OK   = safe / as expected
--                INFO = informational, no action needed
--                WARN = review before running the migrations
--                FAIL = fix before running the migrations
--   object       table, policy, column or constraint the row is about
--   detail       what was found
--   safe_result  what a safe result looks like for this check

with
tables(tbl) as (
  values ('clients'), ('domains'), ('domain_renewals')
),

rls as (
  select c.relname as tbl, c.relrowsecurity, c.relforcerowsecurity
  from pg_class c
  where c.relnamespace = 'public'::regnamespace
    and c.relkind in ('r', 'p')
    and c.relname in (select tbl from tables)
),

pol as (
  select p.tablename as tbl, p.policyname, p.permissive, p.roles::text[] as roles, p.cmd, p.qual, p.with_check
  from pg_policies p
  where p.schemaname = 'public'
    and p.tablename in (select tbl from tables)
),

cols as (
  select c.table_name as tbl, c.column_name, c.data_type, c.udt_name, c.is_nullable, c.column_default
  from information_schema.columns c
  where c.table_schema = 'public'
    and c.table_name in (select tbl from tables)
),

cons as (
  select cl.relname as tbl, con.conname, con.contype, con.convalidated,
         pg_get_constraintdef(con.oid) as def,
         rcl.relname as ref_tbl, rns.nspname as ref_schema
  from pg_constraint con
  join pg_class cl on cl.oid = con.conrelid
  left join pg_class rcl on rcl.oid = con.confrelid
  left join pg_namespace rns on rns.oid = rcl.relnamespace
  where cl.relnamespace = 'public'::regnamespace
    and cl.relname in (select tbl from tables)
),

idx as (
  select i.tablename as tbl, i.indexname, i.indexdef, x.indisunique
  from pg_indexes i
  join pg_class ic on ic.relname = i.indexname and ic.relnamespace = 'public'::regnamespace
  join pg_index x on x.indexrelid = ic.oid
  where i.schemaname = 'public'
    and i.tablename in (select tbl from tables)
),

-- 1. Hardening migration components ------------------------------------------
hardening as (
  select 'RLS enabled' as item, t.tbl,
         coalesce(r.relrowsecurity, false) as ok,
         case when r.tbl is null then 'table not found'
              when r.relrowsecurity then 'enabled'
              else 'disabled' end as detail
  from tables t left join rls r on r.tbl = t.tbl

  union all
  select 'dd_owner_only restrictive policy', t.tbl,
         exists (select 1 from pol p where p.tbl = t.tbl and p.policyname = 'dd_owner_only' and p.permissive = 'RESTRICTIVE'),
         coalesce((select lower(p.permissive) from pol p where p.tbl = t.tbl and p.policyname = 'dd_owner_only'), 'missing')
  from tables t

  union all
  select 'user_id NOT NULL', t.tbl,
         coalesce(c.is_nullable = 'NO', false),
         coalesce('is_nullable = ' || c.is_nullable, 'user_id column missing')
  from tables t left join cols c on c.tbl = t.tbl and c.column_name = 'user_id'

  union all
  select 'user_id default auth.uid()', t.tbl,
         coalesce(c.column_default ilike '%auth.uid()%', false),
         coalesce('default = ' || c.column_default, case when c.tbl is null then 'user_id column missing' else 'no default' end)
  from tables t left join cols c on c.tbl = t.tbl and c.column_name = 'user_id'

  union all
  select 'constraint ' || n.conname, n.tbl,
         exists (select 1 from cons k where k.tbl = n.tbl and k.conname = n.conname),
         coalesce((select case when k.convalidated then 'present (validated)' else 'present (NOT VALID)' end
                   from cons k where k.tbl = n.tbl and k.conname = n.conname), 'missing')
  from (values ('domains', 'domains_status_check'),
               ('domain_renewals', 'domain_renewals_status_check'),
               ('domain_renewals', 'domain_renewals_currency_check'),
               ('domain_renewals', 'domain_renewals_amounts_check')) as n(tbl, conname)

  union all
  select 'trigger dd_set_updated_at', n.tbl,
         exists (select 1 from pg_trigger tg join pg_class c on c.oid = tg.tgrelid
                 where c.relnamespace = 'public'::regnamespace and c.relname = n.tbl
                   and tg.tgname = 'dd_set_updated_at' and not tg.tgisinternal),
         ''
  from (values ('clients'), ('domains')) as n(tbl)

  union all
  select 'function public.dd_set_updated_at()', null,
         to_regprocedure('public.dd_set_updated_at()') is not null, ''
),

-- 3. Owner-scoped permissive policy coverage per command ---------------------
coverage as (
  select t.tbl, k.cmd,
         exists (
           select 1 from pol p
           where p.tbl = t.tbl
             and p.permissive = 'PERMISSIVE'
             and p.cmd in (k.cmd, 'ALL')
             and p.roles && array['authenticated', 'public']::text[]
             and (case when k.cmd = 'INSERT' then coalesce(p.with_check, p.qual) else p.qual end) ~* 'auth\.uid\(\)'
             and (case when k.cmd = 'INSERT' then coalesce(p.with_check, p.qual) else p.qual end) ~* 'user_id'
         ) as covered
  from tables t
  cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) as k(cmd)
),

-- 4. Permissive policies that are not limited to the row owner ---------------
loose_policies as (
  select p.*,
         case
           when lower(btrim(coalesce(p.qual, ''))) = 'true' or lower(btrim(coalesce(p.with_check, ''))) = 'true' then 'FAIL'
           when p.roles && array['anon']::text[] then 'WARN'
           when coalesce(p.qual, '') !~* 'auth\.uid\(\)' and coalesce(p.with_check, '') !~* 'auth\.uid\(\)' then 'WARN'
         end as flag
  from pol p
  where p.permissive = 'PERMISSIVE'
),

-- 6. Duplicate domain names per user -----------------------------------------
dups_strict as (
  select d.user_id, lower(rtrim(d.domain_name, '.')) as nm, count(*) as n,
         string_agg(d.id::text || ' = "' || d.domain_name || '"', ', ' order by d.created_at) as rows_list
  from public.domains d
  group by 1, 2
  having count(*) > 1
),
dups_loose as (
  select d.user_id, regexp_replace(lower(rtrim(btrim(d.domain_name), '.')), '^www\.', '') as nm, count(*) as n,
         string_agg(d.id::text || ' = "' || d.domain_name || '"', ', ' order by d.created_at) as rows_list
  from public.domains d
  group by 1, 2
  having count(*) > 1 and count(distinct lower(rtrim(d.domain_name, '.'))) > 1
),

-- 7. Columns the Hostinger migration adds -------------------------------------
hostinger_cols(col, expected_type) as (
  values ('ownership_type', 'text'),
         ('provider', 'text'),
         ('provider_domain_id', 'text'),
         ('provider_status', 'text'),
         ('registered_date', 'date'),
         ('last_synced_at', 'timestamp with time zone')
),

-- 8. Existing ownership_type column, if any -----------------------------------
ot as (
  select c.* from cols c where c.tbl = 'domains' and c.column_name = 'ownership_type'
),

report(sort, check_no, status, object, detail, safe_result) as (

  -- 1. Hardening migration ---------------------------------------------------
  select 100, '1.1', case when h.ok then 'OK' else 'INFO' end,
         coalesce(h.tbl || ': ', '') || h.item, h.detail,
         'OK on every 1.x row = hardening already applied. INFO = that part is not applied yet (expected before running it).'
  from hardening h

  union all
  select 101, '1.2',
         case when bool_and(h.ok) then 'OK' when bool_or(h.ok) then 'WARN' else 'INFO' end,
         'Hardening migration summary',
         case when bool_and(h.ok) then 'APPLIED'
              when bool_or(h.ok) then 'PARTIALLY APPLIED'
              else 'NOT APPLIED' end
           || ' (' || count(*) filter (where h.ok) || '/' || count(*) || ' components present)',
         'APPLIED (re-running is harmless) or NOT APPLIED (run it first). PARTIAL = someone changed objects by hand; review the 1.1 rows.'
  from hardening h

  -- 2. Existing RLS policies -------------------------------------------------
  union all
  select 200, '2.1', 'INFO', r.tbl,
         'RLS ' || case when r.relrowsecurity then 'enabled' else 'DISABLED' end
           || case when r.relforcerowsecurity then ', forced' else '' end
           || '; ' || (select count(*) from pol p where p.tbl = r.tbl and p.permissive = 'PERMISSIVE') || ' permissive, '
           || (select count(*) from pol p where p.tbl = r.tbl and p.permissive = 'RESTRICTIVE') || ' restrictive policies',
         'RLS enabled with at least one permissive policy. (The hardening migration enables RLS if it is off.)'
  from rls r

  union all
  select 201, '2.2', 'INFO', p.tbl || '.' || p.policyname,
         lower(p.permissive) || ' | cmd ' || p.cmd || ' | roles ' || array_to_string(p.roles, ',')
           || ' | using: ' || coalesce(p.qual, '-') || ' | check: ' || coalesce(p.with_check, '-'),
         'Every using/check expression compares user_id with auth.uid().'
  from pol p

  union all
  select 202, '2.2', 'WARN', t.tbl, 'No RLS policies on this table.',
         'At least one owner-scoped permissive policy per table.'
  from tables t
  where not exists (select 1 from pol p where p.tbl = t.tbl)

  -- 3. Owner-scoped permissive policy per table ------------------------------
  union all
  select 300, '3.1',
         case when bool_and(cv.covered) then 'OK' when bool_or(cv.covered) then 'WARN' else 'FAIL' end,
         cv.tbl,
         case when bool_and(cv.covered) then 'owner-scoped permissive policy covers SELECT, INSERT, UPDATE, DELETE'
              else 'no owner-scoped permissive policy for: '
                   || array_to_string(array_agg(cv.cmd order by cv.cmd) filter (where not cv.covered), ', ')
                   || case when not bool_or(cv.covered)
                           then '. Restrictive policies grant nothing on their own: after hardening the app could not read or write this table.'
                           else '' end
         end,
         'OK for all three tables. FAIL/WARN: add a permissive policy "for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))" first.'
  from coverage cv
  group by cv.tbl

  -- 4. Unrestricted policies ---------------------------------------------------
  union all
  select 400, '4.1', lp.flag, lp.tbl || '.' || lp.policyname,
         case lp.flag
           when 'FAIL' then 'USING/WITH CHECK is "true": grants access to every row'
           else 'not limited to the row owner (no auth.uid() check' || case when lp.roles && array['anon']::text[] then ', or granted to anon' else '' end || ')'
         end
           || ' | roles ' || array_to_string(lp.roles, ',') || ' | using: ' || coalesce(lp.qual, '-') || ' | check: ' || coalesce(lp.with_check, '-'),
         'No rows in section 4 other than the OK row. The hardening restrictive policy blocks cross-user access even so, but unrestricted policies should be removed.'
  from loose_policies lp
  where lp.flag is not null

  union all
  select 401, '4.1', 'OK', 'all permissive policies', 'No USING (true) / unrestricted permissive policies found.',
         'This OK row.'
  where not exists (select 1 from loose_policies lp where lp.flag is not null)

  -- 5. NULL user_id ------------------------------------------------------------
  union all
  select 500, '5.1', case when n = 0 then 'OK' else 'FAIL' end, tbl,
         n || ' row(s) with NULL user_id',
         '0 in every table. Otherwise the hardening migration stops at SET NOT NULL and rolls back; assign those rows to their owner first.'
  from (
    select 'clients' as tbl, (select count(*) from public.clients where user_id is null) as n
    union all select 'domains', (select count(*) from public.domains where user_id is null)
    union all select 'domain_renewals', (select count(*) from public.domain_renewals where user_id is null)
  ) as nulls

  -- 6. Duplicate domains -------------------------------------------------------
  union all
  select 600, '6.1', 'WARN', 'domains: ' || ds.nm,
         ds.n || ' rows for user ' || ds.user_id || ': ' || ds.rows_list,
         'No 6.1 rows. Each one makes the Hostinger migration skip the unique index domains_user_domain_name_key (the rest still applies). Merge the rows, then re-run the migration.'
  from dups_strict ds

  union all
  select 601, '6.1', 'OK', 'domains', 'No duplicates by case-insensitive, trailing-dot-normalised name.',
         'This OK row: the unique index will be created.'
  where not exists (select 1 from dups_strict)

  union all
  select 602, '6.2', 'INFO', 'domains: ' || dl.nm,
         'Possible duplicate under a looser rule (spaces / www.): ' || dl.rows_list,
         'Does not block the index. Review and merge if they are the same domain.'
  from dups_loose dl

  -- 7. Hostinger migration columns and objects --------------------------------
  union all
  select 700, '7.1',
         case when c.column_name is null then 'OK'
              when c.data_type = hc.expected_type
                or (hc.expected_type = 'text' and c.data_type = 'character varying') then
                case when c.is_nullable = 'NO' then 'WARN' else 'INFO' end
              else 'FAIL' end,
         'domains.' || hc.col,
         case when c.column_name is null then 'absent (the migration will add it)'
              else 'already exists: ' || c.data_type
                   || case when c.data_type = 'USER-DEFINED' then ' (' || c.udt_name || ')' else '' end
                   || ', nullable ' || c.is_nullable || coalesce(', default ' || c.column_default, '')
         end,
         'absent (OK), or already present as ' || hc.expected_type || ' and nullable (INFO: "add column if not exists" skips it). FAIL = different type; WARN = NOT NULL.'
  from hostinger_cols hc
  left join cols c on c.tbl = 'domains' and c.column_name = hc.col

  union all
  select 710, '7.2', 'INFO', 'domains: ' || k.conname, 'already exists: ' || k.def,
         'Usually absent. If present, the migration replaces it with its own definition.'
  from cons k
  where k.tbl = 'domains' and k.conname in ('domains_ownership_type_check', 'domains_provider_check')

  union all
  select 711, '7.2',
         case when i.indexname = 'domains_user_domain_name_key'
               and not (i.indisunique and i.indexdef ilike '%user_id%' and i.indexdef ilike '%lower(rtrim(%') then 'WARN'
              else 'INFO' end,
         'domains: ' || i.indexname, 'already exists: ' || i.indexdef,
         'Usually absent. If present, "if not exists" keeps the existing index as is; WARN = its definition differs from the migration''s.'
  from idx i
  where i.tbl = 'domains' and i.indexname in ('domains_user_provider_idx', 'domains_user_domain_name_key')

  -- 8. ownership_type compatibility -------------------------------------------
  union all
  select 800, '8.1', 'OK', 'domains.ownership_type', 'Column does not exist yet; the migration adds it as nullable text.',
         'This OK row (or the rows below all OK/INFO).'
  where not exists (select 1 from ot)

  union all
  select 801, '8.1',
         case when ot.data_type in ('text', 'character varying') then 'OK'
              when ot.data_type = 'USER-DEFINED'
               and (select array_agg(e.enumlabel::text) from pg_enum e join pg_type ty on ty.oid = e.enumtypid
                    where ty.typname = ot.udt_name) @> array['agency', 'client'] then 'WARN'
              else 'FAIL' end,
         'domains.ownership_type type',
         ot.data_type || case when ot.data_type = 'USER-DEFINED'
                              then ' ' || ot.udt_name || ' labels: '
                                   || coalesce((select string_agg(e.enumlabel::text, ', ' order by e.enumsortorder)
                                                from pg_enum e join pg_type ty on ty.oid = e.enumtypid
                                                where ty.typname = ot.udt_name), '?')
                              else '' end,
         'text or varchar. Enum containing agency and client works but WARN: tell me before running. Any other type: FAIL.'
  from ot

  union all
  select 802, '8.2',
         case when coalesce(v.bad, 0) = 0 then 'OK' else 'FAIL' end,
         'domains.ownership_type values',
         coalesce(v.bad, 0) || ' row(s) with a value other than agency/client/NULL. Distinct values: ' || coalesce(v.vals, '(none)'),
         '0. Otherwise the migration''s CHECK (agency, client) fails and the whole migration rolls back.'
  from ot
  cross join lateral (
    select
      (xpath('/row/n/text()', query_to_xml(
        'select count(*) as n from public.domains where ownership_type is not null and ownership_type::text not in (''agency'', ''client'')',
        false, true, '')))[1]::text::bigint as bad,
      (xpath('/row/v/text()', query_to_xml(
        'select string_agg(distinct coalesce(ownership_type::text, ''(null)''), '', '') as v from public.domains',
        false, true, '')))[1]::text as vals
  ) as v

  union all
  select 803, '8.3', case when ot.is_nullable = 'NO' then 'WARN' else 'OK' end,
         'domains.ownership_type nullability/default',
         'nullable ' || ot.is_nullable || coalesce(', default ' || ot.column_default, ', no default'),
         'nullable YES. NOT NULL would make "Not set" in the domain form fail.'
  from ot

  -- 9. Keys and constraints ----------------------------------------------------
  union all
  select 900, '9.1', case when exists (select 1 from cons k where k.tbl = t.tbl and k.contype = 'p') then 'OK' else 'FAIL' end,
         t.tbl || ' primary key',
         coalesce((select string_agg(k.conname || ': ' || k.def, '; ') from cons k where k.tbl = t.tbl and k.contype = 'p'), 'missing'),
         'PRIMARY KEY (id) on every table.'
  from tables t

  union all
  select 910, '9.2',
         case when exists (select 1 from cons k where k.tbl = f.tbl and k.contype = 'f' and k.ref_tbl = f.ref and k.def ilike 'FOREIGN KEY (' || f.col || ')%')
              then 'OK' else f.missing_status end,
         f.tbl || '.' || f.col || ' → ' || f.ref,
         coalesce((select string_agg(k.conname || ': ' || k.def, '; ') from cons k
                   where k.tbl = f.tbl and k.contype = 'f' and k.ref_tbl = f.ref and k.def ilike 'FOREIGN KEY (' || f.col || ')%'),
                  'missing'),
         f.safe
  from (values
    ('domains', 'client_id', 'clients', 'WARN', 'Present. The app blocks deleting a client that still has domains, but the FK guarantees it.'),
    ('domain_renewals', 'domain_id', 'domains', 'WARN', 'Present. The app blocks deleting a domain that still has renewals, but the FK guarantees it.'),
    ('clients', 'user_id', 'users', 'INFO', 'Optional: FK to auth.users(id). RLS enforces ownership either way.'),
    ('domains', 'user_id', 'users', 'INFO', 'Optional: FK to auth.users(id). RLS enforces ownership either way.'),
    ('domain_renewals', 'user_id', 'users', 'INFO', 'Optional: FK to auth.users(id). RLS enforces ownership either way.')
  ) as f(tbl, col, ref, missing_status, safe)

  union all
  select 920, '9.3',
         case when i.indexdef ilike '%domain_name%' and i.indexdef not ilike '%user_id%' then 'WARN' else 'INFO' end,
         'domains unique index ' || i.indexname, i.indexdef,
         'Unique indexes on domains should include user_id. WARN = domain names are unique across ALL users, so importing a domain another account has would fail.'
  from idx i
  where i.tbl = 'domains' and i.indisunique and i.indexname <> 'domains_user_domain_name_key'

  union all
  select 930, '9.4', case when x.n = 0 then 'OK' else 'WARN' end, x.obj, x.n || ' ' || x.what, x.safe
  from (
    select 'domains → clients' as obj,
           (select count(*) from public.domains d join public.clients c on c.id = d.client_id where c.user_id is distinct from d.user_id) as n,
           'domain(s) linked to a client owned by a different user' as what,
           '0. Otherwise, after hardening, editing those domains fails until the client link is fixed.' as safe
    union all
    select 'domain_renewals → domains',
           (select count(*) from public.domain_renewals r join public.domains d on d.id = r.domain_id where d.user_id is distinct from r.user_id),
           'renewal(s) linked to a domain owned by a different user',
           '0. Otherwise, after hardening, editing those renewals fails until fixed.'
  ) as x

  union all
  select 940, '9.5', case when x.n = 0 then 'OK' else 'WARN' end, x.obj, x.n || ' existing row(s) would violate this rule', x.safe
  from (
    select 'domains.status in (active, transferred, cancelled)' as obj,
           (select count(*) from public.domains where status is not null and status not in ('active', 'transferred', 'cancelled')) as n,
           '0. The hardening CHECK is NOT VALID, so the migration still runs, but those rows cannot be saved until corrected.' as safe
    union all
    select 'domain_renewals.status in (scheduled, invoiced, paid, cancelled)',
           (select count(*) from public.domain_renewals where status is not null and status not in ('scheduled', 'invoiced', 'paid', 'cancelled')),
           '0 (same as above).'
    union all
    select 'domain_renewals.currency is a 3-letter code',
           (select count(*) from public.domain_renewals where currency is not null and currency !~ '^[A-Z]{3}$'),
           '0 (same as above).'
    union all
    select 'domain_renewals amounts are not negative',
           (select count(*) from public.domain_renewals where coalesce(registrar_cost, 0) < 0 or coalesce(client_charge, 0) < 0),
           '0 (same as above).'
  ) as x
)

select check_no, status, object, detail, safe_result
from report
order by sort, object;
