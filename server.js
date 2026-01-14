// server.js (FINAL: Edge + Auth + Resend)
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const mongoose = require('mongoose');
const https = require('https');
const dns = require('node:dns');
const net = require('net'); 
const { Resend } = require('resend');
const bcrypt = require('bcryptjs'); // ✅ NEW: For Password Hashing
const jwt = require('jsonwebtoken'); // ✅ NEW: For Login Tokens

// 1. Force IPv4 (Critical for stability)
dns.setDefaultResultOrder('ipv4first');

require('dotenv').config();

console.log("------------------------------------------------");
console.log("🚀 VERSION: FINAL (AUTH + EDGE + RESEND)");
console.log("------------------------------------------------");

// 🔥 CONFIG: Edge Monitors (Handled by Laptop)
const EDGE_MONITORS = ["slpost", "Finger print", "MORS", "mms"]; 
const JWT_SECRET = process.env.JWT_SECRET || "change-this-to-something-secret";

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

// 1. ✅ User Schema (For Login)
const UserSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true }
});

// 2. Monitor Schema
const MonitorSchema = new mongoose.Schema({
  name: String,
  url: String,
  status: { type: String, default: 'unknown' },
  lastChecked: Date,
  downSince: Date, 
  alertSent: { type: Boolean, default: false },
  history: [{
    status: String,
    timestamp: { type: Date, default: Date.now }
  }]
});

// 3. Subscriber Schema
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
  
  // Allow Edge Node updates without user token
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

// 1. Register (Use this once to create your account)
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password } = req.body;
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
            const host = parsed.hostname;
            const port = parsed.port || (cleanUrl.startsWith('https') ? 443 : 80);

            const socket = new net.Socket();
            socket.setTimeout(5000); 

            socket.connect(port, host, () => {
                socket.end();
                resolve(true); 
            });

            socket.on('error', () => { socket.destroy(); resolve(false); });
            socket.on('timeout', () => { socket.destroy(); resolve(false); });

        } catch (e) { resolve(false); }
    });
}

async function sendAlert(monitor, status) {
  const subscribers = await Subscriber.find();
  if (subscribers.length === 0) return;

  const isUp = status === 'up';
  const subject = isUp 
    ? `✅ RECOVERY: ${monitor.name} is Back Online`
    : `🚨 ALERT: ${monitor.name} is DOWN`;
  
  const text = isUp
    ? `Great news! The service "${monitor.name}" (${monitor.url}) has recovered and is back online.`
    : `The service "${monitor.name}" (${monitor.url}) has been down for over 2 minutes. Please investigate.`;

  console.log(`📧 Sending '${status}' alert via Resend to ${subscribers.length} subscribers...`);

  try {
    const { data, error } = await resend.emails.send({
      from: 'onboarding@resend.dev', 
      to: subscribers.map(s => s.email), 
      subject: subject,
      text: text
    });
    if (error) console.error("❌ Resend API Error:", error);
    else console.log(`✅ Alert sent successfully! ID: ${data.id}`);
  } catch (err) {
    console.error("❌ Critical Email Error:", err.message);
  }
}

