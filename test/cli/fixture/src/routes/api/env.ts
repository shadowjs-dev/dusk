// Server-only: the greeting comes from the .env file of the app, read the way the dev server and `dusk start` read it.
export const GET = (): Response =>
  Response.json({ greeting: process.env["DUSK_CLI_GREETING"] ?? null });
