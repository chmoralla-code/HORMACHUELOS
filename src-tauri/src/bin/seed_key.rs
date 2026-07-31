use ai_forge_lib::config;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 2 {
        eprintln!("Usage: seed_key <provider>");
        eprintln!("  Reads the API key from stdin so it is not exposed in the process list.");
        eprintln!("Example: Get-Content env:PROVIDER_KEY | seed_key openrouter");
        std::process::exit(2);
    }
    let provider = &args[1];
    use std::io::Read;
    let mut buf = String::new();
    std::io::stdin().read_to_string(&mut buf).unwrap_or(0);
    let key = buf.trim().to_string();
    if key.is_empty() {
        eprintln!("Error: empty key provided");
        std::process::exit(1);
    }
    match config::store_api_key(provider, &key) {
        Ok(()) => println!("OK: API key for '{}' stored in OS keychain.", provider),
        Err(e) => {
            eprintln!("Error storing key for '{}': {}", provider, e);
            std::process::exit(1);
        }
    }
}
