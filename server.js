// server.js (FINAL: Edge + Auth + Resend + Admin Key Security)
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const mongoose = require('mongoose');
const https = require('https');
const dns = require('node:dns');
const net = require('net'); 
const { Resend } = require('resend');
const bcrypt = require('bcryptjs'); 
const jwt = require('jsonwebtoken'); 

// 1. Force IPv4 (Critical for stability)
dns.setDefaultResultOrder('ipv4first');

require('dotenv').config();

console.log("------------------------------------------------");
console.log("🚀 VERSION: FINAL SECURE (AUTH + EDGE + KEY CHECK)");
console.log("------------------------------------------------");

// 🔥 CONFIG
const EDGE_MONITORS = ["slpost", "Finger print", "MORS", "mms"]; 
const JWT_SECRET = process.env.JWT_SECRET || "change-this-to-something-secret";
const ADMIN_SECRET = process.env.ADMIN_SECRET_KEY || "nuwan-secure-2026"; // 🔒 The Master Key

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(express.json());
app.use(cors({
  origin: process.env.FRONTEND_URL || "*", 
  credentials: true
}));

// Database
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch(err => console.error('❌ MongoDB Connection Error:', err));

// --- SCHEMAS ---
const UserSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true }
});

const MonitorSchema = new mongoose.Schema({
  name: String,
  url: String,
  status: { type: String, default: 'unknown' },
  lastChecked: Date,
  downSince: Date, 
  alertSent: { type: Boolean, default: false },
  history: [{ status: String, timestamp: { type: Date, default: Date.now } }]
});

const SubscriberSchema = new mongoose.Schema({
  email: { type: String, unique: true, required: true }
});

const User = mongoose.model('User', UserSchema);
const Monitor = mongoose.model('Monitor', MonitorSchema);
const Subscriber = mongoose.model('Subscriber', SubscriberSchema);
const resend = new Resend(process.env.RESEND_API_KEY);

// --- 🔒 MIDDLEWARE: PROTECT ROUTES ---
const auth = (req, res, next) => {
  const token = req.header('x-auth-token');
  if (req.path === '/api/edge-update') return next();
  if (!token) return res.status(401).json({ msg: 'No token, authorization denied' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (e) {
    res.status(400).json({ msg: 'Token is not valid' });
  }
};

// --- AUTH ROUTES ---

// 1. Register (SECURED WITH ADMIN KEY)
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, adminKey } = req.body; // <--- 1. Get Key

    // 🔒 2. Check Key
    if (adminKey !== ADMIN_SECRET) {
        return res.status(403).json({ msg: "Invalid Admin Secret Key. Registration Denied." });
    }

    let user = await User.findOne({ email });
    if (user) return res.status(400).json({ msg: 'User already exists' });

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    user = new User({ email, password: hashedPassword });
    await user.save();

    const token = jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: '1h' });
    res.json({ token, user: { id: user._id, email: user.email } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 2. Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ msg: 'User does not exist' });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ msg: 'Invalid credentials' });

    const token = jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, user: { id: user._id, email: user.email } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- HELPERS ---
function checkTcp(targetUrl) {
    return new Promise((resolve) => {
        try {
            const cleanUrl = targetUrl.startsWith('http') ? targetUrl : `http://${targetUrl}`;
            const parsed = new URL(cleanUrl);
            const socket = new net.Socket();
            socket.setTimeout(5000); 
            socket.connect(parsed.port || (cleanUrl.startsWith('https')?443:80), parsed.hostname, () => { socket.end(); resolve(true); });
            socket.on('error', () => { socket.destroy(); resolve(false); });
            socket.on('timeout', () => { socket.destroy(); resolve(false); });
        } catch (e) { resolve(false); }
    });
}

