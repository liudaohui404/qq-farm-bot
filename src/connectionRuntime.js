/**
 * 长连接运行时：负责 WS 连接、登录、心跳、请求应答与推送分发。
 * 该模块不包含业务循环逻辑，业务层可在不重登的前提下热重载。
 */

const WebSocket = require("ws");
const EventEmitter = require("events");
const { CONFIG } = require("./config");
const { types } = require("./proto");
const { toLong, toNum, syncServerTime, log, logWarn } = require("./utils");
const {
  updateStatusFromLogin,
  updateStatusGold,
  updateStatusLevel,
} = require("./status");
const { notifyExpProgressIfNeeded } = require("./larkNotifier");

class ConnectionRuntime extends EventEmitter {
  constructor() {
    super();

    this.ws = null;
    this.clientSeq = 1;
    this.serverSeq = 0;
    this.heartbeatTimer = null;
    this.pendingCallbacks = new Map();
    this.lastHeartbeatResponse = Date.now();
    this.heartbeatMissCount = 0;

    this.userState = {
      gid: 0,
      name: "",
      level: 0,
      gold: 0,
      exp: 0,
    };

    // 兼容旧业务模块的事件名。
    this.networkEvents = new EventEmitter();
  }

  getUserState() {
    return this.userState;
  }

  getWs() {
    return this.ws;
  }

