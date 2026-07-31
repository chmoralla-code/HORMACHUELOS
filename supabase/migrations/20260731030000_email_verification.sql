alter table public.accounts add column if not exists email_verified boolean not null default false;

create table if not exists public.email_verifications (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id) on delete cascade,
  email text not null,
  code_hash text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists email_verifications_account_idx on public.email_verifications (account_id);
create index if not exists email_verifications_email_idx on public.email_verifications (email);

alter table public.email_verifications enable row level security;
revoke all on public.email_verifications from anon, authenticated;
grant all on public.email_verifications to service_role;
