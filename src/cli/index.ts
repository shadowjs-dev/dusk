/**
 * The `dusk` bin (`dist/cli/index.js`, with a `#!/usr/bin/env node` line added by the build). Nothing else in the package
 * imports this folder: the command line never reaches a client or server bundle.
 *
 * @packageDocumentation
 */
import { installCrashHandlers, wantsJson } from "./json";
import { main } from "./main";

const argv = process.argv.slice(2);
if (wantsJson(argv)) {
  // A crash is JSON too. The command is the first word that is not an option, or `dusk` alone.
  const word = argv.find((arg) => !arg.startsWith("-"));
  installCrashHandlers(word === undefined ? "dusk" : `dusk ${word === "preview" ? "start" : word}`);
}
const code = await main(argv);
// Let stdout drain before exiting: a pipe may still hold the document.
process.stdout.write("", () => process.exit(code));
