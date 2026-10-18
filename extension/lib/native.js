export class NativeBridge {
  constructor(runtime) {
    this.runtime = runtime;
    this.port = null;
    this.pending = new Map();
    this.connected = false;
  }

  connect() {
    if (this.port) return;
    const port = this.runtime.connectNative('com.tingjian.audio');
    this.port = port;
    port.onMessage.addListener(message => {
      if (message?.event) { this.onEvent?.(message); return; }
      const request = this.pending.get(message?.id);
      if (!request) return;
      this.pending.delete(message.id);
      message.ok ? request.resolve(message.data) : request.reject(new Error(message.error || '本地组件操作失败。'));
    });
    port.onDisconnect.addListener(() => {
      if (this.port !== port) return;
      const error = this.runtime.lastError?.message || '本地组件连接已断开。';
      this.port = null;
      this.connected = false;
      for (const request of this.pending.values()) request.reject(new Error(error));
      this.pending.clear();
      this.onDisconnect?.(error);
    });
  }

  request(command, body = {}) {
    return new Promise((resolve, reject) => {
      try {
        this.connect();
        const id = crypto.randomUUID();
        this.pending.set(id, {resolve, reject});
        this.port.postMessage({...body, id, command});
      } catch (error) { reject(error); }
    });
  }
}
