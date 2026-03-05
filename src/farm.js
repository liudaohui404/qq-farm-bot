/**
 * 自己的农场操作 - 收获/浇水/除草/除虫/铲除/种植/商店/巡田
 */

const protobuf = require("protobufjs");
const { CONFIG, PlantPhase, PHASE_NAMES } = require("./config");
const { types } = require("./proto");
const { sendMsgAsync, getUserState, networkEvents } = require("./network");
const {
  toLong,
  toNum,
  getServerTimeSec,
  toTimeSec,
  log,
  logWarn,
  sleep,
} = require("./utils");
const {
  getPlantNameBySeedId,
  getPlantName,
  getPlantExp,
  getItemName,
} = require("./gameConfig");
const { getBag, getBagItems } = require("./warehouse");
const { analyzeExpYield } = require("../tools/calc-exp-yield");

// ============ 内部状态 ============
let isCheckingFarm = false;
let isFirstFarmCheck = true;
let farmCheckTimer = null;
let farmLoopRunning = false;

// ============ 农场 API ============

// 操作限制更新回调 (由 friend.js 设置)
let onOperationLimitsUpdate = null;
function setOperationLimitsCallback(callback) {
  onOperationLimitsUpdate = callback;
}

async function getAllLands() {
  const body = types.AllLandsRequest.encode(
    types.AllLandsRequest.create({}),
  ).finish();
  const { body: replyBody } = await sendMsgAsync(
    "gamepb.plantpb.PlantService",
    "AllLands",
    body,
  );
  const reply = types.AllLandsReply.decode(replyBody);
  // 更新操作限制
  if (reply.operation_limits && onOperationLimitsUpdate) {
    onOperationLimitsUpdate(reply.operation_limits);
  }
  return reply;
}

async function harvest(landIds) {
  const state = getUserState();
  const body = types.HarvestRequest.encode(
    types.HarvestRequest.create({
      land_ids: landIds,
      host_gid: toLong(state.gid),
      is_all: true,
    }),
  ).finish();
  const { body: replyBody } = await sendMsgAsync(
    "gamepb.plantpb.PlantService",
    "Harvest",
    body,
  );
  return types.HarvestReply.decode(replyBody);
}

async function waterLand(landIds) {
  const state = getUserState();
  const body = types.WaterLandRequest.encode(
    types.WaterLandRequest.create({
      land_ids: landIds,
      host_gid: toLong(state.gid),
    }),
  ).finish();
  const { body: replyBody } = await sendMsgAsync(
    "gamepb.plantpb.PlantService",
    "WaterLand",
    body,
  );
  return types.WaterLandReply.decode(replyBody);
}

async function weedOut(landIds) {
  const state = getUserState();
  const body = types.WeedOutRequest.encode(
    types.WeedOutRequest.create({
      land_ids: landIds,
      host_gid: toLong(state.gid),
    }),
  ).finish();
  const { body: replyBody } = await sendMsgAsync(
    "gamepb.plantpb.PlantService",
    "WeedOut",
    body,
  );
  return types.WeedOutReply.decode(replyBody);
}

async function insecticide(landIds) {
  const state = getUserState();
  const body = types.InsecticideRequest.encode(
    types.InsecticideRequest.create({
      land_ids: landIds,
      host_gid: toLong(state.gid),
    }),
  ).finish();
  const { body: replyBody } = await sendMsgAsync(
    "gamepb.plantpb.PlantService",
    "Insecticide",
    body,
  );
  return types.InsecticideReply.decode(replyBody);
}

// 普通肥料 ID
const NORMAL_FERTILIZER_ID = 1011;
const ORGANIC_FERTILIZER_ID = 1012;
const WHITE_RADISH_SEED_ID = 20002;
const WHITE_RADISH_PRIORITY_MAX_LEVEL = 28;
const FERTILIZE_OP_SEC_PER_LAND = 0.05;
const MS_PER_HOUR = 3600000;
const EXP_MODE_DEFAULT_TARGET_PER_HOUR = 70000;
const EXP_MODE_DEFAULT_EXP_PER_LAND_PER_ROUND = 44;
const EXP_MODE_INTERVAL_CHANGE_THRESHOLD = 500;
let cachedPropShopId = null;
let lastExpModeIntervalMs = 0;

function tuneExpModeInterval(unlockedLandCount) {
  if (!CONFIG.whiteRadishExpMode) return;
  const targetExpPerHour = Math.max(
    1,
    toNum(CONFIG.expModeTargetPerHour, EXP_MODE_DEFAULT_TARGET_PER_HOUR),
  );
  const expPerLandPerRound = Math.max(
    1,
    toNum(
      CONFIG.expModeExpPerLandPerRound,
      EXP_MODE_DEFAULT_EXP_PER_LAND_PER_ROUND,
    ),
  );
  const lands = Math.max(1, toNum(unlockedLandCount, 1));
  const estimatedRoundExp = lands * expPerLandPerRound;
  const tunedIntervalMs = Math.max(
    1000,
    Math.round((estimatedRoundExp * MS_PER_HOUR) / targetExpPerHour),
  );
  if (
    Math.abs(tunedIntervalMs - lastExpModeIntervalMs) >=
    EXP_MODE_INTERVAL_CHANGE_THRESHOLD
  ) {
    CONFIG.farmCheckInterval = tunedIntervalMs;
    lastExpModeIntervalMs = tunedIntervalMs;
    log(
      "经验模式",
      `目标${targetExpPerHour}/h，按${lands}块地估算每轮${estimatedRoundExp}经验，巡查间隔设为${(tunedIntervalMs / 1000).toFixed(1)}秒`,
    );
  }
}

async function getShopProfiles() {
  const body = types.ShopProfilesRequest.encode(
    types.ShopProfilesRequest.create({}),
  ).finish();
  const { body: replyBody } = await sendMsgAsync(
    "gamepb.shoppb.ShopService",
    "ShopProfiles",
    body,
  );
  return types.ShopProfilesReply.decode(replyBody);
}

