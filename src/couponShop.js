/**
 * 点券商店 - 自动用点券购买有机化肥容器
 */

const { types } = require("./proto");
const { CONFIG } = require("./config");
const network = require("./network");
const { toLong, toNum, log, logWarn } = require("./utils");
const { getItemName } = require("./gameConfig");
const { getBag, getBagItems } = require("./warehouse");

const COUPON_ITEM_ID = 1002; // 点券
const ORGANIC_FERTILIZER_ITEM_ID = 1012; // 有机化肥容器

let buyTimer = null;
let buyStartTimer = null;
let cachedPropShopId = null;
let activeContext = null;

function request(serviceName, methodName, bodyBytes, timeout) {
  if (activeContext) {
    return activeContext.request(serviceName, methodName, bodyBytes, timeout);
  }
  return network.sendMsgAsync(serviceName, methodName, bodyBytes, timeout);
}

async function getShopProfiles() {
  const body = types.ShopProfilesRequest.encode(
    types.ShopProfilesRequest.create({}),
  ).finish();
  const { body: replyBody } = await request(
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
      "点券",
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

  let hit = profiles.find((p) => toNum(p.shop_type) === 1);
  if (!hit) {
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

async function getShopInfo(shopId) {
  const body = types.ShopInfoRequest.encode(
    types.ShopInfoRequest.create({
      shop_id: toLong(shopId),
    }),
  ).finish();
  const { body: replyBody } = await request(
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
  const { body: replyBody } = await request(
    "gamepb.shoppb.ShopService",
    "BuyGoods",
    body,
  );
  return types.BuyGoodsReply.decode(replyBody);
}

function findCouponCount(items) {
  for (const item of items || []) {
    if (toNum(item.id) === COUPON_ITEM_ID) {
      return toNum(item.count);
    }
  }
  return 0;
}

function findOrganicFertilizerGoods(goodsList) {
  for (const goods of goodsList || []) {
    if (!goods.unlocked) continue;
    if (toNum(goods.item_id) !== ORGANIC_FERTILIZER_ITEM_ID) continue;
    const price = toNum(goods.price);
    if (price <= 0) continue;
    return {
      goodsId: toNum(goods.id),
      price,
      boughtNum: toNum(goods.bought_num),
      limitCount: toNum(goods.limit_count),
      itemCount: Math.max(1, toNum(goods.item_count) || 1),
    };
  }
  return null;
}

function getLimitRemaining(goods) {
  if (!goods || goods.limitCount <= 0) return Number.MAX_SAFE_INTEGER;
  return Math.max(0, goods.limitCount - goods.boughtNum);
}

async function buyOrganicFertilizerWithCouponOnce() {
  if (!CONFIG.autoBuyOrganicFertilizerWithCoupon) return;

  try {
    const bagReply = await getBag();
    const bagItems = getBagItems(bagReply);
    const couponCount = findCouponCount(bagItems);
    if (couponCount <= 0) return;

    const propShopId = await resolvePropShopId();
    const shopReply = await getShopInfo(propShopId);
    const goods = findOrganicFertilizerGoods(shopReply.goods_list);
    if (!goods) {
      logWarn("点券", "道具商店未找到可购买的有机化肥容器(1012)");
      return;
    }

    const byCoupon = Math.floor(couponCount / goods.price);
    const byLimit = getLimitRemaining(goods);
    const buyCount = Math.max(0, Math.min(byCoupon, byLimit));
    if (buyCount <= 0) return;

    const reply = await buyGoods(goods.goodsId, buyCount, goods.price);
    const getItems = reply.get_items || [];
    const costItems = reply.cost_items || [];

    let gotOrganic = 0;
    for (const item of getItems) {
      if (toNum(item.id) === ORGANIC_FERTILIZER_ITEM_ID) {
        gotOrganic += toNum(item.count);
      }
    }

    let couponCost = 0;
    for (const item of costItems) {
      if (toNum(item.id) === COUPON_ITEM_ID) {
        couponCost += toNum(item.count);
      }
    }

    const gotName = getItemName(ORGANIC_FERTILIZER_ITEM_ID);
    log(
      "点券",
      `已购买 ${gotName} x${gotOrganic || buyCount * goods.itemCount}，消耗点券 ${couponCost || buyCount * goods.price}`,
    );
  } catch (e) {
    logWarn("点券", `自动购买失败: ${e.message}`);
  }
}

function startCouponShopLoop(interval = 60000) {
  if (buyTimer || buyStartTimer) return;
  const safeInterval = Math.max(10000, toNum(interval, 60000));

  if (activeContext) {
    activeContext.scheduleInterval(
      "coupon-shop-loop",
      () => buyOrganicFertilizerWithCouponOnce(),
      safeInterval,
      8000,
    );
    return;
  }

  buyStartTimer = setTimeout(() => {
    buyStartTimer = null;
    buyOrganicFertilizerWithCouponOnce();
    buyTimer = setInterval(() => {
      buyOrganicFertilizerWithCouponOnce();
    }, safeInterval);
  }, 8000);
}

function stopCouponShopLoop() {
  if (buyStartTimer) {
    clearTimeout(buyStartTimer);
    buyStartTimer = null;
  }
  if (!buyTimer) return;
  clearInterval(buyTimer);
  buyTimer = null;
}

async function init(context) {
  activeContext = context;
  startCouponShopLoop(CONFIG.couponBuyInterval);
}

async function cleanup() {
  stopCouponShopLoop();
  activeContext = null;
}

module.exports = {
  buyOrganicFertilizerWithCouponOnce,
  init,
  cleanup,
};
