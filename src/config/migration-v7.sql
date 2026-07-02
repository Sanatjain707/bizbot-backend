-- BizBot schema v7 — indexes for query performance + duplicate protection.
-- Idempotent; safe to re-run.

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
