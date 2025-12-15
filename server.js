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
console.log("🚀 VERSION CHECK: SSL FIX + INSTANT ALERT");
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
  downSince: Date, // Kept for schema compatibility, but not strictly used in new logic
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

// 2. Email Transporter (THE FIX: Switched to 'service: gmail')
// This automatically uses Port 465 (SSL), which bypasses the Port 587 blocks on Railway.
const transporter = nodemailer.createTransport({
  service: 'gmail', 
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS, // Ensure this is your APP PASSWORD
  }
});

// Verify connection on startup
transporter.verify((error, success) => {
  if (error) {
    console.error("❌ Email Connection Error:", error);
  } else {
    console.log("✅ Email Service is Ready (SSL/Port 465)");
  }
});

// Helper: Send Alerts
async function sendAlert(monitor, status) {
  const subscribers = await Subscriber.find();
  if (subscribers.length === 0) return;

  const subject = `🚨 ALERT: ${monitor.name} is ${status.toUpperCase()}`;
  const text = `The service "${monitor.name}" (${monitor.url}) is now ${status.toUpperCase()}.`;

  console.log(`📧 Sending ${subscribers.length} alerts for ${monitor.name}`);

  // Send to all subscribers
  const mailOptions = {
    from: `"Uptime Monitor" <${process.env.SMTP_USER}>`,
    to: subscribers.map(s => s.email),
    subject: subject,
    text: text
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log("✅ Emails sent successfully.");
  } catch (error) {
    console.error("❌ Failed to send email:", error.message);
  }
}

// 3. Monitoring Logic (Simplified)
async function checkMonitors() {
  const monitors = await Monitor.find();
  const httpsAgent = new https.Agent({ rejectUnauthorized: false });

  for (const monitor of monitors) {
    let currentStatus = 'down';

    try {
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

    // Update History
    if (monitor.status !== currentStatus) {
      console.log(`🔄 ${monitor.name} changed to ${currentStatus}`);
      monitor.status = currentStatus;
      monitor.history.push({ status: currentStatus, timestamp: new Date() });
      if (monitor.history.length > 500) monitor.history.shift();
    }

    // --- NEW SIMPLIFIED LOGIC ---
    // If it's UP, just reset the flag
    if (currentStatus === 'up') {
      monitor.alertSent = false;
      monitor.downSince = null;
    } 
    // If it's DOWN and we haven't emailed yet -> Email immediately
    else if (currentStatus === 'down') {
      if (!monitor.alertSent) {
        console.log(`🔻 ${monitor.name} is DOWN. Sending Immediate Alert.`);
        
        // 1. Set flag TRUE immediately to prevent loops
        monitor.alertSent = true;
        monitor.downSince = new Date();
        await monitor.save();

        // 2. Send Email
        await sendAlert(monitor, 'down');
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
        
        // Simple test using the new 'service: gmail' transporter
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