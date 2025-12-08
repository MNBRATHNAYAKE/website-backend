import monitors from '../data/monitors.js'; // path to your JSON array
import { randomUUID } from 'crypto';

export default function handler(req, res) {
  if (req.method === 'GET') {
    res.status(200).json(monitors);
  } else if (req.method === 'POST') {
    const { name, url } = req.body;
    if (!name || !url) return res.status(400).json({ error: 'Name and URL required' });

    const newMonitor = {
      id: randomUUID(),
      name,
      url,
      status: 'up',
      history: [],
      downSince: null,
      alertSent: false
    };

    monitors.push(newMonitor);
    res.status(201).json(newMonitor);
  } else if (req.method === 'DELETE') {
    const { id } = req.query;
    const index = monitors.findIndex(m => m.id === id);
    if (index === -1) return res.status(404).json({ error: 'Monitor not found' });

    monitors.splice(index, 1);
    res.status(200).json({ message: 'Deleted' });
  } else {
    res.setHeader('Allow', ['GET', 'POST', 'DELETE']);
    res.status(405).end(`Method ${req.method} Not Allowed`);
  }
}
