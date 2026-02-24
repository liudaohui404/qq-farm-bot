const axios = require("axios");
const { CONFIG } = require("./config");
const { getLevelExpProgress, getLevelExpTable } = require("./gameConfig");
const { logWarn } = require("./utils");

let progressState = {
  initialized: false,
  level: 0,
  bucket: 0,
};

function getLarkWebhook() {
  return (
    process.env.FEISHU_WEBHOOK ||
    process.env.LARK_WEBHOOK ||
    CONFIG.larkWebhook ||
    ""
  ).trim();
}

function formatLarkError(err) {
  if (err && err.response) {
    const body = JSON.stringify(err.response.data);
    const bodySafe = body.length > 300 ? `${body.slice(0, 300)}...` : body;
    return `${err.message} (status=${err.response.status}, body=${bodySafe})`;
  }
  return err && err.message ? err.message : String(err);
}

async function sendLarkText(text) {
  const webhook = getLarkWebhook();
  if (!webhook) return false;

  await axios.post(
    webhook,
    {
      msg_type: "text",
      content: { text },
    },
    { timeout: 10000 },
  );
  return true;
}

function sendLarkTextSafe(text, errorPrefix = "推送失败") {
  sendLarkText(text).catch((err) => {
    logWarn("飞书", `${errorPrefix}: ${formatLarkError(err)}`);
  });
}

function notifyQrLink(url) {
  if (!url) return;
  sendLarkTextSafe(`[扫码登录] 请打开链接扫码: ${url}`, "二维码链接推送失败");
}

function getProgressBucket(level, exp) {
  const levelExpTable = getLevelExpTable();
  if (!levelExpTable || level <= 0 || exp < 0) return null;

  const progress = getLevelExpProgress(level, exp);
  if (!progress || progress.needed <= 0) return null;

  const percent = Math.floor((progress.current / progress.needed) * 100);
  const bucket = Math.floor(percent / 10);
  return {
    percent,
    bucket,
    current: progress.current,
    needed: progress.needed,
  };
}

function notifyExpProgressIfNeeded({ name, level, exp }) {
  const progress = getProgressBucket(Number(level) || 0, Number(exp) || 0);
  if (!progress) return;

  const newLevel = Number(level) || 0;
  const newBucket = progress.bucket;

  if (!progressState.initialized) {
    progressState = {
      initialized: true,
      level: newLevel,
      bucket: Math.max(0, newBucket),
    };
    return;
  }

  if (newLevel !== progressState.level) {
    progressState.level = newLevel;
    progressState.bucket = Math.max(0, newBucket);
    return;
  }

  if (newBucket <= progressState.bucket || newBucket < 1) {
    return;
  }

  progressState.bucket = newBucket;
  sendLarkTextSafe(
    `[经验进度] 角色:${name || "未知"} Lv${newLevel} 进度:${progress.percent}% (${progress.current}/${progress.needed})`,
    "经验进度推送失败",
  );
}

module.exports = {
  getLarkWebhook,
  sendLarkText,
  sendLarkTextSafe,
  notifyQrLink,
  notifyExpProgressIfNeeded,
};