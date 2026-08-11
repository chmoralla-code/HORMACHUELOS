from playwright.sync_api import sync_playwright


def scenario(page, name: str):
    return page.evaluate(f"() => window.__videoPasteHarness.{name}()")


def main() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1200, "height": 800})
        page_errors = []
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        page.goto("http://127.0.0.1:1420/video-paste-harness.html")
        page.wait_for_function("() => Boolean(window.__videoPasteHarness)")

        memory = scenario(page, "memoryVideo")
        assert memory["prevented"] is True
        assert [call["cmd"] for call in memory["calls"]] == ["save_pasted_video"]
        assert memory["calls"][0]["byteLength"] == 5
        assert memory["calls"][0]["headers"]["x-ai-forge-video-extension"] == "mp4"
        assert len(memory["chips"]) == 1 and memory["chips"][0]["video"] is True

        explorer = scenario(page, "explorerPath")
        assert explorer["prevented"] is True
        assert [call["cmd"] for call in explorer["calls"]] == ["import_video_path"]
        assert explorer["calls"][0]["args"]["path"].endswith("screen recording.mp4")
        assert len(explorer["chips"]) == 1 and explorer["chips"][0]["video"] is True

        native = scenario(page, "nativeOnly")
        assert native["prevented"] is True
        assert [call["cmd"] for call in native["calls"]] == ["import_clipboard_videos"]
        assert len(native["chips"]) == 1 and "video-native.mp4" in native["chips"][0]["text"]

        snipping = scenario(page, "thumbnailAndNativeVideo")
        assert snipping["prevented"] is True
        assert [call["cmd"] for call in snipping["calls"]] == ["import_clipboard_videos"]
        assert len(snipping["chips"]) == 1 and "video-snipping.mp4" in snipping["chips"][0]["text"]

        text = scenario(page, "ordinaryText")
        assert text["prevented"] is False
        assert text["calls"] == []
        assert text["chips"] == []
        assert not page_errors, f"browser errors: {page_errors}"
        browser.close()

    print("Video paste checks passed: Blob, Explorer path, native CF_HDROP, Snipping thumbnail, text")


if __name__ == "__main__":
    main()
