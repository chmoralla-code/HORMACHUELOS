"""Focused browser smoke test for the hardened AI-Forge shell."""

import json
from pathlib import Path

from playwright.sync_api import sync_playwright


BASE_URL = "http://127.0.0.1:1420"
SCREENSHOT = Path(__file__).resolve().parents[1] / "test-results" / "updates-smoke-900x600.png"


def install_tauri_mock(page):
    settings = {
        "provider": "cursor",
        "model": "grok-4.5",
        "base_url": "https://api.cursor.com/v1",
        "max_iterations": 25,
        "command_timeout_secs": 120,
        "auto_approve": False,
        "permission_mode": "plan",
        "capability_mode": "thinking",
        "taglish": False,
        "computer_use_enabled": False,
        "smart_agent_enabled": True,
        "flavour_enabled": True,
        "model_effort": "high",
    }
    license_status = {
        "plan": "free",
        "active": True,
        "expiresAt": "",
        "email": "",
        "tokenBudget": 100000,
        "tokensUsed": 0,
        "topUpUrl": "",
        "message": "",
        "window4hUsed": 0,
        "window4hBudget": 100000,
        "windowWeekUsed": 0,
        "windowWeekBudget": 100000,
        "blockedBy": "",
    }
    page.add_init_script(
        """
        (() => {
          const callbacks = new Map();
          const settings = %s;
          const licenseStatus = %s;
          window.__testSettings = settings;
          window.__savedSettingsHistory = [];
          window.__delayOllamaDiscovery = false;
          window.__pendingOllamaDiscoveries = 0;
          window.__ollamaDiscoveryResolvers = [];
          window.__releaseOllamaDiscoveries = () => {
            window.__delayOllamaDiscovery = false;
            const resolvers = window.__ollamaDiscoveryResolvers.splice(0);
            for (const resolve of resolvers) resolve();
          };
          const invoke = async (cmd, args = {}) => {
            if (cmd === 'plugin:event|listen') return args.handler;
            if (cmd === 'plugin:event|unlisten') return null;
            if (cmd === 'get_settings') return {...settings};
            if (cmd === 'save_settings') {
              Object.assign(settings, args.settings || {});
              window.__savedSettingsHistory.push({...settings});
              return null;
            }
            if (cmd === 'get_computer_use_status') return {
              supported: true,
              paused: false,
              emergencyShortcut: 'Ctrl+Alt+Esc',
              emergencyShortcutAvailable: true,
            };
            if (cmd === 'get_license_status') return {...licenseStatus};
            if (cmd === 'get_project_root') return null;
            if (cmd === 'list_recent_projects') return [];
            if (cmd === 'list_integrations') return [];
            if (cmd === 'list_project_templates') return [];
            if (cmd === 'has_api_key') return false;
            if (cmd === 'list_provider_models') {
              if (args.provider !== 'ollama') return [];
              const models = ['deepseek-v4-flash', 'glm-5.1:cloud', 'glm-5.2:cloud'];
              if (!window.__delayOllamaDiscovery) return models;
              window.__pendingOllamaDiscoveries += 1;
              await new Promise((resolve) => {
                window.__ollamaDiscoveryResolvers.push(resolve);
              });
              window.__pendingOllamaDiscoveries -= 1;
              return models;
            }
            if (cmd === 'get_website_session') return 'desktop-test-session';
            if (cmd === 'app_version') return '0.1.5';
            return null;
          };
          window.__TAURI_INTERNALS__ = {
            invoke,
            transformCallback(callback, once = false) {
              const id = crypto.getRandomValues(new Uint32Array(1))[0];
              callbacks.set(id, (data) => {
                if (once) callbacks.delete(id);
                return callback && callback(data);
              });
              return id;
            },
            unregisterCallback(id) { callbacks.delete(id); },
            runCallback(id, data) {
              const callback = callbacks.get(id);
              if (callback) callback(data);
            },
            convertFileSrc(path) { return path; },
          };
          window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
            unregisterListener(_event, id) { callbacks.delete(id); },
          };
        })();
        """
        % (json.dumps(settings), json.dumps(license_status))
    )


