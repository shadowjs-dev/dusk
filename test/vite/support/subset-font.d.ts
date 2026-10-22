/** The part of `subset-font` the tests use (the package ships no types). */
declare module "subset-font" {
  /** Cuts a font down to the characters of `text`. */
  export default function subsetFont(
    font: Uint8Array,
    text: string,
    options?: { readonly targetFormat?: "sfnt" | "woff" | "woff2" },
  ): Promise<Buffer>;
}
