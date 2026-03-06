/**
 * 任务系统 - 自动领取任务奖励
 */

const { types } = require("./proto");
const { CONFIG } = require("./config");
const network = require("./network");
const { toLong, toNum, log, logWarn, sleep } = require("./utils");
const { getItemName } = require("./gameConfig");

let startupTimerIds = [];
let activeContext = null;

function request(serviceName, methodName, bodyBytes, timeout) {
  if (activeContext) {
    return activeContext.request(serviceName, methodName, bodyBytes, timeout);
  }
  return network.sendMsgAsync(serviceName, methodName, bodyBytes, timeout);
}

function scheduleStartupTask(fn, delayMs) {
  if (activeContext) {
    return activeContext.scheduleTimeout("task-startup", fn, delayMs);
  }
  const timerId = setTimeout(async () => {
    startupTimerIds = startupTimerIds.filter((id) => id !== timerId);
    await fn();
  }, delayMs);
  startupTimerIds.push(timerId);
}

// ============ 任务 API ============

async function getTaskInfo() {
  const body = types.TaskInfoRequest.encode(
    types.TaskInfoRequest.create({}),
  ).finish();
  const { body: replyBody } = await request(
    "gamepb.taskpb.TaskService",
    "TaskInfo",
    body,
  );
  return types.TaskInfoReply.decode(replyBody);
}

async function claimTaskReward(taskId, doShared = false) {
  const body = types.ClaimTaskRewardRequest.encode(
    types.ClaimTaskRewardRequest.create({
      id: toLong(taskId),
      do_shared: doShared,
    }),
  ).finish();
  const { body: replyBody } = await request(
    "gamepb.taskpb.TaskService",
    "ClaimTaskReward",
    body,
  );
  return types.ClaimTaskRewardReply.decode(replyBody);
}

async function batchClaimTaskReward(taskIds, doShared = false) {
  const body = types.BatchClaimTaskRewardRequest.encode(
    types.BatchClaimTaskRewardRequest.create({
      ids: taskIds.map((id) => toLong(id)),
      do_shared: doShared,
    }),
  ).finish();
  const { body: replyBody } = await request(
    "gamepb.taskpb.TaskService",
    "BatchClaimTaskReward",
    body,
  );
  return types.BatchClaimTaskRewardReply.decode(replyBody);
}

// ============ 任务分析 ============

/**
 * 分析任务列表，找出可领取的任务
 */
function analyzeTaskList(tasks) {
  const claimable = [];
  for (const task of tasks) {
    const id = toNum(task.id);
    const progress = toNum(task.progress);
    const totalProgress = toNum(task.total_progress);
    const isClaimed = task.is_claimed;
    const isUnlocked = task.is_unlocked;
    const shareMultiple = toNum(task.share_multiple);

    // 可领取条件: 已解锁 + 未领取 + 进度完成
    if (
      isUnlocked &&
      !isClaimed &&
      progress >= totalProgress &&
      totalProgress > 0
    ) {
      claimable.push({
        id,
        desc: task.desc || `任务#${id}`,
        shareMultiple,
        rewards: task.rewards || [],
      });
    }
  }
  return claimable;
}

/**
 * 计算奖励摘要
 */
function getRewardSummary(items) {
  const summary = [];
  for (const item of items) {
    const id = toNum(item.id);
    const count = toNum(item.count);
    // 常见物品ID: 1=金币, 2=经验
    if (id === 1) summary.push(`金币${count}`);
    else if (id === 2) summary.push(`经验${count}`);
    summary.push(`${getItemName(id)}(${id})x${count}`);
  }
  return summary.join("/");
}

function getTaskStatusText(task) {
  const progress = toNum(task.progress);
  const totalProgress = toNum(task.total_progress);
  const isClaimed = !!task.is_claimed;
  const isUnlocked = !!task.is_unlocked;

  if (!isUnlocked) return "未解锁";
  if (isClaimed) return "已领取";
  if (totalProgress > 0 && progress >= totalProgress) return "可领取";
  return "进行中";
}

function printTaskSection(title, tasks) {
  const list = tasks || [];
  log("任务列表", `${title}: ${list.length} 个`);
  if (list.length === 0) return;

  for (const task of list) {
    const id = toNum(task.id);
    const desc = task.desc || `任务#${id}`;
    const progress = toNum(task.progress);
    const totalProgress = toNum(task.total_progress);
    const shareMultiple = toNum(task.share_multiple);
    const status = getTaskStatusText(task);
    const progressStr =
      totalProgress > 0 ? `${progress}/${totalProgress}` : `${progress}`;
    const shareStr = shareMultiple > 1 ? ` 奖励x${shareMultiple}` : "";
    log("任务列表", `#${id} [${status}] ${desc} (${progressStr})${shareStr}`);
  }
}

