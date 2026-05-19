# ESP32 Ksher Backend

Small backend for the ESP32 kiosk. The ESP32 never stores Ksher merchant credentials; it only calls this backend.

## Endpoints for ESP32

- `POST /api/payments/create`
- `GET /api/payments/status?order_no=...`
- `POST /api/payments/cancel`

Both require:

```text
Authorization: Bearer DEVICE_TOKEN
```

## Setup

```bash
cd backend
cp .env.example .env
npm start
```

Start with `KSHER_MOCK=true` to test the ESP32 screen flow. For real Ksher calls:

1. Set `KSHER_MOCK=false`
2. Put the latest `privatekey.pem` from Ksher Merchant Platform in `backend/privatekey.pem`
3. Set `KSHER_APPID=mchxxxxx`
4. Set `KSHER_CHANNEL=promptpay`
5. Expose this backend through HTTPS if you want webhook callbacks, then set `KSHER_NOTIFY_URL=https://your-domain/api/payments/ksher/notify`

## ESP32 Config

Set these in the `.ino`:

```cpp
const char *BACKEND_BASE_URL = "http://YOUR_SERVER_IP:8787";
const char *DEVICE_TOKEN = "same-as-.env";
```

For production HTTPS, replace `httpsClient.setInsecure()` in the `.ino` with your backend CA certificate.

## Deploy To Vercel

Deploy the `backend` folder as the Vercel project root. The serverless entrypoint is:

```text
api/[...path].js
```

Set these Environment Variables in Vercel:

```env
DEVICE_TOKEN=your-device-token
KSHER_MOCK=false
KSHER_API_BASE=https://api.mch.ksher.net/KsherPay
KSHER_APPID=mchxxxxx
KSHER_CHANNEL=promptpay
KSHER_FEE_TYPE=THB
KSHER_PRODUCT=ESP32 Kiosk
KSHER_VERSION=3.0.0
KSHER_NOTIFY_URL=https://your-vercel-domain.vercel.app/api/payments/ksher/notify
KSHER_PRIVATE_KEY_PEM=-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----
```

Then set ESP32 to:

```cpp
const char *BACKEND_BASE_URL = "https://your-vercel-domain.vercel.app";
```

In live mode, `/api/payments/status` queries Ksher directly by `order_no`, so it does not rely on server memory. Mock mode on Vercel is only best-effort because serverless memory is not persistent.
