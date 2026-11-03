-- DomainDesk: email + WhatsApp renewal reminders
--
-- Safe to run more than once. Adds columns to clients (all with safe defaults:
-- WhatsApp is opt-in and starts off for every existing client), two new
-- tables, three functions and one scheduled job. Existing rows and existing
-- policies are not changed.
--
-- Requires 20261104000000_hosting_renewals.sql.
--
-- Scheduling: pg_cron calls the renewal-reminders Edge Function every hour
-- through pg_net. The call is authenticated with a random secret generated
-- here and kept in Supabase Vault; it never leaves the database except in
-- that request header. Provider keys (Resend, WhatsApp) are Edge Function
-- secrets and are never stored in tables.

begin;

-- 0. Dependencies -----------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'domain_renewals' and column_name = 'hosting_plan_id'
  ) then
    raise exception 'Apply 20261104000000_hosting_renewals.sql first.';
  end if;
end;
$$;

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

-- 1. Client reminder preferences ---------------------------------------------
-- Email reminders go to clients.email unless the client opted out.
-- WhatsApp needs a number in international format AND recorded consent.

alter table public.clients add column if not exists email_reminders     boolean not null default true;
alter table public.clients add column if not exists whatsapp_number     text;
alter table public.clients add column if not exists whatsapp_opt_in     boolean not null default false;
alter table public.clients add column if not exists whatsapp_opt_in_at  timestamptz;

alter table public.clients drop constraint if exists clients_whatsapp_check;
alter table public.clients add constraint clients_whatsapp_check check (
  (whatsapp_number is null or whatsapp_number ~ '^\+[1-9][0-9]{7,14}$')
  and (not whatsapp_opt_in or whatsapp_number is not null)
);

-- 2. Reminder settings (one row per user) -------------------------------------

