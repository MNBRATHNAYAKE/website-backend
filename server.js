// server.js
const express = require('express');
const axios = require('axios');
const nodemailer = require('nodemailer');
const cors = require('cors');
const mongoose = require('mongoose');
const https = require('https');
const dns = require('node:dns');

// 1. Force IPv4 (Kept this as it helps prevents network timeouts)
dns.setDefaultResultOrder('ipv4first');

require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(express.json());
app.use(cors({
  origin: process.env.FRONTEND_URL || "*", 
  credentials: true
}));

// --- DATABASE CONNECTION (UNCHANGED) ---
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch(err => console.error('❌ MongoDB Connection Error:', err));

// --- SCHEMAS (UNCHANGED) ---
const MonitorSchema = new mongoose.Schema({
  name: String,
  url: String,
  status: { type: String, default: 'unknown' },
  lastChecked: Date,
  alertSent: { type: Boolean, default: false }, // Flag to prevent spamming
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

// --- 2. NEW EMAIL CONFIGURATION ---
// We use the 'service' shorthand. This automatically handles Port 465/SSL 
// and is much more stable for Gmail than manual port configuration.
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS, // Make sure this is your APP PASSWORD
  }
});

// Verify connection on startup so you see errors immediately in logs
transporter.verify((error, success) => {
  if (error) {
    console.error("❌ Email Connection Error:", error);
  } else {
    console.log("✅ Email Service is Ready to Send");
  }
});

// --- HELPER: SEND EMAIL ---
async function sendDownAlert(monitor) {
  const subscribers = await Subscriber.find();
  if (subscribers.length === 0) return;

  console.log(`📧 Sending alert for ${monitor.name} to ${subscribers.length} people...`);

  const mailOptions = {
    from: `"Uptime Monitor" <${process.env.SMTP_USER}>`,
    to: subscribers.map(sub => sub.email), // Send to all at once
    subject: `🚨 ALERT: ${monitor.name} is DOWN`,
    text: `The service "${monitor.name}" (${monitor.url}) is currently unreachable. Please check your server.`
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log("✅ Email sent successfully.");
  } catch (error) {
    console.error("❌ Failed to send email:", error.message);
  }
}

// --- 3. SIMPLIFIED MONITORING LOOP ---
async function checkMonitors() {
  const monitors = await Monitor.find();
  const httpsAgent = new https.Agent({ rejectUnauthorized: false });

  for (const monitor of monitors) {
    let currentStatus = 'down';

    try {
      // Timeout set to 10s to prevent hanging
      await axios.get(monitor.url, { 
        timeout: 10000, 
        httpsAgent: httpsAgent 
      });
      currentStatus = 'up';
    } catch (error) {
      currentStatus = 'down';
    }

    // UPDATE HISTORY
    if (monitor.status !== currentStatus) {
      console.log(`🔄 ${monitor.name} changed to ${currentStatus}`);
      monitor.status = currentStatus;
      monitor.history.push({ status: currentStatus, timestamp: new Date() });
      if (monitor.history.length > 50) monitor.history.shift();
    }

    // --- ALERT LOGIC (SIMPLIFIED) ---
    if (currentStatus === 'up') {
      // If site is up, reset the flag so we can alert next time it crashes
      monitor.alertSent = false;
    } 
    else if (currentStatus === 'down') {
      // If site is down AND we haven't sent an alert yet
      if (!monitor.alertSent) {
        
        // 1. Mark as sent immediately (to prevent loops)
        monitor.alertSent = true;
        await monitor.save();

        // 2. Send the email
        await sendDownAlert(monitor);
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
  const monitors = await Monitor.find();
  res.json(monitors);
});

app.post('/monitors', async (req, res) => {
  const { name, url } = req.body;
  const newMonitor = new Monitor({ name, url });
  await newMonitor.save();
  res.json(newMonitor);
});

app.delete('/monitors/:id', async (req, res) => {
  await Monitor.findByIdAndDelete(req.params.id);
  res.json({ message: 'Deleted' });
});

// SUBSCRIBER ROUTE (For your frontend input)
app.post('/subscribers', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Invalid email' });
    
    // Upsert: Adds email if it doesn't exist, does nothing if it does
    await Subscriber.updateOne({ email }, { email }, { upsert: true });
    
    res.json({ message: 'Subscribed successfully!' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
});