const express = require('express');
const axios = require('axios');
const nodemailer = require('nodemailer');
const cors = require('cors');
const mongoose = require('mongoose');
const https = require('https');

require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(express.json());
app.use(cors({ origin: "*" })); // Allow all for now to prevent CORS headaches

// --- DATABASE CONNECTION ---
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch(err => console.error('❌ MongoDB Connection Error:', err));

const MonitorSchema = new mongoose.Schema({
  name: String,
  url: String,
  status: { type: String, default: 'unknown' },
  alertSent: { type: Boolean, default: false }, // Simple flag: Has email been sent for this downtime?
  history: [{ status: String, timestamp: { type: Date, default: Date.now } }]
});

const SubscriberSchema = new mongoose.Schema({
  email: { type: String, unique: true, required: true }
});

const Monitor = mongoose.model('Monitor', MonitorSchema);
const Subscriber = mongoose.model('Subscriber', SubscriberSchema);

// --- 2. NEW EMAIL CONFIGURATION (SSL/465) ---
// Switched to Port 465 (SSL) which is often more reliable than 587 on cloud hosts
const transporter = nodemailer.createTransport({
  service: 'gmail', // Built-in service handler for Gmail
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS, // MUST be an App Password, not login password
  }
});

// Verify email connection on startup
transporter.verify(function (error, success) {
  if (error) {
    console.log("❌ Email Service Error:", error);
  } else {
    console.log("✅ Email Service is Ready");
  }
});

// --- SIMPLE EMAIL FUNCTION ---
async function sendDownAlert(monitor) {
  const subscribers = await Subscriber.find();
  if (subscribers.length === 0) return;

  const mailOptions = {
    from: `"Monitor Alert" <${process.env.SMTP_USER}>`,
    to: subscribers.map(s => s.email), // Send to all subscribers
    subject: `🚨 ALERT: ${monitor.name} is DOWN`,
    text: `Your monitor "${monitor.name}" (${monitor.url}) is currently unreachable. Please check your server.`
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`📧 Alert sent to ${subscribers.length} subscribers.`);
  } catch (error) {
    console.error("❌ Failed to send email:", error.message);
  }
}

// --- 3. SIMPLIFIED MONITORING LOGIC ---
async function checkMonitors() {
  const monitors = await Monitor.find();
  // Agent to ignore SSL errors on target sites (e.g. self-signed certs)
  const httpsAgent = new https.Agent({ rejectUnauthorized: false });

  for (const monitor of monitors) {
    let isUp = false;

    try {
      await axios.get(monitor.url, { timeout: 10000, httpsAgent });
      isUp = true;
    } catch (error) {
      isUp = false;
    }

    // UPDATE HISTORY (Keep last 50 entries)
    const statusStr = isUp ? 'up' : 'down';
    monitor.history.push({ status: statusStr, timestamp: new Date() });
    if (monitor.history.length > 50) monitor.history.shift();

    // --- THE LOGIC ---
    if (isUp) {
      // If site is UP, we reset the alert flag so we can alert again if it crashes later
      monitor.status = 'up';
      monitor.alertSent = false; 
    } else {
      // If site is DOWN
      monitor.status = 'down';
      
      // Only send email if we haven't sent one for this specific crash yet
      if (!monitor.alertSent) {
        console.log(`🔻 ${monitor.name} is DOWN. Sending email...`);
        
        // 1. Mark true FIRST to prevent loop if email fails/hangs
        monitor.alertSent = true; 
        await monitor.save(); 

        // 2. Send the email
        await sendDownAlert(monitor);
      }
    }
    
    await monitor.save();
  }
}

// Run check every 60 seconds
setInterval(checkMonitors, 60000);

// --- API ROUTES ---
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

// SUBSCRIBER ROUTES
app.post('/subscribers', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Invalid email' });
    
    // Upsert: Create if doesn't exist, ignore if it does
    await Subscriber.updateOne({ email }, { email }, { upsert: true });
    res.json({ message: 'Subscribed successfully' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
});