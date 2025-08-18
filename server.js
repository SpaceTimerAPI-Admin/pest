// server.js

import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST'] }
});

const rooms = new Map();
function rid(n = 12) {
  const c = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from({ length: n }, () =>
    c[Math.floor(Math.random() * c.length)]
  ).join('');
}

function getBaseURL(req) {
  const env = (process.env.PUBLIC_URL || '').trim();
  if (env) return env.replace(/\/+$/, '');
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${proto}://${host}`;
}

function parseDevice(ua = '') {
  if (/mobile|iphone|ipod|android(?!.*tablet)/i.test(ua)) return 'Mobile';
  if (/ipad|tablet/i.test(ua)) return 'Tablet';
  return 'Desktop';
}

async function notifyDiscord(id, baseUrl, meta = {}) {
  const webhook = process.env.DISCORD_WEBHOOK_URL;
  if (!webhook) return;
  const joinUrl = `${baseUrl}/agent?id=${id}`; // use /agent (no .html)
  const lines = [
    `🆘 New support request: **${id}**`,
    `Join: ${joinUrl}`
  ];
  if (meta.device) lines.push(`Device: ${meta.device}`);
  if (meta.ip) lines.push(`IP: ${meta.ip}`);
  try {
    await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: lines.join('\n') })
    });
  } catch (e) {
    console.error('Discord webhook error', e);
  }
}

app.post('/api/start-session', async (req, res) => {
  // If you're using a password gate, keep it here. Otherwise, remove.
  const answer = ((req.body && req.body.answer) || '').trim().toLowerCase();
  if (answer !== 'milo') {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const id = rid();
  rooms.set(id, { clients: new Set(), agents: new Set() });
  const base = getBaseURL(req);
  const ua = req.get('user-agent') || '';
  const device = parseDevice(ua);
  const xf = req.headers['x-forwarded-for'];
  const ip = Array.isArray(xf)
    ? xf[0]
    : xf
    ? String(xf).split(',')[0].trim()
    : req.ip || 'unknown';

  notifyDiscord(id, base, { device, ip }).catch(e =>
    console.error('notifyDiscord failed', e)
  );
  res.json({ id });
});

app.get('/health', (req, res) => res.json({ ok: true }));

io.on('connection', socket => {
  socket.on('closed', ({ room, role }) => {
    if (room) {
      io.to(room).emit('message', {
        text: `${role} closed browser`,
        role: 'sys'
      });
    }
  });

  socket.on('join', ({ room, role }) => {
    if (!rooms.has(room))
      rooms.set(room, { clients: new Set(), agents: new Set() });
    const r = rooms.get(room);
    socket.data = { room, role };
    socket.join(room);
    if (role === 'agent') r.agents.add(socket.id);
    else r.clients.add(socket.id);

    io.to(room).emit('message', {
      text: `${role} joined`,
      role: 'sys'
    });
  });

  socket.on('message', ({ room, text, role }) => {
    if (!rooms.has(room)) return;
    io.to(room).emit('message', { text, role });
  });

  socket.on('disconnect', () => {
    const { room, role } = socket.data || {};
    if (!room || !rooms.has(room)) return;
    const r = rooms.get(room);
    if (role === 'agent') r.agents.delete(socket.id);
    else if (role === 'client') r.clients.delete(socket.id);

    if (r.clients.size === 0 && r.agents.size === 0) {
      io.to(room).emit('ended');
      rooms.delete(room);
    } else {
      io.to(room).emit('message', {
        text: `${role} disconnected`,
        role: 'sys'
      });
    }
  });
});

// Serve agent console at both /agent and /agent.html
function agentPageHtml() {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Console</title>
<script src="https://cdn.socket.io/4.7.5/socket.io.min.js"></script>
<style>
  /* styles omitted for brevity — use your existing agent styles */
</style>
</head><body>
  <div id="messages"></div>
  <form id="form"><input id="input"/><button>Send</button></form>
  <script>
    /* your existing agent JS here */
  </script>
</body></html>`;
}

app.get('/agent', (req, res) => {
  res.set('Content-Type', 'text/html').send(agentPageHtml());
});
app.get('/agent.html', (req, res) => {
  res.set('Content-Type', 'text/html').send(agentPageHtml());
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Chat server running on port', PORT);
});