async function resolvePropShopId() {
  if (cachedPropShopId != null) return cachedPropShopId;

  const reply = await getShopProfiles();
  const profiles = reply.shop_profiles || [];
  if (profiles.length === 0) {
    throw new Error("商店列表为空");
  }

  const configuredShopId = toNum(CONFIG.fertilizerShopId);
  if (configuredShopId > 0) {
    const configuredHit = profiles.find(
      (p) => toNum(p.shop_id) === configuredShopId,
    );
    if (configuredHit) {
      cachedPropShopId = configuredShopId;
      return cachedPropShopId;
    }
    logWarn(
      "施肥",
      `配置的 fertilizerShopId=${configuredShopId} 不存在，改用自动识别`,
    );
  }

  const preferredKeyword = String(
    CONFIG.fertilizerShopNameKeyword || "",
  ).trim();
  if (preferredKeyword) {
    const keywordHit = profiles.find((p) =>
      String(p.shop_name || "").includes(preferredKeyword),
    );
    if (keywordHit) {
      cachedPropShopId = toNum(keywordHit.shop_id);
      return cachedPropShopId;
    }
  }

  // 优先按商店类型=1(道具商店)匹配
  let hit = profiles.find((p) => toNum(p.shop_type) === 1);
  if (!hit) {
    // 次选：按名称兜底
    hit = profiles.find((p) => {
      const name = String(p.shop_name || "");
      return name.includes("道具") || name.includes("商城");
    });
  }

  if (!hit) {
    throw new Error(
      `未找到道具商店，可用商店: ${profiles.map((p) => `${toNum(p.shop_id)}(${p.shop_name || "未知"})`).join(",")}`,
    );
  }

  cachedPropShopId = toNum(hit.shop_id);
  return cachedPropShopId;
}

async function findFertilizerGoods(fertilizerId) {
  const propShopId = await resolvePropShopId();
  const shopReply = await getShopInfo(propShopId);
  if (!shopReply.goods_list || shopReply.goods_list.length === 0) return null;

  const state = getUserState();
  for (const goods of shopReply.goods_list) {
    if (!goods.unlocked) continue;
    if (toNum(goods.item_id) !== fertilizerId) continue;

    let meetsConditions = true;
    const conds = goods.conds || [];
    for (const cond of conds) {
      if (toNum(cond.type) === 1) {
        const requiredLevel = toNum(cond.param);
        if (state.level < requiredLevel) {
          meetsConditions = false;
          break;
        }
      }
    }
    if (!meetsConditions) continue;

    const limitCount = toNum(goods.limit_count);
    const boughtNum = toNum(goods.bought_num);
    if (limitCount > 0 && boughtNum >= limitCount) continue;

    const price = toNum(goods.price);
    if (price <= 0) continue;

    return {
      goodsId: toNum(goods.id),
      itemId: toNum(goods.item_id),
      price,
    };
  }

  return null;
}

async function autoBuyFertilizerIfNeeded(fertilizerId) {
  if (!CONFIG.autoBuyFertilizerWhenEmpty) return false;

  let goods = null;
  try {
    goods = await findFertilizerGoods(fertilizerId);
    if (
      !goods &&
      fertilizerId === ORGANIC_FERTILIZER_ID &&
      CONFIG.allowOrganicBuyFallbackToNormal
    ) {
      // 有机买不到时，尝试普通化肥兜底
      goods = await findFertilizerGoods(NORMAL_FERTILIZER_ID);
    }
  } catch (e) {
    logWarn("施肥", `查询化肥商店失败: ${e.message}`);
    return false;
  }

  if (!goods) {
    logWarn("施肥", `商店无可购买化肥（目标ID=${fertilizerId}）`);
    return false;
  }

  const state = getUserState();
  if (state.gold < goods.price) {
    logWarn(
      "施肥",
      `金币不足，无法购买 ${getItemName(goods.itemId)}，需要 ${goods.price}，当前 ${state.gold}`,
    );
    return false;
  }

  try {
    const buyReply = await buyGoods(goods.goodsId, 1, goods.price);
    let costGold = goods.price;
    if (buyReply.cost_items) {
      for (const item of buyReply.cost_items) {
        const id = toNum(item.id);
        const count = toNum(item.count);
        if (id === 1 || id === 1001) {
          state.gold -= count;
          costGold = count;
        }
      }
    }
    log(
      "施肥",
      `化肥不足已自动购买: ${getItemName(goods.itemId)} x1，花费 ${costGold} 金币`,
    );
    return true;
  } catch (e) {
    logWarn("施肥", `自动购买化肥失败: ${e.message}`);
    return false;
  }
}

/**
 * 施肥 - 必须逐块进行，服务器不支持批量
 * 施肥间隔可通过 CONFIG.fertilizeInterval 调整
 */
