// server.js
const express = require('express');
const axios = require('axios');
const nodemailer = require('nodemailer');
const cors = require('cors');
const mongoose = require('mongoose');
const https = require('https');
require('dotenv').config();

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

// 4. Email Transporter
const transporter = nodemailer.createTransport({
  service: 'gmail', 
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS, 
  },
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
      .catch(e => console.error(`Failed to send to ${sub.email}`))
  );
  await Promise.all(promises);
}

// 5. Monitoring Logic (Standard HTTP Check)
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
      console.log(`❌ ${monitor.name} check failed: ${error.message}`);
      currentStatus = 'down';
    }

    // --- LOGIC START ---

    // 1. Detect Status Change
    if (monitor.status !== currentStatus) {
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

    // 2. CRITICAL FIX: Handle "Zombie" Downtime
    // If site is ALREADY down in DB but missing a timestamp (e.g. from before this code update),
    // set the timestamp now so the 5-minute timer can actually start.
    if (currentStatus === 'down' && !monitor.downSince) {
        monitor.downSince = new Date();
    }

    // 3. The 5-Minute Timer Check
    if (currentStatus === 'down' && monitor.downSince && !monitor.alertSent) {
      const minutesDown = (new Date() - new Date(monitor.downSince)) / 60000;
      
      if (minutesDown >= 5) { 
        await sendAlert(monitor, 'down');
        monitor.alertSent = true; // Mark as sent so we don't send again
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

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
});