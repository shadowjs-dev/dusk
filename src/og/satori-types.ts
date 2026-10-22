/**
 * The part of satori's API this package uses, declared here so the optional satori package's own declarations (which
 * import React) are not needed to typecheck Dusk. satori is loaded with a dynamic import in `image-response.ts`.
 * @internal
 */
export interface SatoriFont {
  readonly name: string;
  readonly data: ArrayBuffer;
  readonly weight: number;
  readonly style: string;
}

/** Options of satori's `default` export. @internal */
export interface SatoriOptions {
  readonly width: number;
  readonly height: number;
  readonly fonts: readonly SatoriFont[];
}
