// --- MODULE IMPORTS ---
const express = require('express');
const fs = require('fs');
const path = require('path');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');

const app = express();
app.set('trust proxy', true);

// --- CONFIG ---
const PORT = process.env.PORT || 3000;

const RLD_FILE = path.join(__dirname, 'rld.json');
const SAVED_DIR = path.join(__dirname, 'saved');
const SAVED_CHATS_FILE = path.join(SAVED_DIR, 'chats.json');

const API_KEYS = {
    OA: process.env.OAAPI || "",
    DS: process.env.DSAPI || ""
};

// --- MODEL REGISTRY ---
const MODEL_REGISTRY = {
    // DeepSeek
    'deepseek-v4-flash': { provider: 'DeepSeek' },
    // OpenAI
    'gpt-4o': { provider: 'OpenAI'},
    'gpt-4.1': { provider: 'OpenAI'},
    'gpt-5-nano': { provider: 'OpenAI', flex: true },
    'gpt-4o-mini': { provider: 'OpenAI' },
    'gpt-4.1-nano': { provider: 'OpenAI' },
    'gpt-5-mini': { provider: 'OpenAI', flex: true },
    'gpt-5': { provider: 'OpenAI', flex: true },
    'gpt-5.1': { provider: 'OpenAI', flex: true },
    'gpt-5.2': { provider: 'OpenAI', flex: true },
    'o4-mini': { provider: 'OpenAI', flex: true },
    'gpt-5.4': { provider: 'OpenAI', flex: true },
    'gpt-5.4-nano': { provider: 'OpenAI', flex: true },
    'gpt-5.4-mini': { provider: 'OpenAI', flex: true }

};

// --- FILE INIT ---
if (!fs.existsSync(RLD_FILE)) {
    fs.writeFileSync(RLD_FILE, JSON.stringify({}));
}

if (!fs.existsSync(SAVED_DIR)) {
    fs.mkdirSync(SAVED_DIR);
}

if (!fs.existsSync(SAVED_CHATS_FILE)) {
    fs.writeFileSync(SAVED_CHATS_FILE, JSON.stringify({}));
}

// --- MIDDLEWARE ---
app.use(bodyParser.json({ limit: "1mb" }));

app.use(express.static(path.join(__dirname, 'public')));

// --- DEBUG LOG ---
app.use((req, res, next) => {
    try {
        console.log(
            "PATH:", req.path,
            "UA:", req.headers["user-agent"],
            "BODY:", JSON.stringify(req.body || {})
        );
    } catch {}
    next();
});

// --- SECURITY HEADERS ---
app.use((req, res, next) => {

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');

    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }

    next();
});

// --- RATE LIMIT GROUP ---
const getModelGroup = (model) => {

    if (['gpt-5', 'gpt-5.1', 'gpt-5.2', 'gpt-5.4', 'gpt-4.1', 'gpt-4o'].includes(model)) {
        return { group: 'D', limit: 45 };
    }

    if (model === 'deepseek-v4-flash') {
        return { group: 'C', limit: 80 };
    }

    if ([
        'o4-mini',
        'gpt-5-mini',
        'gpt-4.1-nano',
        'gpt-4o-mini',
        'gpt-5.4-nano',
        'gpt-5.4-mini'
    ].includes(model)) {
        return { group: 'B', limit: 150 };
    }

    return { group: 'A', limit: 80 };
};

// --- DAILY LIMIT STORAGE ---
let rlQueue = Promise.resolve();

function todayKey() {
    return new Date().toISOString().slice(0, 10);
}

async function checkDailyLimit(model) {

    return new Promise((resolve) => {

        rlQueue = rlQueue.then(() => {

            let data = {};

            try {
                data = JSON.parse(fs.readFileSync(RLD_FILE));
            } catch {
                data = {};
            }

            const today = todayKey();
            const { group, limit } = getModelGroup(model);

            if (!data[today]) data[today] = {};
            if (!data[today][group]) data[today][group] = 0;

            if (data[today][group] >= limit) {
                resolve(false);
                return;
            }

            data[today][group]++;

            fs.writeFileSync(RLD_FILE, JSON.stringify(data));

            resolve(true);

        });

    });

}

