"""Basic static scrape with Scrapling's Fetcher (curl_cffi HTTP engine).

Demonstrates: one-off request, TLS impersonation, CSS selection,
navigation, and the Response object's metadata.
"""
from scrapling.fetchers import Fetcher


def main():
    # One-off request; `impersonate` makes TLS look like real Chrome.
    page = Fetcher.get("https://quotes.toscrape.com/", impersonate="chrome")

    print("status:", page.status)
    print("title:", page.css("title::text").get())

    quotes = page.css(".quote")
    print(f"found {len(quotes)} quotes")
    for q in quotes[:3]:
        text = q.css(".text::text").get()
        author = q.css(".author::text").get()
        tags = q.css(".tag::text").getall()
        print(f"- {text}  -- {author}  tags={tags}")

    # Follow pagination with the same parser API
    nxt = page.css("li.next > a::attr(href)").get()
    print("next page link:", nxt)

    # Response object extras
    print("cookies:", dict(page.cookies))
    print("content-type:", page.headers.get("content-type"))


if __name__ == "__main__":
    main()
