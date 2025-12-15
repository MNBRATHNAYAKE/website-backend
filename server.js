// server.js
const express = require('express');
const axios = require('axios');
const nodemailer = require('nodemailer');
const cors = require('cors');
const mongoose = require('mongoose');
const https = require('https');
require('dotenv').config();

// --- VERSION CHECK LOG ---
console.log("------------------------------------------------");
console.log("🚀 VERSION CHECK: FINAL SSL + SPAM FIX LIVE!");
console.log("------------------------------------------------");

const app = express();
// CRASH FIX: Use the port Railway provides, or 5000 locally
const PORT = process.env.PORT || 5000;

// 1. Middleware
app.use(express.json());
app.use(cors({
  origin: process.env.FRONTEND_URL || "*", 
  credentials: true
}));

// 2. Database Connection
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch(err => console.error('❌ MongoDB Connection Error:', err));

// 3. Define Schemas
const MonitorSchema = new mongoose.Schema({
  name: String,
  url: String,
  status: { type: String, default: 'unknown' }, // 'up', 'down', 'unknown'
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

// 4. Email Transporter (UPDATED: SSL Fix)
const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',  // Force Gmail Host
  port: 465,               // Force SSL Port (Fixes Timeout)
  secure: true,            // TRUE for port 465
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS, 
  },
  connectionTimeout: 10000, // Prevent hanging
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

// 5. Monitoring Logic
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
        // Site just went DOWN: Start the timer
        monitor.downSince = new Date();
        monitor.alertSent = false;
      } else {
        // Site came UP: Send email ONLY if we previously sent a "DOWN" alert
        if (monitor.alertSent) {
             await sendAlert(monitor, 'up'); 
        }
        monitor.downSince = null;
        monitor.alertSent = false;
      }
    }

    // 2. CRITICAL ZOMBIE FIX
    if (currentStatus === 'down' && !monitor.downSince) {
        console.log(`⚠️ Fixing Zombie Timer for ${monitor.name}. Restarting timer.`);
        monitor.downSince = new Date();
        monitor.alertSent = false; 
    }

    // 3. The 5-Minute Timer Check
    if (currentStatus === 'down' && monitor.downSince && !monitor.alertSent) {
      const minutesDown = (new Date() - new Date(monitor.downSince)) / 60000;
      
      // Log progress
      if (minutesDown > 1) {
          console.log(`⏳ ${monitor.name} down for ${minutesDown.toFixed(1)} mins...`);
      }

      if (minutesDown >= 5) { 
        console.log(`🚀 5 Minutes Reached! Sending Alert for ${monitor.name}`);
        
        // --- SPAM FIX: Mark as sent BEFORE trying to email ---
        // This stops the infinite loop if email fails
        monitor.alertSent = true; 
        
        try {
            await sendAlert(monitor, 'down');
        } catch (err) {
            console.error("❌ Critical Email Error:", err.message);
        }
      }
    }

    monitor.lastChecked = new Date();
    await monitor.save();
  }
}

// Run check every 60 seconds
setInterval(checkMonitors, 60000);

// 6. API Routes
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


// --- EMAIL DEBUG ROUTE ---
app.get('/api/test-email', async (req, res) => {
    try {
        console.log("🧪 Starting Email Test...");
        console.log(`👤 Using User: ${process.env.SMTP_USER}`); 
        
        if (!process.env.SMTP_PASS) {
            throw new Error("SMTP_PASS is MISSING or Empty!");
        } else {
            console.log(`🔑 Password is set (${process.env.SMTP_PASS.length} chars)`);
        }

        let info = await transporter.sendMail({
            from: process.env.SMTP_USER,
            to: process.env.SMTP_USER, 
            subject: "Test Email from Railway",
            text: "If you see this, your email configuration is PERFECT! 🎉"
        });

        console.log("✅ Email Test Success:", info.response);
        res.json({ success: true, message: "Email Sent!", details: info.response });
    } catch (error) {
        console.error("❌ Email Test Failed:", error);
        res.status(500).json({ 
            error: "Email Failed", 
            reason: error.message, 
            code: error.code, 
            command: error.command 
        });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
});