from playwright.sync_api import Route, sync_playwright


def json_response(route: Route, body: str) -> None:
    route.fulfill(
        status=200,
        content_type="application/json",
        headers={"Access-Control-Allow-Origin": "*"},
        body=body,
    )


def main() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page()
        starts = {"count": 0}
        account_checks = {"count": 0}

        def handle_start(route: Route) -> None:
            starts["count"] += 1
            if starts["count"] == 1:
                route.abort("connectionfailed")
                return
            json_response(
                route,
                """{
                  "ok": true,
                  "userCode": "ABCD-EFGH",
                  "deviceCode": "device-token",
                  "verifyUrl": "https://hormachuelos.vercel.app/#/login?desktop=1&dcode=ABCD-EFGH",
                  "intervalSeconds": 2
                }""",
            )

        page.route("https://hormachuelos.vercel.app/api/auth/device-start", handle_start)
        page.route(
            "https://hormachuelos.vercel.app/api/auth/device-poll",
            lambda route: json_response(
                route,
                """{
                  "ok": true,
                  "status": "complete",
                  "token": "desktop-session-token-1234",
                  "user": {"email": "signed-in@example.com", "plan": "pro"}
                }""",
            ),
        )
        def handle_account(route: Route) -> None:
            account_checks["count"] += 1
            if account_checks["count"] == 1:
                route.abort("connectionfailed")
                return
            json_response(
                route,
                """{
                  "ok": true,
                  "user": {"email": "signed-in@example.com", "plan": "pro"}
                }""",
            )

        page.route("https://hormachuelos.vercel.app/api/auth/me", handle_account)

        page.goto("http://127.0.0.1:1420/auth-sync-harness.html")
        page.wait_for_load_state("networkidle")
        status = page.locator(".auth-gate-status")
        status.wait_for(state="visible")
        page.wait_for_function("document.body.dataset.signedIn === 'signed-in@example.com'")

        assert starts["count"] >= 2, "the failed initial request was not retried"
        assert page.locator("body").get_attribute("data-network-session-preserved") == "true"
        assert page.locator("body").get_attribute("data-session-cleared") is None
        assert page.locator(".auth-gate-overlay").count() == 0
        assert page.locator("body").get_attribute("data-saved-token") == "desktop-session-token-1234"
        opened = page.locator("body").get_attribute("data-opened-url") or ""
        assert "desktop=1" in opened and "dcode=ABCD-EFGH" in opened
        browser.close()

    print("Browser-to-desktop account sync checks passed")


if __name__ == "__main__":
    main()
