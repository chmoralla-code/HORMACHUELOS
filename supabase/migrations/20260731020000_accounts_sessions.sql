-- Custom email/password auth (no Supabase Auth / no email delivery)
create table if not exists public.accounts (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  password_hash text not null,
  name text not null default '',
  plan text,
  period text,
  credits integer not null default 0,
  license_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists sessions_account_idx on public.sessions (account_id);
create index if not exists accounts_email_idx on public.accounts (email);

create table if not exists public.web_orders (
  id uuid primary key default gen_random_uuid(),
  account_id uuid references public.accounts (id) on delete set null,
  email text,
  plan_id text not null,
  plan_name text,
  period text,
  amount_php integer not null default 0,
  method text,
  license_key text,
  demo boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.accounts enable row level security;
alter table public.sessions enable row level security;
alter table public.web_orders enable row level security;

revoke all on public.accounts from anon, authenticated;
revoke all on public.sessions from anon, authenticated;
revoke all on public.web_orders from anon, authenticated;
grant all on public.accounts to service_role;
grant all on public.sessions to service_role;
grant all on public.web_orders to service_role;
