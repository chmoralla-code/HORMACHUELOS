-- Hormachuelos profiles + orders (applied remotely 2026-07-31)
create extension if not exists "pgcrypto";

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text unique,
  name text,
  plan text default 'none',
  credits integer default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users (id) on delete set null,
  email text,
  plan text not null,
  amount_php integer not null,
  status text not null default 'pending',
  payment_method text,
  license_key text,
  meta jsonb default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
alter table public.orders enable row level security;
