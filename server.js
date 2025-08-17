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

const rooms = new Map();

function rid(n=12){const c='abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';return Array.from({length:n},()=>c[Math.floor(Math.random()*c.length)]).join('')}

function getBaseURL(req) {
  const env = (process.env.PUBLIC_URL || '').trim();
  if (env) return env.replace(/\/+$/, '');
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${proto}://${host}`;
}

function parseDevice(ua='') {
  if (/mobile|iphone|ipod|android(?!.*tablet)/i.test(ua)) return 'Mobile';
  if (/ipad|tablet/i.test(ua)) return 'Tablet';
  return 'Desktop';
}

async function notifyDiscord(id, baseUrl, meta = {}) {
  const webhook = process.env.DISCORD_WEBHOOK_URL;
  if (!webhook) return;
  const joinUrl = `${baseUrl}/agent.html?id=${id}`;
  const lines = [
    `🆘 New support request: **${id}**`,
    `Join: ${joinUrl}`
  ];
  if (meta.device) lines.push(`Device: ${meta.device}`);
  if (meta.ip) lines.push(`IP: ${meta.ip}`);
  try {
    await fetch(webhook, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ content: lines.join('\n') }) });
  } catch (e) { console.error('Discord webhook error', e); }
}

app.post('/api/start-session', async (req, res) => {
  const id = rid();
  rooms.set(id, { clients: new Set(), agents: new Set() });
  const base = getBaseURL(req);
  const ua = req.get('user-agent') || '';
  const device = parseDevice(ua);
  const xf = req.headers['x-forwarded-for'];
  const ip = Array.isArray(xf) ? xf[0] : (xf ? String(xf).split(',')[0].trim() : (req.ip || 'unknown'));
  notifyDiscord(id, base, { device, ip }).catch(e => console.error('notifyDiscord failed', e));
  res.json({ id });
});

app.get('/health', (req, res) => res.json({ ok: true }));

io.on('connection', (socket) => {
  socket.on('closed', ({room, role, how}) => { if(room){ io.to(room).emit('message', { text: `${role} closed browser`, role: 'sys' }); } });

  socket.on('join', ({ room, role }) => {
    if (!rooms.has(room)) rooms.set(room, { clients: new Set(), agents: new Set() });
    const r = rooms.get(room);
    socket.data = { room, role };
    socket.join(room);
    (role === 'agent' ? r.agents : r.clients).add(socket.id);
    io.to(room).emit('message', { text: `${role} joined`, role: 'sys' });
  });

  socket.on('message', ({ room, text, role }) => {
    if (!rooms.has(room)) return;
    io.to(room).emit('message', { text, role });
  });

  socket.on('disconnect', (reason) => {
    const { room, role } = socket.data || {};
    if (!room || !rooms.has(room)) return;
    const r = rooms.get(room);
    if (role === 'agent') r.agents.delete(socket.id);
    else if (role === 'client') r.clients.delete(socket.id);

    if (r.clients.size === 0 && r.agents.size === 0) {
      io.to(room).emit('ended');
      rooms.delete(room);
    } else {
      io.to(room).emit('message', { text: `${role} disconnected`, role: 'sys' });
    }
  });
});

app.get('/agent.html', (req, res) => {
  res.set('Content-Type','text/html').send(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Console</title>
<script src="https://cdn.socket.io/4.7.5/socket.io.min.js"></script>
<style>
:root{--ink:#0f172a;--b:#e5e7eb;--bg:#ffffff}
*{box-sizing:border-box}body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;margin:0;color:var(--ink);background:#f8fafc}
.header{position:sticky;top:0;background:#fff;border-bottom:1px solid var(--b);padding:12px 16px}
.wrap{max-width:900px;margin:0 auto;padding:0 12px}
#messages{height:60vh;overflow:auto;border:1px solid var(--b);border-radius:10px;padding:10px;margin:12px 0;background:#fff}
.line{padding:8px 10px;margin-bottom:6px;border-radius:8px;background:#eef}
.client{background:#e1f5ea}
.agent{background:#eaf7e1}
.sys{background:#fff3cd}
.composer{display:flex;gap:8px;position:sticky;bottom:0;background:#f8fafc;padding:12px 0}
.composer input{flex:1;padding:12px;border-radius:10px;border:1px solid var(--b);font-size:16px}
.composer button{padding:12px 14px;border-radius:10px;border:0;background:#2563eb;color:#fff;font-weight:600}
@media (max-width:640px){
  #messages{height:64vh}
}
</style>
</head><body>
<div class="header"><div class="wrap"><strong>Agent Console</strong> <span id="status" style="opacity:.7"></span></div></div>
<div class="wrap">
  <div id="messages"></div>
  <form id="form" class="composer">
    <input id="input" placeholder="Type a reply..." autocomplete="off" />
    <button type="submit">Send</button>
    <button id="endBtn" type="button" style="background:#ef4444">End</button>
  </form>
</div>
<script>
const id=new URLSearchParams(location.search).get('id');
const status=document.getElementById('status');
const msgs=document.getElementById('messages');
const inp=document.getElementById('input');
const end=document.getElementById('endBtn');
if(!id){document.body.innerHTML='<p style="padding:20px">Missing ?id=</p>';}
const socket=io('/',{transports:['websocket']});
socket.on('connect',()=>{ socket.emit('join',{room:id,role:'agent'}); status.textContent='· connected'; });
socket.on('message',m=>{const el=document.createElement('div'); el.className='line '+(m.role||'sys'); el.textContent=m.text; msgs.appendChild(el); msgs.scrollTop=msgs.scrollHeight;});
socket.on('ended',()=>{const el=document.createElement('div'); el.className='line sys'; el.textContent='Session ended'; msgs.appendChild(el); });
document.getElementById('form').addEventListener('submit',e=>{e.preventDefault(); const t=inp.value.trim(); if(!t)return; socket.emit('message',{room:id,text:t,role:'agent'}); inp.value='';});
end.addEventListener('click',()=>{ socket.disconnect(); status.textContent='· disconnected'; });
window.addEventListener('beforeunload',()=>{ socket.emit('closed', { room: id, role: 'agent', how: 'browser' }); });
</script>
</body></html>`);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('evergreen chat server :' + PORT));
