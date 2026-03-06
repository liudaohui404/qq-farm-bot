/**
 * QQ经典农场 挂机脚本 - 入口文件
 *
 * 模块结构:
 *   src/config.js   - 配置常量与枚举
 *   src/utils.js    - 通用工具函数
 *   src/proto.js    - Protobuf 加载与类型管理
 *   src/network.js  - WebSocket 连接/消息编解码/登录/心跳
 *   src/farm.js     - 自己农场操作与巡田循环
 *   src/friend.js   - 好友农场操作与巡查循环
 *   src/decode.js   - PB解码/验证工具模式
 */

const { CONFIG } = require("./src/config");
const { loadProto } = require("./src/proto");
const {
  connect,
  cleanup,
  getWs,
  getConnectionRuntime,
} = require("./src/network");
const { RuntimeManager } = require("./src/runtimeManager");
const { installReloadSignal } = require("./src/reloadSignal");
const {
  initStatusBar,
  cleanupStatusBar,
  setStatusPlatform,
} = require("./src/status");
const { debugSellFruits } = require("./src/warehouse");
const { processInviteCodes } = require("./src/invite");
const { verifyMode, decodeMode } = require("./src/decode");
const { emitRuntimeHint } = require("./src/utils");
const { getQQFarmCodeByScan } = require("./src/qqQrLogin");
const EventEmitter = require("events");

let runtimeManager = null;
let uninstallReloadSignal = null;
let shuttingDown = false;

function getReloadRuntimeState() {
  const connectionRuntime = getConnectionRuntime();
  const state = connectionRuntime ? connectionRuntime.getUserState() : null;
  return {
    loggedIn: !!(state && state.gid),
    gid: state ? state.gid : 0,
    name: state ? state.name : "",
    platform: CONFIG.platform,
  };
}

// ============ 帮助信息 ============
function showHelp() {
  console.log(`
QQ经典农场 挂机脚本
====================

用法:
  node client.js --code <登录code> [--wx] [--interval <秒>] [--friend-interval <秒>]
  node client.js --qr [--interval <秒>] [--friend-interval <秒>]
  node client.js --mock [--reload-port <端口>]
  node client.js --verify
  node client.js --decode <数据> [--hex] [--gate] [--type <消息类型>]

参数:
  --code              小程序 login() 返回的临时凭证 (必需)
  --qr                启动后使用QQ扫码获取登录code（仅QQ平台）
  --wx                使用微信登录 (默认为QQ小程序)
  --mock              不连接服务器，启动一个本地 mock 运行时用于测试热重载
  --white-radish      默认优先白萝卜（等价 forceLowestLevelCrop=true）
  --interval          自己农场巡查完成后等待秒数, 默认10秒, 最低10秒
  --friend-interval   好友巡查完成后等待秒数, 默认1秒, 最低1秒
  --reload-port       HTTP 热重载端口，默认 9999
  --verify            验证proto定义
  --decode            解码PB数据 (运行 --decode 无参数查看详细帮助)

功能:
  - 自动收获成熟作物 → 购买种子 → 种植 → 施肥
  - 自动除草、除虫、浇水
  - 自动铲除枯死作物
  - 自动巡查好友农场: 帮忙浇水/除草/除虫 + 偷菜
  - 自动领取任务奖励 (支持分享翻倍)
  - 每分钟自动出售仓库果实
    - 自动使用点券购买有机化肥容器(1012)
  - 启动时读取 share.txt 处理邀请码 (仅微信)
  - 心跳保活

邀请码文件 (share.txt):
  每行一个邀请链接，格式: ?uid=xxx&openid=xxx&share_source=xxx&doc_id=xxx
  启动时会尝试通过 SyncAll API 同步这些好友
`);
}

// ============ 参数解析 ============
function parseArgs(args) {
  const options = {
    code: "",
    qrLogin: false,
    mockMode: false,
    reloadPort: 9999,
    deleteAccountMode: false,
    name: "",
    certId: "",
    certType: 0,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--code" && args[i + 1]) {
      options.code = args[++i];
    }
    if (args[i] === "--qr") {
      options.qrLogin = true;
    }
    if (args[i] === "--mock") {
      options.mockMode = true;
    }
    if (args[i] === "--wx") {
      CONFIG.platform = "wx";
    }
    if (args[i] === "--white-radish") {
      CONFIG.forceLowestLevelCrop = true;
    }
    if (args[i] === "--interval" && args[i + 1]) {
      const sec = parseInt(args[++i]);
      CONFIG.farmCheckInterval = Math.max(sec, 1) * 1000;
    }
    if (args[i] === "--friend-interval" && args[i + 1]) {
      const sec = parseInt(args[++i]);
      CONFIG.friendCheckInterval = Math.max(sec, 1) * 1000; // 最低1秒
    }
    if (args[i] === "--reload-port" && args[i + 1]) {
      const port = parseInt(args[++i], 10);
      if (Number.isInteger(port) && port > 0 && port < 65536) {
        options.reloadPort = port;
      }
    }
  }
  return options;
}

function createMockConnectionRuntime() {
  const networkEvents = new EventEmitter();
  const userState = {
    gid: 95270001,
    name: "mock-user",
    level: 1,
    gold: 0,
    exp: 0,
  };

  return {
    networkEvents,
    getUserState() {
      return userState;
    },
    sendMsgAsync(serviceName, methodName) {
      return Promise.reject(
        new Error(`[mock] request blocked: ${serviceName}.${methodName}`),
      );
    },
  };
}

