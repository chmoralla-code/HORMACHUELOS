"""
AI-Forge — Comprehensive Playwright UI Test Suite
Tests the web frontend served by Vite at http://localhost:1420
Note: Tauri IPC calls won't work outside the webview, so we test the DOM
structure, CSS rendering, interactive elements, and catch JS errors.
"""
import json, sys, time, os
from playwright.sync_api import sync_playwright

BASE = "http://localhost:1420"
SCREENSHOT_DIR = os.path.join(os.path.dirname(__file__), "test_screenshots")
os.makedirs(SCREENSHOT_DIR, exist_ok=True)

results = []
console_errors = []

def install_tauri_mock(page, recent=None):
    recent = recent or []
    page.add_init_script(f"""
    (() => {{
      const callbacks = new Map();
      const tree = {{ nodes: [
        {{ name: 'src', path: 'src', isDir: true, size: 0, modifiedMs: 1, truncated: false, children: [
          {{ name: 'main.ts', path: 'src/main.ts', isDir: false, size: 42, modifiedMs: 2, truncated: false, children: [] }},
          {{ name: 'app.css', path: 'src/app.css', isDir: false, size: 84, modifiedMs: 2, truncated: false, children: [] }}
        ] }},
        {{ name: 'README.md', path: 'README.md', isDir: false, size: 128, modifiedMs: 1, truncated: false, children: [] }}
      ], truncated: false }};
      const settings = {{ provider: 'deepseek', model: 'deepseek-v4-pro', base_url: 'https://api.deepseek.com', max_iterations: 25, command_timeout_secs: 120, auto_approve: false }};
      const invoke = async (cmd, args = {{}}) => {{
        if (cmd === 'plugin:event|listen') return args.handler;
        if (cmd === 'plugin:event|unlisten') return null;
        if (cmd === 'list_recent_projects') return {json.dumps(recent)};
        if (cmd === 'app_version') return '0.1.0';
        if (cmd === 'get_settings') return settings;
        if (cmd === 'has_api_key') return false;
        if (cmd === 'list_project_files') return tree;
        if (cmd === 'read_project_file') return {{ path: args.relativePath, content: 'export const foundry = true;\\n', size: 29, language: 'ts' }};
        return null;
      }};
      window.__TAURI_INTERNALS__ = {{
        invoke,
        transformCallback(callback, once = false) {{
          const id = crypto.getRandomValues(new Uint32Array(1))[0];
          callbacks.set(id, (data) => {{ if (once) callbacks.delete(id); return callback && callback(data); }});
          return id;
        }},
        unregisterCallback(id) {{ callbacks.delete(id); }},
        runCallback(id, data) {{ const callback = callbacks.get(id); if (callback) callback(data); }},
        convertFileSrc(path) {{ return path; }},
      }};
      window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {{ unregisterListener(_event, id) {{ callbacks.delete(id); }} }};
    }})();
    """)

def screenshot(page, name):
    path = os.path.join(SCREENSHOT_DIR, f"{name}.png")
    page.screenshot(path=path, full_page=True)
    return path

def test(name, passed, detail=""):
    status = "PASS" if passed else "FAIL"
    results.append({"name": name, "status": status, "detail": detail})
    print(f"  [{status}] {name}" + (f" — {detail}" if detail else ""))

