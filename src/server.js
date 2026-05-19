import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

loadEnv(path.join(rootDir, ".env"));

const config = {
  port: intEnv("PORT", 8787),
  deviceToken: requiredEnv("DEVICE_TOKEN", "change-this-device-token"),
  mock: boolEnv("KSHER_MOCK", true),
  ksherApiBase: env("KSHER_API_BASE", "https://api.mch.ksher.net/KsherPay"),
  ksherAppid: requiredEnv("KSHER_APPID", "mch00000"),
  ksherChannel: env("KSHER_CHANNEL", "promptpay"),
  ksherFeeType: env("KSHER_FEE_TYPE", "THB"),
  ksherProduct: env("KSHER_PRODUCT", "ESP32 Kiosk"),
  ksherVersion: env("KSHER_VERSION", "3.0.0"),
  ksherNotifyUrl: env("KSHER_NOTIFY_URL", ""),
  privateKeyPem: env("KSHER_PRIVATE_KEY_PEM", ""),
  privateKeyPath: env("KSHER_PRIVATE_KEY_PATH", "./privatekey.pem"),
  verifyResponse: boolEnv("KSHER_VERIFY_RESPONSE", false),
  supabaseUrl: env("SUPABASE_URL", ""),
  supabaseServiceRoleKey: env("SUPABASE_SERVICE_ROLE_KEY", "")
};

const supabase = config.supabaseUrl && config.supabaseServiceRoleKey
  ? createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
      auth: { persistSession: false }
    })
  : null;

const orders = new Map();

const server = http.createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { ok: false, error: "Internal server error" });
  }
});

server.listen(config.port, () => {
  console.log(`ESP32 Ksher backend listening on http://0.0.0.0:${config.port}`);
  console.log(`Ksher mode: ${config.mock ? "mock" : "live"}`);
  console.log(`Supabase storage: ${supabase ? "enabled" : "disabled"}`);
});

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/payments/ksher/notify") {
    await handleKsherNotify(req, res);
    return;
  }

  if (!isAuthorized(req)) {
    sendJson(res, 401, { ok: false, error: "Unauthorized" });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/payments/create") {
    await handleCreatePayment(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/payments/cancel") {
    await handleCancelPayment(req, res);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/payments/status") {
    await handlePaymentStatus(url, res);
    return;
  }

  sendJson(res, 404, { ok: false, error: "Not found" });
}

