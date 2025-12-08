// server.js
const express = require('express');
const axios = require('axios');
const nodemailer = require('nodemailer');
const cors = require('cors');
const mongoose = require('mongoose');
const https = require('https');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// 1. Middleware
app.use(express.json());
app.use(cors({
  origin: process.env.FRONTEND_URL || "*", // Allow your frontend
  credentials: true
}));

// 2. Database Connection (MongoDB)
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
  service: 'gmail', // Or use host/port from your env
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS, // App Password, not login password
  },
});

// Helper: Send Alerts
async function sendAlert(monitor, status) {
  const subscribers = await Subscriber.find();
  if (subscribers.length === 0) return;

  const subject = `Monitor ${status.toUpperCase()}: ${monitor.name}`;
  const text = `The service "${monitor.name}" (${monitor.url}) is now ${status.toUpperCase()}.`;

  console.log(`📧 Sending ${subscribers.length} alerts for ${monitor.name}`);

  // Send in parallel for speed
  const promises = subscribers.map(sub => 
    transporter.sendMail({ from: process.env.SMTP_USER, to: sub.email, subject, text })
      .catch(e => console.error(`Failed to send to ${sub.email}`))
  );
  await Promise.all(promises);
}

// 5. Monitoring Logic (The Worker)
// 5. Monitoring Logic (The Worker)
async function checkMonitors() {
  const monitors = await Monitor.find();
  
  // Create an HTTPS agent that ignores SSL errors (Fixes "Down" on gov/legacy sites)
  const httpsAgent = new https.Agent({  
    rejectUnauthorized: false 
  });

  for (const monitor of monitors) {
    // const start = Date.now(); // Optional: Track response time later if needed
    let currentStatus = 'down';

    try {
      // We assume it's UP until proven otherwise
      await axios.get(monitor.url, { 
        timeout: 15000, // Increased timeout to 15s (some gov sites are slow)
        httpsAgent: httpsAgent, // Use the lenient SSL agent
        headers: {
          // Fake a real browser so we don't get blocked
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1',
          'Cache-Control': 'max-age=0'
        }
      });
      currentStatus = 'up';
    } catch (error) {
      console.log(`❌ ${monitor.name} check failed: ${error.message}`);
      currentStatus = 'down';
    }

    // Logic: Status Changed?
    if (monitor.status !== currentStatus) {
      monitor.status = currentStatus;
      monitor.history.push({ status: currentStatus, timestamp: new Date() });
      
      // Limit history to last 500 entries
      if (monitor.history.length > 500) monitor.history.shift();

      if (currentStatus === 'down') {
        monitor.downSince = new Date();
        monitor.alertSent = false;
      } else {
        monitor.downSince = null;
        monitor.alertSent = false;
        await sendAlert(monitor, 'up'); // Recovered!
      }
    }

    // Handle "Still Down" Alert logic
    if (currentStatus === 'down' && monitor.downSince && !monitor.alertSent) {
      const minutesDown = (new Date() - new Date(monitor.downSince)) / 60000;
      if (minutesDown >= 2) { 
        await sendAlert(monitor, 'down');
        monitor.alertSent = true;
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
    // Simple regex for email validation
    if (!email || !email.includes('@')) return res.status(400).json({error: 'Invalid email'});
    
    await Subscriber.updateOne({ email }, { email }, { upsert: true });
    res.json({ message: 'Subscribed' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/subscribers', async (req, res) => {
  const count = await Subscriber.countDocuments();
  res.json({ count });
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));