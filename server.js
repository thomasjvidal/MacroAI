import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import bodyParser from 'body-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenerativeAI } from "@google/generative-ai";
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_FILE = path.join(__dirname, 'database.json');

// Helper DB
const readDB = () => {
    try {
        if (!fs.existsSync(DB_FILE)) return { profile: {}, meals: [], onboarding: {} };
        return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (e) {
        return { profile: {}, meals: [], onboarding: {} };
    }
};

const writeDB = (data) => {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
    } catch (e) {
        console.error('Erro ao salvar DB:', e);
    }
};

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;

// --- ENDPOINTS DE PERSISTÊNCIA (Sync) ---

// 1. Perfil
app.get('/api/profile', (req, res) => {
    const db = readDB();
    res.json(db.profile || {});
});

app.post('/api/profile', (req, res) => {
    const db = readDB();
    db.profile = { ...db.profile, ...req.body };
    writeDB(db);
    res.json({ success: true, profile: db.profile });
});

// 2. Onboarding
app.post('/api/onboarding', (req, res) => {
    const db = readDB();
    db.onboarding = req.body;
    // Também atualiza perfil básico se disponível
    if (req.body.data) {
        const d = req.body.data;
        db.profile = {
            ...db.profile,
            name: d.name || db.profile.name,
            email: d.email || db.profile.email,
            weight: d.weight || db.profile.weight,
            height: d.height || db.profile.height,
            age: d.age || db.profile.age,
            gender: d.gender || db.profile.gender,
            goal: d.goal || db.profile.goal
        };
    }
    writeDB(db);
    res.json({ success: true });
});

// 3. Refeições
app.get('/api/meals', (req, res) => {
    const db = readDB();
    res.json(db.meals || []);
});

app.post('/api/meals', (req, res) => {
    const db = readDB();
    db.meals = db.meals || [];
    
    let meal;
    if (req.body.id) {
        const index = db.meals.findIndex(m => m.id === req.body.id);
        if (index !== -1) {
            // Update existing
            db.meals[index] = { ...db.meals[index], ...req.body, timestamp: new Date().toISOString() };
            meal = db.meals[index];
        } else {
            // Create new with provided ID (rare but possible if syncing)
            meal = { ...req.body, timestamp: new Date().toISOString() };
            db.meals.unshift(meal);
        }
    } else {
        // Create new
        meal = { id: Date.now().toString(), ...req.body, timestamp: new Date().toISOString() };
        db.meals.unshift(meal);
    }

    // Manter apenas últimas 100
    if (db.meals.length > 100) db.meals = db.meals.slice(0, 100);
    writeDB(db);
    res.json({ success: true, meal });
});

// 4. Check-ins
app.get('/api/checkins', (req, res) => {
    const db = readDB();
    res.json(db.checkins || {});
});

app.post('/api/checkins', (req, res) => {
    const db = readDB();
    db.checkins = db.checkins || {};
    // Merge new checkins with existing
    db.checkins = { ...db.checkins, ...req.body };
    writeDB(db);
    res.json({ success: true });
});

// 5. Chat History
app.get('/api/chat/history', (req, res) => {
    const db = readDB();
    res.json(db.chatHistory || []);
});

app.post('/api/chat/history', (req, res) => {
    const db = readDB();
    // Expects array of messages or single message? Let's say full array for simplicity or sync
    // Or maybe append?
    // Let's replace for now as client holds source of truth for session
    db.chatHistory = req.body.messages || [];
    writeDB(db);
    res.json({ success: true });
});

// Endpoint para verificar status das chaves de API
app.get('/api/health', (req, res) => {
    res.json({
        status: 'online',
        providers: {
            gemini: !!process.env.GEMINI_API_KEY,
            openai: !!process.env.OPENAI_API_KEY,
            huggingface: !!process.env.HF_API_KEY
        }
    });
});

