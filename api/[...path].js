import crypto from "node:crypto";

const mockOrders = new Map();

const config = {
  deviceToken: env("DEVICE_TOKEN", "change-this-device-token"),
  mock: boolEnv("KSHER_MOCK", true),
  ksherApiBase: env("KSHER_API_BASE", "https://api.mch.ksher.net/KsherPay"),
  ksherAppid: env("KSHER_APPID", "mch00000"),
  ksherChannel: env("KSHER_CHANNEL", "promptpay"),
  ksherFeeType: env("KSHER_FEE_TYPE", "THB"),
  ksherProduct: env("KSHER_PRODUCT", "ESP32 Kiosk"),
  ksherVersion: env("KSHER_VERSION", "3.0.0"),
  ksherNotifyUrl: env("KSHER_NOTIFY_URL", ""),
  privateKeyPem: env("KSHER_PRIVATE_KEY_PEM", "")
};

export default async function handler(req, res) {
  try {
    const path = normalizePath(req.query.path);

    if (req.method === "GET" && path === "/health") {
      return sendJson(res, 200, { ok: true, runtime: "vercel" });
    }

    if (req.method === "POST" && path === "/api/payments/ksher/notify") {
      return handleKsherNotify(req, res);
    }

    if (!isAuthorized(req)) {
      return sendJson(res, 401, { ok: false, error: "Unauthorized" });
    }

    if (req.method === "POST" && path === "/api/payments/create") {
      return handleCreatePayment(req, res);
    }

    if (req.method === "POST" && path === "/api/payments/cancel") {
      return handleCancelPayment(req, res);
    }

    if (req.method === "GET" && path === "/api/payments/status") {
      return handlePaymentStatus(req, res);
    }

    return sendJson(res, 404, { ok: false, error: "Not found" });
  } catch (error) {
    console.error(error);
    return sendJson(res, 500, { ok: false, error: "Internal server error" });
  }
}

async function handleCreatePayment(req, res) {
  const body = await readBody(req);
  const amount = Number(body.amount);
  const deviceId = sanitizeId(String(body.device_id || "esp32"));

  if (!Number.isInteger(amount) || amount <= 0 || amount > 100000) {
    return sendJson(res, 400, { ok: false, error: "Invalid amount" });
  }

  const orderNo = makeOrderNo(deviceId);
  const totalFee = amount * 100;
  const ksher = config.mock
    ? mockNativePay(orderNo, totalFee)
    : await createKsherNativePay({ orderNo, totalFee, deviceId });

  const qrText = ksher.code_url || ksher.PaymentCode || "";
  if (!qrText) {
    return sendJson(res, 502, { ok: false, error: "Ksher did not return QR text" });
  }

  mockOrders.set(orderNo, {
    orderNo,
    amount,
    totalFee,
    status: "PENDING",
    createdAt: Date.now(),
    updatedAt: Date.now()
  });

  return sendJson(res, 200, {
    ok: true,
    order_no: orderNo,
    ksher_order_no: ksher.ksher_order_no || ksher.PaymentID || "",
    qr_text: qrText,
    expires_in: 180
  });
}

async function handlePaymentStatus(req, res) {
  const orderNo = String(req.query.order_no || "");
  if (!orderNo) return sendJson(res, 400, { ok: false, error: "Missing order_no" });

  if (config.mock) {
    const order = mockOrders.get(orderNo);
    if (!order) return sendJson(res, 404, { ok: false, error: "Order not found" });
    if (order.status === "PENDING" && Date.now() - order.createdAt > 15000) {
      order.status = "PAID";
      order.updatedAt = Date.now();
    }
    return sendJson(res, 200, { ok: true, status: order.status, order_no: orderNo });
  }

  const ksher = await queryKsherOrder(orderNo);
  return sendJson(res, 200, {
    ok: true,
    status: mapKsherStatus(ksher.result),
    order_no: orderNo,
    ksher_result: ksher.result || ""
  });
}

async function handleCancelPayment(req, res) {
  const body = await readBody(req);
  const orderNo = String(body.order_no || "");
  if (!orderNo) return sendJson(res, 400, { ok: false, error: "Missing order_no" });

  if (config.mock) {
    const order = mockOrders.get(orderNo);
    if (!order) return sendJson(res, 404, { ok: false, error: "Order not found" });
    if (order.status === "PAID") return sendJson(res, 409, { ok: false, error: "Order already paid" });
    order.status = "CANCELLED";
    order.updatedAt = Date.now();
    return sendJson(res, 200, { ok: true, status: order.status, order_no: orderNo });
  }

  await closeKsherOrder(orderNo);
  return sendJson(res, 200, { ok: true, status: "CANCELLED", order_no: orderNo });
}