async function fertilize(
  landIds,
  fertilizerId = CONFIG.preferredFertilizerId || ORGANIC_FERTILIZER_ID,
) {
  let successCount = 0;
  for (const landId of landIds) {
    try {
      const body = types.FertilizeRequest.encode(
        types.FertilizeRequest.create({
          land_ids: [toLong(landId)],
          fertilizer_id: toLong(fertilizerId),
        }),
      ).finish();
      await sendMsgAsync("gamepb.plantpb.PlantService", "Fertilize", body);
      successCount++;
    } catch (e) {
      // 施肥失败（通常是化肥不足），尝试自动购买一次后重试当前地块
      const purchased = await autoBuyFertilizerIfNeeded(fertilizerId);
      if (!purchased) {
        // 不自动购买或购买失败时，有机化肥自动回退普通化肥
        if (fertilizerId === ORGANIC_FERTILIZER_ID) {
          try {
            const fallbackBody = types.FertilizeRequest.encode(
              types.FertilizeRequest.create({
                land_ids: [toLong(landId)],
                fertilizer_id: toLong(NORMAL_FERTILIZER_ID),
              }),
            ).finish();
            await sendMsgAsync(
              "gamepb.plantpb.PlantService",
              "Fertilize",
              fallbackBody,
            );
            successCount++;
            log("施肥", `土地#${landId} 有机化肥不足，已回退普通化肥`);
            if (landIds.length > 1)
              await sleep(Math.max(50, toNum(CONFIG.fertilizeInterval, 180)));
            continue;
          } catch (fallbackErr) {
            logWarn(
              "施肥",
              `土地#${landId} 回退普通化肥失败: ${fallbackErr.message}`,
            );
          }
        }
        break;
      }

      try {
        const retryBody = types.FertilizeRequest.encode(
          types.FertilizeRequest.create({
            land_ids: [toLong(landId)],
            fertilizer_id: toLong(fertilizerId),
          }),
        ).finish();
        await sendMsgAsync(
          "gamepb.plantpb.PlantService",
          "Fertilize",
          retryBody,
        );
        successCount++;
      } catch (retryErr) {
        logWarn("施肥", `补货后重试失败: ${retryErr.message}`);
        break;
      }
    }
    if (landIds.length > 1)
      await sleep(Math.max(50, toNum(CONFIG.fertilizeInterval, 180)));
  }
  return successCount;
}

async function logCurrentFertilizerBalance() {
  try {
    const bagReply = await getBag();
    const items = getBagItems(bagReply);
    let normalCount = 0;
    let organicCount = 0;

    for (const item of items || []) {
      const id = toNum(item.id);
      const count = toNum(item.count);
      if (id === NORMAL_FERTILIZER_ID) normalCount += count;
      if (id === ORGANIC_FERTILIZER_ID) organicCount += count;
    }

    log(
      "施肥",
      `当前化肥余量: 普通(${NORMAL_FERTILIZER_ID})=${normalCount}, 有机(${ORGANIC_FERTILIZER_ID})=${organicCount}`,
    );
  } catch (e) {
    logWarn("施肥", `读取化肥余量失败: ${e.message}`);
  }
}

async function fertilizeByMatureStrategy(plantedGroups) {
  const groups = plantedGroups || [];
  if (groups.length === 0) return 0;

  const allLands = groups.flatMap((g) => g.lands || []);
  if (allLands.length === 0) return 0;

  let totalFertilized = 0;

  if (CONFIG.useNormalFertilizerFirst) {
    const normalFertilized = await fertilize(allLands, NORMAL_FERTILIZER_ID);
    totalFertilized = Math.max(totalFertilized, normalFertilized);
    if (normalFertilized > 0) {
      log("施肥", `普通化肥: ${normalFertilized}/${allLands.length}`);
    }
  }

  const maxOrganicRounds = groups.reduce(
    (m, g) => Math.max(m, toNum(g.organicTimes)),
    0,
  );
  for (let round = 1; round <= maxOrganicRounds; round++) {
    const roundLands = groups
      .filter((g) => toNum(g.organicTimes) >= round)
      .flatMap((g) => g.lands || []);
    if (roundLands.length === 0) continue;

    const roundFertilized = await fertilize(roundLands, ORGANIC_FERTILIZER_ID);
    if (roundFertilized > 0) {
      log(
        "施肥",
        `有机化肥第${round}轮: ${roundFertilized}/${roundLands.length}`,
      );
      totalFertilized = Math.max(totalFertilized, roundFertilized);
    }
    if (roundFertilized < roundLands.length) {
      logWarn("施肥", `有机化肥第${round}轮未完全成功，停止后续轮次`);
      break;
    }
  }

  return totalFertilized;
}

async function removePlant(landIds) {
  const body = types.RemovePlantRequest.encode(
    types.RemovePlantRequest.create({
      land_ids: landIds.map((id) => toLong(id)),
    }),
  ).finish();
  const { body: replyBody } = await sendMsgAsync(
    "gamepb.plantpb.PlantService",
    "RemovePlant",
    body,
  );
  return types.RemovePlantReply.decode(replyBody);
}

// ============ 商店 API ============

async function getShopInfo(shopId) {
  const body = types.ShopInfoRequest.encode(
    types.ShopInfoRequest.create({
      shop_id: toLong(shopId),
    }),
  ).finish();
  const { body: replyBody } = await sendMsgAsync(
    "gamepb.shoppb.ShopService",
    "ShopInfo",
    body,
  );
  return types.ShopInfoReply.decode(replyBody);
}

async function buyGoods(goodsId, num, price) {
  const body = types.BuyGoodsRequest.encode(
    types.BuyGoodsRequest.create({
      goods_id: toLong(goodsId),
      num: toLong(num),
      price: toLong(price),
    }),
  ).finish();
  const { body: replyBody } = await sendMsgAsync(
    "gamepb.shoppb.ShopService",
    "BuyGoods",
    body,
  );
  return types.BuyGoodsReply.decode(replyBody);
}

// ============ 种植 ============

function encodePlantRequest(seedId, landIds) {
  const writer = protobuf.Writer.create();
  const itemWriter = writer.uint32(18).fork();
  itemWriter.uint32(8).int64(seedId);
  const idsWriter = itemWriter.uint32(18).fork();
  for (const id of landIds) {
    idsWriter.int64(id);
  }
  idsWriter.ldelim();
  itemWriter.ldelim();
  return writer.finish();
}

/**
 * 种植 - 游戏中拖动种植间隔很短，这里用 50ms
 */
async function plantSeeds(seedId, landIds) {
  let successCount = 0;
  for (const landId of landIds) {
    try {
      const body = encodePlantRequest(seedId, [landId]);
      const { body: replyBody } = await sendMsgAsync(
        "gamepb.plantpb.PlantService",
        "Plant",
        body,
      );
      types.PlantReply.decode(replyBody);
      successCount++;
    } catch (e) {
      logWarn("种植", `土地#${landId} 失败: ${e.message}`);
    }
    if (landIds.length > 1) await sleep(50); // 50ms 间隔
  }
  return successCount;
}

