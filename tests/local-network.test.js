(function (global) {
  "use strict";

  const { test, equal, includes, rejects } = global.TNCWebTest;
  const {
    isPrivateHostname,
    permissionNamesForHostname,
    prepareLocalNetworkAccess
  } = global.TNCWeb;

  test("Local Network Access recognizes private targets", () => {
    equal(isPrivateHostname("192.168.8.187"), true);
    equal(isPrivateHostname("10.10.100.254"), true);
    equal(isPrivateHostname("172.16.1.4"), true);
    equal(isPrivateHostname("172.32.1.4"), false);
    equal(isPrivateHostname("tnc415.local"), true);
    equal(isPrivateHostname("example.com"), false);
  });

  test("Local Network Access leaves the prompt to the WebSocket request", async () => {
    let fetched = false;
    const result = await prepareLocalNetworkAccess({
      pageUrl: "https://staskaaa-netizen.github.io/FEather/",
      websocketUrl: "ws://192.168.8.187:8000/",
      permissions: {
        async query() {
          return { state: "prompt" };
        }
      },
      fetchImpl: async () => {
        fetched = true;
        return { type: "opaque", status: 0 };
      }
    });
    equal(result.state, "prompt");
    equal(result.privateTarget, true);
    equal(fetched, false);
  });

  test("Loopback targets use the loopback-network permission", () => {
    equal(permissionNamesForHostname("localhost")[0], "loopback-network");
    equal(permissionNamesForHostname("127.0.0.1")[0], "loopback-network");
    equal(permissionNamesForHostname("192.168.8.187")[0], "local-network");
  });

  test("Denied Local Network Access produces a useful error", async () => {
    const error = await rejects(
      prepareLocalNetworkAccess({
        pageUrl: "https://staskaaa-netizen.github.io/FEather/",
        websocketUrl: "ws://192.168.8.187:8000/",
        permissions: {
          async query() {
            return { state: "denied" };
          }
        },
        fetchImpl: async () => {
          throw new Error("Probe must not run when denied.");
        }
      }),
      "LOCAL_NETWORK_DENIED"
    );
    includes(error.message, "site settings");
  });

  test("Local file usage does not request network permission", async () => {
    let queried = false;
    const result = await prepareLocalNetworkAccess({
      pageUrl: "file:///C:/acc/FEather/index.html",
      websocketUrl: "ws://192.168.8.187:8000/",
      permissions: {
        async query() {
          queried = true;
          return { state: "prompt" };
        }
      }
    });
    equal(result.state, "not-required");
    equal(queried, false);
  });
})(window);

