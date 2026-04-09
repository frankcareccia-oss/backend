"use strict";

const request = require("supertest");
const { prisma, resetDb } = require("./helpers/seed");
const { captureConsoleLogs } = require("./helpers/captureStdout");

describe("Public pay routes guardrails", () => {
  let app;

  beforeAll(() => {
    app = require("../index");
  });

  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  test("Rejects auth presence on GET /p/:code", async () => {
    const { output, restore } = captureConsoleLogs();
    try {
      const res = await request(app)
        .get("/p/does-not-matter")
        .set("Authorization", "Bearer x");

      expect(res.status).toBe(400);

      const code = res.body?.code ?? res.body?.errorCode ?? res.body?.error?.code ?? "";
      expect(code).toContain("PUBLIC_ROUTE_AUTH_PRESENT");

      const joined = output.join("\n");
      expect(joined).toContain("billing.public_route.auth_rejected");
      expect(joined).toContain("TC-BE-PUB-01");
    } finally {
      restore();
    }
  });

  test("Allows no-auth on GET /p/:code (200 or 404) without auth rejection", async () => {
    const { output, restore } = captureConsoleLogs();
    try {
      const res = await request(app).get("/p/does-not-matter");
      expect([200, 404]).toContain(res.status);

      // Verify the auth-rejection hook did NOT fire (no auth header sent)
      const joined = output.join("\n");
      expect(joined).not.toContain("billing.public_route.auth_rejected");
      expect(joined).not.toContain("PUBLIC_ROUTE_AUTH_PRESENT");

      // OK hook only fires on 200 (when token is found)
      if (res.status === 200) {
        expect(joined).toContain("billing.public_route.ok");
        expect(joined).toContain("TC-S-PUB-01");
      }
    } finally {
      restore();
    }
  });
});
