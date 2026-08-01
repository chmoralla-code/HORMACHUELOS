use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;

const MAX_BACKUP_BYTES: usize = 64 * 1024 * 1024;
const MAX_INSTALLER_BYTES: u64 = 300 * 1024 * 1024;
const MIN_INSTALLER_BYTES: u64 = 1024 * 1024;
static UPDATE_RUNNING: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppUpdateProgress<'a> {
    phase: &'a str,
    percent: Option<u8>,
    message: &'a str,
}

fn emit_progress(app: &AppHandle, phase: &'static str, percent: Option<u8>, message: &'static str) {
    let _ = app.emit(
        "app-update-progress",
        AppUpdateProgress {
            phase,
            percent,
            message,
        },
    );
}

fn update_backup_path() -> Result<PathBuf, String> {
    let dirs = directories::ProjectDirs::from("com", "ai-forge", "AI-Forge")
        .ok_or_else(|| "Could not locate the persistent Hormachuelos data folder.".to_string())?;
    let dir = dirs.config_dir();
    std::fs::create_dir_all(dir)
        .map_err(|error| format!("Could not prepare the update backup folder: {error}"))?;
    Ok(dir.join("update-state-backup.json"))
}

fn update_cache_path(version: &str, extension: &str) -> Result<PathBuf, String> {
    let dirs = directories::ProjectDirs::from("com", "ai-forge", "AI-Forge")
        .ok_or_else(|| "Could not locate the Hormachuelos update cache.".to_string())?;
    let dir = dirs.cache_dir().join("updates");
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("Could not prepare the update cache: {error}"))?;
    Ok(dir.join(format!("Hormachuelos_{version}_x64-update.{extension}")))
}

#[tauri::command]
pub fn save_update_backup(state_json: String) -> Result<(), String> {
    if state_json.is_empty() || state_json.len() > MAX_BACKUP_BYTES {
        return Err("The local update backup is empty or too large.".into());
    }
    let value: serde_json::Value = serde_json::from_str(&state_json)
        .map_err(|_| "The local update backup is not valid JSON.".to_string())?;
    if value.get("format").and_then(serde_json::Value::as_u64) != Some(1)
        || !value
            .get("entries")
            .is_some_and(serde_json::Value::is_object)
    {
        return Err("The local update backup has an unsupported format.".into());
    }

    let path = update_backup_path()?;
    let pending = path.with_extension("pending");
    std::fs::write(&pending, state_json.as_bytes())
        .map_err(|error| format!("Could not save local data before updating: {error}"))?;
    if path.exists() {
        std::fs::remove_file(&path)
            .map_err(|error| format!("Could not replace the previous update backup: {error}"))?;
    }
    std::fs::rename(&pending, &path)
        .map_err(|error| format!("Could not finalize the local update backup: {error}"))?;
    Ok(())
}

#[tauri::command]
pub fn load_update_backup() -> Result<Option<String>, String> {
    let path = update_backup_path()?;
    if !path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&path)
        .map_err(|error| format!("Could not restore local data after updating: {error}"))?;
    Ok(Some(raw))
}

#[tauri::command]
pub fn clear_update_backup() -> Result<(), String> {
    let path = update_backup_path()?;
    if !path.exists() {
        return Ok(());
    }
    std::fs::remove_file(&path)
        .map_err(|error| format!("Could not clear the restored update backup: {error}"))
}

fn parse_version(version: &str) -> Result<[u64; 3], String> {
    let version = version.trim().trim_start_matches('v');
    let parts: Vec<&str> = version.split('.').collect();
    if parts.len() != 3
        || parts
            .iter()
            .any(|part| part.is_empty() || !part.chars().all(|ch| ch.is_ascii_digit()))
    {
        return Err("The update version is invalid.".into());
    }
    Ok([
        parts[0]
            .parse()
            .map_err(|_| "The update version is invalid.")?,
        parts[1]
            .parse()
            .map_err(|_| "The update version is invalid.")?,
        parts[2]
            .parse()
            .map_err(|_| "The update version is invalid.")?,
    ])
}

fn validate_version(version: &str) -> Result<String, String> {
    parse_version(version)?;
    Ok(version.trim().trim_start_matches('v').to_string())
}

fn validate_sha256(expected_sha256: &str) -> Result<String, String> {
    let checksum = expected_sha256.trim().to_ascii_lowercase();
    if checksum.len() != 64 || !checksum.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return Err("The release manifest has an invalid installer checksum.".into());
    }
    Ok(checksum)
}

