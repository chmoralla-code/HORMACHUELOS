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

#[cfg(windows)]
fn install_kind_for_executable(executable: &Path) -> &'static str {
    let has_nsis_uninstaller = executable
        .parent()
        .is_some_and(|directory| directory.join("uninstall.exe").is_file());
    if has_nsis_uninstaller {
        "nsis"
    } else {
        // WiX/MSI installs do not bundle uninstall.exe. Portable development
        // copies also use MSI as the safer first installer family.
        "msi"
    }
}

#[tauri::command]
pub fn app_install_kind() -> &'static str {
    #[cfg(windows)]
    {
        std::env::current_exe()
            .ok()
            .as_deref()
            .map(install_kind_for_executable)
            .unwrap_or("msi")
    }
    #[cfg(not(windows))]
    {
        "unknown"
    }
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
    emit_progress(app, "downloading", None, "Downloading the update…");
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
fn install_helper_script() -> &'static str {
    r#"
param(
  [Parameter(Mandatory = $true)][ValidateRange(1, 2147483647)][int]$ParentProcessId,
  [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$InstallerPath,
  [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$AppPath,
  [Parameter(Mandatory = $true)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$ExpectedVersion,
  [Parameter(Mandatory = $true)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedSha256,
  [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$ReadyPath,
  [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$LogPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-UpdateLog {
  param([Parameter(Mandatory = $true)][string]$Message)
  try {
    $line = '{0} {1}' -f [DateTimeOffset]::Now.ToString('o'), $Message
    Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8
  } catch {}
}

function Get-HormachuelosCandidates {
  $candidates = @($AppPath)
  foreach ($manufacturerKey in @(
    'HKCU:\Software\Hormachuelos\Hormachuelos',
    'HKLM:\Software\Hormachuelos\Hormachuelos'
  )) {
    try {
      $item = Get-Item -LiteralPath $manufacturerKey -ErrorAction Stop
      $candidates += [string]$item.GetValue('')
      $candidates += [string]$item.GetValue('InstallDir')
    } catch {}
  }

  foreach ($uninstallRoot in @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
  )) {
    try {
      foreach ($key in Get-ChildItem -LiteralPath $uninstallRoot -ErrorAction Stop) {
        $entry = Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction SilentlyContinue
        if ($null -eq $entry) { continue }
        $displayNameProperty = $entry.PSObject.Properties['DisplayName']
        if ($null -ne $displayNameProperty -and [string]$displayNameProperty.Value -eq 'Hormachuelos') {
          $installLocationProperty = $entry.PSObject.Properties['InstallLocation']
          if ($null -ne $installLocationProperty) {
            $candidates += [string]$installLocationProperty.Value
          }
        }
      }
    } catch {}
  }

  foreach ($baseDirectory in @($env:ProgramW6432, $env:ProgramFiles)) {
    if (![string]::IsNullOrWhiteSpace($baseDirectory)) {
      $candidates += Join-Path -Path $baseDirectory -ChildPath 'Hormachuelos'
    }
  }
  if (![string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    $candidates += Join-Path -Path $env:LOCALAPPDATA -ChildPath 'Hormachuelos'
    $candidates += Join-Path -Path $env:LOCALAPPDATA -ChildPath 'Programs\Hormachuelos'
  }
  return $candidates
}

function Test-HormachuelosVersion {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][bool]$RequireExpectedVersion
  )
  if (!(Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
  if (!$RequireExpectedVersion) { return $true }
  try {
    $actualVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo($Path).ProductVersion
    if ([string]::IsNullOrWhiteSpace($actualVersion)) { return $false }
    return ([version]$actualVersion).ToString(3) -eq ([version]$ExpectedVersion).ToString(3)
  } catch {
    return $false
  }
}

function Resolve-HormachuelosPath {
  param([Parameter(Mandatory = $true)][bool]$RequireExpectedVersion)
  foreach ($candidateValue in Get-HormachuelosCandidates) {
    if ([string]::IsNullOrWhiteSpace($candidateValue)) { continue }
    $candidate = $candidateValue.Trim().Trim('"')
    if ([IO.Path]::GetExtension($candidate).ToLowerInvariant() -ne '.exe') {
      $candidate = Join-Path -Path $candidate -ChildPath 'ai-forge.exe'
    }
    if (Test-HormachuelosVersion -Path $candidate -RequireExpectedVersion $RequireExpectedVersion) {
      return $candidate
    }
  }
  return $null
}

function Assert-InstallerHash {
  $actualSha256 = (Get-FileHash -LiteralPath $InstallerPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualSha256 -ne $ExpectedSha256.ToLowerInvariant()) {
    throw 'The verified installer changed before it could be started.'
  }
}

function Test-HormachuelosRunning {
  param([Parameter(Mandatory = $true)][string]$Path)
  try { $expectedPath = [IO.Path]::GetFullPath($Path) } catch { return $false }
  foreach ($process in @(Get-Process -Name 'ai-forge' -ErrorAction SilentlyContinue)) {
    try {
      if ([IO.Path]::GetFullPath($process.Path) -ieq $expectedPath) { return $true }
    } catch {}
  }
  return $false
}

function Remove-UpdateHelperFiles {
  Remove-Item -LiteralPath $ReadyPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
}

function Open-PreviousHormachuelos {
  $fallbackPath = Resolve-HormachuelosPath -RequireExpectedVersion $false
  if (![string]::IsNullOrWhiteSpace($fallbackPath)) {
    try {
      Start-Process -FilePath $fallbackPath
      Write-UpdateLog "Reopened previous app after update failure: $fallbackPath"
    } catch {
      Write-UpdateLog "Previous app could not be reopened: $($_.Exception.Message)"
    }
  } else {
    Write-UpdateLog 'No runnable Hormachuelos executable was found after the update failure.'
  }
}

try {
  $logDirectory = Split-Path -Parent $LogPath
  if (![string]::IsNullOrWhiteSpace($logDirectory)) {
    [IO.Directory]::CreateDirectory($logDirectory) | Out-Null
  }
  if (!(Test-Path -LiteralPath $InstallerPath -PathType Leaf)) {
    throw "Verified installer is missing: $InstallerPath"
  }
  if (!(Test-Path -LiteralPath $AppPath -PathType Leaf)) {
    throw "Running application is missing: $AppPath"
  }
  Assert-InstallerHash
  Write-UpdateLog "Helper ready for Hormachuelos $ExpectedVersion."
  [IO.File]::WriteAllText(
    $ReadyPath,
    "ready:$ExpectedVersion",
    [Text.UTF8Encoding]::new($false)
  )
} catch {
  Write-UpdateLog "Helper initialization failed: $($_.Exception.Message)"
  exit 10
}

try {
  Wait-Process -Id $ParentProcessId -Timeout 120 -ErrorAction SilentlyContinue
} catch {}
if ($null -ne (Get-Process -Id $ParentProcessId -ErrorAction SilentlyContinue)) {
  Write-UpdateLog 'The running app did not close within 120 seconds; installation was cancelled.'
  Remove-UpdateHelperFiles
  exit 11
}

try {
  Assert-InstallerHash
} catch {
  Write-UpdateLog "Installer integrity check failed after app exit: $($_.Exception.Message)"
  Open-PreviousHormachuelos
  Remove-UpdateHelperFiles
  exit 13
}

$exitCode = -1
try {
  $extension = [IO.Path]::GetExtension($InstallerPath).ToLowerInvariant()
  Write-UpdateLog "Starting $extension installer."
  if ($extension -eq '.msi') {
    $quotedInstaller = '"' + $InstallerPath + '"'
    $result = Start-Process -FilePath 'msiexec.exe' -ArgumentList @(
      '/i', $quotedInstaller, '/passive', '/norestart',
      'AUTOLAUNCHAPP=True', 'LAUNCHAPPARGS=""'
    ) -Wait -PassThru
  } elseif ($extension -eq '.exe') {
    $result = Start-Process -FilePath $InstallerPath -ArgumentList @(
      '/P', '/UPDATE', '/R'
    ) -Wait -PassThru
  } else {
    throw "Unsupported installer type: $extension"
  }
  $exitCode = [int]$result.ExitCode
  Write-UpdateLog "Installer exited with code $exitCode."
} catch {
  Write-UpdateLog "Installer failed to start: $($_.Exception.Message)"
}

if ($exitCode -in @(0, 1641, 3010)) {
  if ($exitCode -in @(1641, 3010)) {
    Write-UpdateLog "Windows reported that a reboot may still be required (code $exitCode)."
  }
  $launchPath = Resolve-HormachuelosPath -RequireExpectedVersion $true
  if (![string]::IsNullOrWhiteSpace($launchPath)) {
    try {
      $nativeRestarted = $false
      for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
        if (Test-HormachuelosRunning -Path $launchPath) {
          $nativeRestarted = $true
          break
        }
        Start-Sleep -Milliseconds 250
      }
      if ($nativeRestarted) {
        Write-UpdateLog "Installer opened updated app: $launchPath"
      } else {
        $startedProcess = Start-Process -FilePath $launchPath -PassThru
        Start-Sleep -Milliseconds 500
        if ($startedProcess.HasExited) {
          throw "Updated app exited immediately with code $($startedProcess.ExitCode)."
        }
        Write-UpdateLog "Helper opened updated app: $launchPath"
      }
      Remove-Item -LiteralPath $InstallerPath -Force -ErrorAction SilentlyContinue
      Remove-UpdateHelperFiles
      exit 0
    } catch {
      Write-UpdateLog "Updated app could not be opened: $($_.Exception.Message)"
    }
  } else {
    Write-UpdateLog "Installer succeeded, but Hormachuelos $ExpectedVersion was not found."
  }
}

Open-PreviousHormachuelos
Remove-UpdateHelperFiles
exit 12
"#
}

#[cfg(windows)]
fn update_helper_log_path() -> Result<PathBuf, String> {
    let dirs = directories::ProjectDirs::from("com", "ai-forge", "AI-Forge")
        .ok_or_else(|| "Could not locate the Hormachuelos update log folder.".to_string())?;
    let directory = dirs.data_local_dir().join("logs");
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("Could not prepare the update log folder: {error}"))?;
    Ok(directory.join("update-helper.log"))
}

#[cfg(windows)]
struct InstallHelperCommand<'a> {
    helper_path: &'a Path,
    installer: &'a Path,
    current_exe: &'a Path,
    expected_version: &'a str,
    expected_sha256: &'a str,
    ready_path: &'a Path,
    log_path: &'a Path,
    parent_id: u32,
}

#[cfg(windows)]
fn install_helper_command(options: InstallHelperCommand<'_>) -> std::process::Command {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut command = std::process::Command::new("powershell.exe");
    command
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-WindowStyle",
            "Hidden",
            "-File",
        ])
        .arg(options.helper_path)
        .arg("-ParentProcessId")
        .arg(options.parent_id.to_string())
        .arg("-InstallerPath")
        .arg(options.installer)
        .arg("-AppPath")
        .arg(options.current_exe)
        .arg("-ExpectedVersion")
        .arg(options.expected_version)
        .arg("-ExpectedSha256")
        .arg(options.expected_sha256)
        .arg("-ReadyPath")
        .arg(options.ready_path)
        .arg("-LogPath")
        .arg(options.log_path)
        .creation_flags(CREATE_NO_WINDOW);
    command
}

#[cfg(windows)]
async fn launch_install_helper(
    installer: &Path,
    current_exe: &Path,
    expected_version: &str,
    expected_sha256: &str,
) -> Result<(), String> {
    let cache_directory = installer
        .parent()
        .ok_or_else(|| "The downloaded installer has no parent folder.".to_string())?;
    let process_id = std::process::id();
    let helper_path = cache_directory.join(format!("update-helper-{process_id}.ps1"));
    let ready_path = cache_directory.join(format!("update-helper-{process_id}.ready"));
    let log_path = update_helper_log_path()?;
    let _ = std::fs::remove_file(&ready_path);
    std::fs::write(&helper_path, install_helper_script())
        .map_err(|error| format!("Could not prepare the internal update helper: {error}"))?;

    let mut command = install_helper_command(InstallHelperCommand {
        helper_path: &helper_path,
        installer,
        current_exe,
        expected_version,
        expected_sha256,
        ready_path: &ready_path,
        log_path: &log_path,
        parent_id: process_id,
    });
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            let _ = std::fs::remove_file(&ready_path);
            let _ = std::fs::remove_file(&helper_path);
            return Err(format!(
                "Could not start the internal update helper: {error}"
            ));
        }
    };

    let expected_ready = format!("ready:{expected_version}");
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(8);
    loop {
        if let Ok(value) = std::fs::read_to_string(&ready_path) {
            if value.trim() == expected_ready {
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                if let Some(status) = child.try_wait().map_err(|error| {
                    format!("Could not monitor the internal update helper: {error}")
                })? {
                    let _ = std::fs::remove_file(&ready_path);
                    let _ = std::fs::remove_file(&helper_path);
                    return Err(format!(
                        "The update helper stopped before the app could close (exit code {}). Hormachuelos stayed open. Details: {}",
                        status.code().unwrap_or(-1),
                        log_path.display()
                    ));
                }
                let _ = std::fs::remove_file(&ready_path);
                return Ok(());
            }
        }
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("Could not monitor the internal update helper: {error}"))?
        {
            let _ = std::fs::remove_file(&ready_path);
            let _ = std::fs::remove_file(&helper_path);
            return Err(format!(
                "The update helper could not initialize (exit code {}). Hormachuelos stayed open. Details: {}",
                status.code().unwrap_or(-1),
                log_path.display()
            ));
        }
        if tokio::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            let _ = std::fs::remove_file(&ready_path);
            let _ = std::fs::remove_file(&helper_path);
            return Err(format!(
                "The update helper did not become ready. Hormachuelos stayed open. Details: {}",
                log_path.display()
            ));
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
}

