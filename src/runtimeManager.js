/**
 * 业务模块加载器：支持装载、卸载、全量重载。
 */

const path = require("path");
const EventEmitter = require("events");
const { RuntimeContext } = require("./runtimeContext");

class RuntimeManager extends EventEmitter {
  constructor(connectionRuntime, options = {}) {
    super();
    this.connectionRuntime = connectionRuntime;
    this.moduleRoot = options.moduleRoot || __dirname;
    this.moduleOrder = [];
    this.modules = new Map();
    this.reloading = false;
  }

  async loadModules(moduleNames) {
    this.moduleOrder = [...moduleNames];
    for (const moduleName of moduleNames) {
      await this.loadModule(moduleName);
    }
  }

  async loadModule(moduleName) {
    if (this.modules.has(moduleName)) return;

    const modulePath = path.join(this.moduleRoot, `${moduleName}.js`);
    delete require.cache[require.resolve(modulePath)];

    const mod = require(modulePath);
    const context = new RuntimeContext(this.connectionRuntime);

    if (typeof mod.init !== "function") {
      throw new Error(`module ${moduleName} is missing init(context)`);
    }

    await mod.init(context);

    await context.afterLoad();
    this.modules.set(moduleName, { mod, context, modulePath });
    this.emit("loaded", { moduleName });
  }

  async unloadModule(moduleName) {
    const record = this.modules.get(moduleName);
    if (!record) return;

    const { mod, context } = record;

    if (typeof mod.cleanup !== "function") {
      throw new Error(`module ${moduleName} is missing cleanup(context)`);
    }

    await mod.cleanup(context);

    await context.prepareUnload();
    this.modules.delete(moduleName);
    this.emit("unloaded", { moduleName });
  }

  async unloadAllModules() {
    for (const moduleName of [...this.modules.keys()].reverse()) {
      await this.unloadModule(moduleName);
    }
  }

  async reloadAll() {
    if (this.reloading) {
      throw new Error("reload already in progress");
    }

    this.reloading = true;
    try {
      const order =
        this.moduleOrder.length > 0
          ? [...this.moduleOrder]
          : [...this.modules.keys()];
      await this.unloadAllModules();
      for (const moduleName of order) {
        await this.loadModule(moduleName);
      }
      this.emit("reloaded", { moduleNames: order });
    } finally {
      this.reloading = false;
    }
  }

  getLoadedModules() {
    return [...this.modules.keys()];
  }
}

module.exports = {
  RuntimeManager,
};
