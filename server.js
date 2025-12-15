// server.js
const express = require('express');
const axios = require('axios');
const nodemailer = require('nodemailer');
const cors = require('cors');
const mongoose = require('mongoose');
const https = require('https');
const dns = require('node:dns');

// 1. Force IPv4 to prevent timeouts
dns.setDefaultResultOrder('ipv4first');

require('dotenv').config();

console.log("------------------------------------------------");
console.log("🚀 VERSION CHECK: INSTANT-SAVE + PORT 587 FIX");
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

// 2. Email Transporter (Switched to Port 587)
const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 587,               // Standard STARTTLS port
  secure: false,           // Must be false for 587
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS, 
  },
  tls: {
    rejectUnauthorized: false // Helps avoid SSL errors on cloud servers
  },
  connectionTimeout: 10000, 
});

// Helper: Send Alerts
async function sendAlert(monitor, status) {
  const subscribers = await Subscriber.find();
  if (subscribers.length === 0) return;

  const subject = `Monitor ${status.toUpperCase()}: ${monitor.name}`;
  const text = `The service "${monitor.name}" (${monitor.url}) is now ${status.toUpperCase()}.`;

  console.log(`📧 Sending ${subscribers.length} alerts for ${monitor.name}`);

  const promises = subscribers.map(sub => 
    transporter.sendMail({ from: process.env.SMTP_USER, to: sub.email, subject, text })
      .then(() => console.log(`✅ Email sent to ${sub.email}`))
      .catch(e => console.error(`❌ FAILED to send to ${sub.email}. Reason: ${e.message}`))
  );
  await Promise.all(promises);
}

// 3. Monitoring Logic
async function checkMonitors() {
  const monitors = await Monitor.find();
  const httpsAgent = new https.Agent({ rejectUnauthorized: false });

  for (const monitor of monitors) {
    let currentStatus = 'down';

    try {
      await axios.get(monitor.url, { 
        timeout: 15000, 
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

    // --- LOGIC START ---

    // 1. Detect Status Change
    if (monitor.status !== currentStatus) {
      console.log(`🔄 ${monitor.name} changed to ${currentStatus}`);
      monitor.status = currentStatus;
      monitor.history.push({ status: currentStatus, timestamp: new Date() });
      if (monitor.history.length > 500) monitor.history.shift();

      if (currentStatus === 'down') {
        monitor.downSince = new Date();
        monitor.alertSent = false;
      } else {
        if (monitor.alertSent) {
             await sendAlert(monitor, 'up'); 
        }
        monitor.downSince = null;
        monitor.alertSent = false;
      }
    }

    // 2. Zombie Fix
    if (currentStatus === 'down' && !monitor.downSince) {
        monitor.downSince = new Date();
        monitor.alertSent = false; 
    }

    // 3. The 5-Minute Timer
    if (currentStatus === 'down' && monitor.downSince && !monitor.alertSent) {
      const minutesDown = (new Date() - new Date(monitor.downSince)) / 60000;
      
      if (minutesDown > 1) {
          console.log(`⏳ ${monitor.name} down for ${minutesDown.toFixed(1)} mins...`);
      }

      if (minutesDown >= 5) { 
        console.log(`🚀 5 Minutes Reached! Sending Alert for ${monitor.name}`);
        
        // --- 4. INSTANT SAVE FIX ---
        // We set TRUE and Save immediately. 
        // This ensures the DB is updated BEFORE we attempt the risky email.
        monitor.alertSent = true; 
        await monitor.save(); 
        
        try {
            await sendAlert(monitor, 'down');
        } catch (err) {
            console.error("❌ Critical Email Error:", err.message);
        }
        // Continue to next loop without saving again to be safe
        continue; 
      }
    }

    monitor.lastChecked = new Date();
    await monitor.save();
  }
}

setInterval(checkMonitors, 60000);

// API Routes
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
            text: "Port 587 Fix Applied! 🎉"
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