async function sendAlert(monitor, status) {
  const subscribers = await Subscriber.find();
  if (subscribers.length === 0) return;
  const isUp = status === 'up';
  const subject = isUp ? `✅ RECOVERY: ${monitor.name}` : `🚨 ALERT: ${monitor.name} is DOWN`;
  const text = isUp ? `Service "${monitor.name}" is back online.` : `Service "${monitor.name}" is DOWN.`;
  try {
    await resend.emails.send({
      from: 'onboarding@resend.dev', to: subscribers.map(s => s.email), subject, text
    });
  } catch (err) { console.error("Email Error:", err.message); }
}

async function updateMonitorStatus(monitor, currentStatus) {
    if (monitor.status !== currentStatus) {
        monitor.status = currentStatus;
        monitor.history.push({ status: currentStatus, timestamp: new Date() });
        if (monitor.history.length > 500) monitor.history.shift();

        if (currentStatus === 'down') {
          monitor.downSince = new Date();
          monitor.alertSent = false;
        } else {
          monitor.downSince = null;
          if (monitor.alertSent) await sendAlert(monitor, 'up');
          monitor.alertSent = false;
        }
    }
    if (currentStatus === 'down' && monitor.downSince && !monitor.alertSent) {
        const minutesDown = (new Date() - new Date(monitor.downSince)) / 60000;
        if (minutesDown >= 2) {
          monitor.alertSent = true;
          await monitor.save(); 
          await sendAlert(monitor, 'down');
        }
    }
    monitor.lastChecked = new Date();
    await monitor.save();
}

// --- CLOUD MONITOR LOOP ---
async function checkMonitors() {
  const monitors = await Monitor.find();
  const httpsAgent = new https.Agent({ rejectUnauthorized: false });

  for (const monitor of monitors) {
    try {
      if (EDGE_MONITORS.includes(monitor.name)) continue; 
      let currentStatus = 'down';
      try {
        await axios.get(monitor.url, { timeout: 5000, httpsAgent, headers: { 'User-Agent': 'UptimeBot/1.0' } });
        currentStatus = 'up'; 
      } catch (httpError) {
        if (await checkTcp(monitor.url)) currentStatus = 'up';
      }
      await updateMonitorStatus(monitor, currentStatus);
    } catch (err) { /* ignore */ }
  }
}
setInterval(checkMonitors, 60000);

// --- ROUTES ---
app.get('/', (req, res) => res.send('Uptime Monitor is Running 🟢'));
app.get('/monitors', async (req, res) => res.json(await Monitor.find()));
app.get('/subscribers', async (req, res) => res.json(await Subscriber.find()));
app.post('/api/edge-update', async (req, res) => {
    try {
        const { name, status } = req.body; 
        const monitor = await Monitor.findOne({ name });
        if (!monitor) return res.status(404).json({ error: "Monitor not found" });
        await updateMonitorStatus(monitor, status);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 🔒 PROTECTED
app.post('/monitors', auth, async (req, res) => { 
  try {
    const { name, url } = req.body;
    const newMonitor = new Monitor({ name, url, status: 'unknown', history: [] });
    await newMonitor.save();
    res.json(newMonitor);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/monitors/:id', auth, async (req, res) => {
  await Monitor.findByIdAndDelete(req.params.id);
  res.json({ message: 'Deleted' });
});

app.delete('/subscribers', auth, async (req, res) => {
    try {
        const { email } = req.body;
        await Subscriber.deleteOne({ email });
        res.json({ message: 'Deleted subscriber' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/subscribers', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !email.includes('@')) return res.status(400).json({error: 'Invalid email'});
    await Subscriber.updateOne({ email }, { email }, { upsert: true });
    res.json({ message: 'Subscribed' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/test-email', async (req, res) => {
    try {
        const { data, error } = await resend.emails.send({
            from: 'onboarding@resend.dev', to: 'your-email@gmail.com', subject: 'Test', text: 'It works!'
        });
        if (error) return res.status(500).json({ error });
        res.json({ success: true, data });
    } catch (e) { res.status(500).json({ error: e.message }); } 
});

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server running on port ${PORT}`));