  isConnected() {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  encodeMsg(serviceName, methodName, bodyBytes) {
    const msg = types.GateMessage.create({
      meta: {
        service_name: serviceName,
        method_name: methodName,
        message_type: 1,
        client_seq: toLong(this.clientSeq),
        server_seq: toLong(this.serverSeq),
      },
      body: bodyBytes || Buffer.alloc(0),
    });
    const encoded = types.GateMessage.encode(msg).finish();
    this.clientSeq++;
    return encoded;
  }

  sendMsg(serviceName, methodName, bodyBytes, callback) {
    if (!this.isConnected()) {
      log("WS", "连接未打开");
      return false;
    }

    const seq = this.clientSeq;
    const encoded = this.encodeMsg(serviceName, methodName, bodyBytes);
    if (callback) this.pendingCallbacks.set(seq, callback);
    this.ws.send(encoded);
    return true;
  }

  sendMsgAsync(serviceName, methodName, bodyBytes, timeout = 10000) {
    return new Promise((resolve, reject) => {
      if (!this.isConnected()) {
        reject(new Error(`连接未打开: ${methodName}`));
        return;
      }

      const seq = this.clientSeq;
      const timer = setTimeout(() => {
        this.pendingCallbacks.delete(seq);
        const pending = this.pendingCallbacks.size;
        reject(
          new Error(`请求超时: ${methodName} (seq=${seq}, pending=${pending})`),
        );
      }, timeout);

      const sent = this.sendMsg(
        serviceName,
        methodName,
        bodyBytes,
        (err, body, meta) => {
          clearTimeout(timer);
          if (err) reject(err);
          else resolve({ body, meta });
        },
      );

      if (!sent) {
        clearTimeout(timer);
        reject(new Error(`发送失败: ${methodName}`));
      }
    });
  }

  handleMessage(data) {
    try {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      const msg = types.GateMessage.decode(buf);
      const meta = msg.meta;
      if (!meta) return;

      if (meta.server_seq) {
        const seq = toNum(meta.server_seq);
        if (seq > this.serverSeq) this.serverSeq = seq;
      }

      const msgType = meta.message_type;

      if (msgType === 3) {
        this.handleNotify(msg);
        return;
      }

      if (msgType === 2) {
        const errorCode = toNum(meta.error_code);
        const clientSeqVal = toNum(meta.client_seq);

        const cb = this.pendingCallbacks.get(clientSeqVal);
        if (cb) {
          this.pendingCallbacks.delete(clientSeqVal);
          if (errorCode !== 0) {
            cb(
              new Error(
                `${meta.service_name}.${meta.method_name} 错误: code=${errorCode} ${meta.error_message || ""}`,
              ),
            );
          } else {
            cb(null, msg.body, meta);
          }
          return;
        }

        if (errorCode !== 0) {
          logWarn(
            "错误",
            `${meta.service_name}.${meta.method_name} code=${errorCode} ${meta.error_message || ""}`,
          );
        }
      }
    } catch (err) {
      logWarn("解码", err.message);
    }
  }

  handleNotify(msg) {
    if (!msg.body || msg.body.length === 0) return;

    try {
      const event = types.EventMessage.decode(msg.body);
      const type = event.message_type || "";
      const eventBody = event.body;

      if (type.includes("Kickout")) {
        log("推送", `被踢下线! ${type}`);
        try {
          const notify = types.KickoutNotify.decode(eventBody);
          log("推送", `原因: ${notify.reason_message || "未知"}`);
        } catch (e) {
          // ignore decode errors
        }
        this.emit("kickout", { type });
        return;
      }

      if (type.includes("LandsNotify")) {
        try {
          const notify = types.LandsNotify.decode(eventBody);
          const hostGid = toNum(notify.host_gid);
          const lands = notify.lands || [];

          if (
            lands.length > 0 &&
            (hostGid === this.userState.gid || hostGid === 0)
          ) {
            this.networkEvents.emit("landsChanged", lands);
            this.emit("push:lands", lands);
          }
        } catch (e) {
          // ignore decode errors
        }
        return;
      }

      if (type.includes("ItemNotify")) {
        try {
          const notify = types.ItemNotify.decode(eventBody);
          const items = notify.items || [];
          for (const itemChg of items) {
            const item = itemChg.item;
            if (!item) continue;
            const id = toNum(item.id);
            const count = toNum(item.count);

            if (id === 1101 || id === 2) {
              this.userState.exp = count;
              updateStatusLevel(this.userState.level, count);
              notifyExpProgressIfNeeded({
                name: this.userState.name,
                level: this.userState.level,
                exp: this.userState.exp,
              });
            } else if (id === 1 || id === 1001) {
              this.userState.gold = count;
              updateStatusGold(count);
            }
          }
        } catch (e) {
          // ignore decode errors
        }
        return;
      }

      if (type.includes("BasicNotify")) {
        try {
          const notify = types.BasicNotify.decode(eventBody);
          if (notify.basic) {
            const oldLevel = this.userState.level;
            this.userState.level =
              toNum(notify.basic.level) || this.userState.level;
            this.userState.gold =
              toNum(notify.basic.gold) || this.userState.gold;
            const exp = toNum(notify.basic.exp);
            if (exp > 0) {
              this.userState.exp = exp;
              updateStatusLevel(this.userState.level, exp);
            }
            updateStatusGold(this.userState.gold);
            notifyExpProgressIfNeeded({
              name: this.userState.name,
              level: this.userState.level,
              exp: this.userState.exp,
            });

            if (this.userState.level !== oldLevel) {
              log("系统", `升级! Lv${oldLevel} → Lv${this.userState.level}`);
            }
          }
        } catch (e) {
          // ignore decode errors
        }
        return;
      }

      if (type.includes("FriendApplicationReceivedNotify")) {
        try {
          const notify =
            types.FriendApplicationReceivedNotify.decode(eventBody);
          const applications = notify.applications || [];
          if (applications.length > 0) {
            this.networkEvents.emit("friendApplicationReceived", applications);
            this.emit("push:friendApplicationReceived", applications);
          }
        } catch (e) {
          // ignore decode errors
        }
        return;
      }

      if (type.includes("FriendAddedNotify")) {
        try {
          const notify = types.FriendAddedNotify.decode(eventBody);
          const friends = notify.friends || [];
          if (friends.length > 0) {
            const names = friends
              .map((f) => f.name || f.remark || `GID:${toNum(f.gid)}`)
              .join(", ");
            log("好友", `新好友: ${names}`);
          }
        } catch (e) {
          // ignore decode errors
        }
        return;
      }

      if (type.includes("ItemNotify")) {
        try {
          const notify = types.ItemNotify.decode(eventBody);
          const items = notify.items || [];
          for (const chg of items) {
            if (!chg.item) continue;
            const id = toNum(chg.item.id);
            const count = toNum(chg.item.count);
            const delta = toNum(chg.delta);
            if (id === 1) {
              this.userState.gold = count;
              updateStatusGold(count);
              if (delta !== 0) {
                log(
                  "物品",
                  `金币 ${delta > 0 ? "+" : ""}${delta} (当前: ${count})`,
                );
              }
            }
          }
        } catch (e) {
          // ignore decode errors
        }
        return;
      }

      if (type.includes("GoodsUnlockNotify")) {
        try {
          const notify = types.GoodsUnlockNotify.decode(eventBody);
          const goods = notify.goods_list || [];
          if (goods.length > 0) {
            log("商店", `解锁 ${goods.length} 个新商品!`);
          }
        } catch (e) {
          // ignore decode errors
        }
        return;
      }

      if (type.includes("TaskInfoNotify")) {
        try {
          const notify = types.TaskInfoNotify.decode(eventBody);
          if (notify.task_info) {
            this.networkEvents.emit("taskInfoNotify", notify.task_info);
            this.emit("push:taskInfoNotify", notify.task_info);
          }
        } catch (e) {
          // ignore decode errors
        }
        return;
      }
    } catch (e) {
      logWarn("推送", `解码失败: ${e.message}`);
    }
  }

  sendLogin(onLoginSuccess) {
    const body = types.LoginRequest.encode(
      types.LoginRequest.create({
        sharer_id: toLong(0),
        sharer_open_id: "",
        device_info: CONFIG.device_info,
        share_cfg_id: toLong(0),
        scene_id: "1256",
        report_data: {
          callback: "",
          cd_extend_info: "",
          click_id: "",
          clue_token: "",
          minigame_channel: "other",
          minigame_platid: 2,
          req_id: "",
          trackid: "",
        },
      }),
    ).finish();

    this.sendMsg(
      "gamepb.userpb.UserService",
      "Login",
      body,
      (err, bodyBytes) => {
        if (err) {
          log("登录", `失败: ${err.message}`);
          this.emit("loginError", err);
          return;
        }

        try {
          const reply = types.LoginReply.decode(bodyBytes);
          if (reply.basic) {
            this.userState.gid = toNum(reply.basic.gid);
            this.userState.name = reply.basic.name || "未知";
            this.userState.level = toNum(reply.basic.level);
            this.userState.gold = toNum(reply.basic.gold);
            this.userState.exp = toNum(reply.basic.exp);

            updateStatusFromLogin({
              name: this.userState.name,
              level: this.userState.level,
              gold: this.userState.gold,
              exp: this.userState.exp,
            });
            notifyExpProgressIfNeeded({
              name: this.userState.name,
              level: this.userState.level,
              exp: this.userState.exp,
            });

            console.log("");
            console.log("========== 登录成功 ==========");
            console.log(`  GID:    ${this.userState.gid}`);
            console.log(`  昵称:   ${this.userState.name}`);
            console.log(`  等级:   ${this.userState.level}`);
            console.log(`  金币:   ${this.userState.gold}`);
            if (reply.time_now_millis) {
              syncServerTime(toNum(reply.time_now_millis));
              console.log(
                `  时间:   ${new Date(toNum(reply.time_now_millis)).toLocaleString()}`,
              );
            }
            console.log("===============================");
            console.log("");
          }

          this.startHeartbeat();
          if (onLoginSuccess) onLoginSuccess();
          this.emit("loginSuccess", { ...this.userState });
        } catch (e) {
          log("登录", `解码失败: ${e.message}`);
          this.emit("loginError", e);
        }
      },
    );
  }

  startHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);

