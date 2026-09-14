"""JS-rendered scrape with Scrapling's DynamicFetcher (Playwright Chromium).

Fetches the deepseek-harness docs site (a VitePress SPA whose nav is
client-side rendered), waits for network idle, then extracts content.
"""
from scrapling.fetchers import DynamicFetcher


def main():
    # `network_idle` waits until no network connections for >=500ms,
    # which matters for SPA pages that hydrate after DOMContentLoaded.
    page = DynamicFetcher.fetch(
        "https://deepseek-harness.github.io/deepseek-harness/en/guide/python-sdk",
        headless=True,
        network_idle=True,
        disable_resources=True,  # drop fonts/images/media for speed
    )

    print("status:", page.status)
    print("title:", page.css("title::text").get(""))

    # Sidebar links only exist after the client app mounts
    links = page.css("aside a::attr(href)").getall()
    print(f"sidebar links found: {len(links)}")
    for h in links[:8]:
        print(" -", h)

    headings = page.css("main h2::text").getall()
    print("h2 headings:", headings)


if __name__ == "__main__":
    main()
