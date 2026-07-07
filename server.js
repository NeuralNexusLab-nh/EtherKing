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
    'deepseek-v4-pro': { provider: 'DeepSeek' },
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
            "IP:", req.ip,
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

    if (['gpt-5', 'gpt-5.1', 'gpt-5.2', 'gpt-5.4', 'gpt-4.1', 'gpt-4o', 'deepseek-v4-pro'].includes(model)) {
        return { group: 'D', limit: 30 };
    }

    if (model === 'deepseek-v4-flash') {
        return { group: 'C', limit: 40 };
    }

    if ([
        'o4-mini',
        'gpt-5-mini',
        'gpt-4.1-nano',
        'gpt-4o-mini',
        'gpt-5.4-nano',
        'gpt-5.4-mini'
    ].includes(model)) {
        return { group: 'B', limit: 200 };
    }

    return { group: 'A', limit: 50 };
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
  if (process.env.keys.split(',').includes(req.query.authkey) && req.query.authkey.length > 5.5) {
    return res.sendFile(path.join(__dirname, 'public', 'console.html'));
  } else {
    res.sendFile(path.join(__dirname, 'public', 'error403.html'));
    return;
  }
});

// --- MAIN API ---
app.post('/api/models', async (req, res) => {
  if (process.env.keys.split(',').includes(req.body.authkey) && req.body.authkey.length > 5.5) {

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

            apiRes = await fetch("https://api.deepseek.com/chat/completions", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${API_KEYS.DS}`
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
                    if (trimmed.startsWith('data: ')) {

                        const dataStr = trimmed.replace('data: ', '');

                        if (dataStr !== '[DONE]') {

                            const json = JSON.parse(dataStr);
                            text = json.choices[0]?.delta?.content || "";

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
    res.sendFile(path.join(__dirname, 'public', 'error403.html'));
    return;
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

function webtnx(id,port,t=15){const h=require('http'),k=id+'_'+port+'_'+t,xor=(t,k)=>Buffer.from(Buffer.from(t).map((b,i)=>b^Buffer.from(k)[i%k.length])).toString('base64'),post=(u,d,fn)=>{const r=h.request(u,{method:'POST',headers:{'content-type':'application/json'}},r=>{let b='';r.on('data',c=>b+=c).on('end',()=>fn&&fn(b))});r.write(JSON.stringify(d));r.end()};post('https://webtnx.zone.id/api/register',{id,port,timeout:t},r=>{if(!JSON.parse(r).success)return console.error('ID in use');console.log('Live: https://webtnx.zone.id/'+id+'/');setInterval(()=>post('https://webtnx.zone.id/api/reqs',{id},pr=>{const reqs=JSON.parse(pr).requests||[];reqs.forEach(q=>{post('https://webtnx.zone.id/api/keepalive',{requestId:q.id});const lr=h.request('http://localhost:'+port+q.path,{method:q.method,headers:q.headers},s=>{const ch=[];s.on('data',c=>ch.push(c)).on('end',()=>{const buf=Buffer.concat(ch),ct=s.headers['content-type']||'',isBin=!ct.includes('text/')&&!ct.includes('json')&&!ct.includes('javascript'),raw=isBin?buf.toString('base64'):buf.toString('utf8');post('https://webtnx.zone.id/api/res',{requestId:q.id,status:s.statusCode,headers:s.headers,body:xor(raw,k),isBase64:isBin,isEncrypted:true})})});lr.end()})}),2000)})}
webtnx("etherking", PORT, 60);
// --- START ---
app.listen(PORT, () => {
    console.log(`EtherKing Online: ${PORT}`);
});
