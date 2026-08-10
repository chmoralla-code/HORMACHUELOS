"""Smoke-test the sidebar search/disclosure UX against the local Vite harness."""

from __future__ import annotations

import argparse
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:1420/update-harness.html")
    parser.add_argument(
        "--screenshot",
        default="website/test-results/sidebar-search-collapse.png",
    )
    args = parser.parse_args()

    screenshot = Path(args.screenshot).resolve()
    screenshot.parent.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1100, "height": 760})
        page.goto(args.url, wait_until="networkidle")
        page.locator("#background-action").evaluate("node => { node.hidden = true; }")

        sidebar = page.locator("#sidebar")
        sidebar.get_by_role("button", name="Search projects").click()
        project_search = sidebar.get_by_role("searchbox", name="Search projects")
        project_search.fill("beacon")
        assert sidebar.locator(".sb-project-workspace:visible").count() == 1
        assert "Beacon" in sidebar.locator(".sb-project-workspace:visible").inner_text()

        sidebar.get_by_role("button", name="Collapse sessions").click()
        assert not sidebar.locator("#sidebar-session-body").is_visible()
        assert page.evaluate(
            "localStorage.getItem('ai-forge:sidebar-sessions-collapsed')"
        ) == "1"

        sidebar.get_by_role("button", name="Search sessions").click()
        session_search = sidebar.get_by_role("searchbox", name="Search sessions")
        expect(session_search).to_be_focused()
        session_search.fill("installation")
        assert sidebar.locator(".sb-session-item:visible").count() == 1

        page.screenshot(path=str(screenshot), full_page=True)
        browser.close()

    print(f"Sidebar search/collapse smoke test passed. Screenshot: {screenshot}")


if __name__ == "__main__":
    main()
