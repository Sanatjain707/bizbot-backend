-- WhatsApp cost tracking migration (idempotent). Run in Supabase SQL Editor.

-- Per-recipient billing, captured from Meta's status-webhook `pricing` object.
-- billable_category is the category Meta actually charged (marketing/utility/…).
alter table campaign_recipients add column if not exists billable         boolean;
alter table campaign_recipients add column if not exists billable_category text;

-- Real (not estimated) campaign cost, rolled up from the recipients above.
alter table campaigns add column if not exists actual_cost numeric default 0;
