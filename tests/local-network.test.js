(function (global) {
  "use strict";

  const { test, equal, includes, rejects } = global.TNCWebTest;
  const {
    isPrivateHostname,
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

  test("Local Network Access requests permission with a local fetch probe", async () => {
    let permissionState = "prompt";
    let probeOptions;
    const result = await prepareLocalNetworkAccess({
      pageUrl: "https://staskaaa-netizen.github.io/FEather/",
      websocketUrl: "ws://192.168.8.187:8000/",
      permissions: {
        async query() {
          return { state: permissionState };
        }
      },
      fetchImpl: async (url, options) => {
        includes(url, "http://192.168.8.187/");
        probeOptions = options;
        permissionState = "granted";
        return { type: "opaque", status: 0 };
      }
    });
    equal(result.state, "granted");
    equal(probeOptions.targetAddressSpace, "local");
    equal(probeOptions.credentials, "omit");
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
    includes(error.message, "browser settings");
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