// Endpoint de Chat (Proxy para Gemini)
app.post('/api/chat', async (req, res) => {
    try {
        const { message, context, history } = req.body;
        const apiKey = process.env.GEMINI_API_KEY;

        if (!apiKey) {
            return res.status(401).json({ error: 'Chave Gemini não configurada no servidor (.env)' });
        }

        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

        let chatHistory = [];

        // System Prompt (Injected as context)
        const systemPrompt = `
You are the conversational engine of the app "Macro AI".
You are connected to the internal user data system.

USER DATA CONTEXT:
${JSON.stringify(context || {}, null, 2)}

Your job is to:
1. Detect user intent.
2. Fetch relevant internal data (provided above).
3. Generate contextual, data-driven responses.
4. Always prioritize user metrics before generic text.

Rules:
- If greeting: Respond with current contextual data summary.
- If suggest diet: Use remaining macros and favorite foods.
- If analyze: Generate consistency summary.
- Tone: Human, Direct, Motivational, Data-driven. No robotic responses.
- Language: Portuguese (Brazil).
        `;

        if (history && Array.isArray(history)) {
             chatHistory = history.map(h => ({
                 role: h.role === 'assistant' ? 'model' : 'user',
                 parts: [{ text: h.text }]
             }));
        }

        const chat = model.startChat({
            history: [
                { role: 'user', parts: [{ text: systemPrompt }] },
                { role: 'model', parts: [{ text: "Entendido. Estou conectado aos dados do usuário e pronto para responder como Coach." }] },
                ...chatHistory.slice(-10)
            ],
            generationConfig: {
                maxOutputTokens: 500,
                temperature: 0.7,
            },
        });

        const result = await chat.sendMessage(message);
        const response = result.response;
        const text = response.text();

        res.json({ text });

    } catch (error) {
        console.error('Chat Error:', error);
        res.status(500).json({ error: 'Erro ao processar mensagem', details: error.message });
    }
});

// Base de dados simples para fallback (Food101 labels -> Macros aproximados por 100g)
const FOOD_DB = {
    'pizza': { cal: 266, p: 11, c: 33, f: 10 },
    'hamburger': { cal: 295, p: 17, c: 24, f: 14 },
    'sushi': { cal: 140, p: 5, c: 28, f: 1 },
    'salad': { cal: 30, p: 1, c: 4, f: 0 },
    'steak': { cal: 271, p: 26, c: 0, f: 19 },
    'chicken_wings': { cal: 203, p: 30, c: 0, f: 8 },
    'spaghetti_bolognese': { cal: 150, p: 7, c: 20, f: 5 },
    'chocolate_cake': { cal: 371, p: 5, c: 53, f: 15 },
    'default': { cal: 150, p: 10, c: 15, f: 5 }
};

app.get('/api/foods', (req, res) => {
    res.json(FOOD_DB);
});

// Workouts Database
const WORKOUTS_DB = {
    'chest-triceps': {
        title: 'Peito & Tríceps',
        subtitle: '4 séries • 8-12 reps',
        exercises: [
            { name: 'Supino Reto', sets: 4, reps: '8-12', weight: 60, done: false },
            { name: 'Supino Inclinado Halteres', sets: 3, reps: '10-12', weight: 24, done: false },
            { name: 'Crucifixo Máquina', sets: 3, reps: '12-15', weight: 40, done: false },
            { name: 'Tríceps Corda', sets: 4, reps: '12-15', weight: 20, done: false },
            { name: 'Tríceps Francês', sets: 3, reps: '10-12', weight: 18, done: false }
        ]
    },
    'back-biceps': {
        title: 'Costas & Bíceps',
        subtitle: '4 séries • 8-12 reps',
        exercises: [
            { name: 'Puxada Frente', sets: 4, reps: '8-12', weight: 50, done: false },
            { name: 'Remada Curvada', sets: 4, reps: '8-10', weight: 60, done: false },
            { name: 'Pulldown', sets: 3, reps: '12-15', weight: 25, done: false },
            { name: 'Rosca Direta', sets: 4, reps: '10-12', weight: 15, done: false },
            { name: 'Rosca Martelo', sets: 3, reps: '12', weight: 14, done: false }
        ]
    },
    'legs-shoulders': {
        title: 'Pernas & Ombros',
        subtitle: '4 séries • 10-15 reps',
        exercises: [
            { name: 'Agachamento Livre', sets: 4, reps: '8-10', weight: 80, done: false },
            { name: 'Leg Press 45', sets: 4, reps: '10-12', weight: 120, done: false },
            { name: 'Cadeira Extensora', sets: 3, reps: '12-15', weight: 50, done: false },
            { name: 'Desenvolvimento Militar', sets: 4, reps: '8-12', weight: 40, done: false },
            { name: 'Elevação Lateral', sets: 3, reps: '15', weight: 12, done: false }
        ]
    }
};

app.get('/api/workouts', (req, res) => {
    res.json(WORKOUTS_DB);
});


