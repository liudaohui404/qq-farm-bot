/**
 * 业务运行时上下文：为热重载业务模块提供统一能力。
 */

class RuntimeContext {
  constructor(connectionRuntime) {
    this.connectionRuntime = connectionRuntime;
    this.jobs = new Map();
    this.eventUnsubscribers = [];
    this.beforeUnloadHandler = null;
    this.afterLoadHandler = null;
  }

  get state() {
    return this.connectionRuntime.getUserState();
  }

  request(serviceName, methodName, bodyBytes, timeout) {
    return this.connectionRuntime.sendMsgAsync(
      serviceName,
      methodName,
      bodyBytes,
      timeout,
    );
  }

  on(eventName, handler) {
    this.connectionRuntime.networkEvents.on(eventName, handler);
    this.eventUnsubscribers.push(() => {
      this.connectionRuntime.networkEvents.off(eventName, handler);
    });
  }

  scheduleTimeout(name, fn, delayMs) {
    const id = setTimeout(async () => {
      try {
        await fn();
      } catch (err) {
        console.error(`[runtime:${name}] timeout job error: ${err.message}`);
      } finally {
        this.jobs.delete(id);
      }
    }, delayMs);

    this.jobs.set(id, { name, type: "timeout" });
    return id;
  }

  scheduleInterval(name, fn, intervalMs, initialDelayMs = 0) {
    let intervalId = null;
    const start = async () => {
      this.jobs.delete(starterId);

      try {
        await fn();
      } catch (err) {
        console.error(`[runtime:${name}] initial run error: ${err.message}`);
      }

      intervalId = setInterval(async () => {
        try {
          await fn();
        } catch (err) {
          console.error(`[runtime:${name}] interval job error: ${err.message}`);
        }
      }, intervalMs);

      this.jobs.set(intervalId, { name, type: "interval" });
    };

    const starterId = setTimeout(start, Math.max(0, initialDelayMs));
    this.jobs.set(starterId, { name, type: "starter" });
    return starterId;
  }

  cancelJob(jobId) {
    if (!this.jobs.has(jobId)) return;
    clearTimeout(jobId);
    clearInterval(jobId);
    this.jobs.delete(jobId);
  }

  cancelAllJobs() {
    for (const [jobId] of this.jobs) {
      clearTimeout(jobId);
      clearInterval(jobId);
    }
    this.jobs.clear();
  }

  setBeforeUnloadHandler(handler) {
    this.beforeUnloadHandler = handler;
  }

  setAfterLoadHandler(handler) {
    this.afterLoadHandler = handler;
  }

  async prepareUnload() {
    if (this.beforeUnloadHandler) {
      await this.beforeUnloadHandler();
    }

    this.cancelAllJobs();

    for (const unsubscribe of this.eventUnsubscribers) {
      unsubscribe();
    }
    this.eventUnsubscribers = [];
  }

  async afterLoad() {
    if (this.afterLoadHandler) {
      await this.afterLoadHandler();
    }
  }
}

module.exports = {
  RuntimeContext,
};
