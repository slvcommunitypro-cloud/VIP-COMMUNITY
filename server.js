const express = require('express');
const cors = require('cors');
const Parser = require('rss-parser');
const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const poDemo = require('./po-demo');
const signalLogPath = path.join(__dirname, 'signal-log.json');

// ==================== КОНФИГ (лучше всего хранить в .env) ====================
const PORT = process.env.PORT || 3000;

// Telegram
const BOT_TOKEN = process.env.BOT_TOKEN || "8988084203:AAGMNH763cv170X0lRGczjTwUY6Ir-TWlFI";
const WELCOME_GIF_URL = process.env.WELCOME_GIF_URL || "https://i.postimg.cc/ryWPSfVL/89a66af6cb2045bab65e10448563532b.gif";

// Supabase (рекомендуется использовать SERVICE_ROLE_KEY в продакшене!)
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://rjhnlzayhwidycqdroms.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_2BKzk8OP3abRq8l6wiLbkA_8fJFzh3x';

// Главный админ (ROOT)
const MASTER_ADMIN = process.env.MASTER_ADMIN || "5817328317";

// ==================== ИНИЦИАЛИЗАЦИЯ ====================
const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const parser = new Parser();
const bot = new Telegraf(BOT_TOKEN);

// ==================== SUPABASE ИНИЦИАЛИЗАЦИЯ (защищённая) ====================
let supabase = null;
let supabaseEnabled = false;

try {
    if (SUPABASE_URL && SUPABASE_KEY) {
        supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
        supabaseEnabled = true;
        log('Supabase клиент успешно инициализирован', 'SUPABASE');
    } else {
        log('Supabase ключи не найдены — работаем в режиме In-Memory', 'WARN');
    }
} catch (e) {
    log(`Не удалось инициализировать Supabase: ${e.message}`, 'ERROR');
    supabaseEnabled = false;
}

// In-memory кэш (для быстрых проверок и fallback)
let allowedUsers = [];
let cachedVideoLessons = [];
let cachedChatMessages = []; // ← Кэш для чата

// ==================== ЛОГИРОВАНИЕ ====================
function log(message, type = 'INFO') {
    const time = new Date().toISOString();
    console.log(`[${time}] [${type}] ${message}`);
}

// ==================== SUPABASE — РАБОТА С ПОЛЬЗОВАТЕЛЯМИ ====================
async function loadAllowedUsers() {
    if (!supabaseEnabled || !supabase) {
        allowedUsers = [MASTER_ADMIN];
        log('Supabase отключён — загружен только MASTER_ADMIN', 'WARN');
        return;
    }

    try {
        const { data, error } = await supabase
            .from('allowed_users')
            .select('user_id')
            .order('created_at', { ascending: true });

        if (error) throw error;

        allowedUsers = (data || []).map(row => row.user_id);

        if (allowedUsers.length === 0) {
            const defaults = ["644265574", "5211910606", "987654321", MASTER_ADMIN];
            for (const uid of defaults) {
                await supabase.from('allowed_users').upsert({ user_id: uid }, { onConflict: 'user_id' });
            }
            allowedUsers = defaults;
            log('Добавлены дефолтные пользователи в Supabase', 'SUPABASE');
        }

        log(`Загружено ${allowedUsers.length} пользователей из Supabase`, 'SUPABASE');
    } catch (e) {
        log(`Ошибка загрузки из Supabase: ${e.message} → работаем в памяти`, 'ERROR');
        allowedUsers = [MASTER_ADMIN];
    }
}

async function addUserToSupabase(userId) {
    const normalized = String(userId).trim();
    if (allowedUsers.includes(normalized)) {
        return { success: true, alreadyExists: true };
    }

    if (!supabaseEnabled || !supabase) {
        allowedUsers.push(normalized);
        log(`Пользователь ${normalized} добавлен (только в память)`, 'WARN');
        return { success: true, memoryOnly: true };
    }

    const { error } = await supabase
        .from('allowed_users')
        .upsert({ user_id: normalized }, { onConflict: 'user_id' });

    if (error) {
        log(`Ошибка добавления ${normalized} в Supabase: ${error.message}`, 'ERROR');
        return { success: false, error: error.message };
    }

    allowedUsers.push(normalized);
    log(`Пользователь ${normalized} добавлен в Supabase`, 'SUPABASE');
    return { success: true };
}

