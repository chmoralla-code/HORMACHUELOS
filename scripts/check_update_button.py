from pathlib import Path

from playwright.sync_api import expect, sync_playwright


BASE_URL = "http://127.0.0.1:1420/update-harness.html"
SCREENSHOT = Path(__file__).resolve().parents[1] / "test-results" / "update-button-available.png"


def main() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1000, "height": 760})
        page.goto(BASE_URL, wait_until="networkidle")

        update_button = page.get_by_role(
            "button", name="Update available: v0.1.5. Check for updates", exact=True
        )
        update_button.wait_for(state="visible")
        assert update_button.get_attribute("data-update-available") == "true"
        assert update_button.locator(".sb-update-badge").inner_text() == "v0.1.5"
        SCREENSHOT.parent.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(SCREENSHOT), full_page=True)
        update_button.click()

        dialog = page.get_by_role("dialog", name="Update available")
        dialog.wait_for(state="visible")
        app = page.locator("#app")
        close_button = dialog.get_by_role("button", name="Close update checker")
        not_now_button = dialog.get_by_role("button", name="Not now")
        assert app.evaluate("node => node.inert")
        assert close_button.evaluate("button => button === document.activeElement")

        page.keyboard.press("Shift+Tab")
        assert not_now_button.evaluate("button => button === document.activeElement")
        page.keyboard.press("Tab")
        assert close_button.evaluate("button => button === document.activeElement")

        page.locator("#background-action").evaluate("button => button.focus()")
        assert dialog.evaluate("node => node.contains(document.activeElement)")
        assert "Added the in-app Update button." in dialog.inner_text()
        dialog.get_by_role("button", name="Download v0.1.5").click()
        assert page.locator("body").get_attribute("data-opened-url") == (
            "https://downloads.example/Hormachuelos_0.1.5.msi"
        )
        not_now_button.click()
        assert dialog.count() == 0
        assert not app.evaluate("node => node.inert")
        expect(update_button).to_be_focused()

        page.evaluate("window.__updateMode = 'current'")
        update_button.click()
        current_dialog = page.get_by_role("dialog", name="You're up to date")
        current_dialog.wait_for(state="visible")
        assert app.evaluate("node => node.inert")
        assert "v0.1.4 is the latest version" in current_dialog.inner_text()
        current_dialog.get_by_role("button", name="Done").click()
        assert not app.evaluate("node => node.inert")
        expect(update_button).to_be_focused()

        page.evaluate("window.__updateMode = 'error'")
        update_button.click()
        error_dialog = page.get_by_role("dialog", name="Couldn't check for updates")
        error_dialog.wait_for(state="visible")
        page.evaluate("window.__updateMode = 'current'")
        error_dialog.get_by_role("button", name="Try again").click()
        retried_dialog = page.get_by_role("dialog", name="You're up to date")
        retried_dialog.wait_for(state="visible")
        assert retried_dialog.evaluate("node => node.contains(document.activeElement)")
        retried_dialog.get_by_role("button", name="Done").click()
        assert not app.evaluate("node => node.inert")
        expect(update_button).to_be_focused()

        browser.close()

    print("Desktop Update button checks passed.")


if __name__ == "__main__":
    main()