    this.lastHeartbeatResponse = Date.now();
    this.heartbeatMissCount = 0;

    this.heartbeatTimer = setInterval(() => {
      if (!this.userState.gid) return;

      const timeSinceLastResponse = Date.now() - this.lastHeartbeatResponse;
      if (timeSinceLastResponse > 60000) {
        this.heartbeatMissCount++;
        logWarn(
          "心跳",
          `连接可能已断开 (${Math.round(timeSinceLastResponse / 1000)}s 无响应, pending=${this.pendingCallbacks.size})`,
        );
        if (this.heartbeatMissCount >= 2) {
          log("心跳", "尝试重连...");
          this.pendingCallbacks.forEach((cb) => {
            try {
              cb(new Error("连接超时，已清理"));
            } catch (e) {
              // ignore callback errors
            }
          });
          this.pendingCallbacks.clear();
        }
      }

      const body = types.HeartbeatRequest.encode(
        types.HeartbeatRequest.create({
          gid: toLong(this.userState.gid),
          client_version: CONFIG.clientVersion,
        }),
      ).finish();

      this.sendMsg(
        "gamepb.userpb.UserService",
        "Heartbeat",
        body,
        (err, replyBody) => {
          if (err || !replyBody) return;
          this.lastHeartbeatResponse = Date.now();
          this.heartbeatMissCount = 0;
          try {
            const reply = types.HeartbeatReply.decode(replyBody);
            if (reply.server_time) syncServerTime(toNum(reply.server_time));
          } catch (e) {
            // ignore decode errors
          }
        },
      );
    }, CONFIG.heartbeatInterval);
  }

  connect(code, onLoginSuccess) {
    const url = `${CONFIG.serverUrl}?platform=${CONFIG.platform}&os=${CONFIG.os}&ver=${CONFIG.clientVersion}&code=${code}&openID=`;

    if (this.ws) {
      try {
        this.ws.close();
      } catch (e) {
        // ignore close errors
      }
      this.cleanup();
    }

    this.ws = new WebSocket(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13)",
        Origin: "https://gate-obt.nqf.qq.com",
      },
    });

    this.ws.binaryType = "arraybuffer";

    this.ws.on("open", () => {
      this.emit("connected");
      this.sendLogin(onLoginSuccess);
    });

    this.ws.on("message", (data) => {
      this.handleMessage(Buffer.isBuffer(data) ? data : Buffer.from(data));
    });

    this.ws.on("close", (wsCode, reason) => {
      console.log(`[WS] 连接关闭 (code=${wsCode})`);
      this.cleanup();
      this.emit("disconnected", { code: wsCode, reason: String(reason || "") });
    });

    this.ws.on("error", (err) => {
      logWarn("WS", `错误: ${err.message}`);
      this.emit("connectionError", err);
    });
  }

  cleanup() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.pendingCallbacks.clear();
  }

  destroy() {
    this.cleanup();
    if (this.ws) {
      try {
        this.ws.close();
      } catch (e) {
        // ignore close errors
      }
    }
    this.ws = null;
  }
}

module.exports = {
  ConnectionRuntime,
};
