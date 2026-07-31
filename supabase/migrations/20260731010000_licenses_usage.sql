-- Hosted licenses + usage metering (service_role only)
create table if not exists public.licenses (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  plan text not null,
  email text,
  token_budget bigint not null default 5500000,
  tokens_used bigint not null default 0,
  active boolean not null default true,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  meta jsonb not null default '{}'::jsonb
);

create index if not exists licenses_email_idx on public.licenses (email);
create index if not exists licenses_active_idx on public.licenses (active);

create table if not exists public.usage_events (
  id uuid primary key default gen_random_uuid(),
  license_id uuid references public.licenses (id) on delete cascade,
  provider text,
  model text,
  raw_tokens bigint not null default 0,
  billable_tokens bigint not null default 0,
  created_at timestamptz not null default now()
);

alter table public.licenses enable row level security;
alter table public.usage_events enable row level security;

revoke all on public.licenses from anon, authenticated;
revoke all on public.usage_events from anon, authenticated;
grant all on public.licenses to service_role;
grant all on public.usage_events to service_role;
