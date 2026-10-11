import type { ElementType } from "react";

// A heading cut into words so each can rise into place. The words stay real text in
// real order with real spaces between them, so the heading reads, copies and indexes
// exactly as the plain string would; no inline markup is ever split.
export function Split({ as: Tag = "h2", text, id, hero }: { as?: ElementType; text: string; id?: string; hero?: boolean }) {
  const words = text.split(" ");
  return (
    <Tag id={id} data-split="" data-hero={hero ? "" : undefined}>
      {words.map((w, i) => (
        <span key={i}>
          <span className="w">
            <span className="wi">{w}</span>
          </span>
          {i < words.length - 1 ? " " : null}
        </span>
      ))}
    </Tag>
  );
}
