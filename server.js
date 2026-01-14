// server.js (FINAL: Edge + Auth + Admin Key + MULTI-USER EMAILS)
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

// 1. Force IPv4
dns.setDefaultResultOrder('ipv4first');

require('dotenv').config();

console.log("------------------------------------------------");
console.log("🚀 VERSION: FINAL (MULTI-RESEND ACCOUNT SUPPORT)");
console.log("------------------------------------------------");

// 🔥 CONFIG
const EDGE_MONITORS = ["slpost", "Finger print", "MORS", "mms"]; 
const JWT_SECRET = process.env.JWT_SECRET || "change-this-to-something-secret";
const ADMIN_SECRET = process.env.ADMIN_SECRET_KEY || "nuwan-secure-2026"; 
const SUPER_ADMIN_EMAIL = "m.nuwan245@gmail.com"; 

// 📧 EMAIL MAPPING CONFIGURATION
// ⚠️ YOU MUST UPDATE THIS LIST EVERY TIME YOU ADD A NEW FREE SUBSCRIBER
const EMAIL_KEYS = {
    // "Subscriber Email" : process.env.THEIR_KEY
    "m.nuwan245@gmail.com": process.env.RESEND_API_KEY_MAIN, 
    "ssanetwork@slpost.lk": process.env.RESEND_API_KEY_FRIEND // <--- CHANGE THIS TO REAL EMAIL
};

const app = express();
const PORT = process.env.PORT || 5000;

app.use(express.json());
app.use(cors({ origin: process.env.FRONTEND_URL || "*", credentials: true }));

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch(err => console.error('❌ MongoDB Connection Error:', err));

// --- SCHEMAS ---
const UserSchema = new mongoose.Schema({ email: { type: String, unique: true }, password: String });
const MonitorSchema = new mongoose.Schema({
  name: String, url: String, status: { type: String, default: 'unknown' },
  lastChecked: Date, downSince: Date, alertSent: { type: Boolean, default: false },
  history: [{ status: String, timestamp: { type: Date, default: Date.now } }]
});
const SubscriberSchema = new mongoose.Schema({ email: { type: String, unique: true } });

const User = mongoose.model('User', UserSchema);
const Monitor = mongoose.model('Monitor', MonitorSchema);
const Subscriber = mongoose.model('Subscriber', SubscriberSchema);

// --- 🔒 MIDDLEWARE ---
const auth = (req, res, next) => {
  const token = req.header('x-auth-token');
  if (req.path === '/api/edge-update') return next();
  if (!token) return res.status(401).json({ msg: 'No token' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); } 
  catch (e) { res.status(400).json({ msg: 'Invalid Token' }); }
};

// --- AUTH ROUTES ---
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, adminKey } = req.body; 
    if (adminKey !== ADMIN_SECRET) return res.status(403).json({ msg: "Invalid Admin Key." });
    if (await User.findOne({ email })) return res.status(400).json({ msg: 'User exists' });

    const hashedPassword = await bcrypt.hash(password, await bcrypt.genSalt(10));
    const user = new User({ email, password: hashedPassword });
    await user.save();

    res.json({ token: jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: '1h' }), user: { id: user._id, email } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user || !(await bcrypt.compare(password, user.password))) return res.status(400).json({ msg: 'Invalid credentials' });
    res.json({ token: jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: '24h' }), user: { id: user._id, email } });
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

// 📧 INSTANT LOOP ALERT SYSTEM
async function sendAlert(monitor, status) {
  const subscribers = await Subscriber.find(); // Get everyone from DB
  if (subscribers.length === 0) return;

  const isUp = status === 'up';
  const subject = isUp ? `✅ RECOVERY: ${monitor.name}` : `🚨 ALERT: ${monitor.name} is DOWN`;
  const text = isUp ? `Service "${monitor.name}" is back online.` : `Service "${monitor.name}" is DOWN.`;

  console.log(`📧 Blasting alerts to ${subscribers.length} subscribers...`);

  // This loop runs instantly for each person
  for (const sub of subscribers) {
      const recipientEmail = sub.email;
      
      // 1. Find the specific key for this person
      const apiKey = EMAIL_KEYS[recipientEmail];
      
      // 2. If no key is mapped in code, we can't send (Free Tier Limitation)
      if (!apiKey) {
          console.log(`⚠️ Skipping ${recipientEmail} (No API Key found in server.js)`);
          continue;
      }

      try {
          // 3. Switch Identity to the correct Resend Account
          const currentResend = new Resend(apiKey);
          
          await currentResend.emails.send({
              from: 'onboarding@resend.dev',
              to: recipientEmail,
              subject: subject,
              text: text
          });
          console.log(`   ✅ Sent to: ${recipientEmail}`);
      } catch (err) {
          console.error(`   ❌ Failed to send to ${recipientEmail}:`, err.message);
      }
  }
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
app.get('/', (req, res) => res.send('Uptime Monitor Active 🟢'));
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

// --- SUPER ADMIN ROUTES ---
app.get('/api/users', auth, async (req, res) => {
  try {
    const currentUser = await User.findById(req.user.id);
    if (!currentUser || currentUser.email !== SUPER_ADMIN_EMAIL) return res.status(403).json({ msg: "Access Denied." });
    res.json(await User.find().select('-password'));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/users/:id', auth, async (req, res) => {
  try {
    const currentUser = await User.findById(req.user.id);
    if (!currentUser || currentUser.email !== SUPER_ADMIN_EMAIL) return res.status(403).json({ msg: "Access Denied." });
    if (req.user.id === req.params.id) return res.status(400).json({ msg: "Cannot delete self." });
    await User.findByIdAndDelete(req.params.id);
    res.json({ message: 'User deleted' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/subscribers', auth, async (req, res) => {
    try { await Subscriber.deleteOne({ email: req.body.email }); res.json({ message: 'Deleted subscriber' }); } 
    catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/subscribers', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !email.includes('@')) return res.status(400).json({error: 'Invalid email'});
    await Subscriber.updateOne({ email }, { email }, { upsert: true });
    res.json({ message: 'Subscribed' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Test Email Route (For Main account only)
app.get('/api/test-email', async (req, res) => {
    try {
        const resend = new Resend(process.env.RESEND_API_KEY_MAIN);
        const { data, error } = await resend.emails.send({
            from: 'onboarding@resend.dev', to: 'm.nuwan245@gmail.com', subject: 'Test', text: 'It works!'
        });
        if (error) return res.status(500).json({ error });
        res.json({ success: true, data });
    } catch (e) { res.status(500).json({ error: e.message }); } 
});

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server running on port ${PORT}`));