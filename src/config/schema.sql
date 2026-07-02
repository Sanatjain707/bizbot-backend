-- BizBot Database Schema (v6 — includes ai_enabled + billing columns)
-- Run in Supabase SQL Editor

create extension if not exists "uuid-ossp";

create table if not exists businesses (
  id                uuid primary key default uuid_generate_v4(),
  name              text not null,
  type              text default 'General',
  owner_name        text,
  whatsapp_phone_id text unique not null,
  services          text,
  pricing           text,
  working_hours     text default '9am - 8pm, Monday to Saturday',
  location          text,
  upi_id            text,
  ai_tone           text default 'friendly',
  ai_instructions   text,
  plan              text default 'none',
  plan_expires_at   timestamptz,
  razorpay_sub_id   text,
  hourly_capacity   int,                       -- null = unlimited concurrent bookings/hour
  created_at        timestamptz default now()
);

create table if not exists customers (
  id                uuid primary key default uuid_generate_v4(),
  business_id       uuid references businesses(id) on delete cascade,
  phone             text not null,
  name              text,
  last_seen         timestamptz default now(),
  total_visits      int default 0,
  ai_enabled        boolean default true,
  reengagement_sent boolean default false,
  created_at        timestamptz default now(),
  unique(business_id, phone)
);

create table if not exists messages (
  id          uuid primary key default uuid_generate_v4(),
  business_id uuid references businesses(id) on delete cascade,
  customer_id uuid references customers(id) on delete cascade,
  role        text not null check (role in ('user', 'assistant')),
  content     text not null,
  created_at  timestamptz default now()
);

create table if not exists appointments (
  id               uuid primary key default uuid_generate_v4(),
  business_id      uuid references businesses(id) on delete cascade,
  customer_id      uuid references customers(id) on delete cascade,
  service          text,
  appointment_time timestamptz not null,
  status           text default 'confirmed' check (status in ('confirmed','done','cancelled','no_show')),
  reminder_sent    boolean default false,
  notes            text,
  created_at       timestamptz default now()
);

create table if not exists payments (
  id            uuid primary key default uuid_generate_v4(),
  business_id   uuid references businesses(id) on delete cascade,
  customer_id   uuid references customers(id) on delete cascade,
  amount        numeric not null,
  description   text,
  due_date      timestamptz default now(),
  status        text default 'pending' check (status in ('pending','paid','cancelled')),
  reminder_sent boolean default false,
  paid_at       timestamptz,
  created_at    timestamptz default now()
);

create index if not exists idx_customers_business on customers(business_id);
create index if not exists idx_messages_customer_created on messages(customer_id, created_at desc);
create index if not exists idx_messages_business_created on messages(business_id, created_at desc);
create index if not exists idx_appointments_business_time on appointments(business_id, appointment_time);
create index if not exists idx_appointments_customer_status_time on appointments(customer_id, status, appointment_time);
create index if not exists idx_payments_business_status_due on payments(business_id, status, due_date);
create index if not exists idx_payments_customer_status on payments(customer_id, status);
create unique index if not exists uniq_appointments_customer_time_confirmed
  on appointments(customer_id, appointment_time) where status = 'confirmed';

alter table businesses enable row level security;
alter table customers enable row level security;
alter table messages enable row level security;
alter table appointments enable row level security;
alter table payments enable row level security;

-- MIGRATION: if upgrading from older schema, add new columns:
-- alter table customers add column if not exists ai_enabled boolean default true;
-- alter table businesses add column if not exists ai_tone text default 'friendly';
-- alter table businesses add column if not exists ai_instructions text;
