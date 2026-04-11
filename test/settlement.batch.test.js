// tests/settlement.batch.test.js — Batch settlement: create, finalize, pay, detail

const { getApp } = require("./helpers/setup");
const { prisma, resetDb, createMerchant } = require("./helpers/seed");
const { uuid } = require("../src/events/event.outbox.service");
const { createAccrual } = require("../src/settlement/settlement.accrual.service");
const { createBatch, finalizeBatch, markBatchPaid, getBatchDetail, listBatches } = require("../src/settlement/settlement.batch.service");

let app;
let merchant;
let cpg;
let batchId;

beforeAll(async () => {
  app = getApp();
  await resetDb();

  merchant = await createMerchant({ name: "Batch Test Market" });

  cpg = await prisma.cpgEntity.create({
    data: {
      name: "Batch Test CPG",
      status: "active",
      platformFeeCents: 10,
    },
  });

  await prisma.cpgParticipation.create({
    data: { cpgId: cpg.id, merchantId: merchant.id, status: "active", agreedAt: new Date() },
  });

  // Seed some open accruals
  const now = new Date();
  for (let i = 0; i < 5; i++) {
    await createAccrual({
      sourceEventId: uuid(),
      cpgId: cpg.id,
      merchantId: merchant.id,
      grossAmountCents: 200 + i * 50,
      feeAmountCents: 10,
      upc: "batch-upc-" + i,
      transactionId: "batch-txn-" + i,
    });
  }
}, 15000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Settlement Batch", () => {
  describe("createBatch", () => {
    it("groups open accruals into a batch and emits hook", async () => {
      const hooks = [];
      const now = new Date();
      const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

      const { batch, itemCount } = await createBatch({
        cpgId: cpg.id,
        periodStart: weekAgo,
        periodEnd: now,
        cadence: "weekly",
        emitHook: (name, data) => hooks.push({ name, data }),
      });

      expect(batch).toBeTruthy();
      expect(itemCount).toBe(5);
      expect(batch.cpgId).toBe(cpg.id);
      expect(batch.status).toBe("open");
      expect(batch.itemCount).toBe(5);
      expect(batch.totalGrossCents).toBe(200 + 250 + 300 + 350 + 400); // 1500
      expect(batch.totalFeeCents).toBe(50); // 5 × 10
      expect(batch.totalNetCents).toBe(1450); // 1500 - 50

      batchId = batch.id;

      const hook = hooks.find(h => h.name === "settlement.batch.created");
      expect(hook).toBeTruthy();
      expect(hook.data.tc).toBe("TC-SET-02");
    });

    it("accruals are marked as batched", async () => {
      const accruals = await prisma.settlementAccrual.findMany({
        where: { cpgId: cpg.id, batchId },
      });
      expect(accruals.length).toBe(5);
      accruals.forEach(a => expect(a.status).toBe("batched"));
    });

    it("returns empty when no open accruals", async () => {
      const { batch, itemCount, reason } = await createBatch({
        cpgId: cpg.id,
        periodStart: new Date(),
        periodEnd: new Date(),
      });
      expect(batch).toBeNull();
      expect(itemCount).toBe(0);
      expect(reason).toContain("no open accruals");
    });
  });

  describe("finalizeBatch", () => {
    it("locks batch for payout and emits hook", async () => {
      const hooks = [];
      const batch = await finalizeBatch(batchId, (name, data) => hooks.push({ name, data }));

      expect(batch.status).toBe("finalized");
      expect(batch.finalizedAt).toBeTruthy();

      const hook = hooks.find(h => h.name === "settlement.batch.finalized");
      expect(hook).toBeTruthy();
      expect(hook.data.tc).toBe("TC-SET-03");
    });
  });

  describe("markBatchPaid", () => {
    it("marks batch and accruals as paid", async () => {
      const hooks = [];
      const batch = await markBatchPaid(batchId, "WIRE-REF-001", (name, data) => hooks.push({ name, data }));

      expect(batch.status).toBe("paid");
      expect(batch.paidAt).toBeTruthy();
      expect(batch.paymentReference).toBe("WIRE-REF-001");

      // Verify accruals updated
      const accruals = await prisma.settlementAccrual.findMany({ where: { batchId } });
      accruals.forEach(a => expect(a.status).toBe("paid"));

      const hook = hooks.find(h => h.name === "settlement.batch.paid");
      expect(hook).toBeTruthy();
      expect(hook.data.tc).toBe("TC-SET-04");
    });
  });

  describe("getBatchDetail", () => {
    it("returns batch with items and merchant breakdown", async () => {
      const detail = await getBatchDetail(batchId);

      expect(detail).toBeTruthy();
      expect(detail.items.length).toBe(5);
      expect(detail.cpg.name).toBe("Batch Test CPG");
      expect(detail.merchantBreakdown.length).toBe(1);
      expect(detail.merchantBreakdown[0].merchantId).toBe(merchant.id);
      expect(detail.merchantBreakdown[0].grossCents).toBe(1500);
    });

    it("returns null for non-existent batch", async () => {
      const detail = await getBatchDetail(99999);
      expect(detail).toBeNull();
    });
  });

  describe("listBatches", () => {
    it("lists batches for a CPG", async () => {
      const batches = await listBatches({ cpgId: cpg.id });
      expect(batches.length).toBeGreaterThanOrEqual(1);
      expect(batches[0]).toHaveProperty("cpg");
    });

    it("filters by status", async () => {
      const batches = await listBatches({ cpgId: cpg.id, status: "paid" });
      batches.forEach(b => expect(b.status).toBe("paid"));
    });
  });
});
