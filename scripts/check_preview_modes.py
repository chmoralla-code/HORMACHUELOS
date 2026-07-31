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
            "ollama",
            "deepseek",
            "openrouter",
            "glm",
        ], f"unexpected visible provider catalog: {providers}"
        assert body.get_attribute("data-cursor-models") == "grok-4.5"

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

        page.get_by_role("button", name="Close preview").click()
        preview.wait_for(state="hidden")
        browser.close()

    print(f"Preview mode checks passed; screenshot: {SCREENSHOT}")


if __name__ == "__main__":
    main()
