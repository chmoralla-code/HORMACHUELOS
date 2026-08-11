from pathlib import Path
from time import perf_counter

from playwright.sync_api import sync_playwright


SCREENSHOT = Path(__file__).resolve().parent / "preview-modes-test.png"


def open_preview_actions(page):
    """Open the compact preview-tools panel and return its visible group."""
    toggle = page.get_by_role("button", name="Preview actions")
    toggle.click()
    actions = page.get_by_role("group", name="Preview actions")
    actions.wait_for(state="visible")
    assert toggle.get_attribute("aria-expanded") == "true"
    return actions


def main() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 1000})
        page.goto("http://127.0.0.1:1420/preview-harness.html")
        page.wait_for_load_state("networkidle")

        preview = page.locator(".site-preview")
        preview.wait_for(state="visible")
        assert "is-open" in (preview.get_attribute("class") or "")
        body = page.locator("body")
        providers = (body.get_attribute("data-providers") or "").split(",")
        assert providers == [
            "cursor",
            "hormachuelos_free",
            "ollama",
            "deepseek",
            "openrouter",
        ], f"unexpected visible provider catalog: {providers}"
        assert body.get_attribute("data-cursor-models") == "grok-4.5,composer-2.5"
        assert body.get_attribute("data-hormachuelos-free-models") == (
            "hormachuelos-v1,hormachuelos-v2,hormachuelos-v3,hormachuelos-v4"
        )
        assert body.get_attribute("data-tool-animation") == "lightningToolSpawnBlue"
        assert body.get_attribute("data-agentic-animation") == "lightningFadeInOutBlue"
        assert body.get_attribute("data-agentic-color") == "rgb(85, 185, 255)"
        assert "shine-blue" in (body.get_attribute("data-live-thinking-class") or "")
        assert body.get_attribute("data-live-thinking-animation") == "lightningFadeInOutBlue"
        assert body.get_attribute("data-live-thinking-color") == "rgb(85, 185, 255)"
        assert body.get_attribute("data-agentic-chip-animation") == "lightningChipFadeBlue"

        # Appearance is a live, persisted global preference—not just a color
        # override on the switch itself. Exercise all three button modes and
        # leave the harness in the default Dark mode for the remaining checks.
        root = page.locator("html")
        appearance = page.get_by_role("group", name="Appearance mode")
        assert appearance.is_visible()
        dark_mode = page.get_by_role("button", name="Use Dark appearance")
        light_mode = page.get_by_role("button", name="Use Light appearance")
        gray_mode = page.get_by_role("button", name="Use Gray appearance")
        assert root.get_attribute("data-appearance") == "dark"
        assert dark_mode.get_attribute("aria-pressed") == "true"

        light_mode.click()
        assert root.get_attribute("data-appearance") == "light"
        assert root.evaluate("element => getComputedStyle(element).colorScheme") == "light"
        assert root.evaluate("element => getComputedStyle(element).getPropertyValue('--canvas').trim()") == "#f4f7fb"
        assert light_mode.get_attribute("aria-pressed") == "true"

        gray_mode.click()
        assert root.get_attribute("data-appearance") == "gray"
        assert root.evaluate("element => getComputedStyle(element).colorScheme") == "dark"
        assert root.evaluate("element => getComputedStyle(element).getPropertyValue('--canvas').trim()") == "#2a2d32"
        assert page.evaluate("() => localStorage.getItem('ai-forge:appearance')") == "gray"

        # Reload confirms the preference is restored before the interactive
        # app module has a chance to render, avoiding a bright/dark flash.
        page.reload()
        page.wait_for_load_state("networkidle")
        assert root.get_attribute("data-appearance") == "gray"
        assert gray_mode.get_attribute("aria-pressed") == "true"

        dark_mode.click()
        assert root.get_attribute("data-appearance") == "dark"
        assert dark_mode.get_attribute("aria-pressed") == "true"

        # The desktop must keep its deliberately subtle thinking effects on
        # when Windows reports reduced motion. This matches the app's existing
        # reduced-motion handling for the working-dot wave.
        reduced_page = browser.new_page(viewport={"width": 1440, "height": 1000})
        reduced_page.emulate_media(reduced_motion="reduce")
        reduced_page.goto("http://127.0.0.1:1420/preview-harness.html")
        reduced_page.wait_for_load_state("networkidle")
        reduced_body = reduced_page.locator("body")
        assert reduced_body.get_attribute("data-agentic-animation") == "lightningFadeInOutBlue"
        assert reduced_body.get_attribute("data-agentic-color") == "rgb(85, 185, 255)"
        assert "shine-blue" in (reduced_body.get_attribute("data-live-thinking-class") or "")
        assert reduced_body.get_attribute("data-live-thinking-animation") == "lightningFadeInOutBlue"
        assert reduced_body.get_attribute("data-live-thinking-color") == "rgb(85, 185, 255)"
        reduced_page.close()

        # Widening the preview must not turn the address field into an
        # unbounded bar. The compact action panel leaves useful space while
        # the field deliberately caps at a browser-like working width.
        page.locator(".workbench").evaluate(
            "element => element.style.setProperty('--preview-w', '980px')"
        )
        page.wait_for_timeout(80)
        wide_preview_box = preview.bounding_box()
        wide_omnibox_box = page.locator(".site-preview-omnibox").bounding_box()
        assert wide_preview_box is not None and wide_preview_box["width"] >= 900, wide_preview_box
        assert wide_omnibox_box is not None
        assert 300 <= wide_omnibox_box["width"] <= 562, wide_omnibox_box
        assert page.locator(".site-preview-omnibox").evaluate(
            "element => getComputedStyle(element).maxWidth"
        ) == "560px"

        # The overflow control keeps the six infrequent preview actions in a
        # single accessible panel. Escape first closes Build's nested target
        # picker, then closes the main panel and restores focus to its button.
        actions = open_preview_actions(page)
        assert actions.get_by_role("button", name="Choose build target").is_visible()
        assert actions.get_by_role("button", name="Make the website public").is_visible()
        assert actions.get_by_role("button", name="Toggle Android device preview").is_visible()
        assert actions.get_by_role("button", name="Toggle software window preview").is_visible()
        assert actions.get_by_role("button", name="Design").is_visible()
        assert actions.get_by_role("button", name="Toggle Source Lens").is_visible()
        assert page.get_by_role("button", name="Close preview").is_visible()
        actions.get_by_role("button", name="Choose build target").click()
        build_menu = actions.get_by_role("menu", name="Build target")
        assert build_menu.is_visible()
        page.keyboard.press("Escape")
        assert build_menu.is_hidden()
        assert actions.is_visible()
        page.keyboard.press("Escape")
        assert actions.is_hidden()
        assert page.get_by_role("button", name="Preview actions").get_attribute("aria-expanded") == "false"

        android = page.locator(".site-preview-android-btn")
        software = page.locator(".site-preview-software-btn")
        open_preview_actions(page).get_by_role(
            "button", name="Toggle Android device preview"
        ).click()
        assert android.get_attribute("aria-pressed") == "true"
        assert "is-android" in (preview.get_attribute("class") or "")
        frame_box = page.locator("iframe").bounding_box()
        assert frame_box is not None
        assert 410 <= frame_box["width"] <= 414, frame_box
        assert 913 <= frame_box["height"] <= 917, frame_box
        assert "412 × 915" in page.locator(".site-preview-status").inner_text()

        frame = page.frame_locator("iframe")
        frame.locator("#target").wait_for(state="visible")
        style_block_url = frame.locator("#target").evaluate(
            "element => getComputedStyle(element).backgroundImage"
        )
        style_attribute_url = frame.locator("#inline-style-target").evaluate(
            "element => getComputedStyle(element).backgroundImage"
        )
        for asset_url in (style_block_url, style_attribute_url):
            assert "asset.localhost" in asset_url, asset_url
            assert "127.0.0.1:1420/assets" not in asset_url, asset_url
        style_text = frame.locator("style").text_content() or ""
        assert '@import "https://asset.localhost/' in style_text, style_text
        assert 'url("./assets/comment.png")' in style_text, style_text
        literal_content = frame.locator("#literal-target").evaluate(
            "element => getComputedStyle(element, '::before').content"
        )
        assert "./assets/literal.png" in literal_content, literal_content
        assert "asset.localhost" not in literal_content, literal_content

        source_lens = page.locator(".site-preview-source-lens-btn")
        open_preview_actions(page).get_by_role(
            "button", name="Toggle Source Lens"
        ).click()
        assert source_lens.get_attribute("aria-pressed") == "true"

        open_preview_actions(page).get_by_role("button", name="Design").click()
        assert source_lens.get_attribute("aria-pressed") == "false"
        frame.locator("#target").click()
        assert page.locator("#site-preview-edit-tag").inner_text() == "button"
        assert page.locator(".site-preview-editbar").is_visible()

        # A selected micro-edit must be packaged locally in under a second and
        # dispatched with the isolated fast profile, even when the parent chat
        # may be a long-running session.
        design_input = page.get_by_role("textbox", name="Describe the change")
        design_input.fill("Use the primary color.")
        dispatch_started = perf_counter()
        page.get_by_role("button", name="Ask AI", exact=True).click()
        page.wait_for_function("() => window.__previewPromptDispatches?.length === 1")
        design_dispatch_ms = (perf_counter() - dispatch_started) * 1000
        dispatch = page.evaluate("() => window.__previewPromptDispatches[0]")
        assert design_dispatch_ms < 1000, design_dispatch_ms
        assert dispatch["taskProfile"] == "design_edit_fast", dispatch
        assert "DOM selector: #target" in dispatch["prompt"], dispatch["prompt"]
        assert "Ranked source candidates (open these first): index.html" in dispatch["prompt"]
        assert len(dispatch["prompt"]) < 5000, len(dispatch["prompt"])
        assert "Fast Design edit" in page.locator(".site-preview-status").inner_text()

        open_preview_actions(page).get_by_role(
            "button", name="Toggle software window preview"
        ).click()
        assert software.get_attribute("aria-pressed") == "true"
        assert android.get_attribute("aria-pressed") == "false"
        classes = preview.get_attribute("class") or ""
        assert "is-software" in classes
        assert "is-android" not in classes
        assert page.locator(".site-preview-software-titlebar").is_visible()
        assert "Software window" in page.locator(".site-preview-status").inner_text()
        assert page.locator(".site-preview-editbar").is_visible()

        page.get_by_role("button", name="Reload preview").click()
        frame.locator("#target").wait_for(state="visible")
        page.screenshot(path=str(SCREENSHOT), full_page=True)

        # A reopen during the 280 ms close animation must cancel the stale teardown.
        page.get_by_role("button", name="Close preview").click()
        page.wait_for_timeout(50)
        page.evaluate(
            "opts => window.__preview.open(opts)",
            {
                "projectRoot": r"C:\preview-fixture",
                "entryPath": "index.html",
                "files": [
                    "index.html",
                    "assets/import.css",
                    "assets/style-block.png",
                    "assets/style-attribute.png",
                ],
                "title": "Rapid reopen test",
            },
        )
        preview.wait_for(state="visible")
        page.wait_for_timeout(350)
        assert preview.is_visible()
        assert "is-open" in (preview.get_attribute("class") or "")
        assert page.locator("iframe").count() == 1
        page.frame_locator("iframe").locator("#target").wait_for(state="visible")

        # Session previews are isolated.  A Snake/game preview staged for a
        # background session must not replace the currently rendered session.
        session_a = page.evaluate("() => window.__preview.captureSessionState()")
        assert session_a is not None
        assert session_a["tabs"][0]["entryPath"] == "index.html"
        assert session_a["softwareMode"] is True

        background_session = page.evaluate(
            "args => window.__mergePreviewSessionState(args.current, args.opts)",
            {
                "current": None,
                "opts": {
                    "projectRoot": r"C:\preview-fixture",
                    "entryPath": "snake.html",
                    "files": ["index.html", "snake.html"],
                    "title": "Snake game",
                },
            },
        )
        assert [tab["entryPath"] for tab in background_session["tabs"]] == ["snake.html"]
        # Staging state is pure: it does not steal the active session's iframe.
        assert page.locator(".site-preview-omnibox").input_value() == "index.html"
        assert page.locator("iframe").count() == 1

        page.evaluate("() => window.__preview.clearSessionView()")
        preview.wait_for(state="hidden")
        assert page.locator("iframe").count() == 0

        # Switching into the background session renders its game and nothing
        # from Session A; switching back returns only Session A's page.
        page.evaluate(
            "state => window.__preview.restoreSessionState(state)",
            background_session,
        )
        preview.wait_for(state="visible")
        page.frame_locator("iframe").locator("#target").wait_for(state="visible")
        assert page.locator(".site-preview-omnibox").input_value() == "snake.html"
        assert page.locator("iframe").count() == 1
        assert "is-software" not in (preview.get_attribute("class") or "")

        page.evaluate(
            "state => window.__preview.restoreSessionState(state)",
            session_a,
        )
        page.frame_locator("iframe").locator("#target").wait_for(state="visible")
        assert page.locator(".site-preview-omnibox").input_value() == "index.html"
        assert page.locator("iframe").count() == 1
        assert "snake.html" not in (page.locator(".site-preview-tabs").inner_text() or "")
        assert "is-software" in (preview.get_attribute("class") or "")

        page.get_by_role("button", name="Close preview").click()
        preview.wait_for(state="hidden")
        browser.close()

    print(
        f"Preview mode checks passed; Design dispatch {design_dispatch_ms:.1f} ms; "
        f"screenshot: {SCREENSHOT}"
    )


if __name__ == "__main__":
    main()
