import { DocLayout, Note, type DocSection } from "./parts";
import { REPO } from "../site";

const sections: DocSection[] = [
  {
    id: "agreement",
    title: "What these terms cover",
    body: (
      <>
        <p>
          These terms cover two things: the <strong>Mnemo software</strong>, which is licensed under the Apache License 2.0, and this <strong>website</strong>, mnemo.atmanmishra.dev. By downloading or running the software, or using the website, you accept them.
          If you do not, do not use either.
        </p>
        <p>The project is maintained by Atman Mishra. "We" means the maintainers.</p>
      </>
    ),
  },
  {
    id: "license",
    title: "The software license",
    body: (
      <>
        <p>
          Mnemo is free software under the <a href={`${REPO}/blob/main/LICENSE`}>Apache License, Version 2.0</a>. You may use, copy, modify and distribute it under that license's terms, including its patent grant and its conditions about notices.
          Nothing on this page narrows the license, and if these terms ever conflict with it for the software itself, the license wins.
        </p>
        <p>Third-party components keep their own licenses, listed in <a href={`${REPO}/blob/main/NOTICE`}>NOTICE</a>.</p>
        <p>
          The Apache license does not grant rights to our names and marks (its section 6). You may say that something works with Mnemo or is based on it; do not use the name or the Mne mascot in a way that suggests we made or endorse your fork.
        </p>
      </>
    ),
  },
  {
    id: "as-is",
    title: "No warranty",
    body: (
      <>
        <p>
          Mnemo is <strong>pre-alpha</strong> software provided <strong>"as is"</strong>, without warranties of any kind, express or implied, including merchantability, fitness for a particular purpose and non-infringement. The website and its documentation are provided the same way and may be wrong or out of date.
        </p>
        <Note tone="warn" title="It acts on your computer">
          Mnemo reads files, edits them and runs commands as you, steered by an AI model that can be wrong. Before you use it: keep your work in version control, read what it asks to run, keep the permission mode on <code>default</code> for anything you care about, and use{" "}
          <code>--yolo</code> and <code>-p</code> only where you can afford to lose everything. See <a href="/security">security</a>.
        </Note>
      </>
    ),
  },
  {
    id: "responsibility",
    title: "Your responsibilities",
    body: (
      <ul>
        <li>You are responsible for what you approve, for the commands Mnemo runs with your permissions, and for the code and data you point it at.</li>
        <li>You are responsible for your model provider account: its terms, its costs and the keys you give Mnemo. Mnemo sends your prompts to the provider you choose; the provider's terms govern that relationship.</li>
        <li>You must use Mnemo lawfully, and have the right to share the code and data you give a model.</li>
        <li>Check what an AI model produces before you rely on it or ship it. We make no promise that its output is correct, secure or free of third-party rights.</li>
      </ul>
    ),
  },
  {
    id: "liability",
    title: "Limitation of liability",
    body: (
      <>
        <p>
          To the fullest extent the law allows, the maintainers and contributors are not liable for any loss or damage arising from the software or the website: lost or corrupted files, leaked credentials, charges from a model provider, lost profits, or any indirect, incidental or consequential damage, even if we were told it was possible.
          This mirrors sections 7 and 8 of the Apache License.
        </p>
        <p>Nothing here excludes liability that cannot be excluded by law, and nothing limits any right you have by law that cannot be waived.</p>
      </>
    ),
  },
  {
    id: "website",
    title: "Using the website",
    body: (
      <>
        <ul>
          <li>You may read, link to and quote the site. Crawlers and answer engines are welcome, as <code>robots.txt</code> says.</li>
          <li>Do not attack or overload it, probe it for weaknesses outside responsible disclosure (<a href="/security#report">see security</a>), or use it to distribute malware.</li>
          <li>The site's text and code are part of the repository and available under the same Apache-2.0 license. The figures come from <a href="https://hairline.lucasmarkes.com">Hairline</a> by Lucas Marques (MIT).</li>
          <li>Links to other sites are for convenience. We do not control them and are not responsible for them.</li>
        </ul>
      </>
    ),
  },
  {
    id: "contributions",
    title: "Contributions and feedback",
    body: (
      <p>
        Unless you say otherwise, a contribution you submit to the project is licensed under Apache-2.0 as that license's section 5 describes. Do not submit anything you do not have the right to share, or any secret.
        See <a href={`${REPO}/blob/main/CONTRIBUTING.md`}>CONTRIBUTING.md</a>.
      </p>
    ),
  },
  {
    id: "changes",
    title: "Changes and contact",
    body: (
      <>
        <p>
          We may change these terms; the date above says when, and earlier versions are in the <a href={`${REPO}/commits/main/web/src/pages/Terms.tsx`}>repository history</a>. Using the software or site after a change means you accept the new terms.
          We may also change or stop the project, the website or any release at any time.
        </p>
        <p>Questions: <a href={`${REPO}/issues/new/choose`}>open an issue</a>. Security reports: <a href={`${REPO}/security/advisories/new`}>private reporting</a>.</p>
      </>
    ),
  },
];

export function Terms() {
  return (
    <DocLayout
      eyebrow="terms of use"
      title="Terms of use"
      lead={<>Plain terms for the software and the site: it is free, it is open source, it is provided as is, and it acts on your computer, so be careful what you allow.</>}
      updated="2026-10-13"
      sections={sections}
    />
  );
}
