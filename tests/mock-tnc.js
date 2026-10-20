(function (global) {
  "use strict";

  const TNCWeb = global.TNCWeb;

  class ScriptedMockW610 {
    constructor(transport) {
      this.transport = transport;
      this.scripts = [];
      this.unmatched = [];
      transport.addEventListener("transmit", (event) => {
        this._handleRequest(event.detail.bytes);
      });
    }

    expect(request, responseFragments) {
      this.scripts.push({
        request: TNCWeb.copyBytes(request),
        responseFragments: responseFragments.map((fragment) => TNCWeb.copyBytes(fragment))
      });
    }

    _handleRequest(request) {
      const scriptIndex = this.scripts.findIndex((script) => (
        script.request.byteLength === request.byteLength &&
        script.request.every((byte, index) => byte === request[index])
      ));
      if (scriptIndex === -1) {
        this.unmatched.push(request.slice());
        return;
      }
      const script = this.scripts.splice(scriptIndex, 1)[0];
      setTimeout(() => {
        for (const fragment of script.responseFragments) {
          this.transport.inject(fragment);
        }
      }, 0);
    }
  }

  global.TNCWebTest = global.TNCWebTest || {};
  global.TNCWebTest.ScriptedMockW610 = ScriptedMockW610;
})(window);
