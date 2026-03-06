/**
 * 用于本地验证热重载链路的最小业务模块。
 */

const MODULE_VERSION = "v12";
const MODULE_EVALUATED_AT = new Date().toISOString();

async function init(context) {
  console.log(
    `[mock-module] init version=${MODULE_VERSION} evaluatedAt=${MODULE_EVALUATED_AT} pid=${process.pid}`,
  );

  context.setBeforeUnloadHandler(async () => {
    console.log(`[mock-module] cleanup version=${MODULE_VERSION}`);
  });
}

module.exports = {
  init,
};