async function removeUserFromSupabase(userId) {
    const normalized = String(userId).trim();
    if (normalized === MASTER_ADMIN) {
        return { success: false, error: 'Нельзя удалить ROOT администратора' };
    }

    if (!supabaseEnabled || !supabase) {
        allowedUsers = allowedUsers.filter(id => id !== normalized);
        log(`Пользователь ${normalized} удалён (только из памяти)`, 'WARN');
        return { success: true, memoryOnly: true };
    }

    const { error } = await supabase
        .from('allowed_users')
        .delete()
        .eq('user_id', normalized);

    if (error) {
        log(`Ошибка удаления ${normalized} из Supabase: ${error.message}`, 'ERROR');
        return { success: false, error: error.message };
    }

    allowedUsers = allowedUsers.filter(id => id !== normalized);
    log(`Пользователь ${normalized} удалён из Supabase`, 'SUPABASE');
    return { success: true };
}

function isMaster(adminId) {
    return String(adminId) === MASTER_ADMIN;
}

function normalizeId(id) {
    return String(id).trim();
}

// ==================== SUPABASE — ВИДЕОУРОКИ ====================
async function loadVideoLessonsFromSupabase() {
    if (!supabaseEnabled || !supabase) {
        log('Supabase отключён — видеоуроки загружаются только из памяти', 'WARN');
        return cachedVideoLessons;
    }

    try {
        const { data, error } = await supabase
            .from('video_lessons')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) throw error;

        cachedVideoLessons = (data || []).map(lesson => {
            return {
                ...lesson,
                desc: lesson.description || lesson.desc || lesson.описание || '',
                level: lesson.level || lesson.уровень || ''
            };
        });

        log(`Загружено ${cachedVideoLessons.length} видеоуроков из Supabase`, 'SUPABASE');
        return cachedVideoLessons;
    } catch (e) {
        log(`Ошибка загрузки видеоуроков из Supabase: ${e.message}`, 'ERROR');
        return cachedVideoLessons;
    }
}

async function saveVideoLessonToSupabase(lessonData) {
    if (!supabaseEnabled || !supabase) {
        const newLesson = {
            id: Date.now(),
            ...lessonData,
            created_at: new Date().toISOString()
        };
        cachedVideoLessons.unshift(newLesson);
        log('Видеоурок сохранён только в память (Supabase отключён)', 'WARN');
        return { success: true, memoryOnly: true, lesson: newLesson };
    }

    try {
        const { data, error } = await supabase
            .from('video_lessons')
            .insert([{
                title: lessonData.title,
                category: lessonData.category,
                duration: lessonData.duration || '',
                level: lessonData.level || lessonData.уровень || '',
                description: lessonData.description || lessonData.desc || '',
                youtube: lessonData.youtube
            }])
            .select()
            .single();

        if (error) {
            log(`БД Ошибка вставки: ${JSON.stringify(error)}`, 'ERROR');
            throw error;
        }

        await loadVideoLessonsFromSupabase();
        log(`Видеоурок "${lessonData.title}" успешно сохранён в Supabase`, 'SUPABASE');
        return { success: true, lesson: data };
    } catch (e) {
        log(`Ошибка сохранения видеоурока: ${e.message || JSON.stringify(e)}`, 'ERROR');
        return { success: false, error: e.message || JSON.stringify(e) };
    }
}

// ==================== SUPABASE — ЧАТ (НОВОЕ) ====================
async function loadChatMessagesFromSupabase() {
    if (!supabaseEnabled || !supabase) {
        log('Supabase отключён — чат загружается только из памяти', 'WARN');
        return cachedChatMessages;
    }

    try {
        const { data, error } = await supabase
            .from('chat_messages')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(100); // Берем только последние 100 сообщений, чтобы не грузить систему

        if (error) throw error;

        // Переворачиваем, чтобы старые были сверху, новые снизу (стандарт для чата)
        cachedChatMessages = (data || []).reverse(); 

        log(`Загружено ${cachedChatMessages.length} сообщений чата из Supabase`, 'SUPABASE');
        return cachedChatMessages;
    } catch (e) {
        log(`Ошибка загрузки чата из Supabase: ${e.message}`, 'ERROR');
        return cachedChatMessages;
    }
}

