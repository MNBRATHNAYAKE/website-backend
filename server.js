// server.js
const express = require('express');
const axios = require('axios');
const nodemailer = require('nodemailer');
const cors = require('cors');
const mongoose = require('mongoose');
const https = require('https');
const dns = require('node:dns');

// --- 1. CRITICAL NETWORK FIXES ---
// Forces Node to use IPv4. This is the #1 fix for Railway/Cloud timeouts.
dns.setDefaultResultOrder('ipv4first');

require('dotenv').config();

console.log("------------------------------------------------");
console.log("🚀 VERSION: STABILITY + SMART ALERTS (UP/DOWN)");
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

// --- 2. EMAIL TRANSPORTER (SSL FIX) ---
// We use 'service: gmail' which forces Port 465 (SSL).
// This is much more stable on cloud servers than Port 587.
const transporter = nodemailer.createTransport({
  service: 'gmail', 
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS, // MUST be your App Password
  }
});

// Verify connection on startup
transporter.verify((error, success) => {
  if (error) {
    console.error("❌ Email Connection Error:", error);
  } else {
    console.log("✅ Email Service is Ready (SSL Mode)");
  }
});

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

  console.log(`📧 Sending '${status}' alert for ${monitor.name} to ${subscribers.length} subscribers...`);

  // We send individual emails using Promise.all to ensure everyone gets one
  const promises = subscribers.map(sub => 
    transporter.sendMail({
      from: `"Uptime Monitor" <${process.env.SMTP_USER}>`,
      to: sub.email,
      subject: subject,
      text: text
    }).catch(err => console.error(`❌ Failed to send to ${sub.email}: ${err.message}`))
  );

  await Promise.all(promises);
  console.log(`✅ Finished sending alerts for ${monitor.name}`);
}

// --- 3. SMART MONITORING LOGIC ---
async function checkMonitors() {
  const monitors = await Monitor.find();
  // Ignores SSL certificate errors on the target site (good for dev sites)
  const httpsAgent = new https.Agent({ rejectUnauthorized: false });

  for (const monitor of monitors) {
    let currentStatus = 'down';

    try {
      // 10s timeout + Custom User-Agent to prevent blocking
      await axios.get(monitor.url, { 
        timeout: 10000, 
        httpsAgent: httpsAgent, 
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36',
          'Cache-Control': 'max-age=0'
        }
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
        // Site just crashed: Start the timer, do NOT alert yet.
        monitor.downSince = new Date();
        monitor.alertSent = false;
      } else {
        // Site just recovered:
        monitor.downSince = null;
        // If we had previously sent a DOWN alert, send a RECOVERY alert now
        if (monitor.alertSent) {
           await sendAlert(monitor, 'up');
        }
        monitor.alertSent = false;
      }
    }

    // --- LOGIC B: PERSISTENT DOWNTIME (The 2-Minute Rule) ---
    if (currentStatus === 'down' && monitor.downSince && !monitor.alertSent) {
      const minutesDown = (new Date() - new Date(monitor.downSince)) / 60000;
      
      // Log progress for debugging
      if (minutesDown > 0.5) console.log(`⏳ ${monitor.name} down for ${minutesDown.toFixed(1)} mins...`);

      // Trigger Alert after 2 minutes
      if (minutesDown >= 2) {
        console.log(`🚀 2 Minutes Reached! Sending Alert for ${monitor.name}`);
        
        // 1. Mark as sent FIRST to prevent loops
        monitor.alertSent = true;
        await monitor.save();

        // 2. Send the 'DOWN' email
        await sendAlert(monitor, 'down');
      }
    }

    monitor.lastChecked = new Date();
    await monitor.save();
  }
}

// Run check every 60 seconds
setInterval(checkMonitors, 60000);

// --- API ROUTES (UNCHANGED) ---
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

app.get('/api/test-email', async (req, res) => {
    try {
        console.log("🧪 Starting Email Test...");
        if (!process.env.SMTP_PASS) throw new Error("SMTP_PASS is MISSING!");
        
        let info = await transporter.sendMail({
            from: process.env.SMTP_USER,
            to: process.env.SMTP_USER, 
            subject: "Test Email from Railway",
            text: "Port 465/SSL Fix Applied! 🎉"
        });

        console.log("✅ Email Test Success:", info.response);
        res.json({ success: true, message: "Email Sent!", details: info.response });
    } catch (error) {
        console.error("❌ Email Test Failed:", error);
        res.status(500).json({ error: error.message });
    } 
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
});