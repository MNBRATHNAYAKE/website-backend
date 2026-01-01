// server.js
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const mongoose = require('mongoose');
const https = require('https');
const dns = require('node:dns');
const net = require('net'); 
const { Resend } = require('resend');

// 1. Force IPv4 (Critical for stability)
dns.setDefaultResultOrder('ipv4first');

require('dotenv').config();

console.log("------------------------------------------------");
console.log("🚀 VERSION: FINAL STABLE (NO WARNINGS)");
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

// --- RESEND CONFIGURATION ---
const resend = new Resend(process.env.RESEND_API_KEY);

// --- HELPER: RAW TCP CHECK (Fixed Deprecation Warning) ---
function checkTcp(targetUrl) {
    return new Promise((resolve) => {
        try {
            // Ensure protocol exists for the URL parser
            const cleanUrl = targetUrl.startsWith('http') ? targetUrl : `http://${targetUrl}`;
            
            // ✅ THE FIX: Use 'new URL()' instead of 'url.parse()'
            const parsed = new URL(cleanUrl);
            
            const host = parsed.hostname;
            // Default port: 443 for https, 80 for http, or use specified port
            const port = parsed.port || (cleanUrl.startsWith('https') ? 443 : 80);

            const socket = new net.Socket();
            socket.setTimeout(5000); 

            socket.connect(port, host, () => {
                socket.end();
                resolve(true); // ✅ Port is Open
            });

            socket.on('error', () => {
                socket.destroy();
                resolve(false); // ❌ Connection Failed
            });

            socket.on('timeout', () => {
                socket.destroy();
                resolve(false); // ❌ Timeout
            });

        } catch (e) {
            resolve(false);
        }
    });
}

// --- HELPER: SEND ALERTS ---
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

    if (error) {
        console.error("❌ Resend API Error:", error);
    } else {
        console.log(`✅ Alert sent successfully! ID: ${data.id}`);
    }
  } catch (err) {
    console.error("❌ Critical Email Error:", err.message);
  }
}

// --- SMART MONITORING LOGIC ---
async function checkMonitors() {
  const monitors = await Monitor.find();
  const httpsAgent = new https.Agent({ rejectUnauthorized: false });

  for (const monitor of monitors) {
    try {
      let currentStatus = 'down';

      // STEP 1: Try Standard HTTP Request
      try {
        await axios.get(monitor.url, { 
          timeout: 5000, 
          httpsAgent: httpsAgent, 
          headers: { 'User-Agent': 'UptimeBot/1.0' }
        });
        currentStatus = 'up'; 
      } catch (httpError) {
        
        // STEP 2: HTTP Failed? Try TCP Port Check (Fallback)
        // I removed the console.log spam here so logs are cleaner
        const isPortOpen = await checkTcp(monitor.url);
        
        if (isPortOpen) {
            // Only log if we saved it via TCP
            console.log(`⚠️ HTTP failed for ${monitor.name}, but TCP is OPEN. Marking UP.`);
            currentStatus = 'up';
        } else {
            currentStatus = 'down';
        }
      }

      // --- STATUS CHANGE LOGIC ---
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

      // --- 2-MINUTE ALERT LOGIC ---
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

    } catch (err) {
      if (err.name === 'DocumentNotFoundError' || err.message.includes('No document found')) {
        console.log(`⚠️ Skipped saving "${monitor.name}" because it was deleted.`);
      } else {
        console.error(`❌ Unexpected error for ${monitor.name}:`, err.message);
      }
    }
  }
}

// Run check every 60 seconds
setInterval(checkMonitors, 60000);

// Keep-Alive Route
app.get('/', (req, res) => { res.send('Uptime Monitor is Running 🟢'); });

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
  try {
    const subscribers = await Subscriber.find();
    res.json(subscribers);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/subscribers', async (req, res) => {
    try {
        const { email } = req.body;
        await Subscriber.deleteOne({ email });
        res.json({ message: 'Deleted subscriber' });
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