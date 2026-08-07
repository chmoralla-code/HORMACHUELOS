-- Per-user hosted provider / model allowlists for admin dashboard control.
-- null = no custom restriction (plan-based catalog continues to apply).
-- empty allowed_providers array = restrict to none of the hosted providers.

alter table public.accounts
  add column if not exists allowed_providers text[] null,
  add column if not exists allowed_models jsonb null;

comment on column public.accounts.allowed_providers is
  'Optional allowlist of hosted provider ids. null = unrestricted (plan defaults).';

comment on column public.accounts.allowed_models is
  'Optional map of provider_id -> model alias array (or ["*"]). null/{} = all active models for allowed providers.';