#[cfg(not(windows))]
async fn launch_install_helper(
    _installer: &Path,
    _current_exe: &Path,
    _expected_version: &str,
    _expected_sha256: &str,
) -> Result<(), String> {
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
    emit_progress(app, "preparing", Some(0), "Preparing the secure update…");
    let installer = download_installer(app, url, extension, &version, &sha256).await?;
    emit_progress(
        app,
        "verifying",
        None,
        "Verifying the downloaded installer…",
    );
    let current_exe = std::env::current_exe()
        .map_err(|error| format!("Could not locate the running Hormachuelos app: {error}"))?;
    emit_progress(app, "installing", None, "Starting the internal installer…");
    launch_install_helper(&installer, &current_exe, &version, &sha256).await?;
    state.stop_all_runs();
    emit_progress(
        app,
        "restarting",
        None,
        "Opening the updated Hormachuelos app…",
    );
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
    UPDATE_RUNNING.store(false, Ordering::SeqCst);
    if result.is_err() {
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

    #[cfg(windows)]
    #[test]
    fn update_helper_uses_named_parameters_and_validates_the_restarted_version() {
        let script = super::install_helper_script();
        assert!(script.contains("param("));
        assert!(!script.contains("$args["));
        assert!(script.contains("[IO.File]::WriteAllText("));
        assert!(script.contains("ready:$ExpectedVersion"));
        assert!(script.contains("Assert-InstallerHash"));
        assert!(script.contains("Resolve-HormachuelosPath -RequireExpectedVersion $true"));
        assert!(script.contains("'/P', '/UPDATE', '/R'"));
        assert!(script.contains("'AUTOLAUNCHAPP=True'"));
        assert!(script.contains("Start-Process -FilePath $launchPath"));
        assert!(script.contains("update failure"));
    }

    #[cfg(windows)]
    #[test]
    fn update_helper_is_started_as_a_real_powershell_file() {
        let helper = std::path::Path::new(r"C:\Temp Folder\update-helper.ps1");
        let installer = std::path::Path::new(r"C:\Temp Folder\Hormachuelos update.exe");
        let app = std::path::Path::new(r"C:\Program Files\Hormachuelos\ai-forge.exe");
        let ready = std::path::Path::new(r"C:\Temp Folder\update.ready");
        let log = std::path::Path::new(r"C:\Temp Folder\update.log");
        let sha256 = "a".repeat(64);
        let command = super::install_helper_command(super::InstallHelperCommand {
            helper_path: helper,
            installer,
            current_exe: app,
            expected_version: "0.1.12",
            expected_sha256: &sha256,
            ready_path: ready,
            log_path: log,
            parent_id: 4321,
        });
        let args: Vec<String> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();

        assert_eq!(command.get_program(), "powershell.exe");
        assert!(args.iter().any(|arg| arg == "-File"));
        assert!(!args.iter().any(|arg| arg == "-Command"));
        let file_index = args.iter().position(|arg| arg == "-File").unwrap();
        assert_eq!(args[file_index + 1], helper.to_string_lossy());
        assert!(args
            .windows(2)
            .any(|pair| pair == ["-ParentProcessId", "4321"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["-InstallerPath", installer.to_string_lossy().as_ref()]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["-AppPath", app.to_string_lossy().as_ref()]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["-ExpectedVersion", "0.1.12"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["-ExpectedSha256", sha256.as_str()]));
    }

    #[cfg(windows)]
    #[test]
    fn detects_the_installed_windows_installer_family() {
        let directory = std::env::temp_dir().join(format!(
            "hormachuelos-install-kind-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let app = directory.join("ai-forge.exe");
        std::fs::write(&app, []).unwrap();

        assert_eq!(super::install_kind_for_executable(&app), "msi");
        std::fs::write(directory.join("uninstall.exe"), []).unwrap();
        assert_eq!(super::install_kind_for_executable(&app), "nsis");
        let _ = std::fs::remove_dir_all(directory);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn update_helper_failure_is_acknowledged_before_the_app_can_exit() {
        let directory = std::env::temp_dir().join(format!(
            "hormachuelos-update-helper-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let missing_installer = directory.join("missing-installer.exe");
        let current_exe = std::env::current_exe().unwrap();

        let error = super::launch_install_helper(
            &missing_installer,
            &current_exe,
            "9.9.9",
            &"a".repeat(64),
        )
        .await
        .unwrap_err();

        assert!(error.contains("exit code 10"), "{error}");
        assert!(error.contains("Hormachuelos stayed open"), "{error}");
        let _ = std::fs::remove_dir_all(directory);
    }
}
