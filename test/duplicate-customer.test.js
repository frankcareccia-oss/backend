// test/duplicate-customer.test.js — Duplicate Square customer detection tests

"use strict";

const { prisma, resetDb, createMerchant } = require("./helpers/seed");
const { encrypt } = require("../src/utils/encrypt");

// We test the dispatchSquareEvent function directly to verify customer.created handling
// and the duplicate detection logic on the payment path.

// Mock fetch for Square API calls
const fetchCalls = [];
const fetchMocks = [];

function mockFetch(urlPattern, response) {
  fetchMocks.push({ pattern: urlPattern, response });
}

function resetFetchMocks() {
  fetchCalls.length = 0;
  fetchMocks.length = 0;
}

let merchant, consumer, posConn, store;

beforeAll(async () => {
  global._origFetch = global.fetch;
  global.fetch = jest.fn(async (url, opts) => {
    fetchCalls.push({ url, method: opts?.method, body: opts?.body ? JSON.parse(opts.body) : null });
    for (const mock of fetchMocks) {
      if (url.includes(mock.pattern)) {
        const resp = mock.response;
        return {
          ok: resp.ok !== false,
          status: resp.status || 200,
          json: async () => resp.body,
          text: async () => JSON.stringify(resp.body),
        };
      }
    }
    return {
      ok: false,
      status: 404,
      json: async () => ({ errors: [{ detail: `No mock for ${url}` }] }),
      text: async () => JSON.stringify({ errors: [{ detail: `No mock for ${url}` }] }),
    };
  });
});

afterAll(async () => {
  global.fetch = global._origFetch;
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDb();
  resetFetchMocks();

  merchant = await createMerchant({ name: "Dup Test Shop" });

  consumer = await prisma.consumer.create({
    data: { phoneE164: "+17735550001", firstName: "Liam", lastName: "Wilson" },
  });

  store = await prisma.store.create({
    data: { merchantId: merchant.id, name: "Main Store", phoneRaw: "773-555-0001" },
  });

  posConn = await prisma.posConnection.create({
    data: {
      merchantId: merchant.id,
      posType: "square",
      status: "active",
      accessTokenEnc: encrypt("sq-test-token"),
      externalMerchantId: "SQ_MERCH_DUP",
    },
  });

  await prisma.posLocationMap.create({
    data: {
      posConnectionId: posConn.id,
      externalLocationId: "SQ_LOC_1",
      pvStoreId: store.id,
      active: true,
    },
  });
});

