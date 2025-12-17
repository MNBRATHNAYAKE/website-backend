// server.js
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const mongoose = require('mongoose');
const https = require('https');
const dns = require('node:dns');
const { Resend } = require('resend'); // ✅ NEW: Using Resend

// 1. Force IPv4 (Critical for stability)
dns.setDefaultResultOrder('ipv4first');

require('dotenv').config();

console.log("------------------------------------------------");
console.log("🚀 VERSION: RESEND API + SMART ALERTS (UP/DOWN)");
console.log("------------------------------------------------");

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

// Schemas
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

const SubscriberSchema = new mongoose.Schema({
  email: { type: String, unique: true, required: true }
});

const Monitor = mongoose.model('Monitor', MonitorSchema);
const Subscriber = mongoose.model('Subscriber', SubscriberSchema);

// --- 2. RESEND CONFIGURATION ---
// This uses HTTP (Port 443) which works everywhere (Render, Railway, Localhost)
const resend = new Resend(process.env.RESEND_API_KEY);

// --- HELPER: SEND ALERTS (HANDLES UP & DOWN) ---
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
    // IMPORTANT: On the free tier, 'from' MUST be 'onboarding@resend.dev'
    // You can only send emails to yourself (the email you signed up with) unless you add a domain.
    const { data, error } = await resend.emails.send({
      from: 'onboarding@resend.dev', 
      to: subscribers.map(s => s.email), 
      subject: subject,
      text: text
    });

    if (error) {
        console.error("❌ Resend API Error:", error);
    } else {
        console.log(`✅ Alert sent successfully! ID: ${data.id}`);
    }
  } catch (err) {
    console.error("❌ Critical Email Error:", err.message);
  }
}

// --- 3. SMART MONITORING LOGIC ---
async function checkMonitors() {
  const monitors = await Monitor.find();
  const httpsAgent = new https.Agent({ rejectUnauthorized: false });

  for (const monitor of monitors) {
    let currentStatus = 'down';

    try {
      // 10s timeout + Custom User-Agent
      await axios.get(monitor.url, { 
        timeout: 10000, 
        httpsAgent: httpsAgent, 
        headers: { 'User-Agent': 'UptimeBot/1.0' }
      });
      currentStatus = 'up';
    } catch (error) {
      currentStatus = 'down';
    }

    // --- LOGIC A: STATUS CHANGE ---
    if (monitor.status !== currentStatus) {
      console.log(`🔄 ${monitor.name} changed to ${currentStatus}`);
      
      monitor.status = currentStatus;
      monitor.history.push({ status: currentStatus, timestamp: new Date() });
      if (monitor.history.length > 500) monitor.history.shift();

      if (currentStatus === 'down') {
        // Site just crashed: Start timer, don't alert yet
        monitor.downSince = new Date();
        monitor.alertSent = false;
      } else {
        // Site just recovered
        monitor.downSince = null;
        // If we previously sent a DOWN alert, send RECOVERY alert now
        if (monitor.alertSent) {
           await sendAlert(monitor, 'up');
        }
        monitor.alertSent = false;
      }
    }

    // --- LOGIC B: PERSISTENT DOWNTIME (The 2-Minute Rule) ---
    if (currentStatus === 'down' && monitor.downSince && !monitor.alertSent) {
      const minutesDown = (new Date() - new Date(monitor.downSince)) / 60000;
      
      if (minutesDown > 0.5) console.log(`⏳ ${monitor.name} down for ${minutesDown.toFixed(1)} mins...`);

      if (minutesDown >= 2) {
        console.log(`🚀 2 Minutes Reached! Sending Alert for ${monitor.name}`);
        
        // 1. Mark as sent FIRST to prevent loops
        monitor.alertSent = true;
        await monitor.save();

        // 2. Send the 'DOWN' email via Resend
        await sendAlert(monitor, 'down');
      }
    }

    monitor.lastChecked = new Date();
    await monitor.save();
  }
}

// Run check every 60 seconds
setInterval(checkMonitors, 60000);

// Keep-Alive Route (Helpful for Render)
app.get('/', (req, res) => {
    res.send('Uptime Monitor is Running 🟢');
});

// --- API ROUTES ---
app.get('/monitors', async (req, res) => {
  try {
    const monitors = await Monitor.find();
    res.json(monitors);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/monitors', async (req, res) => {
  try {
    const { name, url } = req.body;
    const newMonitor = new Monitor({ name, url, status: 'unknown', history: [] });
    await newMonitor.save();
    res.json(newMonitor);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/monitors/:id', async (req, res) => {
  await Monitor.findByIdAndDelete(req.params.id);
  res.json({ message: 'Deleted' });
});

app.post('/subscribers', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !email.includes('@')) return res.status(400).json({error: 'Invalid email'});
    await Subscriber.updateOne({ email }, { email }, { upsert: true });
    res.json({ message: 'Subscribed' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/subscribers', async (req, res) => {
  const count = await Subscriber.countDocuments();
  res.json({ count });
});

// Test Email Route
app.get('/api/test-email', async (req, res) => {
    try {
        console.log("🧪 Starting Resend Test...");
        const { data, error } = await resend.emails.send({
            from: 'onboarding@resend.dev',
            to: 'your-email@gmail.com', // Replace with your actual email for manual testing
            subject: "Test from Resend",
            text: "It works! 🎉"
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