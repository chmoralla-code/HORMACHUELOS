# AI-Forge — Model Selection + Real Logos

## Goal
Tweak the AI-Forge desktop app so the user can choose between three preconfigured model providers, each with its real brand logo shown in the Settings modal and header. The three providers and keys:

| # | Provider | API Key | Models | Base URL |
|---|----------|---------|--------|----------|
| 1 | DeepSeek | Stored in OS keychain | `deepseek-v4-flash`, `deepseek-v4-pro` | `https://api.deepseek.com` |
| 2 | OpenRouter (free models) | Stored in OS keychain | tool-capable free-tier list | `https://openrouter.ai/api/v1` |
| 3 | GLM / Z.AI | Stored in OS keychain | `glm-5.2` | `https://open.bigmodel.cn/api/paas/v4` |

DeepSeek's current lineup is **deepseek-v4-flash** for faster work and **deepseek-v4-pro** for more capable agentic tasks.

GLM 5.2 is served by the official Z.AI OpenAI-compatible endpoint.

## Approach

The app already supports OpenAI-compatible providers (`openai.rs` handles `openrouter`, `pollinations`). DeepSeek and GLM-cloud are also OpenAI-compatible, so the **Rust backend needs almost no changes** — they all reuse `OpenAi::new` with a custom `base_url` and `provider_kind`. The main work is **frontend**:

1. Replace the `PROVIDERS` list in `settings.ts` with the three target providers.
2. Add real brand logos (SVG) to `icons.ts` and display them next to each provider option and in the active-provider chip.
3. Make the header provider chip show the logo.
4. Keep keys out of the frontend bundle and save them only into the OS keychain.
5. Set sensible default models.

### Files to change

#### 1. `src/components/icons.ts` — add brand logos
Add a `logos` map with inline SVG paths (using `currentColor` so they fit the monochrome theme but keep each brand's recognizable mark). Logos:
- **DeepSeek** — the DeepSeek whale/dolphin mark.
- **OpenRouter** — the OpenRouter "OR" hexagon mark.
- **GLM / Zhipu** — the Zhipu/GLM mark.

Add a helper `logo(name)` returning a sized span.

#### 2. `src/components/settings.ts` — new provider list + logo rendering
Rewrite `PROVIDERS` to exactly the three target providers. Each entry gains a `logo` field. Render the logo:
- In the provider `<select>` (custom-styled option rows aren't supported cross-WebView, so instead render a **provider picker row** of clickable cards above/beside the model dropdown — each card shows logo + name).
- In the model section header.

Add the DeepSeek and GLM base URLs. Keep the existing "custom model" input.

Keep the API-key save/clear/status flow exactly as-is (it stores into the Windows keychain via `set_api_key`).

#### 3. `src/main.ts` — header chip shows logo
In `refreshHeader()`, look up the active provider's logo and prepend it to the `chip`.

#### 4. `src/ipc.ts` — update `Provider` type
Add `"deepseek" | "openrouter" | "glm"` (keep others for compat).

#### 5. `src-tauri/src/llm/mod.rs` — register new provider kinds
- `provider_needs_key`: all three need keys.
- `provider_default_base_url`: use `deepseek` → `https://api.deepseek.com`, `glm` → `https://open.bigmodel.cn/api/paas/v4`.
- `build_provider`: map `deepseek` and `glm` to `openai::OpenAi::new` (OpenAI-compatible) with their `provider_kind`.

#### 6. `src-tauri/src/llm/openai.rs` — default base URLs
Add `"deepseek"` and `"glm"` arms to the `default_base` match. GLM-cloud's Atomeocean endpoint supports OpenAI `chat/completions` + tool_calls, so no extra logic needed.

#### 7. `src/app.css` — provider card styles
Add `.provider-cards`, `.provider-card`, `.provider-card.active`, `.provider-card .logo` classes for the new provider picker.

#### 8. `src-tauri/src/config.rs` — default provider
Change `Default` to `provider: "deepseek"`, `model: "deepseek-v4-pro"` so first-run opens on DeepSeek's current agentic model.

## API keys handling

API keys must never be embedded, prefilled, logged, bundled, or returned to the webview. The user pastes a key once in Settings; Rust stores it in the Windows Credential Manager and exposes only save/status/clear operations. Any credentials previously placed in this file or frontend bundles must be revoked and rotated at the provider console.

## Build / verify

After edits:
1. `npm run build` — verify the frontend compiles (Vite + esbuild).
2. If feasible, `cargo build` inside `src-tauri` to verify Rust compiles. (Full `cargo tauri dev` requires a display; the build check is enough to catch compile errors.)
3. No new npm/cargo dependencies needed — all changes use existing stack.

## Out of scope
- Rebuilding the `.exe`/MSI installers (full `cargo tauri build`) — only requested a tweak.
- Persisting which model is "active" beyond the existing settings.json (already handled).
