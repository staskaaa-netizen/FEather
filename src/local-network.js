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

  function isLoopbackHostname(hostname) {
    const host = normalizedHostname(hostname);
    return host === "localhost" || host === "::1" || /^127\./.test(host);
  }

  function permissionNamesForHostname(hostname) {
    if (isLoopbackHostname(hostname)) {
      return ["loopback-network", "local-network", "local-network-access"];
    }
    return ["local-network", "local-network-access"];
  }

  async function queryLocalNetworkPermission(permissions, hostname) {
    if (!permissions || typeof permissions.query !== "function") {
      return { supported: false, state: "unknown", name: "" };
    }
    for (const name of permissionNamesForHostname(hostname)) {
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
    const privateTarget = isPrivateHostname(websocketUrl.hostname);
    if (pageUrl.protocol !== "https:" || !privateTarget) {
      return { required: false, supported: false, state: "not-required" };
    }

    const permission = await queryLocalNetworkPermission(
      settings.permissions || global.navigator.permissions,
      websocketUrl.hostname
    );
    if (permission.supported && permission.state === "denied") {
      throw localNetworkError(
        "Local-network permission is blocked for this site. Open the browser's site settings, allow local-network access for FEather, reload the page, and press Connect."
      );
    }

    return {
      required: true,
      supported: permission.supported,
      state: permission.state,
      permissionName: permission.name,
      privateTarget
    };
  }

  global.TNCWeb = global.TNCWeb || {};
  Object.assign(global.TNCWeb, {
    isPrivateHostname,
    isLoopbackHostname,
    permissionNamesForHostname,
    prepareLocalNetworkAccess,
    queryLocalNetworkPermission
  });
})(window);
