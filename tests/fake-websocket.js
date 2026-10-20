(function (global) {
  "use strict";

  class FakeWebSocket extends EventTarget {
    constructor(url) {
      super();
      this.url = url;
      this.readyState = 0;
      this.binaryType = "blob";
      this.sent = [];
      this.closeCalls = [];
    }

    open() {
      this.readyState = 1;
      this.dispatchEvent(new Event("open"));
    }

    send(data) {
      if (this.readyState !== 1) {
        throw new Error("FakeWebSocket is not open.");
      }
      this.sent.push(global.TNCWeb.copyBytes(data));
    }

    message(data) {
      this.dispatchEvent(new MessageEvent("message", { data }));
    }

    fail() {
      this.dispatchEvent(new Event("error"));
    }

    close(code, reason) {
      this.closeCalls.push({ code, reason });
      if (this.readyState === 3) {
        return;
      }
      this.readyState = 3;
      this.dispatchEvent(new CloseEvent("close", {
        code: code || 1000,
        reason: reason || "",
        wasClean: true
      }));
    }

    lose(code, reason) {
      this.readyState = 3;
      this.dispatchEvent(new CloseEvent("close", {
        code: code || 1006,
        reason: reason || "",
        wasClean: false
      }));
    }
  }

  global.TNCWebTest = global.TNCWebTest || {};
  global.TNCWebTest.FakeWebSocket = FakeWebSocket;
})(window);
