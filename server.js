const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const app = express();
app.use(express.json());

// [إصلاح CORS] تصريح المرور الآمن
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization, telegram-init-data");
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// ⚠️ 1. ضع توكن البوت الحقيقي الخاص بك هنا
const BOT_TOKEN = '8991189300:AAHuIelcqXJLSV7naltiyuBr9H7oEU9MjrI'; 
const bot = new Telegraf(BOT_TOKEN);

// ⚠️ 2. ضع رقم الـ Chat ID الخاص بك هنا (المشرف العام والوسيط)
const ADMIN_CHAT_ID = '2093073123';

// 🗄️ الاتصال بقاعدة البيانات وتحديث الجداول لتشمل البائعين والبيانات السرية للمنتج
const db = new sqlite3.Database(path.join(__dirname, 'database.db'), (err) => {
    if (err) console.error('خطأ في قاعدة البيانات:', err.message);
});

db.serialize(() => {
    // جدول المنتجات يضم الآن: اسم البائع، حساب بريدي موب، والبيانات السرية (تسلم بعد الدفع)
    db.run(`CREATE TABLE IF NOT EXISTS marketplace_products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        seller_name TEXT NOT NULL,
        product_name TEXT NOT NULL,
        price INTEGER NOT NULL,
        rip_number TEXT NOT NULL,
        secret_data TEXT NOT NULL
    )`);

    // جدول الطلبات لتتبع الضمان
    db.run(`CREATE TABLE IF NOT EXISTS escrow_orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER,
        product_name TEXT,
        price INTEGER,
        seller_name TEXT,
        buyer_name TEXT,
        buyer_phone TEXT,
        status TEXT DEFAULT 'بانتظار الدفع'
    )`);
});

// عرض الواجهة
app.use(express.static(__dirname));
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

// 🌐 [GET] جلب كافة منتجات السوق لجميع التجار
app.get('/api/products', (req, res) => {
    db.all("SELECT id, seller_name, product_name, price, rip_number FROM marketplace_products", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// 🌐 [POST] سماح لأي تاجر بنشر منتجه وبياناته السرية في السوق
app.post('/api/products', (req, res) => {
    const { seller_name, product_name, price, rip_number, secret_data } = req.body;
    if (!seller_name || !product_name || !price || !rip_number || !secret_data) {
        return res.status(400).json({ error: "بيانات ناقصة" });
    }
    
    db.run("INSERT INTO marketplace_products (seller_name, product_name, price, rip_number, secret_data) VALUES (?, ?, ?, ?, ?)", 
    [seller_name, product_name, parseInt(price), rip_number, secret_data], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.status(201).json({ success: true });
    });
});

// 🌐 [POST] إطلاق طلب شراء وضمان (Escrow) جديد
app.post('/api/orders', (req, res) => {
    const { product_id, buyer_name, buyer_phone } = req.body;
    
    // جلب بيانات المنتج المختار لمعرفة البائع والسعر
    db.get("SELECT * FROM marketplace_products WHERE id = ?", [product_id], (err, product) => {
        // 🟢 تم إصلاح الخطأ المطبعي هنا وتغيير العبارة إلى الكود الرقمي السليم 404
        if (!product) return res.status(404).json({ error: "المنتج غير موجود" });

        db.run("INSERT INTO escrow_orders (product_id, product_name, price, seller_name, buyer_name, buyer_phone) VALUES (?, ?, ?, ?, ?, ?)",
        [product.id, product.product_name, product.price, product.seller_name, buyer_name, buyer_phone], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            
            const orderId = this.lastID;
            const message = `🚨 **عملية وساطة (Escrow) سوق مفتوح** 🚨\n\n` +
                            `🆔 رقم العملية: ${orderId}\n` +
                            `📦 المنتج الرقمي: ${product.product_name}\n` +
                            `💰 السعر: ${product.price} DA\n` +
                            `👤 المشتري: ${buyer_name} (${buyer_phone})\n` +
                            `🏪 البائع: ${product.seller_name}\n` +
                            `💳 حساب تحويل البائع (RIP): \`${product.rip_number}\`\n\n` +
                            `يرجى مراجعة وصل التحويل يدوياً ثم اتخاذ إجراء الضمان:`;

            // إرسال الرسالة التفاعلية لك بصفتك الوسيط الحصري للمنصة
            bot.telegram.sendMessage(ADMIN_CHAT_ID, message, Markup.inlineKeyboard([
                [Markup.button.callback('✅ تأكيد الدفع وتسليم البيانات المشتري', `approve_${orderId}`)],
                [Markup.button.callback('❌ إلغاء العملية وإرجاع المنتج', `reject_${orderId}`)]
            ])).catch(e => console.error(e.message));

            res.json({ success: true });
        });
    });
});

// معالجة التحكم في الضمان يدوياً وإرسال البيانات السرية للمشتري عبر البوت
bot.on('callback_query', (ctx) => {
    const action = ctx.callbackQuery.data;
    
    if (action.startsWith('approve_')) {
        const orderId = action.split('_')[1];
        // جلب البيانات السرية للمنتج لتسليمها بعد نجاح الضمان
        db.get("SELECT o.*, p.secret_data FROM escrow_orders o JOIN marketplace_products p ON o.product_id = p.id WHERE o.id = ?", [orderId], (err, order) => {
            if (!order || err) return ctx.answerCbQuery("الطلب غير موجود أو بيع مسبقاً");
            
            db.run("UPDATE escrow_orders SET status = 'تم التسليم بنجاح' WHERE id = ?", [orderId], () => {
                // حذف المنتج من السوق لأنه بيع ولم يعد متوفراً
                db.run("DELETE FROM marketplace_products WHERE id = ?", [order.product_id], () => {
                    ctx.editMessageText(ctx.callbackQuery.message.text + `\n\n✅ **تمت الموافقة! البيانات السرية المسلمة للمشتري هي:** \`${order.secret_data}\``);
                });
            });
        });
    } else if (action.startsWith('reject_')) {
        const orderId = action.split('_')[1];
        db.run("UPDATE escrow_orders SET status = 'ملغية من المشرف' WHERE id = ?", [orderId], () => {
            ctx.editMessageText(ctx.callbackQuery.message.text + `\n\n🔴 **تم إلغاء العملية من قبل الوسيط وإعادة السلعة للسوق.**`);
        });
    }
});

bot.launch();
app.listen(3000, () => { console.log('سوق الجزائر الرقمي المفتوح جاهز على المنفذ 3000!'); });
