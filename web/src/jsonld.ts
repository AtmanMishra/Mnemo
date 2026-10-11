import { AUTHOR, BUILD_DATE, DESCRIPTION, LICENSE_URL, REPO, SITE, TITLE, VERSION } from "./site";

// Structured data for the one page. Only facts the page itself states: no ratings,
// no reviews, no price other than free. FAQPage markup is left out on purpose: Google
// retired its rich result, and the questions are on the page as plain headings.
export function jsonLd(): string {
  const graph = [
    {
      "@type": "WebSite",
      "@id": `${SITE}/#website`,
      url: `${SITE}/`,
      name: "Mnemo",
      description: DESCRIPTION,
      inLanguage: "en",
      publisher: { "@id": `${SITE}/#author` },
    },
    {
      "@type": "Person",
      "@id": `${SITE}/#author`,
      name: AUTHOR.name,
      url: AUTHOR.url,
      sameAs: [AUTHOR.url],
    },
    {
      "@type": "SoftwareApplication",
      "@id": `${SITE}/#software`,
      name: "Mnemo",
      description: DESCRIPTION,
      url: `${SITE}/`,
      applicationCategory: "DeveloperApplication",
      operatingSystem: "macOS, Linux, Windows",
      softwareVersion: VERSION,
      downloadUrl: `${REPO}/releases/latest`,
      license: LICENSE_URL,
      isAccessibleForFree: true,
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      author: { "@id": `${SITE}/#author` },
      sameAs: [REPO],
      image: `${SITE}/og.png`,
    },
    {
      "@type": "SoftwareSourceCode",
      "@id": `${SITE}/#source`,
      name: "Mnemo",
      codeRepository: REPO,
      programmingLanguage: ["TypeScript", "Rust"],
      license: LICENSE_URL,
      author: { "@id": `${SITE}/#author` },
    },
    {
      "@type": "WebPage",
      "@id": `${SITE}/#webpage`,
      url: `${SITE}/`,
      name: TITLE,
      isPartOf: { "@id": `${SITE}/#website` },
      about: { "@id": `${SITE}/#software` },
      dateModified: BUILD_DATE,
      primaryImageOfPage: { "@type": "ImageObject", url: `${SITE}/og.png`, width: 1200, height: 630 },
    },
  ];
  return JSON.stringify({ "@context": "https://schema.org", "@graph": graph }).replace(/</g, "\\u003c");
}