create table if not exists public.notification_settings (
  user_id                     uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  email_enabled               boolean not null default false,
  whatsapp_enabled            boolean not null default false,
  -- Days before the renewal date (0 = on the day, negative = days overdue).
  reminder_days               integer[] not null default '{30,15,7,3,0}',
  -- Reminders go out at or after this local hour in this time zone.
  send_hour                   integer not null default 9,
  timezone                    text not null default 'UTC',
  sender_name                 text,
  sender_email                text,
  reply_to_email              text,
  agency_name                 text,
  agency_email                text,
  agency_phone                text,
  agency_website              text,
  payment_instructions        text,
  whatsapp_template_name      text,
  whatsapp_template_language  text not null default 'en',
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz,

  constraint notification_settings_days_check check (
    cardinality(reminder_days) between 1 and 10
    and -60 <= all (reminder_days) and 365 >= all (reminder_days)
  ),
  constraint notification_settings_hour_check check (send_hour between 0 and 23),
  constraint notification_settings_timezone_check check (length(timezone) between 1 and 64),
  constraint notification_settings_emails_check check (
    (sender_email is null or sender_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')
    and (reply_to_email is null or reply_to_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')
    and (agency_email is null or agency_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')
  ),
  constraint notification_settings_lengths_check check (
    coalesce(length(sender_name), 0) <= 100
    and coalesce(length(agency_name), 0) <= 200
    and coalesce(length(agency_phone), 0) <= 50
    and coalesce(length(agency_website), 0) <= 200
    and coalesce(length(payment_instructions), 0) <= 2000
  ),
  constraint notification_settings_template_check check (
    (whatsapp_template_name is null or (whatsapp_template_name ~ '^[a-z0-9_]+$' and length(whatsapp_template_name) <= 512))
    and whatsapp_template_language ~ '^[a-z]{2,3}(_[A-Z]{2})?$'
  )
);

drop trigger if exists dd_set_updated_at on public.notification_settings;
create trigger dd_set_updated_at before update on public.notification_settings
  for each row execute function public.dd_set_updated_at();

alter table public.notification_settings enable row level security;
revoke all on public.notification_settings from anon;
grant select, insert, update, delete on public.notification_settings to authenticated;

drop policy if exists dd_owner_access on public.notification_settings;
create policy dd_owner_access on public.notification_settings
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists dd_owner_only on public.notification_settings;
create policy dd_owner_only on public.notification_settings
  as restrictive for all to public
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- 3. Notification log (history + duplicate guard) -----------------------------
-- Written only by the renewal-reminders Edge Function (service role). Users
-- can read their own rows and request a retry of a failed one; nothing else.

create table if not exists public.notification_log (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references auth.users (id) on delete cascade,
  -- Kept as history if the renewal is deleted later.
  renewal_id           uuid references public.domain_renewals (id) on delete set null,
  channel              text not null,
  -- Reminder stage: days before the renewal date (negative = overdue).
  stage                integer not null,
  due_date             date not null,
  target_kind          text not null,
  target_name          text not null,
  client_id            uuid references public.clients (id) on delete set null,
  client_name          text,
  recipient            text not null,
  amount               numeric(12, 2),
  currency             text,
  -- pending: being sent; accepted: the provider accepted it (not proof of
  -- delivery); delivered/read: confirmed by a provider webhook; failed.
  status               text not null default 'pending',
  retryable            boolean not null default false,
  attempts             integer not null default 0,
  last_attempt_at      timestamptz,
  next_attempt_at      timestamptz,
  retry_requested_at   timestamptz,
  provider_message_id  text,
  error                text,
  created_at           timestamptz not null default now(),
  sent_at              timestamptz,
  updated_at           timestamptz,

  constraint notification_log_channel_check check (channel in ('email', 'whatsapp')),
  constraint notification_log_target_check  check (target_kind in ('domain', 'hosting')),
  constraint notification_log_status_check  check (status in ('pending', 'accepted', 'delivered', 'read', 'failed')),
  -- One reminder per renewal, channel, stage and renewal date.
  constraint notification_log_once unique (renewal_id, channel, stage, due_date)
);

create index if not exists notification_log_user_created_idx on public.notification_log (user_id, created_at desc);
create index if not exists notification_log_provider_id_idx on public.notification_log (provider_message_id)
  where provider_message_id is not null;
create index if not exists notification_log_retry_idx on public.notification_log (next_attempt_at)
  where status = 'failed';

drop trigger if exists dd_set_updated_at on public.notification_log;
create trigger dd_set_updated_at before update on public.notification_log
  for each row execute function public.dd_set_updated_at();

alter table public.notification_log enable row level security;
revoke all on public.notification_log from anon, authenticated;
grant select on public.notification_log to authenticated;
grant update (retry_requested_at) on public.notification_log to authenticated;

drop policy if exists dd_owner_read on public.notification_log;
create policy dd_owner_read on public.notification_log
  for select to authenticated
  using (user_id = (select auth.uid()));

-- A retry can only be requested for the user's own failed reminders.
drop policy if exists dd_owner_retry on public.notification_log;
create policy dd_owner_retry on public.notification_log
  for update to authenticated
  using (user_id = (select auth.uid()) and status = 'failed')
  with check (user_id = (select auth.uid()) and status = 'failed');

drop policy if exists dd_owner_only on public.notification_log;
create policy dd_owner_only on public.notification_log
  as restrictive for all to public
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- 4. Reminder candidates (service role only) --------------------------------
-- Every unpaid (scheduled/invoiced) renewal with a date, for users who turned
-- a channel on, with its target and client contact details. Paid and
-- cancelled renewals, and renewals for transferred/cancelled domains or
-- cancelled hosting plans, are never returned.

create or replace function public.dd_reminder_candidates()
returns table (
  renewal_id        uuid,
  user_id           uuid,
  target_kind       text,
  target_name       text,
  provider          text,
  renewal_date      date,
  renewal_status    text,
  amount            numeric,
  currency          text,
  client_id         uuid,
  client_name       text,
  contact_name      text,
  email             text,
  email_reminders   boolean,
  whatsapp_number   text,
  whatsapp_opt_in   boolean
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    r.id,
    r.user_id,
    case when r.hosting_plan_id is not null then 'hosting' else 'domain' end,
    coalesce(h.plan_name, d.domain_name),
    h.provider,
    r.renewal_date,
    r.status,
    r.client_charge,
    r.currency,
    c.id,
    c.name,
    c.contact_name,
    c.email,
    coalesce(c.email_reminders, false),
    c.whatsapp_number,
    coalesce(c.whatsapp_opt_in, false)
  from public.domain_renewals r
  join public.notification_settings s on s.user_id = r.user_id and (s.email_enabled or s.whatsapp_enabled)
  left join public.domains d on d.id = r.domain_id and d.user_id = r.user_id
  left join public.hosting_plans h on h.id = r.hosting_plan_id and h.user_id = r.user_id
  left join public.clients c on c.id = coalesce(h.client_id, d.client_id) and c.user_id = r.user_id
  where r.status in ('scheduled', 'invoiced')
    and r.renewal_date is not null
    and (d.id is not null or h.id is not null)
    and (d.id is null or coalesce(d.status, 'active') = 'active')
    and (h.id is null or h.status <> 'cancelled');
$$;

revoke all on function public.dd_reminder_candidates() from public, anon, authenticated;
grant execute on function public.dd_reminder_candidates() to service_role;

-- 5. Scheduler secret --------------------------------------------------------

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'dd_reminders_cron_secret') then
    perform vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'hex'),
      'dd_reminders_cron_secret',
      'Authenticates the hourly pg_cron call to the renewal-reminders Edge Function.'
    );
  end if;
end;
$$;

-- The Edge Function checks the header it received against Vault; only the
-- service role may call this, and it returns a yes/no, never the secret.
create or replace function public.dd_check_reminders_secret(p_secret text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select s.decrypted_secret = p_secret and length(p_secret) >= 32
     from vault.decrypted_secrets s where s.name = 'dd_reminders_cron_secret' limit 1),
    false
  );
$$;

revoke all on function public.dd_check_reminders_secret(text) from public, anon, authenticated;
grant execute on function public.dd_check_reminders_secret(text) to service_role;

-- Scheduler health for the Notifications page: whether the job exists and
-- how its last run went. No secrets, no other users' data.
create or replace function public.dd_reminder_schedule_status()
returns table (scheduled boolean, schedule text, last_run_at timestamptz, last_run_status text)
language sql
stable
security definer
set search_path = ''
as $$
  select
    j.jobid is not null,
    j.schedule,
    d.start_time,
    d.status
  from (select 1) as one
  left join cron.job j on j.jobname = 'dd-renewal-reminders'
  left join lateral (
    select rd.start_time, rd.status from cron.job_run_details rd
    where rd.jobid = j.jobid order by rd.start_time desc limit 1
  ) d on true;
$$;

revoke all on function public.dd_reminder_schedule_status() from public, anon;
grant execute on function public.dd_reminder_schedule_status() to authenticated;

-- 6. Hourly job ----------------------------------------------------------------
-- Each run sends only what is due (per user time zone and send hour) and
-- retries failed sends on a back-off; duplicates are blocked by
-- notification_log_once. Re-running this file updates the job in place.

select cron.schedule(
  'dd-renewal-reminders',
  '15 * * * *',
  $job$
    select net.http_post(
      url := 'https://vzqogrcpzoumoavfhkyp.supabase.co/functions/v1/renewal-reminders',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-reminders-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'dd_reminders_cron_secret')
      ),
      body := '{"action":"run"}'::jsonb,
      timeout_milliseconds := 120000
    );
  $job$
);

commit;