fn validate_download_url(
    download_url: &str,
    version: &str,
) -> Result<(reqwest::Url, &'static str), String> {
    let url = reqwest::Url::parse(download_url)
        .map_err(|_| "The update download URL is invalid.".to_string())?;
    if url.scheme() != "https"
        || url.port_or_known_default() != Some(443)
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Updates must use a trusted HTTPS download URL.".into());
    }
    let trusted = matches!(
        url.host_str()
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str(),
        "hormachuelos.vercel.app" | "mketkzycxmtvgdbwzsvh.supabase.co"
    );
    if !trusted {
        return Err("The update download host is not trusted.".into());
    }
    let filename = url
        .path_segments()
        .and_then(|mut segments| segments.next_back())
        .unwrap_or_default();
    let exe_name = format!("Hormachuelos_{version}_x64-setup.exe");
    let msi_name = format!("Hormachuelos_{version}_x64_en-US.msi");
    if filename.eq_ignore_ascii_case(&exe_name) {
        Ok((url, "exe"))
    } else if filename.eq_ignore_ascii_case(&msi_name) {
        Ok((url, "msi"))
    } else {
        Err("The update filename does not match the published version.".into())
    }
}

fn has_expected_file_header(path: &Path, extension: &str) -> Result<bool, String> {
    let mut file = std::fs::File::open(path)
        .map_err(|error| format!("Could not verify the downloaded installer: {error}"))?;
    let mut prefix = [0_u8; 8];
    let read = file
        .read(&mut prefix)
        .map_err(|error| format!("Could not verify the downloaded installer: {error}"))?;
    let valid = if extension == "exe" {
        read >= 2 && prefix.starts_with(b"MZ")
    } else {
        read == prefix.len() && prefix == [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]
    };
    Ok(valid)
}

async fn download_installer(
    app: &AppHandle,
    url: reqwest::Url,
    extension: &str,
    version: &str,
    expected_sha256: &str,
) -> Result<PathBuf, String> {
    let path = update_cache_path(version, extension)?;
    let pending = path.with_extension(format!("{extension}.part"));
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(std::time::Duration::from_secs(20))
        .timeout(std::time::Duration::from_secs(20 * 60))
        .build()
        .map_err(|error| format!("Could not initialize the update download: {error}"))?;
    let mut response = client
        .get(url)
        .header(reqwest::header::ACCEPT, "application/octet-stream")
        .send()
        .await
        .map_err(|error| format!("Could not download the update: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "The update server returned HTTP {}.",
            response.status().as_u16()
        ));
    }
    if response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            let value = value.to_ascii_lowercase();
            value.contains("text/html") || value.contains("application/json")
        })
    {
        return Err("The update server returned a web page instead of an installer.".into());
    }
    let total = response.content_length();
    if total.is_some_and(|bytes| bytes > MAX_INSTALLER_BYTES) {
        return Err("The update installer is larger than the allowed limit.".into());
    }

    let mut file = tokio::fs::File::create(&pending)
        .await
        .map_err(|error| format!("Could not create the temporary installer: {error}"))?;
    let mut downloaded = 0_u64;
    let mut last_percent = 0_u8;
    let mut digest = Sha256::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("The update download was interrupted: {error}"))?
    {
        downloaded = downloaded.saturating_add(chunk.len() as u64);
        if downloaded > MAX_INSTALLER_BYTES {
            let _ = tokio::fs::remove_file(&pending).await;
            return Err("The update installer exceeded the allowed limit.".into());
        }
        digest.update(&chunk);
        file.write_all(&chunk)
            .await
            .map_err(|error| format!("Could not save the update installer: {error}"))?;
        if let Some(total) = total.filter(|total| *total > 0) {
            let percent = ((downloaded.saturating_mul(100) / total).min(100)) as u8;
            if percent >= last_percent.saturating_add(2) {
                last_percent = percent;
                emit_progress(app, "downloading", Some(percent), "Downloading update…");
            }
        }
    }
    file.flush()
        .await
        .map_err(|error| format!("Could not finalize the update installer: {error}"))?;
    file.sync_all()
        .await
        .map_err(|error| format!("Could not synchronize the update installer: {error}"))?;
    drop(file);
    let actual_sha256 = format!("{:x}", digest.finalize());
    if actual_sha256 != expected_sha256 {
        let _ = tokio::fs::remove_file(&pending).await;
        return Err("The installer checksum does not match the published release manifest.".into());
    }
    if downloaded < MIN_INSTALLER_BYTES || !has_expected_file_header(&pending, extension)? {
        let _ = tokio::fs::remove_file(&pending).await;
        return Err("The downloaded file is not a valid Hormachuelos Windows installer.".into());
    }
    if path.exists() {
        tokio::fs::remove_file(&path)
            .await
            .map_err(|error| format!("Could not replace the previous update installer: {error}"))?;
    }
    tokio::fs::rename(&pending, &path)
        .await
        .map_err(|error| format!("Could not finalize the update installer: {error}"))?;
    Ok(path)
}