async function handleCreatePayment(req, res) {
  const body = await readJson(req);
  const amount = Number(body.amount);
  const deviceId = sanitizeId(String(body.device_id || "esp32"));

  if (!Number.isInteger(amount) || amount <= 0 || amount > 100000) {
    sendJson(res, 400, { ok: false, error: "Invalid amount" });
    return;
  }

  const orderNo = makeOrderNo(deviceId);
  const totalFee = amount * 100;

  await saveTransaction({
    orderNo,
    deviceId,
    amount,
    totalFee,
    currency: "THB",
    status: "PENDING"
  });
  await logPaymentEvent(orderNo, "create_requested", "PENDING", "Payment creation requested", {
    device_id: deviceId,
    amount,
    total_fee: totalFee
  });

  let ksher;
  try {
    if (config.mock) {
      ksher = mockNativePay(orderNo, totalFee);
    } else {
      ksher = await createKsherNativePay({ orderNo, totalFee, deviceId });
    }
  } catch (error) {
    await updateTransaction(orderNo, {
      status: "CREATE_FAILED",
      raw_status: { error: error.message }
    });
    await logPaymentEvent(orderNo, "create_failed", "CREATE_FAILED", error.message, { error: error.message });
    throw error;
  }

  const qrText = ksher.code_url || ksher.PaymentCode || "";
  if (!qrText) {
    await updateTransaction(orderNo, {
      status: "CREATE_FAILED",
      raw_status: { error: "Ksher did not return QR text", raw_create: ksher }
    });
    await logPaymentEvent(orderNo, "create_failed", "CREATE_FAILED", "Ksher did not return QR text", ksher);
    sendJson(res, 502, { ok: false, error: "Ksher did not return QR text" });
    return;
  }

  const order = {
    orderNo,
    ksherOrderNo: ksher.ksher_order_no || ksher.PaymentID || "",
    amount,
    totalFee,
    deviceId,
    qrText,
    status: "PENDING",
    rawCreate: ksher,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  orders.set(orderNo, order);

  await updateTransaction(orderNo, {
    ksher_order_no: order.ksherOrderNo,
    qr_text: qrText,
    raw_create: ksher,
    status: "PENDING"
  });
  await logPaymentEvent(orderNo, "create_succeeded", "PENDING", "Payment QR created", ksher);

  sendJson(res, 200, {
    ok: true,
    order_no: orderNo,
    ksher_order_no: order.ksherOrderNo,
    qr_text: qrText,
    expires_in: 180
  });
}

async function handleCancelPayment(req, res) {
  const body = await readJson(req);
  const orderNo = String(body.order_no || "");
  const order = await findOrder(orderNo);

  if (!order) {
    sendJson(res, 404, { ok: false, error: "Order not found" });
    return;
  }

  if (order.status === "PAID") {
    sendJson(res, 409, { ok: false, error: "Order already paid" });
    return;
  }

  if (!config.mock) {
    await closeKsherOrder(order);
  }

  order.status = "CANCELLED";
  order.updatedAt = Date.now();
  orders.set(orderNo, order);
  await updateTransaction(orderNo, {
    status: "CANCELLED",
    cancelled_at: new Date().toISOString()
  });
  await logPaymentEvent(orderNo, "cancelled", "CANCELLED", "Payment cancelled by device", {
    order_no: orderNo
  });

  sendJson(res, 200, { ok: true, status: order.status, order_no: orderNo });
}

async function handlePaymentStatus(url, res) {
  const orderNo = String(url.searchParams.get("order_no") || "");
  const order = await findOrder(orderNo);

  if (!order) {
    sendJson(res, 404, { ok: false, error: "Order not found" });
    return;
  }

  if (config.mock) {
    if (order.status === "PENDING" && Date.now() - order.createdAt > 15000) order.status = "PAID";
    order.updatedAt = Date.now();
    orders.set(orderNo, order);
    await updateTransactionForStatus(orderNo, order.status, { mock: true });
    sendJson(res, 200, { ok: true, status: order.status, order_no: orderNo });
    return;
  }

  if (order.status === "CANCELLED") {
    sendJson(res, 200, { ok: true, status: order.status, order_no: orderNo });
    return;
  }

  const ksher = await queryKsherOrder(order);
  const status = mapKsherStatus(ksher.result);
  order.status = status;
  order.rawStatus = ksher;
  order.updatedAt = Date.now();
  orders.set(orderNo, order);
  await updateTransactionForStatus(orderNo, status, ksher);
  await logPaymentEvent(orderNo, "status_polled", status, "Payment status polled from Ksher", ksher);

  sendJson(res, 200, {
    ok: true,
    status,
    order_no: orderNo,
    ksher_result: ksher.result || ""
  });
}

async function handleKsherNotify(req, res) {
  const text = await readText(req);
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    sendJson(res, 400, { result: "FAIL", msg: "Invalid JSON" });
    return;
  }

  const data = payload.data || payload;
  const orderNo = data.mch_order_no;
  const status = mapKsherStatus(data.result);

  await logPaymentEvent(orderNo || null, "webhook_received", status, "Ksher webhook received", payload);

  if (orderNo && orders.has(orderNo)) {
    const order = orders.get(orderNo);
    order.status = status;
    order.rawNotify = payload;
    order.updatedAt = Date.now();
    orders.set(orderNo, order);
  }

  if (orderNo) {
    await updateTransactionForStatus(orderNo, status, payload, "raw_notify");
  }

  sendJson(res, 200, { result: "SUCCESS", msg: "OK" });
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

async function queryKsherOrder(order) {
  const params = {
    appid: config.ksherAppid,
    mch_order_no: order.orderNo,
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

async function closeKsherOrder(order) {
  const params = {
    appid: config.ksherAppid,
    channel: config.ksherChannel,
    mch_order_no: order.orderNo,
    nonce_str: randomHex(16),
    time_stamp: timestamp(),
    version: config.ksherVersion
  };

  if (order.ksherOrderNo) params.ksher_order_no = order.ksherOrderNo;
  params.sign = signKsher(params);

  const response = await postForm(`${config.ksherApiBase}/order_close`, params);
  if (response.code !== 0 || !response.data || response.data.result !== "SUCCESS") {
    const message = response.data?.err_msg || response.status_msg || response.msg || "Ksher order_close failed";
    throw new Error(message);
  }

  return response.data;
}

async function postForm(url, params) {
  const body = new URLSearchParams(params);
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  const text = await response.text();

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Ksher returned non-JSON HTTP ${response.status}`);
  }

  if (!response.ok) {
    throw new Error(`Ksher HTTP ${response.status}: ${json.msg || json.message || "error"}`);
  }

  return json;
}

function signKsher(params) {
  const privateKey = readPrivateKey();
  const signText = makeKsherSignText(params);
  const signer = crypto.createSign("RSA-MD5");
  signer.update(signText, "utf8");
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
  return stableJson(value);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function readPrivateKey() {
  if (config.privateKeyPem) return config.privateKeyPem.replace(/\\n/g, "\n");

  const keyPath = path.resolve(rootDir, config.privateKeyPath);
  return fs.readFileSync(keyPath, "utf8");
}

async function saveTransaction(order) {
  if (!supabase) return;

  const row = {
    order_no: order.orderNo,
    device_id: order.deviceId,
    amount: order.amount,
    total_fee: order.totalFee,
    currency: order.currency || "THB",
    status: order.status || "PENDING",
    updated_at: new Date().toISOString()
  };

  const { error } = await supabase
    .from("payment_transactions")
    .upsert(row, { onConflict: "order_no" });

  if (error) console.error("Supabase saveTransaction failed", error);
}

async function updateTransaction(orderNo, changes) {
  if (!supabase || !orderNo) return;

  const row = {
    ...changes,
    updated_at: new Date().toISOString()
  };

  const { error } = await supabase
    .from("payment_transactions")
    .update(row)
    .eq("order_no", orderNo);

  if (error) console.error("Supabase updateTransaction failed", error);
}

async function updateTransactionForStatus(orderNo, status, payload, rawColumn = "raw_status") {
  const now = new Date().toISOString();
  const changes = {
    status,
    ksher_result: payload?.data?.result || payload?.result || status,
    [rawColumn]: payload
  };

  if (status === "PAID") changes.paid_at = now;
  if (status === "CANCELLED" || status === "EXPIRED") changes.cancelled_at = now;

  await updateTransaction(orderNo, changes);
}

async function getTransaction(orderNo) {
  if (!supabase || !orderNo) return null;

  const { data, error } = await supabase
    .from("payment_transactions")
    .select("*")
    .eq("order_no", orderNo)
    .maybeSingle();

  if (error) {
    console.error("Supabase getTransaction failed", error);
    return null;
  }

  return data;
}

async function findOrder(orderNo) {
  if (!orderNo) return null;

  const memoryOrder = orders.get(orderNo);
  if (memoryOrder) return memoryOrder;

  const transaction = await getTransaction(orderNo);
  if (!transaction) return null;

  const order = {
    orderNo: transaction.order_no,
    ksherOrderNo: transaction.ksher_order_no || "",
    amount: transaction.amount,
    totalFee: transaction.total_fee,
    deviceId: transaction.device_id || "",
    qrText: transaction.qr_text || "",
    status: transaction.status,
    rawCreate: transaction.raw_create,
    rawStatus: transaction.raw_status,
    rawNotify: transaction.raw_notify,
    createdAt: transaction.created_at ? new Date(transaction.created_at).getTime() : Date.now(),
    updatedAt: transaction.updated_at ? new Date(transaction.updated_at).getTime() : Date.now()
  };

  orders.set(orderNo, order);
  return order;
}

async function logPaymentEvent(orderNo, eventType, status, message, payload) {
  if (!supabase) return;

  const { error } = await supabase
    .from("payment_logs")
    .insert({
      order_no: orderNo,
      event_type: eventType,
      status,
      message,
      payload
    });

  if (error) console.error("Supabase logPaymentEvent failed", error);
}

function mockNativePay(orderNo, totalFee) {
  return {
    result: "SUCCESS",
    ksher_order_no: `MOCK${Date.now()}`,
    mch_order_no: orderNo,
    total_fee: totalFee,
    code_url: makePromptPayLikePayload(orderNo, totalFee)
  };
}

function makePromptPayLikePayload(orderNo, totalFee) {
  return `MOCK-KSHER-PROMPTPAY|ORDER=${orderNo}|AMOUNT=${(totalFee / 100).toFixed(2)}|TS=${Date.now()}`;
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
    case "NOTPAY":
    case "PENDING":
    case "NOTSURE":
    case "USERPAYING":
    default:
      return "PENDING";
  }
}

function makeOrderNo(deviceId) {
  const compactDevice = sanitizeId(deviceId).slice(-8);
  const timePart = Date.now().toString(36).toUpperCase();
  const randomPart = randomHex(3).toUpperCase();
  return `K${compactDevice}${timePart}${randomPart}`.slice(0, 32);
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

function isAuthorized(req) {
  return req.headers.authorization === `Bearer ${config.deviceToken}`;
}

async function readJson(req) {
  const text = await readText(req);
  return text ? JSON.parse(text) : {};
}

function readText(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1024 * 128) {
        req.destroy(new Error("Request too large"));
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload)
  });
  res.end(payload);
}

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function env(name, fallback) {
  return process.env[name] || fallback;
}

function requiredEnv(name, fallback) {
  const value = env(name, fallback);
  if (!value) throw new Error(`Missing required env ${name}`);
  return value;
}

function intEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) ? value : fallback;
}

function boolEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}
