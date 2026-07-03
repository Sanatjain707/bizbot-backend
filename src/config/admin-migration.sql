-- BizBot Admin Console migration (idempotent). Run in Supabase SQL Editor.

-- Suspend flag: an operator can pause a business (AI stops replying) without
-- touching their plan/expiry. isPlanActive() treats suspended = inactive.
alter table businesses add column if not exists suspended boolean not null default false;

-- Ensure a created_at exists for signup sorting / recent-signups (older rows
-- may predate it). Backfills nothing; new rows default to now().
alter table businesses add column if not exists created_at timestamptz default now();

-- Audit trail for every admin action (plan change, suspend, waba flip, etc.).
create table if not exists admin_audit_log (
  id                 uuid primary key default gen_random_uuid(),
  admin_email        text not null,
  action             text not null,
  target_business_id uuid references businesses(id) on delete set null,
  detail             jsonb,
  created_at         timestamptz not null default now()
);

create index if not exists idx_admin_audit_created on admin_audit_log(created_at desc);
create index if not exists idx_businesses_created  on businesses(created_at desc);
