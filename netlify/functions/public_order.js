const admin = require('firebase-admin');
const fetch = require('node-fetch');
const midtransClient = require('midtrans-client');

const IS_PRODUCTION = process.env.MIDTRANS_IS_PRODUCTION === 'true';
const SERVER_KEY = process.env.MIDTRANS_SERVER_KEY;
const CLIENT_KEY = process.env.MIDTRANS_CLIENT_KEY;

const { getPremiumTemplate, getRenewalTemplate } = require('./email_template')

if (!SERVER_KEY || !CLIENT_KEY) {
    console.error("FATAL: Midtrans Key belum disetting di .env atau Netlify Dashboard!");
}

// Switching to CoreApi and Snap
let core = new midtransClient.CoreApi({
    isProduction: IS_PRODUCTION,
    serverKey: SERVER_KEY,
    clientKey: CLIENT_KEY
});

let snap = new midtransClient.Snap({
    isProduction: IS_PRODUCTION,
    serverKey: SERVER_KEY,
    clientKey: CLIENT_KEY
});

// --- INISIALISASI FIREBASE ---
if (!admin.apps.length) {
  try {
    if (process.env.FIREBASE_PRIVATE_KEY && process.env.FIREBASE_CLIENT_EMAIL) {
      console.log("[INIT] Menggunakan ENV Variable...");
      
      const serviceAccount = {
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n').replace(/"/g, '') 
      };

      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: process.env.FIREBASE_DATABASE_URL || "https://strukmaker-3327d110-default-rtdb.asia-southeast1.firebasedatabase.app"
      });
      
      console.log("✅ Firebase Berhasil Terhubung!");
      
    } else {
      throw new Error("❌ FATAL: Environment Variable FIREBASE_PRIVATE_KEY atau CLIENT_EMAIL gak ketemu!");
    }

  } catch (err) {
    console.error("[INIT ERROR] Gagal connect Firebase:", err.message);
  }
}

const db = admin.database();

// --- HELPER: GENERATE KEY ---
const generateRandomKey = () => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    return `PRIMA-${Array.from({ length: 3 }, () => Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')).join('-')}`;
};

// --- HELPER: KIRIM EMAIL ---
const sendEmail = async (data, isRenewal = false) => {
    const url = 'https://api.emailjs.com/api/v1.0/email/send';
    if (!process.env.EMAILJS_SERVICE_ID) return;

    const templateData = {
        name: data.name,
        key: data.key,
        appName: data.appName,
        type: data.type || (isRenewal ? 'Renewal' : 'Monthly'),
        expiryDate: data.expiryDate,
        transactionId: data.transactionId || data.orderId
    };

    const messageHtml = isRenewal ? getRenewalTemplate(templateData) : getPremiumTemplate(templateData);

    const emailPayload = {
        service_id: process.env.EMAILJS_SERVICE_ID,
        template_id: process.env.EMAILJS_TEMPLATE_ID,
        user_id: process.env.EMAILJS_PUBLIC_KEY,
        accessToken: process.env.EMAILJS_PRIVATE_KEY,
        template_params: {
            to_email: data.email,
            to_name: data.name,
            license_key: data.key,
            expiry_date: data.expiryDate,
            type: isRenewal ? `Perpanjangan ${data.appName}` : `${data.appName} (${data.type})`,
            message_html: messageHtml
        }
    };
    try {
        await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(emailPayload) });
    } catch (e) {
        console.error("[EMAIL ERROR]", e);
    }
};

