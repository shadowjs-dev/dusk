// A tiny server for the worker-pool tests. It runs as a real process (the tests spawn it), and the pool forks this same
// file for every worker. It uses the built package, like an installed app does.
//
// Settings come from the environment, so the tests can vary them:
//   T_WORKERS      workers option (a number or "auto"; absent: not passed)
//   T_PORT         port (default 0)
//   T_GRACE_MS     gracefulShutdownMs
//   T_BACKOFF_MS   restartBackoffMs of the pool
//   T_READY_MS     readyTimeoutMs of the pool
//   T_LOCAL_STORE  a label to mark as a process-local store before serving
//   T_FLAG_DIR     a folder; while it holds a file named startup-exit, every worker exits during startup
import { existsSync } from "node:fs";
import { markProcessLocalStore, serve, workerInfo } from "@shadow-js/dusk/node";

const info = workerInfo();
const number = (name) => (process.env[name] === undefined ? undefined : Number(process.env[name]));
const workers = process.env.T_WORKERS === "auto" ? "auto" : number("T_WORKERS");

if (process.env.T_LOCAL_STORE) markProcessLocalStore(process.env.T_LOCAL_STORE);
// A marker file turns "a worker crashes on start" on and off while the pool runs.
const flagDir = process.env.T_FLAG_DIR;
if (flagDir !== undefined && info.clustered && existsSync(`${flagDir}/startup-exit`))
  process.exit(3);

const handler = {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/pid") {
      return Response.json({
        pid: process.pid,
        id: info.id,
        count: info.count,
        clustered: info.clustered,
      });
    }
    if (url.pathname === "/slow") {
      await new Promise((resolve) =>
        setTimeout(resolve, Number(url.searchParams.get("ms") ?? "1000")),
      );
      return new Response(`done by ${process.pid}`);
    }
    if (url.pathname === "/hold") {
      // The first chunk goes out at once, the last one after `ms`: the request is in flight in between.
      const ms = Number(url.searchParams.get("ms") ?? "1000");
      let timer;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("start\n"));
            timer = setTimeout(() => {
              controller.enqueue(new TextEncoder().encode("end\n"));
              controller.close();
            }, ms);
          },
          cancel() {
            clearTimeout(timer);
          },
        }),
        { headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    }
    if (url.pathname === "/die") {
      process.kill(process.pid, "SIGKILL");
      // SIGKILL ends the process; this line only keeps the request open until it does.
      await new Promise(() => undefined);
    }
    return new Response("ok");
  },
};

const options = {
  port: number("T_PORT") ?? 0,
  host: "127.0.0.1",
  ...(workers === undefined ? {} : { workers }),
  ...(number("T_GRACE_MS") === undefined ? {} : { gracefulShutdownMs: number("T_GRACE_MS") }),
  supervise: {
    ...(number("T_BACKOFF_MS") === undefined ? {} : { restartBackoffMs: number("T_BACKOFF_MS") }),
    ...(number("T_READY_MS") === undefined ? {} : { readyTimeoutMs: number("T_READY_MS") }),
  },
};

try {
  const handle = await serve(handler, options);
  if (handle.role !== "worker") {
    process.stdout.write(
      `READY ${JSON.stringify({ port: handle.port, role: handle.role, pid: process.pid })}\n`,
    );
  }
} catch (error) {
  process.stderr.write(`START FAILED ${error?.code ?? ""} ${error?.message ?? error}\n`);
  process.exit(1);
}