function buildSeedStrategyMap(level, landsCount, hasOrganicFertilizer = true) {
  const map = new Map();
  try {
    const safeLands = Math.max(1, toNum(landsCount, 18));
    const targetMatureSeconds = Math.max(
      60,
      toNum(CONFIG.targetMatureSeconds, 300),
    );
    const maxOrganicTimes = Math.max(
      0,
      toNum(CONFIG.maxOrganicFertilizeTimes, 8),
    );

    const payload = analyzeExpYield({
      level,
      lands: safeLands,
      top: 200,
    });

    for (const row of payload.rows || []) {
      if (row.requiredLevel > level) continue;

      const baseGrowSec = Math.max(1, toNum(row.growTimeSec, 0));
      const phaseReduceSec = Math.max(0, toNum(row.normalFertReduceSec, 0));
      const plantSeconds = Math.max(
        0,
        toNum(row.cycleSecNormalFert, 0) - toNum(row.growTimeNormalFert, 0),
      );
      const expHarvest = Math.max(0, toNum(row.expHarvest, 0));

      const normalReduceSec = CONFIG.useNormalFertilizerFirst
        ? phaseReduceSec
        : 0;
      const growAfterNormal = Math.max(1, baseGrowSec - normalReduceSec);

      let organicTimes = 0;
      let targetReached = growAfterNormal <= targetMatureSeconds;

      if (!targetReached && hasOrganicFertilizer) {
        if (phaseReduceSec > 0) {
          organicTimes = Math.ceil(
            (growAfterNormal - targetMatureSeconds) / phaseReduceSec,
          );
          if (organicTimes <= maxOrganicTimes) {
            targetReached = true;
          }
        }
      }

      if (organicTimes > maxOrganicTimes) {
        targetReached = false;
        organicTimes = maxOrganicTimes;
      }

      const finalGrowSec = Math.max(
        1,
        growAfterNormal - organicTimes * phaseReduceSec,
      );
      const fertOpsPerLand =
        (CONFIG.useNormalFertilizerFirst ? 1 : 0) + organicTimes;
      const fertilizeSeconds =
        safeLands * FERTILIZE_OP_SEC_PER_LAND * fertOpsPerLand;
      const cycleSec = finalGrowSec + plantSeconds + fertilizeSeconds;
      const expPerHour =
        cycleSec > 0 ? ((safeLands * expHarvest) / cycleSec) * 3600 : 0;

      map.set(row.seedId, {
        expPerHour,
        organicTimes,
        finalGrowSec,
        targetReached,
      });
    }
  } catch (e) {
    logWarn("商店", `构建收益评分失败: ${e.message}`);
  }
  return map;
}

function pruneParetoStates(states) {
  if (!states || states.length <= 1) return states || [];
  const sorted = [...states].sort(
    (a, b) => a.cost - b.cost || b.score - a.score,
  );
  const kept = [];
  let bestScore = -Infinity;
  for (const s of sorted) {
    if (s.score > bestScore + 1e-8) {
      kept.push(s);
      bestScore = s.score;
    }
  }
  // 小规模截断，防止状态数意外膨胀
  return kept.slice(0, 300);
}

