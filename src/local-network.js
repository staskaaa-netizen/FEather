(function (global) {
  "use strict";

  function localNetworkError(message) {
    const error = new Error(message);
    error.name = "LocalNetworkAccessError";
    error.code = "LOCAL_NETWORK_DENIED";
    return error;
  }

  function normalizedHostname(hostname) {
    return String(hostname || "").replace(/^\[|\]$/g, "").toLowerCase();
  }

  function isPrivateHostname(hostname) {
    const host = normalizedHostname(hostname);
    if (host === "localhost" || host === "::1" || host.endsWith(".local")) {
      return true;
    }
    if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) {
      return true;
    }
    const private172 = host.match(/^172\.(\d+)\./);
    return Boolean(private172 && Number(private172[1]) >= 16 && Number(private172[1]) <= 31);
  }

  async function queryLocalNetworkPermission(permissions) {
    if (!permissions || typeof permissions.query !== "function") {
      return { supported: false, state: "unknown", name: "" };
    }
    for (const name of ["local-network", "local-network-access"]) {
      try {
        const status = await permissions.query({ name });
        return { supported: true, state: status.state, name };
      } catch (error) {
        // Try the compatibility alias before treating the API as unsupported.
      }
    }
    return { supported: false, state: "unknown", name: "" };
  }

  async function prepareLocalNetworkAccess(options) {
    const settings = options || {};
    const pageUrl = new URL(settings.pageUrl || global.location.href);
    const websocketUrl = new URL(settings.websocketUrl);
    if (pageUrl.protocol !== "https:") {
      return { required: false, supported: false, state: "not-required" };
    }

    const permission = await queryLocalNetworkPermission(settings.permissions || global.navigator.permissions);
    if (permission.state === "denied") {
      throw localNetworkError(
        "Local-network permission is denied. Allow local-network access for this GitHub Pages site in the browser settings and retry."
      );
    }

    let probeError = null;
    if (permission.state === "prompt") {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), settings.probeTimeoutMs || 3000);
      try {
        const probeUrl = new URL("http://localhost/");
        probeUrl.hostname = websocketUrl.hostname;
        probeUrl.pathname = "/";
        // Private IP literals are mixed-content exempt after permission is granted.
        // WebSocket itself cannot carry the Fetch targetAddressSpace option.
        await (settings.fetchImpl || global.fetch)(probeUrl.toString(), {
          mode: "no-cors",
          cache: "no-store",
          credentials: "omit",
          targetAddressSpace: "local",
          signal: controller.signal
        });
      } catch (error) {
        probeError = error;
      } finally {
        clearTimeout(timer);
      }
    }

    const after = await queryLocalNetworkPermission(settings.permissions || global.navigator.permissions);
    if (after.state === "denied") {
      throw localNetworkError(
        "Local-network permission was denied. Allow FEather to access devices on the local network, then press Connect."
      );
    }
    return {
      required: true,
      supported: permission.supported,
      state: after.state,
      permissionName: permission.name,
      privateTarget: isPrivateHostname(websocketUrl.hostname),
      probeError: probeError ? probeError.message : ""
    };
  }

  global.TNCWeb = global.TNCWeb || {};
  Object.assign(global.TNCWeb, {
    isPrivateHostname,
    prepareLocalNetworkAccess,
    queryLocalNetworkPermission
  });
})(window);
