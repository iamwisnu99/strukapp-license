const admin = require('firebase-admin');
const PDFDocument = require('pdfkit');

// Setup Firebase Admin (Cek biar gak error double init)
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
        databaseURL: "https://strukmaker-3327d110-default-rtdb.asia-southeast1.firebasedatabase.app/"
    });
}
const db = admin.database();

exports.handler = async (event, context) => {
    const { id } = event.queryStringParameters;
    if (!id) return { statusCode: 400, body: "ID Lisensi Wajib Ada!" };

    try {e
        const snapshot = await db.ref('licenses/' + id).once('value');
        const data = snapshot.val();
        if (!data) return { statusCode: 404, body: "Data Invoice Tidak Ditemukan" };

        return new Promise((resolve, reject) => {
            const doc = new PDFDocument({ size: 'A4', margin: 50 });
            let buffers = [];

            doc.on('data', buffers.push.bind(buffers));
            doc.on('end', () => {
                const pdfData = Buffer.concat(buffers);
                resolve({
                    statusCode: 200,
                    headers: {
                        'Content-Type': 'application/pdf',
                        'Content-Disposition': `inline; filename=Invoice-${data.key.substring(0,8)}.pdf`
                    },
                    body: pdfData.toString('base64'),
                    isBase64Encoded: true
                });
            });

            // --- DESAIN VISUAL INVOICE ---
            doc.fillColor('#4f46e5').fontSize(24).font('Helvetica-Bold').text('PRIMADEV', { align: 'left' });
            doc.fillColor('black').fontSize(10).font('Helvetica').text('Software Solutions', { align: 'left' });
            doc.moveDown();

            doc.fontSize(20).text('INVOICE', { align: 'right', valign: 'top' });

            doc.moveTo(50, 110).lineTo(550, 110).lineWidth(1).strokeColor('#e2e8f0').stroke();

            const topInfo = 130;
            doc.fontSize(10).fillColor('#64748b');
            doc.text('Nomor Invoice:', 50, topInfo);
            doc.text('Tanggal:', 50, topInfo + 15);
            doc.text('Kepada Yth:', 300, topInfo);

            doc.fillColor('black').font('Helvetica-Bold');
            doc.text(`INV-${id.substring(1, 8).toUpperCase()}`, 130, topInfo); // ID Unik
            doc.text(new Date().toLocaleDateString('id-ID', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }), 130, topInfo + 15);
            
            doc.text(data.name, 370, topInfo);
            doc.font('Helvetica').fontSize(9).text(data.email, 370, topInfo + 15);

            const tableTop = 200;

            doc.rect(50, tableTop, 500, 25).fill('#f1f5f9');
            doc.fillColor('black').font('Helvetica-Bold').fontSize(10);
            doc.text('DESKRIPSI', 60, tableTop + 7);
            doc.text('TIPE', 300, tableTop + 7);
            doc.text('HARGA', 450, tableTop + 7, { align: 'right' });

            const itemY = tableTop + 35;
            doc.font('Helvetica-Bold').fontSize(11).text('Lisensi Aplikasi Struk SPBU', 60, itemY);
            doc.font('Helvetica').fontSize(9).fillColor('#64748b').text(`License Key: ${data.key}`, 60, itemY + 15);

            const type = (data.type || 'Standard').toUpperCase();
            doc.fillColor('black').fontSize(10).text(type, 300, itemY);

            const price = parseInt(data.price) || 0;
            const formattedPrice = "Rp " + price.toLocaleString('id-ID');
            doc.text(formattedPrice, 450, itemY, { align: 'right' });

            doc.moveTo(50, itemY + 35).lineTo(550, itemY + 35).strokeColor('#e2e8f0').stroke();

            const totalY = itemY + 50;
            doc.font('Helvetica-Bold').fontSize(14).text('TOTAL', 350, totalY);
            doc.fillColor('#4f46e5').text(formattedPrice, 450, totalY, { align: 'right' });

            doc.fontSize(9).fillColor('#94a3b8').font('Helvetica');
            doc.text('Terima kasih telah membeli lisensi resmi PrimaDev.', 50, 700, { align: 'center', width: 500 });
            doc.text('Invoice ini sah dan diproses secara otomatis oleh komputer.', 50, 715, { align: 'center', width: 500 });

            doc.end();
        });

    } catch (e) {
        return { statusCode: 500, body: "Error: " + e.message };
    }
};