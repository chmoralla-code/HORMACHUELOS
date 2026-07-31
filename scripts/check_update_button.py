from playwright.sync_api import sync_playwright


BASE_URL = "http://127.0.0.1:1420/update-harness.html"


def main() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1000, "height": 760})
        page.goto(BASE_URL, wait_until="networkidle")

        update_button = page.get_by_role("button", name="Update", exact=True)
        update_button.wait_for(state="visible")
        update_button.click()

        dialog = page.get_by_role("dialog", name="Update available")
        dialog.wait_for(state="visible")
        assert "Added the in-app Update button." in dialog.inner_text()
        dialog.get_by_role("button", name="Download v0.1.5").click()
        assert page.locator("body").get_attribute("data-opened-url") == (
            "https://downloads.example/Hormachuelos_0.1.5.msi"
        )
        dialog.get_by_role("button", name="Not now").click()
        assert dialog.count() == 0
        page.wait_for_timeout(20)
        assert update_button.evaluate("button => button === document.activeElement")

        page.evaluate("window.__updateMode = 'current'")
        update_button.click()
        current_dialog = page.get_by_role("dialog", name="You're up to date")
        current_dialog.wait_for(state="visible")
        assert "v0.1.4 is the latest version" in current_dialog.inner_text()
        current_dialog.get_by_role("button", name="Done").click()

        page.evaluate("window.__updateMode = 'error'")
        update_button.click()
        error_dialog = page.get_by_role("dialog", name="Couldn't check for updates")
        error_dialog.wait_for(state="visible")
        page.evaluate("window.__updateMode = 'current'")
        error_dialog.get_by_role("button", name="Try again").click()
        page.get_by_role("dialog", name="You're up to date").wait_for(state="visible")

        browser.close()

    print("Desktop Update button checks passed.")


if __name__ == "__main__":
    main()
