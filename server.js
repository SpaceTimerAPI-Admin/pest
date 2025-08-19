// server.js — ephemeral sessions with redirect on revisit

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
const io = new Server(server, { cors: { origin: '*', methods: ['GET','POST'] } });

/** ENV: where to send people after a session expires */
const EXPIRED_REDIRECT_URL = (process.env.EXPIRED_REDIRECT_URL || '').trim(); // e.g., https://your-site.netlify.app/session-ended.html
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';

/** In-memory session store */
const rooms = new Map();
// value shape: { clients:Set<string>, agents:Set<string>, status:'active'|'ended', purgeTimer?:NodeJS.Timeout }

function rid(n=12){const c='abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';return Array.from({length:n},()=>c[Math.floor(Math.random()*c.length)]).join('')}
function getBaseURL(req){const env=(process.env.PUBLIC_URL||'').trim(); if(env) return env.replace(/\/+$/,''); const proto=req.headers['x-forwarded-proto']||req.protocol||'https'; const host=req.headers['x-forwarded-host']||req.get('host'); return `${proto}://${host}`;}
function deviceFromUA(ua=''){ if(/mobile|iphone|ipod|android(?!.*tablet)/i.test(ua)) return 'Mobile'; if(/ipad|tablet/i.test(ua)) return 'Tablet'; return 'Desktop'; }

async function notifyDiscord(id, baseUrl, meta = {}) {
  if (!DISCORD_WEBHOOK_URL) return;
  const joinUrl = `${baseUrl}/agent?id=${id}`; // agent console link
  const lines = [
    `🆘 New support request: **${id}**`,
    `Join: ${joinUrl}`
  ];
  if (meta.device) lines.push(`Device: ${meta.device}`);
  if (meta.ip) lines.push(`IP: ${meta.ip}`);
  try {
    await fetch(DISCORD_WEBHOOK_URL, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ content: lines.join('\n') }) });
  } catch (e) { console.error('Discord webhook error', e); }
}

function markEnded(id){
  const r = rooms.get(id);
  if (!r || r.status === 'ended') return;
  r.status = 'ended';
  io.to(id).emit('ended');
  // Purge the record later (so we can recognize revisits)
  if (r.purgeTimer) clearTimeout(r.purgeTimer);
  r.purgeTimer = setTimeout(()=> rooms.delete(id), 30 * 60 * 1000); // purge after 30 minutes
}

app.get('/health', (req,res)=> res.json({ ok:true }));

// OPTIONAL password gate; keep/remove per your last setup:
app.post('/api/s

// add near other routes
app.get('/api/expired-url', (req, res) => {
  const url = (process.env.EXPIRED_REDIRECT_URL || '').trim() || '/expired';
  res.json({ url });
});

app.post('/api/start-session', async (req, res) => {
  // NEW: soft gate to ensure request came from our login flow
  const fromPortal = req.get('x-portal-entry') === '1';
  if (!fromPortal) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  // your existing password gate (keep if you want it)
  const answer = ((req.body && req.body.answer) || '').trim().toLowerCase();
  if (answer && answer !== 'milo') {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // ... rest of your existing start-session logic ...
});