#[cfg(windows)]
fn launch_install_helper(installer: &Path, current_exe: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let parent_id = std::process::id().to_string();
    let script = r#"
$ErrorActionPreference = 'Stop'
$parentProcessId = [int]$args[0]
$installerPath = $args[1]
$appPath = $args[2]
try { Wait-Process -Id $parentProcessId -Timeout 120 -ErrorAction SilentlyContinue } catch {}
$exitCode = 1
try {
  if ([IO.Path]::GetExtension($installerPath).ToLowerInvariant() -eq '.msi') {
    $quotedInstaller = '"' + $installerPath + '"'
    $result = Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/i', $quotedInstaller, '/passive', '/norestart', 'AUTOLAUNCHAPP=True', 'LAUNCHAPPARGS=""') -Wait -PassThru
  } else {
    $result = Start-Process -FilePath $installerPath -ArgumentList @('/P', '/UPDATE', '/R') -Wait -PassThru
  }
  $exitCode = $result.ExitCode
} catch {}
if ($exitCode -eq 0 -or $exitCode -eq 3010) {
  Remove-Item -LiteralPath $installerPath -Force -ErrorAction SilentlyContinue
} else {
  try { Start-Process -FilePath $appPath } catch {}
}
"#;

    std::process::Command::new("powershell.exe")
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-Command",
            script,
            &parent_id,
        ])
        .arg(installer)
        .arg(current_exe)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|error| format!("Could not start the internal update installer: {error}"))?;
    Ok(())
}

#[cfg(not(windows))]
fn launch_install_helper(_installer: &Path, _current_exe: &Path) -> Result<(), String> {
    Err("Internal updates are currently supported on Windows only.".into())
}

async fn install_app_update_inner(
    app: &AppHandle,
    state: &crate::state::AppState,
    download_url: String,
    version: String,
    sha256: String,
) -> Result<(), String> {
    let version = validate_version(&version)?;
    let sha256 = validate_sha256(&sha256)?;
    let current_version = app.package_info().version.to_string();
    if parse_version(&version)? <= parse_version(&current_version)? {
        return Err(format!(
            "Hormachuelos v{version} is not newer than the installed v{current_version}."
        ));
    }
    if !update_backup_path()?.exists() {
        return Err("Local data must be backed up before installing an update.".into());
    }
    let (url, extension) = validate_download_url(&download_url, &version)?;
    emit_progress(app, "preparing", Some(0), "Preparing the internal update…");
    let installer = download_installer(app, url, extension, &version, &sha256).await?;
    emit_progress(
        app,
        "verifying",
        Some(100),
        "Verifying the Windows installer…",
    );
    let current_exe = std::env::current_exe()
        .map_err(|error| format!("Could not locate the running Hormachuelos app: {error}"))?;
    state.stop_all_runs();
    emit_progress(
        app,
        "installing",
        Some(100),
        "Starting the internal installer…",
    );
    launch_install_helper(&installer, &current_exe)?;
    emit_progress(app, "restarting", Some(100), "Restarting Hormachuelos…");
    tokio::time::sleep(std::time::Duration::from_millis(350)).await;
    app.exit(0);
    Ok(())
}

#[tauri::command]
pub async fn install_app_update(
    app: AppHandle,
    state: tauri::State<'_, crate::state::AppState>,
    download_url: String,
    version: String,
    sha256: String,
) -> Result<(), String> {
    if UPDATE_RUNNING.swap(true, Ordering::SeqCst) {
        return Err("An app update is already running.".into());
    }
    let result = install_app_update_inner(&app, &state, download_url, version, sha256).await;
    if result.is_err() {
        UPDATE_RUNNING.store(false, Ordering::SeqCst);
        emit_progress(
            &app,
            "error",
            None,
            "The internal update could not be completed.",
        );
    }
    result
}

#[cfg(test)]
mod tests {
    use super::{validate_download_url, validate_sha256, validate_version};

    #[test]
    fn accepts_only_plain_semver_versions() {
        assert_eq!(validate_version("v0.1.9").unwrap(), "0.1.9");
        assert!(validate_version("0.1").is_err());
        assert!(validate_version("0.1.9;calc").is_err());
    }

    #[test]
    fn requires_a_full_sha256_checksum() {
        assert!(validate_sha256(&"a".repeat(64)).is_ok());
        assert!(validate_sha256("abc123").is_err());
        assert!(validate_sha256(&"z".repeat(64)).is_err());
    }

    #[test]
    fn restricts_updates_to_owned_https_hosts_and_installer_types() {
        assert!(validate_download_url(
            "https://hormachuelos.vercel.app/downloads/Hormachuelos_0.1.9_x64-setup.exe",
            "0.1.9"
        )
        .is_ok());
        assert!(validate_download_url(
            "https://mketkzycxmtvgdbwzsvh.supabase.co/storage/v1/object/public/public-assets/downloads/Hormachuelos_0.1.9_x64_en-US.msi",
            "0.1.9"
        )
        .is_ok());
        assert!(validate_download_url(
            "http://hormachuelos.vercel.app/downloads/Hormachuelos_0.1.9_x64-setup.exe",
            "0.1.9"
        )
        .is_err());
        assert!(validate_download_url(
            "https://example.com/Hormachuelos_0.1.9_x64-setup.exe",
            "0.1.9"
        )
        .is_err());
        assert!(validate_download_url(
            "https://hormachuelos.vercel.app/downloads/Hormachuelos_0.1.8_x64-setup.exe",
            "0.1.9"
        )
        .is_err());
    }
}