describe("Duplicate Customer Detection", () => {
  // Import the dispatchSquareEvent from the webhook module
  // We need to access internal functions — require the module and test via webhook route
  // Instead, let's test via the supertest approach like existing webhook tests

  describe("customer.created webhook", () => {
    it("creates a DuplicateCustomerAlert when duplicate phone found", async () => {
      // Mock: customer search returns 2 customers with same phone
      mockFetch("/customers/search", {
        body: {
          customers: [
            { id: "SQ_CUST_ORIG", given_name: "Liam", family_name: "Wilson", phone_number: "+17735550001" },
            { id: "SQ_CUST_DUP", given_name: "Liam-xxxx", family_name: "Doe", phone_number: "+17735550001" },
          ],
        },
      });

      // Use supertest to send customer.created webhook
      const request = require("supertest");
      const { getApp } = require("./helpers/setup");
      const app = getApp();

      const res = await request(app)
        .post("/webhooks/square")
        .set("Content-Type", "application/json")
        .send({
          merchant_id: "SQ_MERCH_DUP",
          type: "customer.created",
          event_id: `evt-cust-dup-${Date.now()}`,
          data: {
            object: {
              customer: {
                id: "SQ_CUST_DUP",
                given_name: "Liam-xxxx",
                family_name: "Doe",
                phone_number: "+17735550001",
              },
            },
          },
        });

      expect(res.status).toBe(200);

      // Wait for async dispatch to complete
      await new Promise(r => setTimeout(r, 500));

      const alerts = await prisma.duplicateCustomerAlert.findMany({
        where: { merchantId: merchant.id, status: "pending" },
      });

      expect(alerts).toHaveLength(1);
      expect(alerts[0].phoneE164).toBe("+17735550001");
      expect(alerts[0].posConnectionId).toBe(posConn.id);

      const customerIds = alerts[0].squareCustomerIds;
      expect(customerIds).toHaveLength(2);
      expect(customerIds.map(c => c.id)).toContain("SQ_CUST_ORIG");
      expect(customerIds.map(c => c.id)).toContain("SQ_CUST_DUP");
    });

    it("does NOT create alert when no duplicates exist", async () => {
      // Mock: customer search returns only 1 customer
      mockFetch("/customers/search", {
        body: {
          customers: [
            { id: "SQ_CUST_ONLY", given_name: "Liam", family_name: "Wilson", phone_number: "+17735550001" },
          ],
        },
      });

      const request = require("supertest");
      const { getApp } = require("./helpers/setup");
      const app = getApp();

      await request(app)
        .post("/webhooks/square")
        .set("Content-Type", "application/json")
        .send({
          merchant_id: "SQ_MERCH_DUP",
          type: "customer.created",
          event_id: `evt-cust-nodup-${Date.now()}`,
          data: {
            object: {
              customer: {
                id: "SQ_CUST_ONLY",
                given_name: "Liam",
                family_name: "Wilson",
                phone_number: "+17735550001",
              },
            },
          },
        });

      await new Promise(r => setTimeout(r, 500));

      const alerts = await prisma.duplicateCustomerAlert.findMany({
        where: { merchantId: merchant.id },
      });
      expect(alerts).toHaveLength(0);
    });

    it("skips when customer has no phone number", async () => {
      const request = require("supertest");
      const { getApp } = require("./helpers/setup");
      const app = getApp();

      const res = await request(app)
        .post("/webhooks/square")
        .set("Content-Type", "application/json")
        .send({
          merchant_id: "SQ_MERCH_DUP",
          type: "customer.created",
          event_id: `evt-cust-nophone-${Date.now()}`,
          data: {
            object: {
              customer: {
                id: "SQ_CUST_NOPHONE",
                given_name: "Liam",
              },
            },
          },
        });

      expect(res.status).toBe(200);

      await new Promise(r => setTimeout(r, 300));

      const alerts = await prisma.duplicateCustomerAlert.findMany({ where: { merchantId: merchant.id } });
      expect(alerts).toHaveLength(0);
      // Should not have called customer search
      const searchCalls = fetchCalls.filter(c => c.url.includes("/customers/search"));
      expect(searchCalls).toHaveLength(0);
    });

    it("updates existing pending alert when new duplicate appears", async () => {
      // Pre-create a pending alert
      await prisma.duplicateCustomerAlert.create({
        data: {
          merchantId: merchant.id,
          posConnectionId: posConn.id,
          phoneE164: "+17735550001",
          squareCustomerIds: [
            { id: "SQ_CUST_ORIG", name: "Liam Wilson", phone: "+17735550001" },
            { id: "SQ_CUST_DUP1", name: "Liam Copy", phone: "+17735550001" },
          ],
          status: "pending",
        },
      });

      // Mock: now 3 customers with same phone
      mockFetch("/customers/search", {
        body: {
          customers: [
            { id: "SQ_CUST_ORIG", given_name: "Liam", family_name: "Wilson", phone_number: "+17735550001" },
            { id: "SQ_CUST_DUP1", given_name: "Liam", family_name: "Copy", phone_number: "+17735550001" },
            { id: "SQ_CUST_DUP2", given_name: "Liam", family_name: "Third", phone_number: "+17735550001" },
          ],
        },
      });

      const request = require("supertest");
      const { getApp } = require("./helpers/setup");
      const app = getApp();

      await request(app)
        .post("/webhooks/square")
        .set("Content-Type", "application/json")
        .send({
          merchant_id: "SQ_MERCH_DUP",
          type: "customer.created",
          event_id: `evt-cust-dup3-${Date.now()}`,
          data: {
            object: {
              customer: {
                id: "SQ_CUST_DUP2",
                given_name: "Liam",
                family_name: "Third",
                phone_number: "+17735550001",
              },
            },
          },
        });

      await new Promise(r => setTimeout(r, 500));

      // Should still be 1 alert, but updated with 3 customers
      const alerts = await prisma.duplicateCustomerAlert.findMany({
        where: { merchantId: merchant.id, status: "pending" },
      });
      expect(alerts).toHaveLength(1);
      expect(alerts[0].squareCustomerIds).toHaveLength(3);
    });
  });
});
