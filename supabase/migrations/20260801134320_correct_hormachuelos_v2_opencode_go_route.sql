-- Correct the original V2 seed without overwriting a route an administrator
-- has intentionally changed in the hosted model dashboard.
update public.hosted_model_configs
set
  base_url = 'https://opencode.ai/zen/go/v1',
  upstream_model = 'deepseek-v4-flash',
  updated_at = now()
where provider_id = 'hormachuelos_free'
  and alias = 'hormachuelos-v2'
  and base_url = 'https://opencode.ai/zen/v1';