async function printCurrentTaskList() {
  try {
    const reply = await getTaskInfo();
    if (!reply.task_info) {
      logWarn("任务列表", "暂无任务数据");
      return;
    }

    const taskInfo = reply.task_info;
    log("任务列表", "========== 当前任务 ==========");
    printTaskSection("成长任务", taskInfo.growth_tasks);
    printTaskSection("每日任务", taskInfo.daily_tasks);
    printTaskSection("其他任务", taskInfo.tasks);
    log("任务列表", "==============================");
  } catch (e) {
    logWarn("任务列表", `获取失败: ${e.message}`);
  }
}

function shouldUseSharedClaim(task) {
  if (CONFIG.taskBaseRewardOnly) return false;
  return toNum(task.shareMultiple) > 1;
}

async function claimSingleTaskReward(task) {
  const useShare = shouldUseSharedClaim(task);
  const multipleStr = useShare ? ` (${task.shareMultiple}倍)` : "";

  try {
    const claimReply = await claimTaskReward(task.id, useShare);
    const items = claimReply.items || [];
    const rewardStr = items.length > 0 ? getRewardSummary(items) : "无";
    log("任务", `领取: ${task.desc}${multipleStr} → ${rewardStr}`);
    return;
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    // 分享领取失败时，自动回退到基础领取，避免“任务未完成”导致整条任务漏领
    if (useShare && msg.includes("任务未完成")) {
      try {
        const claimReply = await claimTaskReward(task.id, false);
        const items = claimReply.items || [];
        const rewardStr = items.length > 0 ? getRewardSummary(items) : "无";
        log("任务", `领取(基础): ${task.desc} → ${rewardStr}`);
        return;
      } catch (fallbackErr) {
        logWarn("任务", `领取失败 #${task.id}: ${fallbackErr.message}`);
        return;
      }
    }
    logWarn("任务", `领取失败 #${task.id}: ${msg}`);
  }
}

// ============ 自动领取 ============

/**
 * 检查并领取所有可领取的任务奖励
 */
async function checkAndClaimTasks() {
  try {
    const reply = await getTaskInfo();
    if (!reply.task_info) return;

    const taskInfo = reply.task_info;
    const allTasks = [
      ...(taskInfo.growth_tasks || []),
      ...(taskInfo.daily_tasks || []),
      ...(taskInfo.tasks || []),
    ];

    const claimable = analyzeTaskList(allTasks);
    if (claimable.length === 0) return;

    log("任务", `发现 ${claimable.length} 个可领取任务`);

    for (const task of claimable) {
      await claimSingleTaskReward(task);
      await sleep(300);
    }
  } catch (e) {
    // 静默失败
  }
}

/**
 * 处理任务状态变化推送
 */
function onTaskInfoNotify(taskInfo) {
  if (!taskInfo) return;

  const allTasks = [
    ...(taskInfo.growth_tasks || []),
    ...(taskInfo.daily_tasks || []),
    ...(taskInfo.tasks || []),
  ];

  const claimable = analyzeTaskList(allTasks);
  if (claimable.length === 0) return;

  // 有可领取任务，延迟后自动领取
  log("任务", `有 ${claimable.length} 个任务可领取，准备自动领取...`);
  scheduleStartupTask(() => claimTasksFromList(claimable), 1000);
}

/**
 * 从任务列表领取奖励
 */
async function claimTasksFromList(claimable) {
  for (const task of claimable) {
    await claimSingleTaskReward(task);
    await sleep(300);
  }
}

// ============ 初始化 ============

function initTaskSystem() {
  // 监听任务状态变化推送
  if (activeContext) {
    activeContext.on("taskInfoNotify", onTaskInfoNotify);
  } else {
    network.networkEvents.on("taskInfoNotify", onTaskInfoNotify);
  }

  // 启动时打印一次当前任务列表
  scheduleStartupTask(() => printCurrentTaskList(), 2500);

  // 启动时检查一次任务
  scheduleStartupTask(() => checkAndClaimTasks(), 4000);
}

function cleanupTaskSystem() {
  if (!activeContext) {
    network.networkEvents.off("taskInfoNotify", onTaskInfoNotify);
  }
  for (const timerId of startupTimerIds) {
    clearTimeout(timerId);
  }
  startupTimerIds = [];
}

async function init(context) {
  activeContext = context;
  initTaskSystem();
}

async function cleanup() {
  cleanupTaskSystem();
  activeContext = null;
}

module.exports = {
  checkAndClaimTasks,
  printCurrentTaskList,
  init,
  cleanup,
};
