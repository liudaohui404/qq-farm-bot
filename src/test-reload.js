const http = require("http");

// 获取目标地址和端口
const target = process.argv[2] || "http://127.0.0.1:9999";
const url = new URL("/reload", target);
const healthUrl = new URL("/health", target);

function fetchJson(endpointUrl) {
  return new Promise((resolve, reject) => {
    http
      .get(endpointUrl, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(new Error(`Invalid JSON from ${endpointUrl.href}: ${data}`));
          }
        });
      })
      .on("error", reject);
  });
}

async function main() {
  try {
    const health = await fetchJson(healthUrl);
    console.log(
      `[test] Health pid=${health.pid} loggedIn=${health.runtimeState?.loggedIn} gid=${health.runtimeState?.gid} modules=${(health.loadedModules || []).join(",")}`,
    );
  } catch (err) {
    console.log(`[test] Health probe failed: ${err.message}`);
  }

  console.log(`[test] Sending POST ${url.href}...`);

  const req = http.request(url, { method: "POST" }, (res) => {
    let data = "";
    res.on("data", (chunk) => (data += chunk));
    res.on("end", () => {
      try {
        const result = JSON.parse(data);
        if (res.statusCode === 200 && result.success) {
          console.log(
            `✓ Reload triggered: ${result.message} pid=${result.pid} gid=${result.runtimeState?.gid} modules=${(result.loadedModules || []).join(",")}`,
          );
          process.exit(0);
        } else {
          console.error(
            `✗ Reload failed: ${result.message} pid=${result.pid || "?"}`,
          );
          process.exit(1);
        }
      } catch (e) {
        console.error(`✗ Invalid response: ${data}`);
        process.exit(1);
      }
    });
  });

  req.on("error", (err) => {
    console.error(`✗ Connection failed: ${err.message}`);
    console.log(
      `\nMake sure bot is running and listening on ${url.hostname}:${url.port}`,
    );
    process.exit(1);
  });

  req.end();
}

main().catch((err) => {
  console.error(`✗ Request failed: ${err.message}`);
  process.exit(1);
});
