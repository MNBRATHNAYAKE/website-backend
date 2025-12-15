// server.js
const express = require('express');
const axios = require('axios');
const nodemailer = require('nodemailer');
const cors = require('cors');
const mongoose = require('mongoose');
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
async function checkMonitors() {
  const monitors = await Monitor.find();
  
  for (const monitor of monitors) {
    const start = Date.now();
    let currentStatus = 'down';

    try {
      // Timeout set to 10s
      await axios.get(monitor.url, { timeout: 10000 });
      currentStatus = 'up';
    } catch (error) {
      currentStatus = 'down';
    }

    // Logic: Status Changed?
    if (monitor.status !== currentStatus) {
      
      // If going DOWN, wait for confirmation (simple logic here: immediate change for now)
      // In production, you might want a "double check" logic here.
      
      monitor.status = currentStatus;
      monitor.history.push({ status: currentStatus, timestamp: new Date() });
      
      // Limit history to last 500 entries to save space
      if (monitor.history.length > 500) monitor.history.shift();

      if (currentStatus === 'down') {
        monitor.downSince = new Date();
        monitor.alertSent = false; // Reset so we can send alert
      } else {
        monitor.downSince = null;
        monitor.alertSent = false;
        // Recovered! Send alert immediately
        await sendAlert(monitor, 'up');
      }
    }

    // Handle "Still Down" Alert logic (e.g., if down for 5 mins)
    if (currentStatus === 'down' && monitor.downSince && !monitor.alertSent) {
      const minutesDown = (new Date() - new Date(monitor.downSince)) / 60000;
      if (minutesDown >= 2) { // Alert after 2 minutes of downtime
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