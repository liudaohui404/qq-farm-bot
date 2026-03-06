/**
 * WebSocket 网络层兼容适配。
 * 对外维持旧 API，不改变业务模块调用方式。
 */

const EventEmitter = require("events");
const { ConnectionRuntime } = require("./connectionRuntime");

const networkEvents = new EventEmitter();

let runtime = null;
let unsubscribeForwarders = [];

function ensureRuntime() {
  if (!runtime) {
    runtime = new ConnectionRuntime();
    wireRuntimeEvents(runtime);
  }
  return runtime;
}

function wireRuntimeEvents(rt) {
  const forward = (eventName) => {
    const handler = (...args) => {
      networkEvents.emit(eventName, ...args);
    };
    rt.networkEvents.on(eventName, handler);
    return () => rt.networkEvents.off(eventName, handler);
  };

  unsubscribeForwarders.forEach((fn) => fn());
  unsubscribeForwarders = [
    forward("landsChanged"),
    forward("friendApplicationReceived"),
    forward("taskInfoNotify"),
  ];
}

function connect(code, onLoginSuccess) {
  const rt = ensureRuntime();
  rt.connect(code, onLoginSuccess);
}

function cleanup() {
  if (runtime) {
    runtime.cleanup();
  }
}

function getWs() {
  return runtime ? runtime.getWs() : null;
}

function sendMsg(serviceName, methodName, bodyBytes, callback) {
  return ensureRuntime().sendMsg(serviceName, methodName, bodyBytes, callback);
}

function sendMsgAsync(serviceName, methodName, bodyBytes, timeout = 10000) {
  return ensureRuntime().sendMsgAsync(
    serviceName,
    methodName,
    bodyBytes,
    timeout,
  );
}

function getUserState() {
  return ensureRuntime().getUserState();
}

function getConnectionRuntime() {
  return runtime;
}

module.exports = {
  connect,
  cleanup,
  getWs,
  sendMsg,
  sendMsgAsync,
  getUserState,
  networkEvents,
  getConnectionRuntime,
};
