create table if not exists public.hosted_model_configs (
  id uuid primary key default gen_random_uuid(),
  provider_id text not null default 'hormachuelos_free',
  alias text not null,
  display_name text not null,
  upstream_model text not null,
  base_url text not null,
  api_key_ciphertext text not null default '',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint hosted_model_configs_provider_alias_key unique (provider_id, alias)
);

create index if not exists hosted_model_configs_provider_active_idx
  on public.hosted_model_configs (provider_id, active, updated_at desc);

alter table public.hosted_model_configs enable row level security;
revoke all on public.hosted_model_configs from anon, authenticated;
grant all on public.hosted_model_configs to service_role;

insert into public.hosted_model_configs (
  provider_id, alias, display_name, upstream_model, base_url, api_key_ciphertext, active
)
values
  (
    'hormachuelos_free',
    'hormachuelos-v1',
    'Hormachuelos v1',
    'deepseek-v4-flash',
    'https://api.neuralwatt.com/v1',
    '',
    true
  ),
  (
    'hormachuelos_free',
    'hormachuelos-v2',
    'Hormachuelos v2',
    'deepseek-v4-flash',
    'https://opencode.ai/zen/go/v1',
    '',
    true
  )
on conflict (provider_id, alias) do update set
  display_name = excluded.display_name,
  updated_at = now();
