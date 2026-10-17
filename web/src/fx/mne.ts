import { SPRITE_ROWS, SPRITE_W, SPRITE_H } from "../art/sprite";

export interface Pixel {
  x: number;
  y: number;
  /** 0..5: the sprite letter a..f, an index into ELEPHANT_TOKENS. */
  c: number;
}

/** Mne's filled pixels, row by row, from the same map as public/mne.svg. */
export const PIXELS: Pixel[] = SPRITE_ROWS.flatMap((row, y) =>
  [...row].flatMap((ch, x) => (ch === "." ? [] : [{ x, y, c: ch.charCodeAt(0) - 97 }])),
);

export { SPRITE_W, SPRITE_H };
