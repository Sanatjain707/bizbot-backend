-- Template improvements migration (idempotent). Run in Supabase SQL Editor.

-- Stores the example values for a template's {{n}} variables, e.g.
-- { "body": ["Priya", "5000"], "header": "Diwali" }. Meta requires an example
-- per variable at submit time; we persist them so previews render filled-in.
alter table templates add column if not exists variable_examples jsonb default '{}'::jsonb;
