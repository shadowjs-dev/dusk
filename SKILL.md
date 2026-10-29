---
name: shadowjs-dusk
description: "Work with @shadow-js/dusk. A full-stack framework with file routes, loaders, server functions and secure request handling. Use when a project imports it, or when asked to add, configure or debug it."
---

# @shadow-js/dusk

Version 1.0.3. A full-stack framework with file routes, loaders, server functions and secure request handling.

## Where to read more

- @shadow-js/dusk: https://dusk.shadowjs.net
- Source and issues: https://github.com/shadowjs-dev/dusk
- The package README is the full reference for options and behavior; read it before changing a configuration.

## Install

```sh
npm install @shadow-js/dusk @shadow-js/core @shadow-js/router @shadow-js/web
```

## Peer dependencies

| Package | Range | Required |
| --- | --- | --- |
| `@resvg/resvg-wasm` | `^2.6.2` | no |
| `@shadow-js/core` | `^1.0.3` | yes |
| `@shadow-js/i18n` | `^1.0.3` | no |
| `@shadow-js/router` | `^1.0.3` | yes |
| `@shadow-js/web` | `^1.0.3` | yes |
| `satori` | `^0.43.0` | no |
| `sharp` | `^0.35.5` | no |
| `subset-font` | `^2.9.0` | no |
| `vite` | `^7.0.0 || ^8.0.0` | no |

## Import paths

Import only from these paths. Never from `dist` or `src`: files that are not listed here are private and change without notice.

- `@shadow-js/dusk/client/stream`
- `@shadow-js/dusk`
- `@shadow-js/dusk/server`
- `@shadow-js/dusk/node`
- `@shadow-js/dusk/testing`
- `@shadow-js/dusk/static`
- `@shadow-js/dusk/client`
- `@shadow-js/dusk/auth`
- `@shadow-js/dusk/og`
- `@shadow-js/dusk/components`
- `@shadow-js/dusk/vite`
- `@shadow-js/dusk/bun`
- `@shadow-js/dusk/deno`
- `@shadow-js/dusk/cloudflare`
- `@shadow-js/dusk/vercel`
- `@shadow-js/dusk/netlify`
- `@shadow-js/dusk/tarout`
- `@shadow-js/dusk/features/pages`
- `@shadow-js/dusk/features/dynamic-params`
- `@shadow-js/dusk/features/metadata`
- `@shadow-js/dusk/features/data-cache`
- `@shadow-js/dusk/features/isr`
- `@shadow-js/dusk/stores/redis`
- `@shadow-js/dusk/stores/contract`
- `@shadow-js/dusk/features/rpc`
- `@shadow-js/dusk/features/api-routes`
- `@shadow-js/dusk/features/streams`
- `@shadow-js/dusk/features/images`
- `@shadow-js/dusk/features/draft-mode`
- `@shadow-js/dusk/features/routing`
- `@shadow-js/dusk/features/pwa`
- `@shadow-js/dusk/i18n`
- `@shadow-js/dusk/i18n/client`

## Quick start

```ts
import { dusk } from "@shadow-js/dusk/vite";
import { defineConfig } from "vite";

export default defineConfig({ plugins: [dusk()] });
```

## Working rules

- Run `npm run check` before proposing a change; it lints, builds, type-checks and tests.
- Keep a public change documented: TSDoc on every exported symbol, and a CHANGELOG entry.
- To change this repository rather than use the package, read AGENTS.md: the layout, the commands, the rules and how a pull request is reviewed.
