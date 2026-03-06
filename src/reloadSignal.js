/**
 * 热重载触发器 - 支持信号和 HTTP 端点（跨平台）。
 */

const http = require("http");
console.log("[reload] initializing reload signal handler...");

function installReloadSignal(runtimeManager, options = {}) {
  const signalName = options.signalName || "SIGUSR2";
  const exitOnFailure = options.exitOnFailure !== false;
  const enableHttp = options.enableHttp !== false;
  const httpPort = options.httpPort || 9999;
  const httpHost = options.httpHost || "127.0.0.1";
  const getRuntimeState =
    typeof options.getRuntimeState === "function"
      ? options.getRuntimeState
      : () => ({});

  let inFlight = false;

  const doReload = async (triggerName) => {
    if (inFlight) {
      console.log(`[reload] ${triggerName} ignored, reload is already running`);
      return false;
    }

    inFlight = true;
    try {
      console.log(`[reload] received ${triggerName}, start reloading...`);
      await runtimeManager.reloadAll();
      console.log("[reload] finished");
      return true;
    } catch (err) {
      console.error(`[reload] failed: ${err.message}`);
      if (exitOnFailure) {
        process.exit(1);
      }
      return false;
    } finally {
      inFlight = false;
    }
  };

  let signalRegistered = false;
  const onSignal = () => doReload(signalName);
  if (signalName && process.platform !== "win32") {
    process.on(signalName, onSignal);
    signalRegistered = true;
  } else if (signalName) {
    console.log(
      `[reload] signal ${signalName} disabled on ${process.platform}, use HTTP trigger instead`,
    );
  }

  let httpServer = null;
  if (enableHttp) {
    httpServer = http.createServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/reload") {
        const success = await doReload("HTTP /reload");
        res.writeHead(success ? 200 : 500, {
          "Content-Type": "application/json",
        });
        const runtimeState = getRuntimeState();
        res.end(
          JSON.stringify({
            success,
            message: success ? "reload completed" : "reload failed",
            pid: process.pid,
            loadedModules: runtimeManager.getLoadedModules(),
            runtimeState,
          }),
        );
        return;
      }

      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            reloading: inFlight,
            pid: process.pid,
            loadedModules: runtimeManager.getLoadedModules(),
            runtimeState: getRuntimeState(),
          }),
        );
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
    });

    httpServer.on("error", (err) => {
      console.error(`[reload] HTTP server error: ${err.message}`);
      if (exitOnFailure) {
        process.exit(1);
      }
    });

    httpServer.listen(httpPort, httpHost, () => {
      console.log(
        `[reload] HTTP endpoint ready: POST http://${httpHost}:${httpPort}/reload`,
      );
    });
  }

  return () => {
    if (signalRegistered) {
      process.off(signalName, onSignal);
    }
    if (httpServer) {
      httpServer.close();
    }
  };
}

module.exports = {
  installReloadSignal,
};