async function startMockMode(options) {
  console.log(
    `[mock] starting local runtime, reload endpoint http://127.0.0.1:${options.reloadPort}/reload`,
  );

  runtimeManager = new RuntimeManager(createMockConnectionRuntime());
  await runtimeManager.loadModules(["mockReloadModule"]);

  uninstallReloadSignal = installReloadSignal(runtimeManager, {
    signalName: CONFIG.reloadSignal,
    exitOnFailure: false,
    httpPort: options.reloadPort,
    getRuntimeState: () => ({
      loggedIn: false,
      gid: 95270001,
      name: "mock-user",
      platform: "mock",
    }),
  });

  console.log(
    "[mock] ready, edit src/mockReloadModule.js and POST /reload to verify hot reload",
  );

  const shutdownMock = async (signalName) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[mock] received ${signalName}, shutting down...`);

    if (uninstallReloadSignal) {
      uninstallReloadSignal();
      uninstallReloadSignal = null;
    }

    if (runtimeManager) {
      await runtimeManager.unloadAllModules();
      runtimeManager = null;
    }

    process.exit(0);
  };

  process.on("SIGINT", () => {
    shutdownMock("SIGINT");
  });

  process.on("SIGTERM", () => {
    shutdownMock("SIGTERM");
  });
}

// ============ 主函数 ============
async function main() {
  const args = process.argv.slice(2);
  let usedQrLogin = false;
  const options = parseArgs(args);

  if (options.mockMode) {
    await startMockMode(options);
    return;
  }

  // 加载 proto 定义
  await loadProto();

  // 验证模式
  if (args.includes("--verify")) {
    await verifyMode();
    return;
  }

  // 解码模式
  if (args.includes("--decode")) {
    await decodeMode(args);
    return;
  }

  // 正常挂机模式
  // QQ 平台支持扫码登录: 显式 --qr，或未传 --code 时自动触发
  if (
    !options.code &&
    CONFIG.platform === "qq" &&
    (options.qrLogin || !args.includes("--code"))
  ) {
    console.log("[扫码登录] 正在获取二维码...");
    options.code = await getQQFarmCodeByScan();
    usedQrLogin = true;
    console.log(`[扫码登录] 获取成功，code=${options.code.substring(0, 8)}...`);
  }

  if (!options.code) {
    if (CONFIG.platform === "wx") {
      console.log("[参数] 微信模式仍需通过 --code 传入登录凭证");
    }
    showHelp();
    process.exit(1);
  }
  if (options.deleteAccountMode && (!options.name || !options.certId)) {
    console.log("[参数] 注销账号模式必须提供 --name 和 --cert-id");
    showHelp();
    process.exit(1);
  }

  // 扫码阶段结束后清屏，避免状态栏覆盖二维码区域导致界面混乱
  if (usedQrLogin && process.stdout.isTTY) {
    process.stdout.write("\x1b[2J\x1b[H");
  }

  // 初始化状态栏
  initStatusBar();
  setStatusPlatform(CONFIG.platform);
  emitRuntimeHint(true);

  const platformName = CONFIG.platform === "wx" ? "微信" : "QQ";
  console.log(
    `[启动] ${platformName} code=${options.code.substring(0, 8)}... 农场${CONFIG.farmCheckInterval / 1000}s 好友${CONFIG.friendCheckInterval / 1000}s`,
  );

  // 连接并登录，登录成功后启动各功能模块
  connect(options.code, async () => {
    // 处理邀请码 (仅微信环境)
    await processInviteCodes();

    const connectionRuntime = getConnectionRuntime();
    runtimeManager = new RuntimeManager(connectionRuntime);

    await runtimeManager.loadModules([
      "farm",
      "friend",
      "task",
      "warehouse",
      "couponShop",
    ]);

    uninstallReloadSignal = installReloadSignal(runtimeManager, {
      signalName: CONFIG.reloadSignal,
      exitOnFailure: true,
      httpPort: options.reloadPort,
      getRuntimeState: getReloadRuntimeState,
    });

    const runtimeState = getReloadRuntimeState();
    console.log(
      `[reload] installed for pid=${process.pid} gid=${runtimeState.gid} modules=${runtimeManager.getLoadedModules().join(",")}`,
    );

    // 启动时立即检查一次背包
    setTimeout(() => debugSellFruits(), 5000);
  });

  async function shutdown(signalName) {
    if (shuttingDown) return;
    shuttingDown = true;

    cleanupStatusBar();
    console.log(`\n[退出] 收到 ${signalName}，正在断开...`);

    if (uninstallReloadSignal) {
      uninstallReloadSignal();
      uninstallReloadSignal = null;
    }

    if (runtimeManager) {
      try {
        await runtimeManager.unloadAllModules();
      } catch (e) {
        console.error("[退出] 卸载业务模块失败:", e.message);
      }
    }

    cleanup();
    const ws = getWs();
    if (ws) ws.close();
    process.exit(0);
  }

  process.on("SIGINT", () => {
    shutdown("SIGINT");
  });

  process.on("SIGTERM", () => {
    shutdown("SIGTERM");
  });
}

main().catch((err) => {
  console.error("启动失败:", err);
  process.exit(1);
});