function findBestSeedPlan(
  availableSeeds,
  landsNeed,
  gold,
  level,
  landsCount,
  hasOrganicFertilizer = true,
) {
  if (!availableSeeds || availableSeeds.length === 0 || landsNeed <= 0) {
    return { plan: [], plannedLands: 0, score: 0, cost: 0 };
  }

  const strategyMap = buildSeedStrategyMap(level, landsCount, hasOrganicFertilizer);
  let options = availableSeeds
    .map((seed) => {
      const limitCount = toNum(seed.goods.limit_count);
      const boughtNum = toNum(seed.goods.bought_num);
      const remainByLimit =
        limitCount > 0 ? Math.max(0, limitCount - boughtNum) : landsNeed;
      const strategy = strategyMap.get(seed.seedId) || null;
      return {
        ...seed,
        maxCount: Math.min(landsNeed, remainByLimit),
        score: strategy ? toNum(strategy.expPerHour, 0) : 0,
        organicTimes: strategy ? toNum(strategy.organicTimes, 0) : 0,
        finalGrowSec: strategy ? toNum(strategy.finalGrowSec, 0) : 0,
        targetReached: !!(strategy && strategy.targetReached),
      };
    })
    .filter((x) => x.maxCount > 0 && x.price > 0)
    .sort((a, b) => b.score - a.score || a.price - b.price);

  if (CONFIG.enableFiveMinuteMatureStrategy && hasOrganicFertilizer) {
    const targetOptions = options.filter((x) => x.targetReached);
    if (targetOptions.length > 0) {
      options = targetOptions;
    } else {
      logWarn(
        "商店",
        `当前等级可用作物无法稳定压到 ${Math.max(60, toNum(CONFIG.targetMatureSeconds, 300))} 秒内，已回退到最快策略`,
      );
    }
  }

  if (options.length === 0) {
    return { plan: [], plannedLands: 0, score: 0, cost: 0 };
  }

  // 若评分缺失，使用原有单种子逻辑兜底
  if (options.every((x) => x.score <= 0)) {
    const fallback = [...options].sort(
      (a, b) => a.requiredLevel - b.requiredLevel || a.price - b.price,
    )[0];
    const count = Math.min(
      landsNeed,
      Math.floor(gold / fallback.price),
      fallback.maxCount,
    );
    if (count <= 0) return { plan: [], plannedLands: 0, score: 0, cost: 0 };
    return {
      plan: [{ ...fallback, count }],
      plannedLands: count,
      score: fallback.score * count,
      cost: fallback.price * count,
    };
  }

  let states = Array.from({ length: landsNeed + 1 }, () => []);
  states[0] = [{ cost: 0, score: 0, picks: {} }];

  for (const opt of options) {
    const next = states.map((bucket) => bucket.slice());
    for (let used = 0; used <= landsNeed; used++) {
      if (states[used].length === 0) continue;
      const maxAdd = Math.min(opt.maxCount, landsNeed - used);
      if (maxAdd <= 0) continue;

      for (const prev of states[used]) {
        for (let add = 1; add <= maxAdd; add++) {
          const nextCost = prev.cost + add * opt.price;
          if (nextCost > gold) break;

          const nextUsed = used + add;
          const nextPicks = { ...prev.picks };
          nextPicks[opt.seedId] = (nextPicks[opt.seedId] || 0) + add;
          next[nextUsed].push({
            cost: nextCost,
            score: prev.score + add * opt.score,
            picks: nextPicks,
          });
        }
      }
    }

    states = next.map(pruneParetoStates);
  }

  let bestState = null;
  let bestUsed = 0;
  for (let used = landsNeed; used >= 1; used--) {
    for (const s of states[used]) {
      if (s.cost > gold) continue;
      if (!bestState) {
        bestState = s;
        bestUsed = used;
        continue;
      }
      if (
        used > bestUsed ||
        (used === bestUsed && s.score > bestState.score + 1e-8) ||
        (used === bestUsed &&
          Math.abs(s.score - bestState.score) <= 1e-8 &&
          s.cost < bestState.cost)
      ) {
        bestState = s;
        bestUsed = used;
      }
    }
    if (bestState && bestUsed === landsNeed) break;
  }

  if (!bestState) {
    return { plan: [], plannedLands: 0, score: 0, cost: 0 };
  }

  const optionBySeedId = new Map(options.map((x) => [x.seedId, x]));
  const plan = Object.entries(bestState.picks)
    .map(([seedIdText, count]) => {
      const seedId = Number(seedIdText);
      const opt = optionBySeedId.get(seedId);
      if (!opt || count <= 0) return null;
      return { ...opt, count };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || a.price - b.price);

  return {
    plan,
    plannedLands: bestUsed,
    score: bestState.score,
    cost: bestState.cost,
  };
}

async function autoPlantEmptyLands(
  deadLandIds,
  emptyLandIds,
  unlockedLandCount,
) {
  let landsToPlant = [...emptyLandIds];
  const state = getUserState();

  // 1. 铲除枯死/收获残留植物（一键操作）
  if (deadLandIds.length > 0) {
    try {
      await removePlant(deadLandIds);
      log("铲除", `已铲除 ${deadLandIds.length} 块 (${deadLandIds.join(",")})`);
      landsToPlant.push(...deadLandIds);
    } catch (e) {
      logWarn("铲除", `批量铲除失败: ${e.message}`);
      // 失败时仍然尝试种植
      landsToPlant.push(...deadLandIds);
    }
  }

  if (landsToPlant.length === 0) return;

  // 2. 查询种子商店并生成组合方案
  let seedOptions = [];
  try {
    const SEED_SHOP_ID = 2;
    const shopReply = await getShopInfo(SEED_SHOP_ID);
    if (!shopReply.goods_list || shopReply.goods_list.length === 0) {
      logWarn("商店", "种子商店无商品");
      return;
    }

    for (const goods of shopReply.goods_list) {
      if (!goods.unlocked) continue;

      let meetsConditions = true;
      let requiredLevel = 0;
      const conds = goods.conds || [];
      for (const cond of conds) {
        if (toNum(cond.type) === 1) {
          requiredLevel = toNum(cond.param);
          if (state.level < requiredLevel) {
            meetsConditions = false;
            break;
          }
        }
      }
      if (!meetsConditions) continue;

      const limitCount = toNum(goods.limit_count);
      const boughtNum = toNum(goods.bought_num);
      if (limitCount > 0 && boughtNum >= limitCount) continue;

      seedOptions.push({
        goods,
        goodsId: toNum(goods.id),
        seedId: toNum(goods.item_id),
        price: toNum(goods.price),
        requiredLevel,
      });
    }

    if (seedOptions.length === 0) {
      logWarn("商店", "没有可购买的种子");
      return;
    }
  } catch (e) {
    logWarn("商店", `查询失败: ${e.message}`);
    return;
  }

  let hasOrganicFertilizer = false;
  try {
    const bagReply = await getBag();
    const items = getBagItems(bagReply);
    hasOrganicFertilizer = (items || []).some(
      (item) =>
        toNum(item.id) === ORGANIC_FERTILIZER_ID && toNum(item.count) > 0,
    );
  } catch (e) {
    logWarn("施肥", `读取有机肥余量失败，按无有机肥处理: ${e.message}`);
  }

  let plantingPlan;
  if (CONFIG.whiteRadishExpMode) {
    const whiteRadish =
      seedOptions.find((s) => s.seedId === WHITE_RADISH_SEED_ID) || null;
    if (!whiteRadish) {
      logWarn("商店", "白萝卜种子不可购买，无法执行白萝卜刷经验模式");
      return;
    }
    const count = Math.min(
      landsToPlant.length,
      Math.floor(state.gold / whiteRadish.price),
    );
    if (count <= 0) {
      logWarn(
        "商店",
        `金币不足! 当前 ${state.gold} 金币，无法购买白萝卜种子`,
      );
      return;
    }
    plantingPlan = {
      plan: [{ ...whiteRadish, count, organicTimes: 0 }],
      plannedLands: count,
      cost: whiteRadish.price * count,
    };
  }

  if (!plantingPlan && state.level < WHITE_RADISH_PRIORITY_MAX_LEVEL) {
    const whiteRadish =
      seedOptions.find((s) => s.seedId === WHITE_RADISH_SEED_ID) || null;
    if (whiteRadish) {
      const count = Math.min(
        landsToPlant.length,
        Math.floor(state.gold / whiteRadish.price),
      );
      if (count > 0) {
        plantingPlan = {
          plan: [{ ...whiteRadish, count }],
          plannedLands: count,
          cost: whiteRadish.price * count,
        };
      }
    }
  }

  if (!plantingPlan && CONFIG.forceLowestLevelCrop) {
    seedOptions.sort(
      (a, b) => a.requiredLevel - b.requiredLevel || a.price - b.price,
    );
    const selected = seedOptions[0];
    const count = Math.min(
      landsToPlant.length,
      Math.floor(state.gold / selected.price),
    );
    if (count <= 0) {
      logWarn(
        "商店",
        `金币不足! 当前 ${state.gold} 金币，无法购买最低等级种子`,
      );
      return;
    }
    plantingPlan = {
      plan: [{ ...selected, count }],
      plannedLands: count,
      cost: selected.price * count,
    };
  } else if (!plantingPlan) {
    plantingPlan = findBestSeedPlan(
      seedOptions,
      landsToPlant.length,
      state.gold,
      state.level,
      unlockedLandCount,
      hasOrganicFertilizer,
    );
    if (plantingPlan.plan.length === 0) {
      logWarn("商店", `金币不足或限购限制，当前金币 ${state.gold}`);
      return;
    }
  }

  const planText = plantingPlan.plan
    .map((p) => `${getPlantNameBySeedId(p.seedId)}x${p.count}`)
    .join(" + ");
  const fertText = plantingPlan.plan
    .map(
      (p) => `${getPlantNameBySeedId(p.seedId)}:有机${toNum(p.organicTimes)}次`,
    )
    .join(" / ");
  log("商店", `最优组合: ${planText}，预计花费 ${plantingPlan.cost} 金币`);
  if (CONFIG.enableFiveMinuteMatureStrategy) {
    log("商店", `5分钟控时策略: ${fertText}`);
  }

  // 3. 购买 + 种植（按组合分批）
  landsToPlant = landsToPlant.slice(0, plantingPlan.plannedLands);
  let nextLandIdx = 0;
  let totalPlantedLands = [];
  const plantedGroupMap = new Map();

  for (const entry of plantingPlan.plan) {
    if (nextLandIdx >= landsToPlant.length) break;

    const remainingLands = landsToPlant.length - nextLandIdx;
    let buyCount = Math.min(entry.count, remainingLands);
    if (buyCount <= 0) continue;

    let actualSeedId = entry.seedId;
    let actualCount = buyCount;
    try {
      const buyReply = await buyGoods(entry.goodsId, buyCount, entry.price);
      if (buyReply.get_items && buyReply.get_items.length > 0) {
        const gotItem = buyReply.get_items[0];
        const gotId = toNum(gotItem.id);
        const gotCount = toNum(gotItem.count);
        log("购买", `获得物品: ${getItemName(gotId)}(${gotId}) x${gotCount}`);
        if (gotId > 0) actualSeedId = gotId;
        if (gotCount > 0) actualCount = Math.min(actualCount, gotCount);
      }
      if (buyReply.cost_items) {
        for (const item of buyReply.cost_items) {
          state.gold -= toNum(item.count);
        }
      }

      const boughtName = getPlantNameBySeedId(actualSeedId);
      log(
        "购买",
        `已购买 ${boughtName}种子 x${actualCount}, 预算价 ${entry.price} 金币/个`,
      );
    } catch (e) {
      logWarn(
        "购买",
        `${getPlantNameBySeedId(entry.seedId)} 购买失败: ${e.message}`,
      );
      continue;
    }

    const targetLands = landsToPlant.slice(
      nextLandIdx,
      nextLandIdx + actualCount,
    );
    if (targetLands.length === 0) continue;

    try {
      const planted = await plantSeeds(actualSeedId, targetLands);
      if (planted > 0) {
        const plantedLands = targetLands.slice(0, planted);
        totalPlantedLands.push(...plantedLands);

        const groupKey = actualSeedId;
        const oldGroup = plantedGroupMap.get(groupKey) || {
          lands: [],
          organicTimes: toNum(entry.organicTimes, 0),
        };
        oldGroup.lands.push(...plantedLands);
        oldGroup.organicTimes = Math.max(
          toNum(oldGroup.organicTimes),
          toNum(entry.organicTimes, 0),
        );
        plantedGroupMap.set(groupKey, oldGroup);

        log(
          "种植",
          `${getPlantNameBySeedId(actualSeedId)} 已种植 ${planted}/${targetLands.length} 块`,
        );
        nextLandIdx += planted;
      }
    } catch (e) {
      logWarn(
        "种植",
        `${getPlantNameBySeedId(actualSeedId)} 种植失败: ${e.message}`,
      );
    }
  }

  // 4. 施肥（逐块拖动，间隔50ms）
  if (totalPlantedLands.length > 0 && !CONFIG.whiteRadishExpMode) {
    await logCurrentFertilizerBalance();
    let fertilized = 0;
    if (CONFIG.enableFiveMinuteMatureStrategy) {
      fertilized = await fertilizeByMatureStrategy(
        Array.from(plantedGroupMap.values()),
      );
    } else {
      fertilized = await fertilize(totalPlantedLands);
    }
    if (fertilized > 0) {
      log("施肥", `已为 ${fertilized}/${totalPlantedLands.length} 块地施肥`);
    }
  }
}

// ============ 土地分析 ============

/**
 * 根据服务器时间确定当前实际生长阶段
 */
function getCurrentPhase(phases, debug, landLabel) {
  if (!phases || phases.length === 0) return null;

  const nowSec = getServerTimeSec();

  if (debug) {
    console.log(
      `    ${landLabel} 服务器时间=${nowSec} (${new Date(nowSec * 1000).toLocaleTimeString()})`,
    );
    for (let i = 0; i < phases.length; i++) {
      const p = phases[i];
      const bt = toTimeSec(p.begin_time);
      const phaseName = PHASE_NAMES[p.phase] || `阶段${p.phase}`;
      const diff = bt > 0 ? bt - nowSec : 0;
      const diffStr =
        diff > 0 ? `(未来 ${diff}s)` : diff < 0 ? `(已过 ${-diff}s)` : "";
      console.log(
        `    ${landLabel}   [${i}] ${phaseName}(${p.phase}) begin=${bt} ${diffStr} dry=${toTimeSec(p.dry_time)} weed=${toTimeSec(p.weeds_time)} insect=${toTimeSec(p.insect_time)}`,
      );
    }
  }

  for (let i = phases.length - 1; i >= 0; i--) {
    const beginTime = toTimeSec(phases[i].begin_time);
    if (beginTime > 0 && beginTime <= nowSec) {
      if (debug) {
        console.log(
          `    ${landLabel}   → 当前阶段: ${PHASE_NAMES[phases[i].phase] || phases[i].phase}`,
        );
      }
      return phases[i];
    }
  }

  if (debug) {
    console.log(
      `    ${landLabel}   → 所有阶段都在未来，使用第一个: ${PHASE_NAMES[phases[0].phase] || phases[0].phase}`,
    );
  }
  return phases[0];
}

function analyzeLands(lands) {
  const result = {
    harvestable: [],
    needWater: [],
    needWeed: [],
    needBug: [],
    growing: [],
    empty: [],
    dead: [],
    harvestableInfo: [], // 收获植物的详细信息 { id, name, exp }
  };

  const nowSec = getServerTimeSec();
  const debug = false;

  if (debug) {
    console.log("");
    console.log("========== 首次巡田详细日志 ==========");
    console.log(
      `  服务器时间(秒): ${nowSec}  (${new Date(nowSec * 1000).toLocaleString()})`,
    );
    console.log(`  总土地数: ${lands.length}`);
    console.log("");
  }

  for (const land of lands) {
    const id = toNum(land.id);
    if (!land.unlocked) {
      if (debug) console.log(`  土地#${id}: 未解锁`);
      continue;
    }

    const plant = land.plant;
    if (!plant || !plant.phases || plant.phases.length === 0) {
      result.empty.push(id);
      if (debug) console.log(`  土地#${id}: 空地`);
      continue;
    }

    const plantName = plant.name || "未知作物";
    const landLabel = `土地#${id}(${plantName})`;

    if (debug) {
      console.log(
        `  ${landLabel}: phases=${plant.phases.length} dry_num=${toNum(plant.dry_num)} weed_owners=${(plant.weed_owners || []).length} insect_owners=${(plant.insect_owners || []).length}`,
      );
    }

    const currentPhase = getCurrentPhase(plant.phases, debug, landLabel);
    if (!currentPhase) {
      result.empty.push(id);
      continue;
    }
    const phaseVal = currentPhase.phase;

    if (phaseVal === PlantPhase.DEAD) {
      result.dead.push(id);
      if (debug) console.log(`    → 结果: 枯死`);
      continue;
    }

    if (phaseVal === PlantPhase.MATURE) {
      result.harvestable.push(id);
      // 收集植物信息用于日志
      const plantId = toNum(plant.id);
      const plantNameFromConfig = getPlantName(plantId);
      const plantExp = getPlantExp(plantId);
      result.harvestableInfo.push({
        landId: id,
        plantId,
        name: plantNameFromConfig || plantName,
        exp: plantExp,
      });
      if (debug)
        console.log(
          `    → 结果: 可收获 (${plantNameFromConfig} +${plantExp}经验)`,
        );
      continue;
    }

    let landNeeds = [];
    const dryNum = toNum(plant.dry_num);
    const dryTime = toTimeSec(currentPhase.dry_time);
    if (dryNum > 0 || (dryTime > 0 && dryTime <= nowSec)) {
      result.needWater.push(id);
      landNeeds.push("缺水");
    }

    const weedsTime = toTimeSec(currentPhase.weeds_time);
    const hasWeeds =
      (plant.weed_owners && plant.weed_owners.length > 0) ||
      (weedsTime > 0 && weedsTime <= nowSec);
    if (hasWeeds) {
      result.needWeed.push(id);
      landNeeds.push("有草");
    }

    const insectTime = toTimeSec(currentPhase.insect_time);
    const hasBugs =
      (plant.insect_owners && plant.insect_owners.length > 0) ||
      (insectTime > 0 && insectTime <= nowSec);
    if (hasBugs) {
      result.needBug.push(id);
      landNeeds.push("有虫");
    }

    result.growing.push(id);
    if (debug) {
      const needStr =
        landNeeds.length > 0 ? ` 需要: ${landNeeds.join(",")}` : "";
      console.log(
        `    → 结果: 生长中(${PHASE_NAMES[phaseVal] || phaseVal})${needStr}`,
      );
    }
  }

  if (debug) {
    console.log("");
    console.log("========== 巡田分析汇总 ==========");
    console.log(
      `  可收获: ${result.harvestable.length} [${result.harvestable.join(",")}]`,
    );
    console.log(
      `  生长中: ${result.growing.length} [${result.growing.join(",")}]`,
    );
    console.log(
      `  缺水:   ${result.needWater.length} [${result.needWater.join(",")}]`,
    );
    console.log(
      `  有草:   ${result.needWeed.length} [${result.needWeed.join(",")}]`,
    );
    console.log(
      `  有虫:   ${result.needBug.length} [${result.needBug.join(",")}]`,
    );
    console.log(`  空地:   ${result.empty.length} [${result.empty.join(",")}]`);
    console.log(`  枯死:   ${result.dead.length} [${result.dead.join(",")}]`);
    console.log("====================================");
    console.log("");
  }

  return result;
}

// ============ 巡田主循环 ============

async function checkFarm() {
  const state = getUserState();
  if (isCheckingFarm || !state.gid) return;
  isCheckingFarm = true;

  try {
    const landsReply = await getAllLands();
    if (!landsReply.lands || landsReply.lands.length === 0) {
      log("农场", "没有土地数据");
      return;
    }

    const lands = landsReply.lands;
    const status = analyzeLands(lands);
    const unlockedLandIds = CONFIG.whiteRadishExpMode
      ? lands
          .filter((land) => land && land.unlocked)
          .map((land) => toNum(land.id))
          .filter((id) => id > 0)
      : [];
    const unlockedLandCount = lands.filter(
      (land) => land && land.unlocked,
    ).length;
    tuneExpModeInterval(unlockedLandCount);
    isFirstFarmCheck = false;

    // 构建状态摘要
    const statusParts = [];
    if (status.harvestable.length)
      statusParts.push(`收:${status.harvestable.length}`);
    if (status.needWeed.length)
      statusParts.push(`草:${status.needWeed.length}`);
    if (status.needBug.length) statusParts.push(`虫:${status.needBug.length}`);
    if (status.needWater.length)
      statusParts.push(`水:${status.needWater.length}`);
    if (status.dead.length) statusParts.push(`枯:${status.dead.length}`);
    if (status.empty.length) statusParts.push(`空:${status.empty.length}`);
    statusParts.push(`长:${status.growing.length}`);

    const hasWork = CONFIG.whiteRadishExpMode
      ? unlockedLandIds.length > 0
      : status.harvestable.length ||
          status.needWeed.length ||
          status.needBug.length ||
          status.needWater.length ||
          status.dead.length ||
          status.empty.length;

    // 执行操作并收集结果
    const actions = [];

    if (CONFIG.whiteRadishExpMode) {
      // 白萝卜刷经验模式：只执行“铲除 + 种植”，不做收获/浇水/除草/除虫。
      // 强制对所有已解锁地块调用 removePlant，以实现“种植→铲除→再种植”的高频经验循环。
      const landsToRemove = unlockedLandIds;
      if (landsToRemove.length > 0) {
        try {
          // 经验模式先统一铲除已解锁地块，因此这里不额外传入空地列表。
          await autoPlantEmptyLands(landsToRemove, [], unlockedLandCount);
          actions.push(`强制铲除${landsToRemove.length}/种植${landsToRemove.length}`);
        } catch (e) {
          logWarn("经验模式", e.message);
        }
      }
    } else {
      // 一键操作：除草、除虫、浇水可以并行执行（游戏中都是一键完成）
      const batchOps = [];
      if (status.needWeed.length > 0) {
        batchOps.push(
          weedOut(status.needWeed)
            .then(() => actions.push(`除草${status.needWeed.length}`))
            .catch((e) => logWarn("除草", e.message)),
        );
      }
      if (status.needBug.length > 0) {
        batchOps.push(
          insecticide(status.needBug)
            .then(() => actions.push(`除虫${status.needBug.length}`))
            .catch((e) => logWarn("除虫", e.message)),
        );
      }
      if (status.needWater.length > 0) {
        batchOps.push(
          waterLand(status.needWater)
            .then(() => actions.push(`浇水${status.needWater.length}`))
            .catch((e) => logWarn("浇水", e.message)),
        );
      }
      if (batchOps.length > 0) {
        await Promise.all(batchOps);
      }

      // 收获（一键操作）
      let harvestedLandIds = [];
      if (status.harvestable.length > 0) {
        try {
          await harvest(status.harvestable);
          actions.push(`收获${status.harvestable.length}`);
          harvestedLandIds = [...status.harvestable];
        } catch (e) {
          logWarn("收获", e.message);
        }
      }

      // 铲除 + 种植 + 施肥（需要顺序执行）
      const allDeadLands = [...status.dead, ...harvestedLandIds];
      const allEmptyLands = [...status.empty];
      if (allDeadLands.length > 0 || allEmptyLands.length > 0) {
        try {
          await autoPlantEmptyLands(
            allDeadLands,
            allEmptyLands,
            unlockedLandCount,
          );
          actions.push(`种植${allDeadLands.length + allEmptyLands.length}`);
        } catch (e) {
          logWarn("种植", e.message);
        }
      }
    }

    // 输出一行日志
    const actionStr = actions.length > 0 ? ` → ${actions.join("/")}` : "";
    if (hasWork) {
      log(
        "农场",
        `[${statusParts.join(" ")}]${actionStr}${!hasWork ? " 无需操作" : ""}`,
      );
    }
  } catch (err) {
    logWarn("巡田", `检查失败: ${err.message}`);
  } finally {
    isCheckingFarm = false;
  }
}

/**
 * 农场巡查循环 - 本次完成后等待指定秒数再开始下次
 */
async function farmCheckLoop() {
  while (farmLoopRunning) {
    await checkFarm();
    if (!farmLoopRunning) break;
    await sleep(CONFIG.farmCheckInterval);
  }
}

function startFarmCheckLoop() {
  if (farmLoopRunning) return;
  farmLoopRunning = true;

  // 监听服务器推送的土地变化事件
  networkEvents.on("landsChanged", onLandsChangedPush);

  // 延迟 2 秒后启动循环
  farmCheckTimer = setTimeout(() => farmCheckLoop(), 2000);
}

/**
 * 处理服务器推送的土地变化
 */
let lastPushTime = 0;
function onLandsChangedPush(lands) {
  if (isCheckingFarm) return;
  const now = Date.now();
  if (now - lastPushTime < 500) return; // 500ms 防抖

  lastPushTime = now;
  log("农场", `收到推送: ${lands.length}块土地变化，检查中...`);

  setTimeout(async () => {
    if (!isCheckingFarm) {
      await checkFarm();
    }
  }, 100);
}

function stopFarmCheckLoop() {
  farmLoopRunning = false;
  if (farmCheckTimer) {
    clearTimeout(farmCheckTimer);
    farmCheckTimer = null;
  }
  networkEvents.removeListener("landsChanged", onLandsChangedPush);
}

module.exports = {
  checkFarm,
  startFarmCheckLoop,
  stopFarmCheckLoop,
  getCurrentPhase,
  setOperationLimitsCallback,
};