app.post('/api/analyze-image', async (req, res) => {
    try {
        let { image, audio, apiKey, provider, endpoint } = req.body;

        // Prioriza chaves do ambiente se não fornecidas pelo cliente
        if (!apiKey) {
            if (provider === 'openai') apiKey = process.env.OPENAI_API_KEY;
            else if (provider === 'gemini') apiKey = process.env.GEMINI_API_KEY;
            else if (provider === 'huggingface') apiKey = process.env.HF_API_KEY;

            // Auto-detecção
            if (!provider) {
                if (process.env.GEMINI_API_KEY) {
                    provider = 'gemini';
                    apiKey = process.env.GEMINI_API_KEY;
                } else if (process.env.OPENAI_API_KEY) {
                    provider = 'openai';
                    apiKey = process.env.OPENAI_API_KEY;
                } else {
                    provider = 'huggingface';
                    apiKey = process.env.HF_API_KEY;
                }
            }
        }

        console.log(`Analisando com ${provider}...`);

        // --- GOOGLE GEMINI (Grátis e Inteligente) ---
        if (provider === 'gemini') {
            if (!apiKey) throw new Error('Chave Gemini não configurada (.env)');

            const genAI = new GoogleGenerativeAI(apiKey);
            // Gemini 1.5 Flash é ótimo para multimodais e rápido
            let modelName = "gemini-1.5-flash";
            let model = genAI.getGenerativeModel({ model: modelName });

            let prompt = 'Você é um nutricionista. Analise a imagem e identifique os alimentos, estime o peso (em gramas) e calcule calorias e macros. Retorne APENAS um JSON: {"items":[{"name":"Alimento","grams":100,"calories":0,"protein":0,"carbs":0,"fat":0}],"confidence":0.9}';

            const parts = [];

            if (audio) {
                if (req.body.search) {
                    prompt = 'Você é um nutricionista. Analise o áudio. Se o usuário listou vários alimentos (ex: "arroz, feijão e frango"), identifique cada um deles separadamente com seus macros estimados para uma porção média. Se o usuário falou apenas um alimento genérico (ex: "maçã"), forneça 3 a 5 variações ou tamanhos comuns. Retorne APENAS um JSON: {"options":[{"name":"Nome do Alimento","grams":100,"calories":0,"protein":0,"carbs":0,"fat":0}]}.';
                } else {
                    prompt = 'Você é um nutricionista. Analise o áudio com a descrição da refeição. Identifique os alimentos mencionados, estime o peso (em gramas) se não especificado (use porções médias), e calcule calorias e macros. Retorne APENAS um JSON: {"items":[{"name":"Alimento","grams":100,"calories":0,"protein":0,"carbs":0,"fat":0}],"confidence":0.9}';
                }
                parts.push(prompt);

                parts.push({
                    inlineData: {
                        data: audio,
                        mimeType: "audio/webm"
                    }
                });
            } else if (image) {
                // Remove header do base64 se existir
                const base64Data = image.includes('base64,') ? image.split('base64,')[1] : image;
                parts.push(prompt);
                parts.push({
                    inlineData: {
                        data: base64Data,
                        mimeType: "image/jpeg"
                    }
                });
            } else {
                throw new Error('Nenhuma imagem ou áudio fornecido.');
            }

            let result;
            try {
                result = await model.generateContent(parts);
            } catch (e) {
                console.log(`Erro com ${modelName}: ${e.message}`);

                // Fallback strategies logic retained if needed, but simplified for brevity
                // If 1.5 fails, we might try pro or earlier versions, but 1.5 is standard now.
                if (e.message.includes('404') || e.message.includes('not found')) {
                    const fallback = "gemini-1.5-flash";
                    console.log(`Tentando fallback ${fallback}`);
                    const model2 = genAI.getGenerativeModel({ model: fallback });
                    result = await model2.generateContent(parts);
                } else {
                    throw e;
                }
            }

            const response = await result.response;
            const text = response.text();

            const cleanText = text.replace(/```json/g, '').replace(/```/g, '').trim();
            return res.json({ provider: 'gemini', result: JSON.parse(cleanText) });
        }

        // --- OPENAI / COMPATIBLE ---
        if (provider === 'openai' || provider === 'custom') {
            if (!apiKey) throw new Error('Chave de API não configurada no servidor (.env)');

            const apiUrl = endpoint || 'https://api.openai.com/v1/chat/completions';
            const model = provider === 'openai' ? 'gpt-4o-mini' : (req.body.model || 'gpt-3.5-turbo');

            const payload = {
                model: model,
                messages: [
                    {
                        role: 'system',
                        content: 'Você é um nutricionista expert. Identifique os alimentos na imagem, estime o peso em gramas visualmente e calcule as calorias e macros. Retorne APENAS um JSON estrito com o seguinte formato, sem markdown ou explicações: {"items":[{"name":"nome do alimento","grams":150,"calories":200,"protein":30,"carbs":10,"fat":5}],"confidence":0.95}'
                    },
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: 'Analise este prato.' },
                            { type: 'image_url', image_url: { url: image } }
                        ]
                    }
                ],
                max_tokens: 500,
                temperature: 0.1
            };

            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                const errText = await response.text();
                throw new Error(`Erro API ${provider}: ${response.status} - ${errText}`);
            }

            const json = await response.json();
            const content = json.choices?.[0]?.message?.content || '{}';
            const cleanContent = content.replace(/```json/g, '').replace(/```/g, '').trim();

            return res.json({
                provider: provider,
                result: JSON.parse(cleanContent)
            });
        }

        // --- HUGGING FACE (Fallback) ---
        console.log('Usando fallback Hugging Face...');
        const headers = {
            'Content-Type': 'application/json',
            ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {})
        };

        // Classificação Food101
        const clsRes = await fetch('https://api-inference.huggingface.co/models/nateraw/food101', {
            method: 'POST',
            headers,
            body: JSON.stringify({ inputs: image })
        });

        let items = [];
        let confidence = 0.5;

        if (clsRes.ok) {
            const classification = await clsRes.json().catch(() => []);
            // Pega o top 3
            const top3 = Array.isArray(classification) ? classification.slice(0, 3) : [];

            if (top3.length > 0) {
                confidence = top3[0].score;
                items = top3.map(item => {
                    const label = item.label;
                    // Tenta achar macros aproximados ou usa default
                    const ref = Object.entries(FOOD_DB).find(([k]) => label.includes(k))?.[1] || FOOD_DB.default;
                    const grams = 100; // Estimativa padrão

                    return {
                        name: label.replace(/_/g, ' '),
                        grams: grams,
                        calories: Math.round(ref.cal * (grams / 100)),
                        protein: Math.round(ref.p * (grams / 100)),
                        carbs: Math.round(ref.c * (grams / 100)),
                        fat: Math.round(ref.f * (grams / 100))
                    };
                });
            }
        } else {
            console.warn('HF Food101 falhou, tentando apenas caption...');
        }

        // Se não conseguiu nada com Food101, tenta captioning para pelo menos dar um nome
        if (items.length === 0) {
            const blipRes = await fetch('https://api-inference.huggingface.co/models/Salesforce/blip-image-captioning-large', {
                method: 'POST',
                headers,
                body: JSON.stringify({ inputs: image })
            });

            if (blipRes.ok) {
                const blipJson = await blipRes.json();
                const text = Array.isArray(blipJson) ? blipJson[0]?.generated_text : blipJson?.generated_text;
                if (text) {
                    items.push({
                        name: text,
                        grams: 100,
                        ...FOOD_DB.default
                    });
                }
            }
        }

        if (items.length === 0) {
            throw new Error('Não foi possível identificar alimentos na imagem.');
        }

        res.json({
            provider: 'huggingface',
            result: {
                items: items,
                confidence: confidence
            }
        });

    } catch (error) {
        console.error('Erro no proxy:', error);
        res.status(500).json({ error: error.message });
    }
});

// --- WORKOUT PROGRESS ENDPOINTS ---
app.get('/api/workouts/progress', (req, res) => {
    const db = readDB();
    res.json(db.workoutProgress || {});
});

app.post('/api/workouts/progress', (req, res) => {
    const db = readDB();
    // Merge new progress with existing
    // Structure: { "2023-10-27": { "chest-triceps": { "exercise-0": { sets: [...] } } } }
    db.workoutProgress = db.workoutProgress || {};
    
    // Deep merge or just replace keys? 
    // Since we likely send the whole day's progress or specific updates, let's merge at top level
    Object.keys(req.body).forEach(date => {
        db.workoutProgress[date] = { 
            ...(db.workoutProgress[date] || {}), 
            ...req.body[date] 
        };
    });
    
    writeDB(db);
    res.json({ success: true });
});

// Exporta o app para Vercel (serverless)
export default app;

// Inicia servidor apenas se não estiver em ambiente serverless (Vercel)
if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => {
        console.log(`Servidor rodando em http://localhost:${PORT}`);
    });
}
