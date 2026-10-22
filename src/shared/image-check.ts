import {
  DEVICE_WIDTHS,
  type ImageWidthSet,
  type ImageWidths,
  resolveImageWidths,
  SMALL_WIDTHS,
  setImageBase,
  setImageWidthSet,
} from "./image";

/**
 * The checks of a width configuration, and the function that installs one for the components. They sit apart from
 * `image.ts` (the component path), so a page that renders `<Image>` does not carry the validation messages. The
 * build (`image.widths` in `dusk.config.ts`), the server (`images.widths`) and the generated client entry all go through
 * here, so a bad list fails at build or at start and never on the first request.
 */

const MAX_WIDTH = 8192;
const MAX_WIDTH_COUNT = 64;

/** One list of an {@link ImageWidths}: absent keeps the default; otherwise 1 to 64 whole widths from 1 to 8192. */
function widthList(
  label: string,
  name: string,
  value: unknown,
  fallback: readonly number[],
): readonly number[] {
  if (value === undefined) return fallback;
  if (!Array.isArray(value)) throw new TypeError(`${label}.${name} must be an array of widths.`);
  const items: unknown[] = value;
  if (items.length === 0 || items.length > MAX_WIDTH_COUNT) {
    throw new RangeError(`${label}.${name} must hold 1 to ${MAX_WIDTH_COUNT} widths.`);
  }
  const widths: number[] = [];
  for (const item of items) {
    if (typeof item !== "number") {
      throw new TypeError(`${label}.${name} must hold numbers, not ${String(item)}.`);
    }
    if (!Number.isInteger(item) || item < 1 || item > MAX_WIDTH) {
      throw new RangeError(
        `${label}.${name} holds ${String(item)}: a width is a whole number from 1 to ${MAX_WIDTH}.`,
      );
    }
    widths.push(item);
  }
  return widths;
}

/**
 * Checks a width configuration of any type and returns the widths in use. `label` names the setting in the messages:
 * `image.widths` for `dusk.config.ts`, `images.widths` for `createHandler`.
 *
 * @param widths The configuration as written, or `undefined` for the defaults.
 * @param label The setting's name in the error messages.
 * @returns The device list, the whole offer and its largest width.
 * @throws TypeError for a value of the wrong type or an unknown key; RangeError for a width out of range.
 * @internal
 */
export function checkImageWidths(widths: unknown, label: string): ImageWidthSet {
  if (widths === undefined) return resolveImageWidths(DEVICE_WIDTHS, SMALL_WIDTHS);
  if (typeof widths !== "object" || widths === null || Array.isArray(widths)) {
    throw new TypeError(`${label} must be an object with deviceSizes and imageSizes.`);
  }
  for (const key of Object.keys(widths)) {
    if (key !== "deviceSizes" && key !== "imageSizes") {
      throw new TypeError(
        `${label} has the unknown key ${JSON.stringify(key)}: use deviceSizes or imageSizes.`,
      );
    }
  }
  const device = widthList(label, "deviceSizes", Reflect.get(widths, "deviceSizes"), DEVICE_WIDTHS);
  const small = widthList(label, "imageSizes", Reflect.get(widths, "imageSizes"), SMALL_WIDTHS);
  return resolveImageWidths(device, small);
}

/**
 * Checks a width configuration (`images.widths`) and returns the widths in use. Throws for anything the optimizer could
 * not serve, so a bad list fails when the handler is created and not on the first request.
 *
 * @param widths The configuration, or `undefined` for the defaults.
 * @returns The device list, the whole offer and its largest width.
 * @throws TypeError for a value of the wrong type or an unknown key; RangeError for a width out of range.
 * @example
 * imageWidthSet({ deviceSizes: [640, 1200], imageSizes: [64] }).all; // [64, 640, 1200]
 * @since 1.0.0
 */
export function imageWidthSet(widths: ImageWidths | undefined): ImageWidthSet {
  return checkImageWidths(widths, "images.widths");
}

/**
 * Sets the widths `<Image>` and `imageProps` use when they are given no others. The generated server and client entries
 * call it before anything renders, so the markup of the server and of the browser agree. `undefined` restores the
 * defaults. Checked like `images.widths`: a bad list throws.
 *
 * @param widths The configuration (see {@link ImageWidths}), or `undefined`.
 * @throws TypeError or RangeError for a configuration that is not valid (see {@link imageWidthSet}).
 * @since 1.0.0
 */
export function configureImageWidths(widths: ImageWidths | undefined): void {
  setImageWidthSet(imageWidthSet(widths));
}

/**
 * Sets the mount point the default image loader writes (`/app`), so `<Image>` under a mounted app asks the optimizer at
 * `/app/_dusk/image`. `""` means the app is at the root. The generated entries call it with the build's base, before
 * anything renders. A value that is not a plain path (leading slash, no trailing slash, no dot segments, no query, no
 * protocol-relative host) throws.
 *
 * @param base The mount point without a trailing slash, or `""`.
 * @throws TypeError for a base that is not a plain path.
 * @since 1.0.0
 */
export function configureImageBase(base: string): void {
  if (
    base !== "" &&
    (!base.startsWith("/") ||
      base.startsWith("//") ||
      base.endsWith("/") ||
      /[\\?#]|\.\.|\/\//.test(base))
  ) {
    throw new TypeError(
      `configureImageBase: ${JSON.stringify(base)} must be a path such as "/app", without a trailing slash.`,
    );
  }
  setImageBase(base);
}