async function saveChatMessageToSupabase(chatData) {
    if (!supabaseEnabled || !supabase) {
        const newMsg = {
            id: Date.now(),
            user_id: chatData.user_id,
            user_name: chatData.user_name || 'Аноним',
            message: chatData.message,
            created_at: new Date().toISOString()
        };
        cachedChatMessages.push(newMsg);
        if (cachedChatMessages.length > 100) cachedChatMessages.shift();
        log('Сообщение сохранено только в память (Supabase отключён)', 'WARN');
        return { success: true, memoryOnly: true, message: newMsg };
    }

    try {
        const { data, error } = await supabase
            .from('chat_messages')
            .insert([{
                user_id: String(chatData.user_id).trim(),
                user_name: String(chatData.user_name || 'Аноним').trim(),
                message: String(chatData.message).trim()
            }])
            .select()
            .single();

        if (error) throw error;

        // Обновляем кэш
        cachedChatMessages.push(data);
        if (cachedChatMessages.length > 100) cachedChatMessages.shift();

        return { success: true, message: data };
    } catch (e) {
        log(`Ошибка сохранения сообщения: ${e.message}`, 'ERROR');
        return { success: false, error: e.message };
    }
}

// ==================== TELEGRAM БОТ ====================
bot.start(async (ctx) => {
    const welcomeText = 
        `👋 *Привет, трейдер! Добро пожаловать в VIP Community!* 💎\n\n` +
        `Здесь тебя ждет мощная аналитика рынка, приватное обучение и лучшие торговые инструменты. 🚀\n\n` +
        `⚠️ *Важно:* Чтобы получить полный доступ к боту и начать зарабатывать с командой, тебе необходимо обязательно зарегистрироваться по нашей ссылке на Pocket Option.\n\n` +
        `Нажимай на кнопку ниже, регистрируйся и пиши администратору для подтверждения!`;

    try {
        await ctx.replyWithAnimation(WELCOME_GIF_URL);
        await ctx.replyWithMarkdown(welcomeText, Markup.inlineKeyboard([
            [Markup.button.url('🔗 Зарегистрироваться в Pocket Option', 'https://u3.shortink.io/register?utm_campaign=848628&utm_source=affiliate&utm_medium=sr&a=yueyrPjXG4Zw24&al=1774255&ac=alifavip&cid=963312')],
            [Markup.button.url('👨‍💻 Написать Администратору VIP', 'https://t.me/Briliant_VIP_PRO')]
        ]));
    } catch (error) {
        log(`Ошибка отправки приветствия: ${error.message}`, 'ERROR');
    }
});

bot.command('help', (ctx) => {
    ctx.replyWithMarkdown(
        `📋 *Доступные команды:*\n\n` +
        `/start — приветствие и регистрация\n` +
        `/myid — узнать свой Telegram ID\n` +
        `/help — эта справка`
    );
});

bot.command('myid', (ctx) => {
    ctx.reply(`Ваш Telegram ID: \`${ctx.from.id}\``);
});

bot.launch()
    .then(() => log('Telegram бот успешно запущен', 'BOT'))
    .catch((err) => log(`Ошибка запуска бота: ${err.message}`, 'ERROR'));

// ==================== ОСНОВНЫЕ ЭНДПОИНТЫ ====================
app.get('/', (req, res) => {
    res.json({
        status: 'ok',
        service: 'VIP COMMUNITY PRO AI Backend',
        version: '2.2-chat-added',
        endpoints: [
            '/api/check-access', 
            '/api/allowed-users', 
            '/api/admin/add-user', 
            '/api/admin/remove-user', 
            '/api/video-lessons',
            '/api/chat',               // ← Новый эндпоинт чата
            '/api/news', 
            '/api/news/refresh', 
            '/api/health'
        ]
    });
});

app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'healthy', 
        timestamp: Date.now(), 
        usersLoaded: allowedUsers.length,
        videoLessonsLoaded: cachedVideoLessons.length,
        chatMessagesLoaded: cachedChatMessages.length,
        supabaseEnabled 
    });
});

app.get('/api/check-access', (req, res) => {
    const userId = req.query.userId;
    if (!userId) return res.status(400).json({ allowed: false, error: 'userId required' });

    const isAllowed = allowedUsers.some(id => normalizeId(id) === normalizeId(userId));
    res.json({ allowed: isAllowed });
});

app.get('/api/allowed-users', (req, res) => {
    res.json({
        success: true,
        count: allowedUsers.length,
        users: allowedUsers,
        master: MASTER_ADMIN
    });
});