def main():
    errors = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 900, "height": 600})
        install_tauri_mock(page)
        page.route(
            "https://hormachuelos.vercel.app/api/update?*",
            lambda route: route.fulfill(
                status=200,
                content_type="application/json",
                body=json.dumps(
                    {
                        "updateAvailable": False,
                        "forceUpdate": False,
                        "currentVersion": "0.1.5",
                        "latest": None,
                    }
                ),
            ),
        )
        page.route(
            "https://hormachuelos.vercel.app/api/auth/me",
            lambda route: route.fulfill(
                status=200,
                content_type="application/json",
                body=json.dumps(
                    {
                        "ok": True,
                        "user": {
                            "email": "desktop-test@example.com",
                            "plan": "free",
                        },
                    }
                ),
            ),
        )
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on(
            "console",
            lambda message: errors.append(message.text) if message.type == "error" else None,
        )
        page.goto(BASE_URL, wait_until="networkidle")

        overflow = page.evaluate(
            "Math.max(document.body.scrollWidth, document.documentElement.scrollWidth) - innerWidth"
        )
        assert overflow <= 1, f"page overflows the 900px viewport by {overflow}px"

        page.evaluate("window.__delayOllamaDiscovery = true")
        page.locator(".chip-model").click()
        page.locator(".chip-menu-provider", has_text="Ollama").click()
        page.wait_for_function("window.__pendingOllamaDiscoveries === 1")
        page.locator(".chip-model").click()
        page.locator(".chip-menu-provider", has_text="DeepSeek").click()
        page.wait_for_function("window.__testSettings.provider === 'deepseek'")
        page.evaluate("window.__releaseOllamaDiscoveries()")
        page.wait_for_function("window.__pendingOllamaDiscoveries === 0")
        page.wait_for_timeout(50)
        assert page.evaluate("window.__testSettings.provider") == "deepseek"
        assert page.evaluate("window.__savedSettingsHistory.at(-1).provider") == "deepseek"

        page.reload(wait_until="networkidle")

        page.locator(".chip-model").click()
        page.locator(".chip-menu-provider", has_text="Ollama").click()
        page.wait_for_function(
            "window.__savedSettingsHistory.some(s => s.provider === 'ollama')"
        )
        ollama_saves = page.evaluate(
            "window.__savedSettingsHistory.filter(s => s.provider === 'ollama')"
        )
        assert ollama_saves[0]["model"] in {
            "deepseek-v4-flash",
            "glm-5.1:cloud",
            "glm-5.2:cloud",
        }
        assert not any(saved["model"] == "llama3.2" for saved in ollama_saves)

        page.reload(wait_until="networkidle")

        files_tab = page.locator("#files-tab")
        files_tab.focus()
        files_tab.press("ArrowRight")
        assert page.locator("#changes-tab").get_attribute("aria-selected") == "true"
        assert page.locator("#changes-panel").is_visible()

        # The legacy full Settings modal is intentionally hidden. Runtime
        # controls live next to the composer, including the Flavour switch.
        assert page.locator(".sb-action", has_text="Settings").count() == 0
        add_button = page.get_by_role("button", name="Add modes and attachments")
        add_button.click()
        flavour_on = page.get_by_role("menuitem", name="Flavour memory — On")
        flavour_on.wait_for(state="visible")
        flavour_on.click()
        page.wait_for_function("window.__testSettings.flavour_enabled === false")
        assert page.evaluate("window.__savedSettingsHistory.at(-1).flavour_enabled") is False

        add_button.click()
        flavour_off = page.get_by_role("menuitem", name="Flavour memory — Off")
        flavour_off.wait_for(state="visible")
        flavour_off.click()
        page.wait_for_function("window.__testSettings.flavour_enabled === true")

        SCREENSHOT.parent.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(SCREENSHOT), full_page=True)
        assert not errors, "browser errors: " + " | ".join(errors)
        browser.close()

    print(f"UI smoke passed; screenshot: {SCREENSHOT}")


if __name__ == "__main__":
    main()
