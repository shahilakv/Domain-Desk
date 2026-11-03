-- DomainDesk: read-only schema & security inspection.
-- Run in Supabase Dashboard → SQL Editor. Changes nothing.

-- 1. Is RLS enabled?
select relname as table_name, relrowsecurity as rls_enabled, relforcerowsecurity as rls_forced
from pg_class
where relnamespace = 'public'::regnamespace
  and relname in ('clients', 'domains', 'domain_renewals');

-- 2. Policies (look for anything granting access without user_id = auth.uid()).
select tablename, policyname, permissive, roles, cmd, qual as using_expr, with_check
from pg_policies
where schemaname = 'public' and tablename in ('clients', 'domains', 'domain_renewals')
order by tablename, policyname;

-- 3. Columns, types, nullability, defaults.
select table_name, column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name in ('clients', 'domains', 'domain_renewals')
order by table_name, ordinal_position;

-- 4. Constraints, including CHECK lists and foreign-key ON DELETE behaviour.
select conrelid::regclass as table_name, conname, pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid in ('public.clients'::regclass, 'public.domains'::regclass, 'public.domain_renewals'::regclass)
order by 1, 2;

-- 5. Table privileges for the API roles.
select table_name, grantee, string_agg(privilege_type, ', ' order by privilege_type) as privileges
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name in ('clients', 'domains', 'domain_renewals')
  and grantee in ('anon', 'authenticated')
group by 1, 2
order by 1, 2;

-- 6. Simulate another signed-in user: every count must be 0.
-- (Runs inside a transaction that is rolled back.)
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000000","role":"authenticated"}', true);
select
  (select count(*) from public.clients)         as clients_visible,
  (select count(*) from public.domains)         as domains_visible,
  (select count(*) from public.domain_renewals) as renewals_visible;
rollback;
