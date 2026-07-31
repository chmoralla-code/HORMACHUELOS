create table if not exists public.app_releases (
  id uuid primary key default gen_random_uuid(),
  version text not null unique,
  title text not null default '',
  whats_new text not null default '',
  msi_url text,
  exe_url text,
  force_update boolean not null default false,
  is_latest boolean not null default false,
  published_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists app_releases_is_latest_idx on public.app_releases (is_latest) where is_latest = true;
create index if not exists app_releases_published_at_idx on public.app_releases (published_at desc);

alter table public.app_releases enable row level security;
revoke all on public.app_releases from anon, authenticated;
grant all on public.app_releases to service_role;

insert into public.app_releases (
  version, title, whats_new, msi_url, exe_url, force_update, is_latest
)
values (
  '0.1.0',
  'Hormachuelos 0.1.0',
  'Initial public release of Hormachuelos for Windows.',
  'https://mketkzycxmtvgdbwzsvh.supabase.co/storage/v1/object/public/public-assets/downloads/Hormachuelos_0.1.0_x64_en-US.msi',
  'https://mketkzycxmtvgdbwzsvh.supabase.co/storage/v1/object/public/public-assets/downloads/Hormachuelos_0.1.0_x64-setup.exe',
  false,
  true
)
on conflict (version) do nothing;
