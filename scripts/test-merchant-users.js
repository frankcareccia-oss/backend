// scripts/test-merchant-users.js

const API_BASE = process.env.API_BASE || "http://localhost:3001";
const JWT = process.env.JWT;
const DEVICE_ID = process.env.PV_DEVICE_ID;

if (!JWT) {
  console.error("ERROR: JWT env variable missing");
  process.exit(1);
}

async function api(path, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${JWT}`,
  };

  if (DEVICE_ID) {
    headers["x-pv-device-id"] = DEVICE_ID;
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { ...headers, ...(options.headers || {}) },
  });

  const text = await res.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  return {
    status: res.status,
    ok: res.ok,
    data,
  };
}

(async () => {
  console.log("API_BASE:", API_BASE);

  // ---------------------------------------------------
  // 1. VERIFY AUTH
  // ---------------------------------------------------

  const me = await api("/me");

  if (!me.ok) {
    console.log("\nGET /me:", me.status, "FAIL");
    console.log(me.data);
    process.exit(1);
  }

  console.log("\nGET /me: OK");
  console.log(me.data);

  const merchantId = me.data?.merchantId || 1;

  console.log("\nUsing merchantId:", merchantId);

  // ---------------------------------------------------
  // 2. LIST USERS
  // ---------------------------------------------------

  const list = await api(`/merchant/users?merchantId=${merchantId}`);

  console.log("\nGET /merchant/users:", list.status);
  console.log(list.data);

  // ---------------------------------------------------
  // 3. CREATE USER
  // ---------------------------------------------------

  const email = `api-test-${Date.now()}@example.com`;

  const create = await api(`/merchant/users`, {
    method: "POST",
    body: JSON.stringify({
      merchantId,
      email,
      firstName: "API",
      lastName: "Test",
      role: "merchant_admin",
    }),
  });

  console.log("\nPOST /merchant/users:", create.status);
  console.log(create.data);

  if (!create.ok) {
    console.log("\nCreate failed. Stopping test.");
    process.exit(1);
  }

  const userId = create.data?.id || create.data?.user?.id;

  console.log("\nCreated userId:", userId);

  // ---------------------------------------------------
  // 4. UPDATE USER
  // ---------------------------------------------------

  const update = await api(`/merchant/users/${userId}`, {
    method: "PATCH",
    body: JSON.stringify({
      merchantId,
      firstName: "API",
      lastName: "Updated",
    }),
  });

  console.log("\nPATCH /merchant/users:", update.status);
  console.log(update.data);

  // ---------------------------------------------------
  // 5. VERIFY UPDATE
  // ---------------------------------------------------

  const verify = await api(`/merchant/users?merchantId=${merchantId}`);

  console.log("\nVerify list:", verify.status);
  console.log(verify.data);

  console.log("\nTEST COMPLETE");
})();