// ==================== ВИДЕОУРОКИ — ЭНДПОИНТЫ ====================
app.get('/api/video-lessons', async (req, res) => {
    try {
        const lessons = await loadVideoLessonsFromSupabase();
        res.json({ 
            success: true, 
            count: lessons.length, 
            lessons: lessons,
            source: supabaseEnabled ? 'supabase' : 'memory'
        });
    } catch (e) {
        log(`Ошибка GET /api/video-lessons: ${e.message}`, 'ERROR');
        res.status(500).json({ success: false, error: e.message, lessons: cachedVideoLessons });
    }
});

app.post('/api/video-lessons', async (req, res) => {
    const { title, category, duration, level, description, desc, youtube, adminId } = req.body;

    if (adminId && !isMaster(adminId)) {
        return res.status(403).json({ 
            success: false, 
            error: 'Только ROOT ADMIN может добавлять видеоуроки' 
        });
    }

    if (!title || !category || !youtube) {
        return res.status(400).json({ 
            success: false, 
            error: 'Обязательные поля: title, category, youtube' 
        });
    }

    const lessonData = {
        title: String(title).trim(),
        category: String(category).trim(),
        duration: duration ? String(duration).trim() : '',
        level: level ? String(level).trim() : '',
        description: description || desc || '',
        youtube: String(youtube).trim()
    };

    const result = await saveVideoLessonToSupabase(lessonData);

    if (!result.success) {
        return res.status(500).json({ success: false, error: result.error || 'Ошибка сохранения (проверьте RLS политики в Supabase)' });
    }

    res.json({ 
        success: true, 
        lesson: result.lesson,
        message: result.memoryOnly 
            ? 'Сохранено только в память сервера (Supabase отключён)' 
            : 'Видеоурок сохранён глобально в Supabase'
    });
});