async function handleKsherNotify(req, res) {
  const body = await readBody(req);
  const data = body.data || body;
  const orderNo = data.mch_order_no || "";

  if (orderNo && mockOrders.has(orderNo)) {
    const order = mockOrders.get(orderNo);
    order.status = mapKsherStatus(data.result);
    order.updatedAt = Date.now();
  }

  return sendJson(res, 200, { result: "SUCCESS", msg: "OK" });
}

async function createKsherNativePay({ orderNo, totalFee, deviceId }) {
  const params = {
    appid: config.ksherAppid,
    channel: config.ksherChannel,
    fee_type: config.ksherFeeType,
    mch_order_no: orderNo,
    nonce_str: randomHex(16),
    time_stamp: timestamp(),
    total_fee: String(totalFee),
    version: config.ksherVersion,
    product: config.ksherProduct,
    device_id: deviceId
  };

  if (config.ksherNotifyUrl) params.notify_url = config.ksherNotifyUrl;
  params.sign = signKsher(params);

  const response = await postForm(`${config.ksherApiBase}/native_pay`, params);
  if (response.code !== 0 || !response.data || response.data.result !== "SUCCESS") {
    const message = response.data?.err_msg || response.status_msg || response.msg || "Ksher native_pay failed";
    throw new Error(message);
  }
  return response.data;
}

async function queryKsherOrder(orderNo) {
  const params = {
    appid: config.ksherAppid,
    mch_order_no: orderNo,
    nonce_str: randomHex(16),
    time_stamp: timestamp(),
    version: config.ksherVersion
  };
  params.sign = signKsher(params);

  const response = await postForm(`${config.ksherApiBase}/order_query`, params);
  if (response.code !== 0 || !response.data) {
    const message = response.data?.err_msg || response.status_msg || response.msg || "Ksher order_query failed";
    throw new Error(message);
  }
  return response.data;
}

async function closeKsherOrder(orderNo) {
  const params = {
    appid: config.ksherAppid,
    channel: config.ksherChannel,
    mch_order_no: orderNo,
    nonce_str: randomHex(16),
    time_stamp: timestamp(),
    version: config.ksherVersion
  };
  params.sign = signKsher(params);

  const response = await postForm(`${config.ksherApiBase}/order_close`, params);
  if (response.code !== 0 || !response.data || response.data.result !== "SUCCESS") {
    const message = response.data?.err_msg || response.status_msg || response.msg || "Ksher order_close failed";
    throw new Error(message);
  }
  return response.data;
}

async function postForm(url, params) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params)
  });
  const text = await response.text();

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Ksher returned non-JSON HTTP ${response.status}`);
  }

  if (!response.ok) throw new Error(`Ksher HTTP ${response.status}`);
  return json;
}

function signKsher(params) {
  if (!config.privateKeyPem) throw new Error("Missing KSHER_PRIVATE_KEY_PEM");
  const privateKey = config.privateKeyPem.replace(/\\n/g, "\n");
  const signer = crypto.createSign("RSA-MD5");
  signer.update(makeKsherSignText(params), "utf8");
  signer.end();
  return signer.sign(privateKey, "hex");
}

function makeKsherSignText(params) {
  return Object.keys(params)
    .filter((key) => key !== "sign")
    .sort()
    .map((key) => `${key}=${stringifyKsherValue(params[key])}`)
    .join("");
}

function stringifyKsherValue(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function mockNativePay(orderNo, totalFee) {
  return {
    result: "SUCCESS",
    ksher_order_no: `MOCK${Date.now()}`,
    mch_order_no: orderNo,
    total_fee: totalFee,
    code_url: `MOCK-KSHER-PROMPTPAY|ORDER=${orderNo}|AMOUNT=${(totalFee / 100).toFixed(2)}|TS=${Date.now()}`
  };
}

function mapKsherStatus(result) {
  switch (result) {
    case "SUCCESS":
      return "PAID";
    case "CLOSED":
      return "EXPIRED";
    case "FAIL":
    case "PAYERROR":
      return "FAILED";
    case "REFUND":
      return "REFUND";
    default:
      return "PENDING";
  }
}

function makeOrderNo(deviceId) {
  const compactDevice = sanitizeId(deviceId).slice(-8);
  return `K${compactDevice}${Date.now().toString(36).toUpperCase()}${randomHex(3).toUpperCase()}`.slice(0, 32);
}

function sanitizeId(value) {
  return value.replace(/[^A-Za-z0-9]/g, "");
}

function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString("hex");
}

function timestamp() {
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}${pad(d.getUTCMilliseconds(), 3)}S`;
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") return JSON.parse(req.body || "{}");
  return {};
}

function isAuthorized(req) {
  return req.headers.authorization === `Bearer ${config.deviceToken}`;
}

function sendJson(res, status, body) {
  res.status(status).json(body);
}

function normalizePath(pathQuery) {
  const parts = Array.isArray(pathQuery) ? pathQuery : [pathQuery].filter(Boolean);
  return `/${parts.join("/")}`;
}

function env(name, fallback) {
  return process.env[name] || fallback;
}

function boolEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}
