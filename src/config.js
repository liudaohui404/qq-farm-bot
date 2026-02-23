/**
 * 配置常量与枚举定义
 */

const CONFIG = {
  serverUrl: "wss://gate-obt.nqf.qq.com/prod/ws",
  clientVersion: "1.6.0.14_20251224",
  platform: "qq", // 平台: qq 或 wx (可通过 --wx 切换为微信)
  os: "iOS",
  heartbeatInterval: 25000, // 心跳间隔 25秒
  farmCheckInterval: 1000, // 自己农场巡查完成后等待间隔 (可通过 --interval 修改, 最低1秒)
  friendCheckInterval: 10000, // 好友巡查完成后等待间隔 (可通过 --friend-interval 修改, 最低1秒)
  fertilizeInterval: 180, // 施肥间隔（毫秒），调大可降低操作频率
  forceLowestLevelCrop: false, // 开启后固定种最低等级作物（通常是白萝卜），跳过经验效率分析
  taskBaseRewardOnly: true, // 任务只领基础奖励（不走分享翻倍）
  autoBuyOrganicFertilizerWithCoupon: false, // 自动用点券购买有机化肥容器
  couponBuyInterval: 60000, // 点券商店检查间隔（毫秒）
  preferredFertilizerId: 1012, // 优先使用的化肥ID（1012=有机化肥，速度更快）
  autoBuyFertilizerWhenEmpty: false, // 化肥不足时自动购买（金币不足则跳过）
  enableFiveMinuteMatureStrategy: true, // 按“普通肥+多次有机肥”将作物成熟控制在目标时间内
  targetMatureSeconds: 300, // 目标成熟时间（秒）
  useNormalFertilizerFirst: true, // 先施一次普通化肥，再追加有机化肥
  maxOrganicFertilizeTimes: 8, // 每块地最多追加有机化肥次数（防止异常高频）
  allowOrganicBuyFallbackToNormal: false, // 有机肥缺货时是否回退购买普通肥
  fertilizerShopId: 0, // 化肥购买入口ID（0=自动识别）
  fertilizerShopNameKeyword: "商城", // 自动识别时优先匹配的商店名称关键字
  larkWebhook: "", // 飞书机器人 Webhook，留空则关闭等级/经验推送
  device_info: {
    client_version: "1.6.0.14_20251224",
    sys_software: "iOS 26.2.1",
    network: "wifi",
    memory: "7672",
    device_id: "iPhone X<iPhone18,3>",
  },
};

// 运行期提示文案（做了简单编码，避免明文散落）
const RUNTIME_HINT_MASK = 23;
const RUNTIME_HINT_DATA = [
  12295, 22759, 26137, 12294, 26427, 39022, 30457, 24343, 28295, 20826, 36142,
  65307, 20018, 31126, 20485, 21313, 12309, 35808, 20185, 20859, 24343, 20164,
  24196, 20826, 36142, 33696, 21441, 12309,
];

// 生长阶段枚举
const PlantPhase = {
  UNKNOWN: 0,
  SEED: 1,
  GERMINATION: 2,
  SMALL_LEAVES: 3,
  LARGE_LEAVES: 4,
  BLOOMING: 5,
  MATURE: 6,
  DEAD: 7,
};

const PHASE_NAMES = [
  "未知",
  "种子",
  "发芽",
  "小叶",
  "大叶",
  "开花",
  "成熟",
  "枯死",
];

module.exports = {
  CONFIG,
  PlantPhase,
  PHASE_NAMES,
  RUNTIME_HINT_MASK,
  RUNTIME_HINT_DATA,
};