app.delete('/api/video-lessons/:id', async (req, res) => {
    const { id } = req.params;
    const adminId = req.body?.adminId || req.query?.adminId;

    if (adminId && !isMaster(adminId)) {
        return res.status(403).json({ success: false, error: 'Только ROOT ADMIN может удалять видеоуроки' });
    }

    if (!supabaseEnabled || !supabase) {
        cachedVideoLessons = cachedVideoLessons.filter(l => String(l.id) !== String(id));
        return res.json({ success: true, message: 'Удалено из памяти' });
    }

    try {
        const { error } = await supabase
            .from('video_lessons')
            .delete()
            .eq('id', id);

        if (error) throw error;

        await loadVideoLessonsFromSupabase();
        res.json({ success: true, message: 'Видеоурок удалён из Supabase' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ==================== ЧАТ — ЭНДПОИНТЫ (НОВОЕ) ====================
app.get('/api/chat', async (req, res) => {
    try {
        const messages = await loadChatMessagesFromSupabase();
        res.json({ 
            success: true, 
            count: messages.length, 
            messages: messages,
            source: supabaseEnabled ? 'supabase' : 'memory'
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message, messages: cachedChatMessages });
    }
});

app.post('/api/chat', async (req, res) => {
    const { user_id, user_name, message } = req.body;

    if (!user_id || !message) {
        return res.status(400).json({ 
            success: false, 
            error: 'Обязательные поля: user_id, message' 
        });
    }

    const result = await saveChatMessageToSupabase({ user_id, user_name, message });

    if (!result.success) {
        return res.status(500).json({ success: false, error: result.error });
    }

    res.json({ success: true, message: result.message });
});

app.delete('/api/chat/:id', async (req, res) => {
    const { id } = req.params;
    const adminId = req.body?.adminId || req.query?.adminId;

    if (adminId && !isMaster(adminId)) {
        return res.status(403).json({ success: false, error: 'Только ROOT ADMIN может удалять сообщения' });
    }

    if (!supabaseEnabled || !supabase) {
        cachedChatMessages = cachedChatMessages.filter(m => String(m.id) !== String(id));
        return res.json({ success: true, message: 'Сообщение удалено из памяти' });
    }

    try {
        const { error } = await supabase
            .from('chat_messages')
            .delete()
            .eq('id', id);

        if (error) throw error;

        await loadChatMessagesFromSupabase();
        res.json({ success: true, message: 'Сообщение удалено из Supabase' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ==================== АДМИН ЭНДПОИНТЫ ====================
app.post('/api/admin/add-user', async (req, res) => {
    const { userId, adminId } = req.body;

    if (!adminId || !isMaster(adminId)) {
        return res.status(403).json({ success: false, error: 'Только ROOT ADMIN может добавлять пользователей' });
    }
    if (!userId) return res.status(400).json({ success: false, error: 'userId required' });

    const result = await addUserToSupabase(userId);
    if (!result.success) {
        return res.status(500).json({ success: false, error: result.error });
    }

    res.json({ success: true, users: allowedUsers, alreadyExists: !!result.alreadyExists });
});

app.post('/api/admin/remove-user', async (req, res) => {
    const { userId, adminId } = req.body;

    if (!adminId || !isMaster(adminId)) {
        return res.status(403).json({ success: false, error: 'Только ROOT ADMIN может удалять пользователей' });
    }
    if (!userId) return res.status(400).json({ success: false, error: 'userId required' });

    const result = await removeUserFromSupabase(userId);
    if (!result.success) {
        return res.status(400).json({ success: false, error: result.error });
    }

    res.json({ success: true, users: allowedUsers });
});

app.post('/api/add-user', async (req, res) => {
    req.body.adminId = MASTER_ADMIN;
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ success: false, error: 'userId required' });

    await addUserToSupabase(userId);
    res.json({ success: true, users: allowedUsers, note: 'Используйте /api/admin/add-user' });
});

app.post('/api/remove-user', async (req, res) => {
    req.body.adminId = MASTER_ADMIN;
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ success: false, error: 'userId required' });

    await removeUserFromSupabase(userId);
    res.json({ success: true, users: allowedUsers });
});

// ==================== PAYOUTS ====================
let currentPayouts = {
    status: "ONLINE",
    timestamp: Date.now(),
    categories: { currencies: [], crypto: [], commodities: [], stocks: [], indices: [] }
};

app.get('/api/payouts', async function (req, res) {
    try {
        const demo = await poDemo.payouts();
        if (demo && demo.categories && demo.categories.currencies && demo.categories.currencies.length) {
            currentPayouts = demo;
            return res.json(demo);
        }
    } catch (e) {}
    return res.json(currentPayouts);
});

function readSignalLog() {
    try {
        const parsed = JSON.parse(fs.readFileSync(signalLogPath, 'utf8'));
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        return [];
    }
}

app.get('/api/signals', function (req, res) {
    const pair = String(req.query.pair || '');
    const rows = readSignalLog().filter(function (row) { return !pair || row.pair === pair; });
    res.json({ ok: true, signals: rows.slice(-200) });
});

app.post('/api/signals', function (req, res) {
    const row = req.body || {};
    if (!row.id || (row.signal !== 'UP' && row.signal !== 'DOWN' && row.signal !== 'NO_TRADE')) {
        return res.status(400).json({ ok: false, error: 'Нужны id и сигнал UP, DOWN или NO_TRADE' });
    }
    const list = readSignalLog();
    const keep = {
        id: String(row.id).slice(0, 120),
        at: Number(row.at) || Date.now(),
        pair: String(row.pair || '').slice(0, 40),
        tf: Number(row.tf) || 1,
        entryAt: Number(row.entryAt) || null,
        expiryAt: Number(row.expiryAt) || null,
        signal: row.signal,
        marketState: String(row.marketState || '').slice(0, 32),
        score: row.score == null ? null : Number(row.score),
        dataAge: row.dataAge == null ? null : Number(row.dataAge),
        reason: String(row.reason || '').slice(0, 400),
        entry: row.entry == null ? null : Number(row.entry),
        close: row.close == null ? null : Number(row.close),
        result: row.result === 'WIN' || row.result === 'LOSS' || row.result === 'PUSH' ? row.result : null,
        up: Number(row.up) || 0,
        down: Number(row.down) || 0,
        indicators: row.indicators && typeof row.indicators === 'object' ? row.indicators : null
    };
    const idx = list.findIndex(function (item) { return item.id === keep.id; });
    if (idx >= 0) list[idx] = Object.assign(list[idx], keep);
    else list.push(keep);
    const trimmed = list.slice(-5000);
    fs.writeFile(signalLogPath, JSON.stringify(trimmed), function () {});
    res.json({ ok: true, count: trimmed.length });
});

app.get('/api/po/health', function (req, res) {
    res.json({ ok: true, connected: true, source: 'pocketoption-demo' });
});

app.get('/api/candles', async function (req, res) {
    const pair = req.query.pair || req.query.symbol || 'EURUSD_otc';
    const period = req.query.period || '60';
    try {
        const demo = await poDemo.candles(pair, period);
        if (demo && Array.isArray(demo.candles) && demo.candles.length) return res.json(demo);
    } catch (e) {
        return res.status(503).json({ ok: false, error: 'Нет свечей Pocket Option' });
    }
    return res.status(503).json({ ok: false, error: 'Нет свечей Pocket Option' });
});

function readGroqKey() {
    let token = String(process.env.GROQ_API_KEY || '').trim();
    if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
        token = token.slice(1, -1).trim();
    }
    token = token.replace(/^Bearer\s+/i, '').replace(/^GROQ_API_KEY=/i, '').trim();
    return token;
}

app.post('/api/ai-chat', async function (req, res) {
    const token = readGroqKey();
    if (!token) return res.status(503).json({ ok: false, error: 'На сервере не задан GROQ_API_KEY' });
    if (!token.startsWith('gsk_') || token.length < 30) {
        return res.status(503).json({ ok: false, error: 'В GROQ_API_KEY нужна строка gsk_… без кавычек' });
    }
    const incoming = Array.isArray(req.body && req.body.messages) ? req.body.messages.slice(-8) : [];
    const ctx = (req.body && req.body.context) || {};
    const clean = incoming
        .filter(function (m) { return m && (m.role === 'user' || m.role === 'assistant') && m.content; })
        .map(function (m) { return { role: m.role, content: String(m.content).slice(0, 2000) }; });
    if (!clean.length) return res.status(400).json({ ok: false, error: 'Пустой запрос' });
    const intro = 'Я искусственный интеллект VIP Community Pro для помощи по торговле в Pocket Option. Хочешь получить сигналы? Переходи в сканер котировок и начинай работать';
    const forecast = req.body && req.body.mode === 'forecast';
    const system = forecast
        ? [
            'Дай прогноз только на следующую минутную свечу. Не оценивай текущую незакрытую минуту.',
            'Первая строка обязана совпасть с полем direction: CALL или PUT. Не меняй сторону и не пиши, что сигнала нет.',
            'Вторая строка: вход на открытии следующей минуты, экспирация на её закрытии.',
            'Дальше одно короткое пояснение: зона Фибоначчи (низ — коррекция вверх, верх — коррекция вниз, середина — коррекция против импульса). Если четыре зелёные свечи подряд — продление вверх. Если четыре красные — продление вниз.',
            'Не обещай прибыль. Всегда выбирай CALL или PUT.',
            'Данные: ' + JSON.stringify({
                pair: ctx.pair || '',
                price: ctx.price || null,
                direction: ctx.direction || '',
                up: ctx.up == null ? null : ctx.up,
                down: ctx.down == null ? null : ctx.down,
                modelStrength: ctx.modelStrength == null ? null : ctx.modelStrength,
                level: ctx.level != null ? ctx.level : null,
                points: ctx.points || '',
                note: ctx.reason || '',
                closes: Array.isArray(ctx.closes) ? ctx.closes.slice(-8) : []
            })
        ].join('\n')
        : [
            'Ты помощник VIP Community. Отвечай по-русски, как в обычном разговоре, коротко и по вопросу.',
            'Если спрашивают кто ты, как тебя зовут, что ты такое или просят представиться, ответь дословно и больше ничего не добавляй: ' + intro,
            'На остальные вопросы отвечай как помощник. Не начинай с торгового сигнала и сам не говори про RSI, Фибоначчи и откуда входить.',
            'Если просят сигнал или прогноз по сделке, ответь: переходи в сканер котировок и начинай работать.'
        ].join('\n');
    try {
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                Authorization: 'Bearer ' + token,
                'Content-Type': 'application/json',
                'User-Agent': 'vip-community/1.0'
            },
            body: JSON.stringify({
                model: 'qwen/qwen3.8-27b',
                messages: [{ role: 'system', content: system }].concat(clean),
                max_tokens: 400,
                temperature: 0.2
            })
        });
        const data = await response.json().catch(function () { return {}; });
        if (!response.ok) {
            const detail = String((data.error && (data.error.message || data.error)) || 'Модель не ответила');
            return res.status(response.status).json({ ok: false, error: detail.slice(0, 300) });
        }
        const answer = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        if (!answer) return res.status(502).json({ ok: false, error: 'Пустой ответ модели' });
        return res.json({ ok: true, answer: answer });
    } catch (e) {
        return res.status(502).json({ ok: false, error: 'Нет связи с моделью' });
    }
});

app.post('/api/update-payouts', (req, res) => {
    const { data } = req.body;
    if (!data) return res.status(400).json({ success: false, error: 'data required' });

    currentPayouts = { status: "ONLINE", timestamp: Date.now(), categories: data };
    log('Данные выплат обновлены', 'MARKET');
    res.json({ success: true });
});

// ==================== LIVE NEWS ====================
let cachedNews = [];
let lastNewsUpdate = 0;
const NEWS_CACHE_TTL = 2 * 60 * 1000;

const RSS_FEEDS = [
    "https://news.google.com/rss/search?q=forex+OR+crypto+OR+stock+market+OR+binary+options&hl=ru&gl=RU&ceid=RU:ru",
    "https://www.investing.com/rss/news.rss"
];

async function refreshNewsCache(force = false) {
    const now = Date.now();
    if (!force && (now - lastNewsUpdate < NEWS_CACHE_TTL) && cachedNews.length > 0) return;

    try {
        const allNews = [];
        let idCounter = 1000;

        for (const feedUrl of RSS_FEEDS) {
            try {
                const feed = await parser.parseURL(feedUrl);
                feed.items.slice(0, 8).forEach(item => {
                    const pubDate = new Date(item.pubDate || Date.now());
                    const timeAgo = getTimeAgo(pubDate);
                    const content = ((item.title || "") + " " + (item.contentSnippet || "")).toLowerCase();

                    let category = "google";
                    if (content.includes("crypto") || content.includes("bitcoin") || content.includes("ethereum") || content.includes("solana")) category = "tv";
                    else if (content.includes("pocket option") || content.includes("binary option")) category = "pocket";

                    allNews.push({
                        id: idCounter++,
                        title: (item.title || "Без заголовка").substring(0, 115),
                        pair: "Рынок • Новости",
                        text: (item.contentSnippet || item.title || "").replace(/<[^>]+>/g, '').substring(0, 165) + "...",
                        source: feed.title || "Финансовые новости",
                        category,
                        time: timeAgo,
                        image: item.enclosure?.url || item.thumbnail || "https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?auto=format&fit=crop&w=600&q=80",
                        full: (item.contentSnippet || item.title || "").replace(/<[^>]+>/g, ''),
                        link: item.link || "#"
                    });
                });
            } catch (_) {}
        }

        if (allNews.length > 0) {
            cachedNews = allNews.slice(0, 18);
            lastNewsUpdate = now;
            log(`Кэш новостей обновлён: ${cachedNews.length} новостей`, 'NEWS');
        }
    } catch (err) {
        log(`Ошибка обновления новостей: ${err.message}`, 'ERROR');
    }
}

function getTimeAgo(date) {
    const diffMin = Math.floor((new Date() - date) / 60000);
    if (diffMin < 1) return "только что";
    if (diffMin < 60) return `${diffMin} мин назад`;
    const diffH = Math.floor(diffMin / 60);
    return diffH < 24 ? `${diffH} ч назад` : date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

app.get('/api/news', async (req, res) => {
    await refreshNewsCache();
    res.json({ success: true, lastUpdated: lastNewsUpdate, count: cachedNews.length, news: cachedNews });
});

app.post('/api/news/refresh', async (req, res) => {
    await refreshNewsCache(true);
    res.json({ success: true, lastUpdated: lastNewsUpdate, count: cachedNews.length, message: "Новости обновлены" });
});

// ==================== ЗАПУСК ====================
app.listen(PORT, async () => {
    log('==================================================', 'START');
    log(`VIP COMMUNITY PRO AI Backend запущен на порту ${PORT}`, 'START');
    log(`Supabase: ${supabaseEnabled ? 'ВКЛЮЧЁН' : 'ОТКЛЮЧЁН (работа в памяти)'}`, 'START');
    log('==================================================', 'START');

    await loadAllowedUsers();
    await loadVideoLessonsFromSupabase();
    await loadChatMessagesFromSupabase(); // ← ВАЖНО: загружаем историю чата при старте
    await refreshNewsCache(true);
    setInterval(() => refreshNewsCache(), NEWS_CACHE_TTL);
});

// Корректное завершение
process.once('SIGINT', () => { bot.stop('SIGINT'); log('Бот остановлен (SIGINT)', 'SHUTDOWN'); });
process.once('SIGTERM', () => { bot.stop('SIGTERM'); log('Бот остановлен (SIGTERM)', 'SHUTDOWN'); });
