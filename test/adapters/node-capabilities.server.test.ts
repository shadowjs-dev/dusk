import { expect, it } from "vitest";
import { bun } from "../../src/bun/index";
import { cloudflare } from "../../src/cloudflare/index";
import { deno } from "../../src/deno/index";
import { netlify } from "../../src/netlify/index";
import { node } from "../../src/node/adapter";
import { tarout } from "../../src/tarout/index";
import { vercel } from "../../src/vercel/index";

it("[NODE-CAP-01] Node layouts declare their implemented WebSocket and static-file middleware bridges", () => {
  for (const adapter of [node(), tarout()]) {
    expect(adapter.capabilities.websockets).toBe(true);
    expect(adapter.capabilities.middlewareForStaticFiles).toBe(true);
    expect(adapter.capabilities.streaming).toBe(true);
    expect(adapter.capabilities.serverSentEvents).toBe(true);
  }
});

it("[NODE-CAP-02] function adapters distinguish Node request context from edge runtimes without the Node builtin bridge", () => {
  expect(vercel().capabilities.asyncContext).toBe(true);
  expect(netlify().capabilities.asyncContext).toBe(true);
  expect(vercel({ runtime: "edge" }).capabilities.asyncContext).toBe(false);
  expect(netlify({ target: "edge" }).capabilities.asyncContext).toBe(false);
});

it("[NODE-CAP-03] only the Node layouts declare Early Hints (103); the others keep the final Link header", () => {
  for (const adapter of [node(), tarout()]) expect(adapter.capabilities.earlyHints).toBe(true);
  for (const adapter of [
    bun(),
    deno(),
    cloudflare(),
    vercel(),
    vercel({ runtime: "edge" }),
    netlify(),
    netlify({ target: "edge" }),
  ]) {
    expect(adapter.capabilities.earlyHints ?? false, adapter.name).toBe(false);
  }
});
