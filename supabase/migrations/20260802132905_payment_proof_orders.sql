-- Manual GCash proof workflow. Receipt images and their hashes are deliberately
-- kept outside the public Data API: only the website's server-side service role
-- can read, write, or sign them for the authenticated admin dashboard.
create table if not exists public.payment_orders (
  id uuid primary key default gen_random_uuid(),
  account_id uuid references public.accounts (id) on delete set null,
  email text not null,
  customer_name text not null default '',
  plan_id text not null,
  plan_name text not null,
  period text not null default 'payg',
  amount_php integer not null check (amount_php > 0),
  status text not null default 'awaiting_proof'
    check (status in (
      'awaiting_proof',
      'upload_ready',
      'scanning',
      'review_required',
      'approval_processing',
      'approved',
      'rejected',
      'scan_failed'
    )),
  proof_path text,
  proof_mime text,
  proof_bytes integer check (proof_bytes is null or proof_bytes > 0),
  proof_sha256 text,
  receipt_reference_hash text,
  receipt_reference_masked text,
  scanner_model text,
  scan_status text not null default 'not_started'
    check (scan_status in ('not_started', 'upload_ready', 'scanning', 'passed', 'review_required', 'failed')),
  scan_confidence numeric(4,3) check (scan_confidence is null or (scan_confidence >= 0 and scan_confidence <= 1)),
  scan_summary text,
  scan_flags jsonb not null default '[]'::jsonb,
  scan_payload jsonb not null default '{}'::jsonb,
  review_reason text,
  license_key text,
  approval_actor text,
  approved_at timestamptz,
  rejected_at timestamptz,
  telegram_message_id bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists payment_orders_account_created_idx
  on public.payment_orders (account_id, created_at desc);

create index if not exists payment_orders_status_created_idx
  on public.payment_orders (status, created_at desc);

-- The hashes are recorded only after server-side validation. The partial unique
-- indexes make duplicate submission races safe even when two browsers submit at
-- the same time.
create unique index if not exists payment_orders_proof_sha256_unique
  on public.payment_orders (proof_sha256)
  where proof_sha256 is not null;

create unique index if not exists payment_orders_reference_hash_unique
  on public.payment_orders (receipt_reference_hash)
  where receipt_reference_hash is not null;

alter table public.payment_orders enable row level security;
revoke all on public.payment_orders from anon, authenticated;
grant all on public.payment_orders to service_role;

-- Private by default: users receive a narrowly scoped, short-lived upload URL
-- and the admin API creates a short-lived view URL only after verifying admin.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'payment-proofs',
  'payment-proofs',
  false,
  6291456,
  array['image/jpeg', 'image/png', 'image/webp']::text[]
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
