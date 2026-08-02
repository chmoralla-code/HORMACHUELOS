from pathlib import Path

from playwright.sync_api import sync_playwright


SCREENSHOT = Path(__file__).resolve().parent / "preview-modes-test.png"


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
        assert body.get_attribute("data-hormachuelos-free-models") == "hormachuelos-v1,hormachuelos-v2"
        assert body.get_attribute("data-tool-animation") == "lightningToolSpawnBlue"
        assert body.get_attribute("data-agentic-animation") == "lightningFadeInOutBlue"
        assert body.get_attribute("data-agentic-color") == "rgb(85, 185, 255)"
        assert body.get_attribute("data-agentic-chip-animation") == "lightningChipFadeBlue"

        android = page.get_by_role("button", name="Toggle Android device preview")
        software = page.get_by_role("button", name="Toggle software window preview")
        android.click()
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

        page.get_by_role("button", name="Design").click()
        frame.locator("#target").click()
        assert page.locator("#site-preview-edit-tag").inner_text() == "button"
        assert page.locator(".site-preview-editbar").is_visible()

        software.click()
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

    print(f"Preview mode checks passed; screenshot: {SCREENSHOT}")


if __name__ == "__main__":
    main()
