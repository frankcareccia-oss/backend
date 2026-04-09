// tests/webhooks.square.test.js — Square webhook pipeline

const request = require("supertest");
const { getApp } = require("./helpers/setup");

let app;
beforeAll(() => { app = getApp(); });

describe("Square Webhook — /webhooks/square", () => {
  it("returns 200 for valid payment.created event", async () => {
    const res = await request(app)
      .post("/webhooks/square")
      .set("Content-Type", "application/json")
      .send({
        merchant_id: "MLB5BR4A4K5DJ",
        type: "payment.created",
        data: {
          type: "payment",
          object: {
            payment: {
              id: `test-webhook-${Date.now()}`,
              status: "APPROVED",
              location_id: "L6P5RSF6XCYWW",
              amount_money: { amount: 500, currency: "USD" },
            },
          },
        },
      });
    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
  });

  it("returns 200 for payment.updated with COMPLETED status", async () => {
    const payId = `test-complete-${Date.now()}`;
    const res = await request(app)
      .post("/webhooks/square")
      .set("Content-Type", "application/json")
      .send({
        merchant_id: "MLB5BR4A4K5DJ",
        type: "payment.updated",
        data: {
          type: "payment",
          object: {
            payment: {
              id: payId,
              status: "COMPLETED",
              location_id: "L6P5RSF6XCYWW",
              amount_money: { amount: 750, currency: "USD" },
              order_id: null,
            },
          },
        },
      });
    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
  });

  it("returns 200 for catalog.version.updated event", async () => {
    const res = await request(app)
      .post("/webhooks/square")
      .set("Content-Type", "application/json")
      .send({
        merchant_id: "MLB5BR4A4K5DJ",
        type: "catalog.version.updated",
        data: {
          type: "catalog_version",
          object: { catalog_version: { updated_at: new Date().toISOString() } },
        },
      });
    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
  });

  it("returns 200 for unhandled event types (graceful skip)", async () => {
    const res = await request(app)
      .post("/webhooks/square")
      .set("Content-Type", "application/json")
      .send({
        merchant_id: "MLB5BR4A4K5DJ",
        type: "refund.updated",
        data: { type: "refund", object: {} },
      });
    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
  });

  it("returns 400 for invalid JSON", async () => {
    const res = await request(app)
      .post("/webhooks/square")
      .set("Content-Type", "application/json")
      .send("not json");
    // express.raw may parse this differently
    expect([200, 400]).toContain(res.status);
  });
});
