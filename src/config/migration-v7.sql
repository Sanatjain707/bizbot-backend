-- BizBot schema v7 — indexes for query performance + duplicate protection
-- + per-hour capacity limit. Idempotent; safe to re-run.

-- Optional per-business concurrent-booking cap. null (default) = unlimited.
-- e.g. a salon with 2 chairs sets hourly_capacity = 2 → validator rejects
-- a third booking that falls in the same IST hour bucket.
alter table businesses add column if not exists hourly_capacity int;

-- Columns referenced by business.js / dashboard.js that pre-existed in code
-- but weren't declared in schema.sql. Idempotent for legacy DBs.
alter table businesses add column if not exists auth_user_id uuid;
alter table businesses add column if not exists email text;
alter table businesses add column if not exists waba_status text default 'pending';
alter table customers  add column if not exists opted_out boolean default false;

-- Look up businesses by owner. Speeds up the auth middleware's join.
create index if not exists idx_businesses_auth_user on businesses(auth_user_id);
create index if not exists idx_businesses_email_lower on businesses (lower(email));

-- Message queries always scope by customer_id + order by created_at (history + pagination).
create index if not exists idx_messages_customer_created
  on messages(customer_id, created_at desc);

-- Dashboard scopes by business_id and orders by created_at.
create index if not exists idx_messages_business_created
  on messages(business_id, created_at desc);

-- Appointment queries filter by business + time (today's list, calendar).
create index if not exists idx_appointments_business_time
  on appointments(business_id, appointment_time);

-- Reschedule/cancel path looks up by customer + status + time.
create index if not exists idx_appointments_customer_status_time
  on appointments(customer_id, status, appointment_time);

-- Payment queries.
create index if not exists idx_payments_business_status_due
  on payments(business_id, status, due_date);

create index if not exists idx_payments_customer_status
  on payments(customer_id, status);

-- Customer lookup by (business, phone) is used on every webhook — schema.sql
-- already has the unique constraint, so the index exists implicitly.

-- Duplicate-booking guard at the DB level.  A partial unique index on
-- confirmed rows lets the same slot exist again after a cancellation.
create unique index if not exists uniq_appointments_customer_time_confirmed
  on appointments(customer_id, appointment_time)
  where status = 'confirmed';

-- Fast keyset pagination for messages inside a conversation.
create index if not exists idx_messages_customer_id_id
  on messages(customer_id, id);

-- Booking-failure alerts. Every time the extractor or validator refuses to
-- create an appointment (capacity full, closed day, ambiguous input, LLM
-- error, etc.), we log the attempt so the business owner can act on it
-- manually. Bot already tells the customer "try another time" — this table
-- gives the owner visibility so they can close the loop.
create table if not exists booking_alerts (
  id                  uuid primary key default uuid_generate_v4(),
  business_id         uuid references businesses(id) on delete cascade,
  customer_id         uuid references customers(id) on delete cascade,
  reason              text not null,
  message_snippet     text,
  ai_reply_snippet    text,
  suggested_service   text,
  suggested_date      text,           -- YYYY-MM-DD in IST when known
  suggested_time      text,           -- HH:MM in 24h when known
  status              text default 'open' check (status in ('open','handled','dismissed')),
  handled_at          timestamptz,
  created_at          timestamptz default now()
);

create index if not exists idx_booking_alerts_biz_status_created
  on booking_alerts(business_id, status, created_at desc);
alter table booking_alerts enable row level security;

-- Plan pricing model changed from feature-tier (starter/growth/pro) to
-- period-based (quarterly/half_yearly/annual). Existing paid rows keep working
-- until plan_expires_at — customers just see their old key name until they
-- next renew. No column type change (plan is `text`), no data migration
-- required. Uncomment the block below only if you want to force everyone off
-- the old tier names immediately:
--   update businesses set plan = 'expired'
--    where plan in ('starter', 'growth', 'pro')
--      and (plan_expires_at is null or plan_expires_at < now());

-- Atomic visit-count bump — prevents lost updates on concurrent
-- "mark done" clicks. The client used to read total_visits, add 1, write
-- back; two racing writers both saw the same starting value.
create or replace function increment_customer_visits(p_customer_id uuid)
returns void as $$
  update customers set total_visits = coalesce(total_visits, 0) + 1
   where id = p_customer_id;
$$ language sql;
