"""Adaptive scraping: relocate elements after a website redesign.

Adaptive scraping ("automatch") flow:
1. Parse the "old" page and select an element with auto_save=True.
   Scrapling stores that element's unique properties under a domain key
   (default storage: SQLite in ~/.scrapling).
2. Later, parse the "new" page where the same selector no longer matches.
3. Re-run the selector with adaptive=True. Scrapling compares stored
   properties against every element and returns the most similar one --
   no AI involved, just similarity scoring.

We run two demos:
  A) Deterministic offline redesign (Selector class, simulated pages).
  B) Real Wayback Machine snapshots of quotes.toscrape.com.
"""
from scrapling import Fetcher, Selector

SELECTOR = "#p1"  # id-based selectors break easily when ids get renamed


OLD_HTML = """
<div class="container"><section class="products">
  <article class="product" id="p1"><h3>Product 1</h3><p class="description">Description 1</p></article>
  <article class="product" id="p2"><h3>Product 2</h3><p class="description">Description 2</p></article>
</section></div>
"""

NEW_HTML = """
<div class="new-container"><div class="product-wrapper"><section class="products">
  <article class="product new-class" data-id="p1"><div class="product-info">
    <h3>Product 1</h3><p class="new-description">Description 1</p></div></article>
  <article class="product new-class" data-id="p2"><div class="product-info">
    <h3>Product 2</h3><p class="new-description">Description 2</p></div></article>
</section></div></div>
"""


def demo_offline():
    print("--- Demo A: offline simulated redesign ---")
    # Step 1: teach Scrapling what '#p1' means on the old design.
    old = Selector(OLD_HTML, adaptive=True, url="https://shop.example.com")
    el_old = old.css(SELECTOR, auto_save=True)[0]
    old_title = el_old.css("h3::text").get()
    print("old design match :", repr(old_title))

    # Step 2: website redesign -- '#p1' no longer exists.
    new = Selector(NEW_HTML, adaptive=True, url="https://shop.example.com")
    assert not new.css(SELECTOR), "selector should be broken after redesign"

    # Step 3: adaptive relocation finds the same product anyway.
    el_new = new.css(SELECTOR, adaptive=True)[0]
    new_title = el_new.css("h3::text").get()
    print("adaptive rematch :", repr(new_title))
    assert old_title == new_title == "Product 1"
    assert el_new.attrib.get("data-id") == "p1" or el_new.css("[data-id=p1]")
    print("OK: element relocated across a full DOM restructure\n")


def demo_wayback():
    print("--- Demo B: Wayback Machine snapshots of quotes.toscrape.com ---")
    Fetcher.configure(adaptive=True, adaptive_domain="quotes.toscrape.com")
    old_url = "https://web.archive.org/web/20220119193923/https://quotes.toscrape.com/"
    new_url = "https://web.archive.org/web/20240102125904/https://quotes.toscrape.com/"

    old_page = Fetcher.get(old_url, timeout=60)
    q_old = old_page.css("div.quote > span.text", auto_save=True)[0]

    new_page = Fetcher.get(new_url, timeout=60)
    matches = new_page.css("div.quote > span.text")
    if matches:
        q_new = matches[0]
        how = "direct match"
    else:
        q_new = new_page.css("div.quote > span.text", adaptive=True)[0]
        how = "ADAPTIVE relocation"
    print(f"old quote: {q_old.text[:50]}...")
    print(f"new quote ({how}): {q_new.text[:50]}...")
    assert q_old.text == q_new.text
    print("OK: same element found across archived designs")


if __name__ == "__main__":
    demo_offline()
    demo_wayback()
