import { HttpError } from "../internal/http-error";
import { formToObject } from "./json";
import { bodyAlreadyReadError, bodyCapOf, DEFAULT_FORM_LIMITS, type FormLimits } from "./limits";

const encoder = new TextEncoder();

/** The caps a form read is held to: the app's `security.limits.form`, then the route's overrides. @since 1.0.0 */
export type FormLimitsOptions = Partial<FormLimits>;

/** The defaults, then each layer in order; a cap a layer leaves `undefined` keeps the value below it (it never disables the cap). */
function capsOf(...layers: readonly (Partial<FormLimits> | undefined)[]): FormLimits {
  const caps: { -readonly [K in keyof FormLimits]: FormLimits[K] } = { ...DEFAULT_FORM_LIMITS };
  for (const layer of layers) {
    for (const key of Object.keys(DEFAULT_FORM_LIMITS) as (keyof FormLimits)[]) {
      const value = layer?.[key];
      if (value !== undefined) caps[key] = value;
    }
  }
  return caps;
}

/**
 * Reads a `multipart/form-data` or `application/x-www-form-urlencoded` body and checks its entries against the form
 * caps: the number of fields and of files, the size of a file, the size of a text field and the total of the text
 * fields. A violation is a 413 with a JSON `data.code` (`FORM_TOO_MANY_FIELDS`, `FORM_TOO_MANY_FILES`,
 * `FORM_FILE_TOO_LARGE`, `FORM_FIELD_TOO_LARGE`, `FORM_FIELDS_TOO_LARGE`).
 *
 * The whole body is parsed into memory first, bounded by the body limit of the request (`limits.maxBodyBytes`, or the
 * route's own `maxBodyBytes`). The caps bound the parsed result; they do not stream the parse. A streaming parser is
 * deferred.
 *
 * @param request The request.
 * @param limits Caps for this read; each one overrides the app's `security.limits.form`.
 * @returns The fields as {@link formToObject} builds them: repeated keys become arrays, files stay `File` objects.
 * @throws HttpError 415 when the content type is not a form, 400 when the body does not parse, 413 over a cap.
 * @example
 * export const POST = apiRoute({
 *   POST: async (event) => {
 *     const fields = await readFormLimited(event.request, { maxFileBytes: 5 * 1024 * 1024 });
 *     return json({ keys: Object.keys(fields) });
 *   },
 * });
 * @since 1.0.0
 */
export async function readFormLimited(
  request: Request,
  limits: FormLimitsOptions = {},
): Promise<Record<string, unknown>> {
  const type = (request.headers.get("content-type") ?? "").split(";")[0] ?? "";
  const mediaType = type.trim().toLowerCase();
  if (mediaType !== "multipart/form-data" && mediaType !== "application/x-www-form-urlencoded") {
    throw new HttpError(415, "Expected a form body");
  }
  const caps = capsOf(bodyCapOf(request)?.form, limits);
  // A body read before this call is the handler's own second read: the clear 500, not a malformed-body 400.
  if (request.bodyUsed) throw bodyAlreadyReadError();
  const data = await formDataOf(request);
  let entries = 0;
  let files = 0;
  let fieldBytes = 0;
  for (const value of data.values()) {
    entries += 1;
    if (entries > caps.maxFields) {
      throw tooLarge("FORM_TOO_MANY_FIELDS", `The form has more than ${caps.maxFields} fields.`);
    }
    if (value instanceof File) {
      files += 1;
      if (files > caps.maxFileCount) {
        throw tooLarge("FORM_TOO_MANY_FILES", `The form has more than ${caps.maxFileCount} files.`);
      }
      if (value.size > caps.maxFileBytes) {
        throw tooLarge("FORM_FILE_TOO_LARGE", `A file is larger than ${caps.maxFileBytes} bytes.`);
      }
      continue;
    }
    const size = encoder.encode(value).byteLength;
    if (size > caps.maxFieldBytes) {
      throw tooLarge("FORM_FIELD_TOO_LARGE", `A field is larger than ${caps.maxFieldBytes} bytes.`);
    }
    fieldBytes += size;
    if (fieldBytes > caps.maxTotalFieldBytes) {
      throw tooLarge(
        "FORM_FIELDS_TOO_LARGE",
        `The text fields are larger than ${caps.maxTotalFieldBytes} bytes.`,
      );
    }
  }
  return formToObject(data);
}

/** A 413 with a stable code in `data.code`, the message a client may read. */
function tooLarge(code: string, message: string): HttpError {
  return new HttpError(413, message, { data: { code } });
}

/**
 * Parses a form body (`multipart/form-data` or `application/x-www-form-urlencoded`). A body over the limit, or a refused
 * read, keeps its own status; a body that does not parse (no boundary, truncated) is the client's 400, not a 500.
 *
 * @param request The request.
 * @returns The parsed fields.
 * @throws HttpError 400 for a malformed body; whatever status the body read itself had (413, 400).
 * @internal
 */
export async function formDataOf(request: Request): Promise<FormData> {
  try {
    return await request.formData();
  } catch (cause) {
    if (cause instanceof HttpError) throw cause;
    throw new HttpError(400, "Invalid form body", { cause });
  }
}
