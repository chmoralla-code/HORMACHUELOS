create table if not exists public.device_links (
  id uuid primary key default gen_random_uuid(),
  user_code text not null unique,
  device_code text not null unique,
  status text not null default 'pending',
  account_id uuid references public.accounts (id) on delete cascade,
  session_token text,
  session_token_hash text,
  expires_at timestamptz not null,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists device_links_device_code_idx on public.device_links (device_code);
alter table public.device_links enable row level security;
revoke all on public.device_links from anon, authenticated;
grant all on public.device_links to service_role;
