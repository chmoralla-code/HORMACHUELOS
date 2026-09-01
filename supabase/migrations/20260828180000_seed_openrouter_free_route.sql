-- Make the OpenRouter Free Router available to the hosted desktop catalog.
-- The provider credential remains write-only and must be saved through the
-- protected admin provider controls; never put an API key in a migration.
insert into public.hosted_model_configs (
  provider_id,
  alias,
  display_name,
  upstream_model,
  base_url,
  api_key_ciphertext,
  active
)
values (
  'openrouter',
  'hormachuelos-provider-profile-v1',
  'OpenRouter',
  'hormachuelos-provider-profile-v1',
  'https://openrouter.ai/api/v1',
  '',
  true
)
on conflict (provider_id, alias) do update set
  display_name = excluded.display_name,
  base_url = excluded.base_url,
  active = true,
  updated_at = now();

insert into public.hosted_model_configs (
  provider_id,
  alias,
  display_name,
  upstream_model,
  base_url,
  api_key_ciphertext,
  active
)
values (
  'openrouter',
  'openrouter/free',
  'OpenRouter Free Router',
  'openrouter/free',
  '',
  '',
  true
)
on conflict (provider_id, alias) do update set
  display_name = excluded.display_name,
  upstream_model = excluded.upstream_model,
  base_url = excluded.base_url,
  active = true,
  updated_at = now();