def run_tests():
    print("\n" + "="*60)
    print("  AI-Forge UI Test Suite")
    print("="*60 + "\n")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1280, "height": 800})
        install_tauri_mock(page)

        # Capture console errors
        page.on("console", lambda msg: console_errors.append({
            "type": msg.type,
            "text": msg.text
        }) if msg.type in ("error", "warning") else None)

        # ── Test 1: Page loads ──
        print("▸ Loading page...")
        page.goto(BASE, wait_until="networkidle")
        page.wait_for_timeout(2000)  # Give JS time to init (IPC will fail but DOM renders)
        screenshot(page, "01_initial_load")
        test("Page loads without fatal crash",
             page.locator("#app").count() > 0,
             "The #app container exists")

        # ── Test 2: Basic DOM structure ──
        print("\n▸ Checking DOM structure...")
        test("Sidebar exists", page.locator(".sidebar").count() > 0)
        test("Main area exists", page.locator(".main").count() > 0)
        test("Header exists", page.locator(".header").count() > 0)
        test("Chat area exists", page.locator("#chat").count() > 0)
        test("Console panel exists", page.locator("#console-panel").count() > 0)
        test("Project inspector exists", page.locator("#inspector").count() > 0)
        test("Files and Changes panels exist", page.locator("#files-panel").count() == 1 and page.locator("#changes-panel").count() == 1)
        test("Forge dock exists", page.locator("#forge-dock").count() == 1)
        test("Modal root exists", page.locator("#modal-root").count() > 0)
        test("Composer exists", page.locator(".composer").count() > 0)

        # ── Test 3: Sidebar branding ──
        print("\n▸ Checking sidebar branding...")
        brand = page.locator(".sb-brand")
        test("Sidebar brand section exists", brand.count() > 0)
        if brand.count() > 0:
            logo_text = brand.locator(".sb-logo").inner_text()
            test("Sidebar logo shows 'AF'", logo_text == "AF", f"Got: '{logo_text}'")
            title_text = brand.locator(".sb-title").inner_text()
            test("Sidebar title shows 'AI-Forge'", title_text == "AI-Forge", f"Got: '{title_text}'")
            version_text = brand.locator(".sb-version").inner_text()
            test("Sidebar version present", version_text.startswith("v"), f"Got: '{version_text}'")

        # ── Test 4: Sidebar action buttons ──
        print("\n▸ Checking sidebar actions...")
        actions = page.locator(".sb-action")
        action_count = actions.count()
        test("Three sidebar action buttons", action_count == 3, f"Found {action_count}")
        if action_count >= 3:
            labels = [actions.nth(i).inner_text().strip() for i in range(3)]
            test("'New Build' button exists", "New Build" in labels, f"Labels: {labels}")
            test("'Open Project' button exists", "Open Project" in labels, f"Labels: {labels}")
            test("'Settings' button exists", "Settings" in labels, f"Labels: {labels}")

        # ── Test 5: Recent projects section ──
        print("\n▸ Checking recent projects...")
        recent_section = page.locator(".sb-section-label")
        recent_labels = recent_section.all_inner_texts()
        test("Recent section label exists",
             any("recent" in label.lower() for label in recent_labels),
             f"Labels: {recent_labels}")

        # ── Test 6: Status indicator ──
        print("\n▸ Checking status indicator...")
        status_indicator = page.locator("#status-indicator")
        test("Status indicator exists", status_indicator.count() > 0)
        if status_indicator.count() > 0:
            status_text = page.locator("#status-text").inner_text()
            test("Status shows 'Ready'", status_text == "Ready", f"Got: '{status_text}'")

        # ── Test 7: Chat empty state ──
        print("\n▸ Checking chat empty state...")
        empty = page.locator(".chat-empty")
        test("Chat empty state renders", empty.count() > 0)
        if empty.count() > 0:
            hero_h2 = empty.locator("h2")
            test("Hero heading 'Forge anything'",
                 hero_h2.count() > 0 and hero_h2.inner_text() == "Forge anything",
                 f"Got: '{hero_h2.inner_text() if hero_h2.count() > 0 else 'none'}'")
            examples = empty.locator(".example")
            test("4 example prompts", examples.count() == 4, f"Found {examples.count()}")

        # ── Test 8: Composer textarea ──
        print("\n▸ Checking composer...")
        textarea = page.locator(".composer-input")
        test("Composer textarea exists", textarea.count() > 0)
        if textarea.count() > 0:
            placeholder = textarea.get_attribute("placeholder")
            test("Placeholder guides project-first forging",
                 placeholder is not None and "project" in placeholder.lower() and "forge" in placeholder.lower(),
                 f"Got: '{placeholder}'")

        send_btn = page.locator(".send-btn")
        test("Send button exists", send_btn.count() > 0)
        if send_btn.count() > 0:
            test("Primary action shows 'Forge'", "forge" in send_btn.inner_text().lower())

        # ── Test 9: Model bar ──
        print("\n▸ Checking model bar...")
        modelbar = page.locator(".modelbar")
        test("Model bar exists", modelbar.count() > 0)
        if modelbar.count() > 0:
            selects = modelbar.locator(".modelbar-select")
            test("Model bar has 2 dropdowns (provider + model)",
                 selects.count() == 2, f"Found {selects.count()}")
            logo_badge = modelbar.locator(".modelbar-logo")
            test("Model bar has logo badge", logo_badge.count() > 0)

            # Check provider dropdown contents
            if selects.count() >= 1:
                prov_sel = selects.nth(0)
                options = prov_sel.locator("option")
                opt_count = options.count()
                test("Provider dropdown has 3 options", opt_count == 3, f"Found {opt_count}")
                if opt_count >= 3:
                    opt_texts = [options.nth(i).inner_text() for i in range(opt_count)]
                    test("DeepSeek option present", any("DeepSeek" in t for t in opt_texts), f"Options: {opt_texts}")
                    test("OpenRouter option present", any("OpenRouter" in t for t in opt_texts), f"Options: {opt_texts}")
                    test("GLM option present", any("GLM" in t for t in opt_texts), f"Options: {opt_texts}")
                    # Check GLM label is updated
                    glm_opt = [t for t in opt_texts if "GLM" in t]
                    if glm_opt:
                        test("GLM label identifies the official Z.AI provider",
                             "Z.AI" in glm_opt[0],
                             f"Got: '{glm_opt[0]}'")

            # Check model dropdown for currently selected provider
            if selects.count() >= 2:
                model_sel = selects.nth(1)
                model_options = model_sel.locator("option")
                model_count = model_options.count()
                test("Model dropdown has options", model_count > 0, f"Found {model_count}")

        # ── Test 10: Click Settings button -> modal opens ──
        print("\n▸ Testing Settings modal...")
        settings_btn = page.locator(".sb-action", has_text="Settings")
        if settings_btn.count() > 0:
            settings_btn.click()
            page.wait_for_timeout(500)
            screenshot(page, "02_settings_modal")

            modal_overlay = page.locator(".modal-overlay")
            test("Settings modal overlay appears", modal_overlay.count() > 0)

            modal = page.locator(".modal")
            test("Settings modal dialog exists", modal.count() > 0)

            if modal.count() > 0:
                modal_title = modal.locator(".modal-title")
                test("Modal title is 'Settings'",
                     modal_title.count() > 0 and modal_title.inner_text() == "Settings",
                     f"Got: '{modal_title.inner_text() if modal_title.count() > 0 else 'none'}'")

                # Provider cards
                provider_cards = modal.locator(".provider-card")
                card_count = provider_cards.count()
                test("3 provider cards in modal", card_count == 3, f"Found {card_count}")

                if card_count >= 3:
                    # Check that one card is active
                    active_cards = modal.locator(".provider-card.active")
                    test("Exactly 1 active provider card", active_cards.count() == 1, f"Found {active_cards.count()}")

                    # Check provider card labels
                    card_names = []
                    for i in range(card_count):
                        name_el = provider_cards.nth(i).locator(".provider-card-name")
                        if name_el.count() > 0:
                            card_names.append(name_el.inner_text())
                    test("Provider card names present", len(card_names) == 3, f"Names: {card_names}")
                    if len(card_names) >= 3:
                        test("GLM card says 'Z.AI'",
                             any("Z.AI" in n for n in card_names),
                             f"Cards: {card_names}")

                # Model dropdown in settings
                model_select = modal.locator("select.field")
                test("Settings has select dropdowns",
                     model_select.count() >= 1, f"Found {model_select.count()}")

                # API key section
                key_input = modal.locator("input[type='password']")
                test("API key input field exists", key_input.count() > 0)
                if key_input.count() > 0:
                    key_val = key_input.input_value()
                    test("API key input starts empty", key_val == "", f"Key length: {len(key_val)}")

                save_key_btn = modal.locator("button.btn.sm", has_text="Save key")
                test("'Save key' button exists", save_key_btn.count() > 0)

                # Base URL field
                base_url_input = modal.locator("input[type='text'][placeholder*='api']")
                test("Base URL input exists", base_url_input.count() > 0)

                # Max iterations field
                iter_input = modal.locator("input[type='number']")
                test("Numeric settings inputs exist", iter_input.count() >= 2, f"Found {iter_input.count()}")

                # Footer buttons
                cancel_btn = modal.locator("button.btn", has_text="Cancel")
                test("Cancel button exists", cancel_btn.count() > 0)
                save_btn = modal.locator("button.btn.primary", has_text="Save")
                test("Save button exists", save_btn.count() > 0)

                # ── Test 11: Click GLM provider card ──
                print("\n▸ Testing provider card switching...")
                glm_card = None
                for i in range(card_count):
                    name_el = provider_cards.nth(i).locator(".provider-card-name")
                    if name_el.count() > 0 and "GLM" in name_el.inner_text():
                        glm_card = provider_cards.nth(i)
                        break
                if glm_card:
                    glm_card.click()
                    page.wait_for_timeout(500)
                    screenshot(page, "03_glm_selected")

                    # Verify GLM card is now active
                    test("GLM card is now active", "active" in (glm_card.get_attribute("class") or ""))

                    # Check model dropdown updated
                    # Re-query after re-render
                    new_model_select = page.locator(".modal select.field")
                    if new_model_select.count() >= 2:
                        model_dd = new_model_select.nth(1)
                        model_opts = model_dd.locator("option")
                        glm_models = [model_opts.nth(j).inner_text() for j in range(model_opts.count())]
                        test("GLM model includes 'glm-5.2'",
                             any("glm-5.2" in m for m in glm_models),
                             f"Models: {glm_models}")
                        test("GLM models do NOT include old 'glm-4-flash'",
                             not any("glm-4-flash" in m for m in glm_models),
                             f"Models: {glm_models}")

                    # Check base URL updated
                    base_inputs = page.locator(".modal input[type='text']")
                    for bi in range(base_inputs.count()):
                        val = base_inputs.nth(bi).input_value()
                        if "bigmodel" in val or "api" in val:
                            test("Base URL shows official BigModel endpoint",
                                 "open.bigmodel.cn/api/paas/v4" in val,
                                 f"Got: '{val}'")
                            break

                    # API keys must never be shipped in the frontend.
                    new_key_input = page.locator(".modal input[type='password']")
                    if new_key_input.count() > 0:
                        key_val = new_key_input.input_value()
                        test("GLM key input starts empty",
                             key_val == "",
                             f"Key length: {len(key_val)}")

                # Close modal
                close_btn = page.locator(".modal-close")
                if close_btn.count() > 0:
                    close_btn.click()
                    page.wait_for_timeout(300)
                    test("Modal closes on X click",
                         page.locator(".modal-overlay").count() == 0)
        else:
            test("Settings button found", False, "Could not find settings button")

        # ── Test 12: Composer interaction ──
        print("\n▸ Testing composer interaction...")
        textarea = page.locator(".composer-input")
        if textarea.count() > 0:
            textarea.fill("Hello AI-Forge test")
            val = textarea.input_value()
            test("Textarea accepts input", val == "Hello AI-Forge test", f"Got: '{val}'")

            # Test auto-resize
            textarea.fill("Line 1\nLine 2\nLine 3\nLine 4")
            page.wait_for_timeout(200)
            height = textarea.evaluate("el => el.offsetHeight")
            test("Textarea auto-resizes for multiline", height > 30, f"Height: {height}px")

            textarea.fill("")  # Clear

        # ── Test 13: Example prompts clickable ──
        print("\n▸ Testing example prompt clicks...")
        examples = page.locator(".example")
        if examples.count() >= 1:
            examples.nth(0).click()
            page.wait_for_timeout(500)
            screenshot(page, "04_after_example_click")
            test("Project-first example opens project picker",
                 page.locator(".modal-overlay").count() == 1 and "build" in page.locator(".modal-title").inner_text().lower())
            test("Example remains in composer until a project is selected",
                 "portfolio" in textarea.input_value().lower(),
                 f"Composer: '{textarea.input_value()}'")
            page.locator(".modal-close").click()

        # ── Test 14: CSS Layout checks ──
        print("\n▸ Checking CSS layout...")
        sidebar_el = page.locator(".sidebar")
        if sidebar_el.count() > 0:
            sidebar_width = sidebar_el.evaluate("el => el.offsetWidth")
            test("Sidebar has reasonable width", 150 < sidebar_width < 350, f"Width: {sidebar_width}px")

        main_el = page.locator(".main")
        if main_el.count() > 0:
            main_width = main_el.evaluate("el => el.offsetWidth")
            test("Main area fills remaining space", main_width > 800, f"Width: {main_width}px")

        # ── Test 15: SVG icons render ──
        print("\n▸ Checking icon rendering...")
        svg_icons = page.locator("svg")
        svg_count = svg_icons.count()
        test("SVG icons render on page", svg_count > 3, f"Found {svg_count} SVGs")

        # ── Test 16: Fonts loaded ──
        print("\n▸ Checking typography...")
        body_font = page.evaluate("getComputedStyle(document.body).fontFamily")
        test("Packaged native UI font applied",
             "Segoe UI" in body_font and "Inter" not in body_font,
             f"Got: '{body_font}'")

        # ── Test 17: Dark theme colors ──
        print("\n▸ Checking dark theme...")
        bg_color = page.evaluate("getComputedStyle(document.body).backgroundColor")
        test("Dark background applied",
             bg_color != "rgb(255, 255, 255)" and bg_color != "rgba(0, 0, 0, 0)",
             f"Got: '{bg_color}'")

        # ── Test 18: Console errors analysis ──
        print("\n▸ Analyzing console output...")
        real_errors = [e for e in console_errors if e["type"] == "error"]
        tauri_errors = []
        non_tauri_errors = real_errors
        test("No JavaScript errors with deterministic IPC mocks",
             len(non_tauri_errors) == 0,
             f"Found {len(non_tauri_errors)} errors: {[e['text'][:80] for e in non_tauri_errors]}" if non_tauri_errors else "Clean")

        # Final empty-project screenshot
        screenshot(page, "05_final_state")

        # ── Test 19: Populated Foundry workspace ──
        print("\n▸ Testing populated project workspace...")
        project_page = browser.new_page(viewport={"width": 1280, "height": 832})
        install_tauri_mock(project_page, [r"C:\Mock\Foundry"])
        project_page.goto(BASE, wait_until="networkidle")
        project_page.wait_for_timeout(500)
        screenshot(project_page, "06_project_workspace")

        tree = project_page.locator(".project-tree")
        test("Mock project file tree loads", tree.count() == 1 and project_page.locator(".tree-item").count() >= 2)
        src_dir = project_page.locator(".tree-item.directory", has_text="src")
        test("Project directories are expandable", src_dir.count() == 1)
        if src_dir.count() == 1:
            src_dir.click()
            main_file = project_page.locator(".tree-item.file", has_text="main.ts")
            test("Expanded directory reveals files", main_file.count() == 1)
            if main_file.count() == 1:
                main_file.click()
                project_page.wait_for_timeout(150)
                test("File click opens read-only viewer", project_page.locator("#file-viewer:not([hidden])").count() == 1)
                test("Viewer renders exact text content", "foundry = true" in project_page.locator("#viewer-content").inner_text())
                test("Viewer labels content read only", "read only" in project_page.locator("#viewer-meta").inner_text().lower())
                project_page.locator(".viewer-back").click()

        project_page.locator("[data-inspector-tab='changes']").click()
        test("Changes inspector is reachable", project_page.locator("#changes-panel:not([hidden])").count() == 1)
        project_page.locator("[data-inspector-tab='console']").click()
        test("Console inspector is reachable", project_page.locator("#console-panel:not([hidden])").count() == 1)

        project_page.locator("[data-inspector-tab='files']").click()
        project_page.locator(".project-filter").focus()
        project_page.keyboard.press("Tab")
        project_page.keyboard.press("Shift+Tab")
        outline_style = project_page.locator(".project-filter").evaluate("el => getComputedStyle(el).outlineStyle")
        test("Keyboard focus indicator is visible", outline_style != "none", f"Outline: {outline_style}")

        project_page.set_viewport_size({"width": 900, "height": 600})
        project_page.wait_for_timeout(200)
        stage_box = project_page.locator(".stage").bounding_box()
        inspector_box = project_page.locator(".inspector").bounding_box()
        responsive_ok = bool(stage_box and inspector_box and inspector_box["y"] >= stage_box["y"] + stage_box["height"] - 2)
        test("Inspector becomes non-overlapping bottom drawer at 900px", responsive_ok,
             f"Stage: {stage_box}, Inspector: {inspector_box}")
        screenshot(project_page, "07_compact_workspace")
        project_page.close()
        browser.close()

    # ── Summary ──
    print("\n" + "="*60)
    passed = sum(1 for r in results if r["status"] == "PASS")
    failed = sum(1 for r in results if r["status"] == "FAIL")
    total = len(results)
    print(f"  Results: {passed}/{total} passed, {failed} failed")
    print("="*60)

    if failed > 0:
        print("\n  ❌ FAILED TESTS:")
        for r in results:
            if r["status"] == "FAIL":
                print(f"    • {r['name']}: {r['detail']}")

    print(f"\n  Screenshots saved to: {SCREENSHOT_DIR}")
    print(f"  Console errors total: {len(console_errors)} ({len(tauri_errors)} Tauri-related)\n")

    # Return results as JSON for downstream processing
    return results, failed

if __name__ == "__main__":
    results, failed = run_tests()
    sys.exit(1 if failed > 0 else 0)
