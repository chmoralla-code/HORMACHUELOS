alter table public.app_releases
  add column if not exists msi_sha256 text,
  add column if not exists exe_sha256 text;

alter table public.app_releases
  drop constraint if exists app_releases_msi_sha256_format,
  add constraint app_releases_msi_sha256_format
    check (msi_sha256 is null or msi_sha256 ~ '^[a-f0-9]{64}$');

alter table public.app_releases
  drop constraint if exists app_releases_exe_sha256_format,
  add constraint app_releases_exe_sha256_format
    check (exe_sha256 is null or exe_sha256 ~ '^[a-f0-9]{64}$');