async function updateMonitorStatus(monitor, currentStatus) {
    if (monitor.status !== currentStatus) {
        console.log(`🔄 ${monitor.name} changed to ${currentStatus}`);
        
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

    // 2-MINUTE ALERT LOGIC
    if (currentStatus === 'down' && monitor.downSince && !monitor.alertSent) {
        const minutesDown = (new Date() - new Date(monitor.downSince)) / 60000;
        if (minutesDown > 0.5) console.log(`⏳ ${monitor.name} down for ${minutesDown.toFixed(1)} mins...`);
        
        if (minutesDown >= 2) {
          console.log(`🚀 2 Minutes Reached! Sending Alert for ${monitor.name}`);
          monitor.alertSent = true;
          await monitor.save(); 
          await sendAlert(monitor, 'down');
        }
    }

    monitor.lastChecked = new Date();
    await monitor.save();
}

// --- SMART MONITORING LOOP (CLOUD) ---
async function checkMonitors() {
  const monitors = await Monitor.find();
  const httpsAgent = new https.Agent({ rejectUnauthorized: false });

  for (const monitor of monitors) {
    try {
      // 🛑 SKIP EDGE MONITORS (Your laptop handles these)
      if (EDGE_MONITORS.includes(monitor.name)) continue; 

      let currentStatus = 'down';

      // STEP 1: HTTP Check
      try {
        await axios.get(monitor.url, { 
          timeout: 5000, 
          httpsAgent: httpsAgent, 
          headers: { 'User-Agent': 'UptimeBot/1.0' }
        });
        currentStatus = 'up'; 
      } catch (httpError) {
        // STEP 2: TCP Fallback
        const isPortOpen = await checkTcp(monitor.url);
        if (isPortOpen) {
            console.log(`⚠️ HTTP failed for ${monitor.name}, but TCP is OPEN. Marking UP.`);
            currentStatus = 'up';
        } else {
            currentStatus = 'down';
        }
      }

      await updateMonitorStatus(monitor, currentStatus);

    } catch (err) {
      if (err.name === 'DocumentNotFoundError') {
        console.log(`⚠️ Skipped saving "${monitor.name}" because it was deleted.`);
      } else {
        console.error(`❌ Unexpected error for ${monitor.name}:`, err.message);
      }
    }
  }
}

// Run check every 60 seconds
setInterval(checkMonitors, 60000);

// --- ROUTES ---

// Public Route (View Only)
app.get('/', (req, res) => res.send('Uptime Monitor is Running 🟢'));

app.get('/monitors', async (req, res) => {
  try {
    const monitors = await Monitor.find();
    res.json(monitors);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/subscribers', async (req, res) => {
  try {
    const subscribers = await Subscriber.find();
    res.json(subscribers);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Edge Node Route (No Auth Required)
app.post('/api/edge-update', async (req, res) => {
    try {
        const { name, status } = req.body; 
        
        const monitor = await Monitor.findOne({ name });
        if (!monitor) return res.status(404).json({ error: "Monitor not found" });

        console.log(`🔌 Edge Node Reported: ${name} is ${status.toUpperCase()}`);
        await updateMonitorStatus(monitor, status);
        
        res.json({ success: true });
    } catch (e) {
        console.error("Edge Update Error:", e);
        res.status(500).json({ error: e.message });
    }
});

// 🔒 PROTECTED ROUTES (Require Login)
app.post('/monitors', auth, async (req, res) => { // <--- 'auth' middleware added
  try {
    const { name, url } = req.body;
    const newMonitor = new Monitor({ name, url, status: 'unknown', history: [] });
    await newMonitor.save();
    res.json(newMonitor);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/monitors/:id', auth, async (req, res) => { // <--- 'auth' middleware added
  await Monitor.findByIdAndDelete(req.params.id);
  res.json({ message: 'Deleted' });
});

app.delete('/subscribers', auth, async (req, res) => { // <--- 'auth' middleware added
    try {
        const { email } = req.body;
        await Subscriber.deleteOne({ email });
        res.json({ message: 'Deleted subscriber' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Public Route for Subscription (Anyone can subscribe)
app.post('/subscribers', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !email.includes('@')) return res.status(400).json({error: 'Invalid email'});
    await Subscriber.updateOne({ email }, { email }, { upsert: true });
    res.json({ message: 'Subscribed' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Test Email Route
app.get('/api/test-email', async (req, res) => {
    try {
        console.log("🧪 Starting Resend Test...");
        const { data, error } = await resend.emails.send({
            from: 'onboarding@resend.dev',
            to: 'your-email@gmail.com', 
            subject: 'Test from Resend',
            text: 'It works! 🎉'
        });
        if (error) {
            console.error("❌ Resend Error:", error);
            return res.status(500).json({ error });
        }
        console.log("✅ Resend Success:", data);
        res.json({ success: true, data });
    } catch (e) {
        res.status(500).json({ error: e.message });
    } 
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
});