exports.handler = async (event, context) => {
    // Header agar bisa diakses dari frontend (CORS)
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE'
    };

    // Load Products from Firebase
    let PRICING_DB = {};
    try {
        const prodSnap = await db.ref('products').once('value');
        if (prodSnap.exists()) PRICING_DB = prodSnap.val();
        else {
            // Fallback to local if Firebase empty (optional safety)
            try { PRICING_DB = require('../../products.json'); } catch (e) { }
        }
    } catch (e) {
        console.error("Failed to load products:", e);
    }

    if (event.httpMethod === 'GET') {
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                catalog: PRICING_DB,
                clientKey: CLIENT_KEY,
                isProduction: IS_PRODUCTION
            })
        };
    }

    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
    }

    if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: "Method Not Allowed" };


    try {
        const body = JSON.parse(event.body || '{}');
        const { action } = body;

        console.log(`[BACKEND] Received ${event.httpMethod} with action: ${action || 'None'}`);

        // --- PATH 1: REQ DARI STORE (Core API) ---
        if (action === 'create_transaction') {
            const { appId, duration, buyerName, buyerEmail, buyerPhone, paymentMethod } = body;
            const product = PRICING_DB[appId];
            if (!product || !product.price[duration]) return { statusCode: 400, headers, body: JSON.stringify({ error: "Produk invalid" }) };

            const price = Math.floor(product.price[duration]);
            const orderId = `ORDER-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

            let parameter = {
                transaction_details: { order_id: orderId, gross_amount: price },
                customer_details: { first_name: buyerName, email: buyerEmail, phone: buyerPhone },
                item_details: [{ id: `${appId}-${duration}`, price: price, quantity: 1, name: `${product.name} (${duration})` }],
                custom_field1: appId, custom_field2: duration, custom_field3: 'public_store'
            };

            if (paymentMethod === 'qris') {
                parameter.payment_type = 'qris';
                parameter.qris = { acquirer: 'gopay' };
            } else if (['bca', 'mandiri', 'bni', 'bri', 'permata'].includes(paymentMethod)) {
                parameter.payment_type = 'bank_transfer';
                if (paymentMethod === 'mandiri') {
                    parameter.payment_type = 'echannel';
                    parameter.echannel = { bill_info1: "Payment:", bill_info2: "Software License" };
                } else if (paymentMethod === 'permata') {
                    parameter.bank_transfer = { bank: 'permata' };
                } else {
                    parameter.bank_transfer = { bank: paymentMethod };
                }
            } else if (paymentMethod === 'gopay' || paymentMethod === 'shopeepay') {
                parameter.payment_type = paymentMethod;
                parameter[paymentMethod] = { callback_url: "https://primadev-license.netlify.app/thankyou.html" };
            } else if (paymentMethod === 'ovo' || paymentMethod === 'dana') {
                parameter.payment_type = 'qris';
                parameter.qris = { acquirer: 'gopay' };
            } else if (paymentMethod === 'card') {
                return { statusCode: 400, headers, body: JSON.stringify({ error: "Metode pembayaran kartu tidak tersedia saat ini." }) };
            }

            const chargeResponse = await core.charge(parameter);

            // --- SAVE TO FIREBASE (Fix for verify_payment 404) ---
            await db.ref(`transactions/${orderId}`).set({
                orderId,
                status: 'pending',
                amount: price,
                customerName: buyerName,
                customerEmail: buyerEmail,
                customerPhone: buyerPhone,
                appName: product.name,
                appId: appId,
                duration,
                orderType: 'NEW',
                paymentMethod: paymentMethod,
                createdAt: Date.now()
            });

            return { statusCode: 200, headers, body: JSON.stringify(chargeResponse) };
        }

        if (action === 'verify_payment') {
            const { orderId } = body;
            if (!orderId) return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing orderId" }) };

            const statusResponse = await core.transaction.status(orderId);
            const transactionStatus = statusResponse.transaction_status;
            const fraudStatus = statusResponse.fraud_status;

            console.log(`[BACKEND] Verifying ${orderId}: ${transactionStatus} | Fraud: ${fraudStatus}`);

            if (transactionStatus !== 'capture' && transactionStatus !== 'settlement') {
                return { statusCode: 200, headers, body: JSON.stringify({ status: transactionStatus, isSuccess: false }) };
            }

            // Challenge di sandbox bisa diabaikan atau ditandai
            if (fraudStatus == 'challenge') {
                console.warn(`[BACKEND] Transaction ${orderId} is challenged.`);
            }

            const trxSnap = await db.ref(`transactions/${orderId}`).once('value');
            if (!trxSnap.exists()) {
                console.error(`[BACKEND] Data transaksi ${orderId} tidak ada di Firebase!`);
                return { statusCode: 404, headers, body: JSON.stringify({ error: "Transaction data not found" }) };
            }
            const trxData = trxSnap.val();

            if (trxData.status === 'success') {
                return { statusCode: 200, headers, body: JSON.stringify({ status: 'success', message: "Already processed" }) };
            }

            console.log(`[BACKEND] OrderType: ${trxData.orderType} | TargetKey: ${trxData.targetLicenseKey || 'NewUser'}`);

            // --- PERPANJANGAN (RENEWAL) ---
            if (trxData.orderType === 'RENEWAL') {
                const targetKey = trxData.targetLicenseKey;
                if (!targetKey) {
                    console.error("[BACKEND ERROR] targetLicenseKey null untuk RENEWAL!");
                    return { statusCode: 400, headers, body: JSON.stringify({ error: "Target License Key missing in transaction" }) };
                }

                const licRef = db.ref(`licenses/${targetKey}`);
                const licSnap = await licRef.once('value');
                if (!licSnap.exists()) return { statusCode: 404, headers, body: JSON.stringify({ error: "License not found" }) };

                const currentData = licSnap.val();
                const now = new Date();
                let currentExpiry = currentData.expiryDate ? new Date(currentData.expiryDate) : null;
                if (currentExpiry && isNaN(currentExpiry.getTime())) currentExpiry = null;

                let baseDate = (currentExpiry && currentExpiry > now) ? currentExpiry : now;
                let newExpiry = new Date(baseDate);
                if (trxData.duration === 'yearly') newExpiry.setFullYear(newExpiry.getFullYear() + 1);
                else newExpiry.setMonth(newExpiry.getMonth() + 1);

                const expiryString = newExpiry.toISOString().split('T')[0];
                await licRef.update({ status: 'active', expiryDate: expiryString, lastRenewalDate: Date.now(), lastTransactionId: orderId });
                await db.ref(`transactions/${orderId}`).update({ status: 'success' });

                // Kirim Email Perpanjangan Berhasil
                await sendEmail({
                    name: currentData.name,
                    email: currentData.email,
                    key: targetKey,
                    appName: currentData.appName,
                    expiryDate: expiryString,
                    transactionId: orderId
                }, true);

                return { statusCode: 200, headers, body: JSON.stringify({ status: 'success', key: targetKey }) };
            }

            // --- PEMBELIAN BARU ---
            const appId = body.appId || (trxData ? trxData.appId : 'struk-spbu');
            const duration = body.duration || (trxData ? trxData.duration : 'monthly');
            const product = PRICING_DB[appId] || { name: 'Aplikasi', price: {} };

            const checks = await db.ref(`licenses`).orderByChild('transactionId').equalTo(orderId).once('value');
            if (checks.exists()) return { statusCode: 200, headers, body: JSON.stringify({ status: 'success', key: Object.keys(checks.val())[0] }) };

            const key = generateRandomKey();
            const expiry = new Date();
            if (duration === 'monthly') expiry.setMonth(expiry.getMonth() + 1);
            else if (duration === 'yearly') expiry.setFullYear(expiry.getFullYear() + 1);
            else expiry.setFullYear(expiry.getFullYear() + 100);

            const newLicense = {
                key, status: 'active', type: duration,
                appName: product.name || (trxData ? trxData.appName : 'Aplikasi'),
                appId: appId,
                price: product.price[duration] || (trxData ? trxData.amount : 0),
                name: body.buyerName || (trxData ? trxData.customerName : 'Customer'),
                email: body.buyerEmail || (trxData ? trxData.customerEmail : 'Email'),
                expiryDate: expiry.toISOString().split('T')[0],
                paymentMethod: `Midtrans ${statusResponse.payment_type}`, transactionId: orderId,
                createdAt: Date.now()
            };
            await db.ref(`licenses/${key}`).set(newLicense);
            if (trxData) await db.ref(`transactions/${orderId}`).update({ status: 'success' });
            await sendEmail({ ...newLicense, key });
            return { statusCode: 200, headers, body: JSON.stringify({ status: 'success', key }) };
        }

        // --- PATH 2: SNAP API (Tanpa Action) ---
        if (!action) {
            const { name = 'Customer', email = 'no-email@example.com', phone = '', amount = 0, duration = 'monthly', appName = 'Struk SPBU', licenseKey = null, orderType = 'NEW' } = body;
            if (amount <= 0) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid Amount' }) };

            const orderId = `ORDER-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
            const itemName = orderType === 'RENEWAL' ? `Perpanjang Lisensi (${duration})` : `Lisensi ${appName} (${duration})`;
            const itemId = orderType === 'RENEWAL' ? 'RENEWAL-SRV' : (duration + '-sub');

            const parameter = {
                transaction_details: { order_id: orderId, gross_amount: parseInt(amount) },
                customer_details: { first_name: name, email: email, phone: phone },
                item_details: [{ id: itemId, price: parseInt(amount), quantity: 1, name: itemName.substring(0, 50) }]
            };

            const transaction = await snap.createTransaction(parameter);
            await db.ref(`transactions/${orderId}`).set({ orderId, status: 'pending', amount: parseInt(amount), customerName: name, customerEmail: email, customerPhone: phone, appName, duration, orderType, targetLicenseKey: licenseKey, createdAt: Date.now() });

            return { statusCode: 200, headers, body: JSON.stringify({ token: transaction.token, redirect_url: transaction.redirect_url, orderId }) };
        }

        return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid action or request" }) };

    } catch (error) {
        console.error("Backend Error:", error);
        return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
    }
};
