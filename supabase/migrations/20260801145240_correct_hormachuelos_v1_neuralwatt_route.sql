update public.hosted_model_configs
set
  base_url = 'https://api.neuralwatt.com/v1',
  updated_at = now()
where provider_id = 'hormachuelos_free'
  and alias = 'hormachuelos-v1'
  and base_url = 'https://portal.neuralwatt.com/v1';
