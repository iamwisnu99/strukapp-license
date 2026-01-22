const admin = require('firebase-admin');
const fetch = require('node-fetch');

if (!admin.apps.length) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: "https://strukmaker-3327d110-default-rtdb.asia-southeast1.firebasedatabase.app"
    });
  } catch (error) {
    console.error("Firebase Admin Init Error:", error);
  }
}

const db = admin.database();
const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
};

const respond = (statusCode, body) => {
  return {
    statusCode,
    headers,
    body: JSON.stringify(body)
  };
};

const sendEmail = async (data) => {
  const url = 'https://api.emailjs.com/api/v1.0/email/send';

  if (!process.env.EMAILJS_SERVICE_ID || !process.env.EMAILJS_PRIVATE_KEY) {
     throw new Error("ENV Variable EmailJS belum di-set di Netlify!");
  }

  const payload = {
    service_id: process.env.EMAILJS_SERVICE_ID,
    template_id: process.env.EMAILJS_TEMPLATE_ID,
    user_id: process.env.EMAILJS_PUBLIC_KEY, 
    accessToken: process.env.EMAILJS_PRIVATE_KEY,
    template_params: {
      to_email: data.email,
      to_name: data.name,
      license_key: data.key,
      expiry_date: data.expiryDate,
      type: data.type,
      message_html: data.html_template
    }
  };

  // Hapus try-catch disini, biar error-nya naik ke atas (Handler utama)
  const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
  });

  // Cek HTTP Status dari EmailJS
  if (!response.ok) {
      const text = await response.text();
      throw new Error(`EmailJS Gagal: ${response.status} - ${text}`);
  }
  
  console.log("Email sent successfully to", data.email);
};

// --- 4. MAIN HANDLER ---
exports.handler = async (event, context) => {
  if (event.httpMethod === 'OPTIONS') {
    return respond(200, { message: 'CORS OK' });
  }

  // --- SECURITY CHECK (VERIFY TOKEN) ---
  const token = event.headers.authorization?.split('Bearer ')[1];
  if (!token) {
    return respond(401, { error: 'Unauthorized: Mana tokennya woy?' });
  }

  try {
    await admin.auth().verifyIdToken(token);
  } catch (error) {
    return respond(403, { error: 'Forbidden: Token basi atau palsu.' });
  }

  const path = 'licenses';

  try {
    // --- GET (READ DATA) ---
    if (event.httpMethod === 'GET') {
      const snapshot = await db.ref(path).once('value');
      const data = snapshot.val() || {};
      const list = Object.keys(data).map(key => ({
        id: key,
        key: key,
        ...data[key]
      })).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

      return respond(200, list);
    }

    // --- POST (CREATE LICENSE) ---
    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body);
      const { key, name, email, type, expiryDate, sendEmailCheck, html_template } = body;

      if (!key || !email) return respond(400, { error: 'Data kurang lengkap bos.' });

      const newLicense = {
        status: 'active',
        type: type.toLowerCase(),
        deviceId: '',
        expiryDate,
        name,
        email,
        createdAt: Date.now()
      };

      await db.ref(`${path}/${key}`).set(newLicense);

      if (sendEmailCheck) {
        await sendEmail({ name, email, key, type, expiryDate, html_template });
      }

      return respond(201, { message: 'License Created', data: newLicense });
    }

    // --- PUT (UPDATE LICENSE) ---
    if (event.httpMethod === 'PUT') {
      const body = JSON.parse(event.body);
      const { id, status, expiryDate, deviceId } = body;

      if (!id) return respond(400, { error: 'Mau update yang mana? ID nya mana?' });

      await db.ref(`${path}/${id}`).update({
        status: status.toLowerCase(),
        expiryDate,
        deviceId
      });

      return respond(200, { message: 'License Updated' });
    }

    // --- DELETE (REMOVE LICENSE) ---
    if (event.httpMethod === 'DELETE') {
      const id = event.queryStringParameters.id;

      if (!id) return respond(400, { error: 'Mau hapus yang mana?' });

      await db.ref(`${path}/${id}`).remove();
      return respond(200, { message: 'License Deleted' });
    }

    return respond(405, { error: 'Method Not Allowed' });

  } catch (error) {
    console.error("Server Error:", error);
    return respond(500, { error: error.message });
  }
};