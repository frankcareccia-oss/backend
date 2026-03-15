// src/auth/device.routes.js

function registerDeviceRoutes(app, { requireJwt }) {
  if (!app) throw new Error("registerDeviceRoutes requires an Express app instance");

  app.get("/auth/device/status", requireJwt, async (req, res) => {
    try {
      const deviceId = String(req.get("x-pv-device-id") || "").trim();
      const deviceIdShort = deviceId ? `${deviceId.slice(0, 8)}…` : null;

      return res.json({
        ok: true,
        trusted: true,
        requiresDeviceVerification: false,
        deviceIdShort
      });
    } catch (e) {
      return res.status(500).json({
        error: {
          code: "SERVER_ERROR",
          message: "Device status check failed"
        }
      });
    }
  });
}

module.exports = { registerDeviceRoutes };