// --- ROUTES ---
app.get('/', (req, res) => {
    return res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/console', (req, res) => {
  if (process.env.keys.includes(req.query.authkey) && req.query.authkey.length > 4.5) {
    return res.sendFile(path.join(__dirname, 'public', 'console.html'));
  } else {
    return res.send("ERROR 403");
  }
});

// --- MAIN API ---
app.post('/api/models', async (req, res) => {
  if (process.env.keys.includes(req.body.authkey) && req.body.authkey.length > 4.5) {

    try {

        const model = req.body.model || "none";

        const { messages } = req.body || {};
        const config = MODEL_REGISTRY[model];

        if (!config) {
            return res.status(400).json({ error: "Invalid model" });
        }

        // --- DAILY LIMIT ---
        const allowed = await checkDailyLimit(model);

        if (!allowed) {
            return res.status(429).send("Daily model group limit reached.");
        }

        const recentMessages = (messages || [])
            .slice(-6)
            .map(m => ({
                role: m.role === 'ai' ? 'assistant' : m.role,
                content: m.content
            }));

        // --- FETCH MODEL ---
        let apiRes;

        if (config.provider === "DeepSeek") {

            apiRes = await fetch("https://https://api.deepseek.com/chat/completions", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${API_KEYS.OA}`
                },
                body: JSON.stringify({
                    model,
                    messages: recentMessages,
                    stream: true,
                    thinking: {"type": "disabled"},
                    max_tokens: 10000
                })
            });

        } else {

            const isFlex = config.flex === true;

            apiRes = await fetch("https://api.openai.com/v1/chat/completions", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${API_KEYS.OA}`
                },
                body: JSON.stringify({
                    model,
                    messages: recentMessages,
                    stream: true,
                    service_tier: isFlex ? "flex" : "default",
                    max_completion_tokens: 10000
                })
            });

        }

        if (!apiRes.ok) {
            const text = await apiRes.text();
            return res.status(apiRes.status).send(text);
        }

        // --- STREAM RESPONSE ---
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Transfer-Encoding', 'chunked');

        let buffer = "";

        for await (const chunk of apiRes.body) {

            const lines = (buffer + chunk.toString()).split('\n');
            buffer = lines.pop();

            for (const line of lines) {

                const trimmed = line.trim();
                if (!trimmed) continue;

                try {

                    let text = "";

                    if (config.provider === "Ollama") {

                        const json = JSON.parse(trimmed);

                        if (json.message?.content) {
                            text = json.message.content;
                        }

                    } else {

                        if (trimmed.startsWith('data: ')) {

                            const dataStr = trimmed.replace('data: ', '');

                            if (dataStr !== '[DONE]') {

                                const json = JSON.parse(dataStr);
                                text = json.choices[0]?.delta?.content || "";

                            }
                        }

                    }

                    if (text) res.write(text);

                } catch {}

            }

        }

        return res.end();

    } catch (err) {

        console.error("Stream Error:", err);

        if (!res.headersSent) {
            return res.status(500).send("Internal server error");
        }

        res.write("\n[System Error: Connection interrupted]");
        return res.end();

    }
  } else {
    return res.send("ERROR 403");
  }
});

// --- ROBOTS ---
app.get(['/robots.txt','/Robots.txt','/robot.txt'], (req,res)=>{
    return res.sendFile(path.join(__dirname,"public","robots.txt"));
});

// --- FALLBACK ---
app.all("*", (req, res) => {
    return res.redirect("/");
});

// --- START ---
app.listen(PORT, () => {
    console.log(`EtherKing Online: ${PORT}`);
});
