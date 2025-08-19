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

// Configurable via env
const EXPIRED_REDIRECT_URL = (process.env.EXPIRED_REDIRECT_URL || '').trim();
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';
const INACTIVITY_MS = Number(process.env.ROOM_INACTIVITY_MS || 5 * 60 * 1000); // default 5 min idle
const MAX_LIFETIME_MS = Number(process.env.ROOM_MAX_LIFETIME_MS || 60 * 60 * 1000); // default 60 min hard cap
const SWEEP_INTERVAL_MS = 60 * 1000; // every 60s

// Rooms store
// value: { clients:Set, agents:Set, status:'active'|'ended', createdAt:number, lastActivity:number, purgeTimer?:Timeout }
const rooms = new Map();

function rid(n=12){
  const c='abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from({length:n},()=>c[Math.floor(Math.random()*c.length)]).join('');
}
function now(){ return Date.now(); }
function touch(id){ const r = rooms.get(id); if (r) r.lastActivity = now(); }
function getBaseURL(req){
  const env=(process.env.PUBLIC_URL||'').trim();
  if(env) return env.replace(/\/+$/,'');
  const proto=req.headers['x-forwarded-proto']||req.protocol||'https';
  const host=req.headers['x-forwarded-host']||req.get('host');
  return `${proto}://${host}`;
}
function deviceFromUA(ua=''){
  if(/mobile|iphone|ipod|android(?!.*tablet)/i.test(ua)) return 'Mobile';
  if(/ipad|tablet/i.test(ua)) return 'Tablet';
  return 'Desktop';
}

async function notifyDiscord(id, baseUrl, meta = {}) {
  if (!DISCORD_WEBHOOK_URL) return;
  const joinUrl = `${baseUrl}/agent?id=${id}`;
  const lines = [
    `🆘 New support request: **${id}**`,
    `Join: ${joinUrl}`
  ];
  if (meta.device) lines.push(`Device: ${meta.device}`);
  if (meta.ip) lines.push(`IP: ${meta.ip}`);
  try {
    await fetch(DISCORD_WEBHOOK_URL, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ content: lines.join('\n') })
    });
  } catch (e) { console.error('Discord webhook error', e); }
}

function makeRoom(id){
  rooms.set(id, {
    clients:new Set(),
    agents:new Set(),
    status:'active',
    createdAt:now(),
    lastActivity:now()
  });
}

async function forceDisconnectAll(roomId){
  try{
    const sockets = await io.in(roomId).fetchSockets();
    sockets.forEach(s => s.disconnect(true));
  }catch(e){ /* ignore */ }
}

function markEnded(id){
  const r = rooms.get(id);
  if (!r || r.status === 'ended') return;
  r.status = 'ended';
  io.to(id).emit('ended');
  forceDisconnectAll(id).catch(()=>{});
  if (r.purgeTimer) clearTimeout(r.purgeTimer);
  r.purgeTimer = setTimeout(()=> rooms.delete(id), 30 * 60 * 1000); // purge after 30 minutes
}

// --- Routes ---
app.get('/health', (req,res)=> res.json({ ok:true }));
app.get('/api/expired-url', (req,res)=> res.json({ url: EXPIRED_REDIRECT_URL || '/session-ended.html' }));
app.get('/api/session-status', (req, res) => {
  const id = String(req.query.id || '').trim();
  if (!id) return res.json({ status: 'invalid' });
  const r = rooms.get(id);
  if (!r) return res.json({ status: 'ended' });
  return res.json({ status: r.status });
});

// ✅ FIXED: Start session (requires header + correct answer 'milo')
app.post('/api/start-session', async (req, res) => {
  const fromPortal = req.get('x-portal-entry') === '1';
  if (!fromPortal) return res.status(403).json({ error: 'Forbidden' });

  const answerRaw = (req.body?.answer ?? '').trim();
  const answer = answerRaw.toLowerCase();

  if (answer !== 'milo') {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const id = rid();
  makeRoom(id);

  const base = getBaseURL(req);
  const ua = req.get('user-agent') || '';
  const device = deviceFromUA(ua);
  const xf = req.headers['x-forwarded-for'];
  const ip = Array.isArray(xf) ? xf[0] : (xf ? String(xf).split(',')[0].trim() : (req.ip || 'unknown'));

  notifyDiscord(id, base, { device, ip }).catch(()=>{});
  res.json({ id });
});

io.on('connection', (socket) => {
  socket.on('join', ({ room, role }) => {
    if (!room) return;
    const r = rooms.get(room);
    if (!r || r.status !== 'active') {
      // reject joins to missing/ended rooms
      socket.emit('ended');
      setTimeout(()=> socket.disconnect(true), 0);
      return;
    }
    socket.data = { room, role };
    socket.join(room);
    (role === 'agent' ? r.agents : r.clients).add(socket.id);
    touch(room);
    io.to(room).emit('message', { text: `${role} joined`, role: 'sys' });
  });

  socket.on('message', ({ room, text, role }) => {
    const r = rooms.get(room);
    if (!r || r.status !== 'active') return;
    touch(room);
    io.to(room).emit('message', { text, role });
  });

  socket.on('end-session', ({ room }) => { if (room) markEnded(room); });

  socket.on('closed', ({ room, role }) => {
    const r = rooms.get(room);
    if (!r) return;
    io.to(room).emit('message', { text: `${role} closed browser`, role:'sys' });
    touch(room);
  });

  socket.on('disconnect', () => {
    const { room, role } = socket.data || {};
    if (!room) return;
    const r = rooms.get(room);
    if (!r) return;
    if (role === 'agent') r.agents.delete(socket.id);
    else if (role === 'client') r.clients.delete(socket.id);
    // end as soon as last participant leaves
    if (r.clients.size === 0 && r.agents.size === 0) {
      markEnded(room);
    } else {
      io.to(room).emit('message', { text: `${role} disconnected`, role:'sys' });
      touch(room);
    }
  });
});

// Sweeper: end rooms that idle too long or exceed lifetime
setInterval(() => {
  const t = now();
  for (const [id, r] of rooms) {
    if (r.status !== 'active') continue;
    if ((t - r.lastActivity) > INACTIVITY_MS) {
      markEnded(id);
      continue;
    }
    if ((t - r.createdAt) > MAX_LIFETIME_MS) {
      markEnded(id);
    }
  }
}, SWEEP_INTERVAL_MS);

// Agent UI (guarded)
function agentPageHtml(){return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Console</title>
<script src="https://cdn.socket.io/4.7.5/socket.io.min.js"></script>
<style>
:root{--ink:#0f172a;--b:#e5e7eb}
*{box-sizing:border-box}body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;margin:0;color:var(--ink);background:#f8fafc}
.header{position:sticky;top:0;background:#fff;border-bottom:1px solid var(--b);padding:12px 16px}
.wrap{max-width:900px;margin:0 auto;padding:0 12px}
#messages{height:60vh;overflow:auto;border:1px solid var(--b);border-radius:12px;padding:12px;margin:12px 0;background:#fff}
.line{padding:8px 10px;margin-bottom:6px;border-radius:8px}
.client{background:#e1f5ea}
.agent{background:#eaf7e1}
.sys{background:#fff3cd}
.composer{display:flex;gap:8px;position:sticky;bottom:0;background:#f8fafc;padding:12px 0}
.composer input{flex:1;padding:12px;border-radius:10px;border:1px solid var(--b);font-size:16px}
.composer button{padding:12px 14px;border-radius:10px;border:0;background:#2563eb;color:#fff;font-weight:600}
.end{background:#ef4444}
</style>
</head><body>
<div class="header"><div class="wrap"><strong>Agent Console</strong> <span id="status" style="opacity:.7"></span></div></div>
<div class="wrap">
  <div id="messages"></div>
  <form id="form" class="composer">
    <input id="input" placeholder="Type a reply..." autocomplete="off" />
    <button type="submit">Send</button>
    <button id="endBtn" type="button" class="end">End</button>
  </form>
</div>
<script>
const id=new URLSearchParams(location.search).get('id');
if(!id){document.body.innerHTML='<p style="padding:20px">Missing ?id=</p>';}
const statusEl=document.getElementById('status');
const msgs=document.getElementById('messages'); const inp=document.getElementById('input'); const end=document.getElementById('endBtn');
const socket=io('/',{transports:['websocket']});
socket.on('connect',()=>{ socket.emit('join',{room:id,role:'agent'}); statusEl.textContent='· connected'; });
socket.on('message',m=>{const el=document.createElement('div'); el.className='line '+(m.role||'sys'); el.textContent=m.text; msgs.appendChild(el); msgs.scrollTop=msgs.scrollHeight;});
socket.on('ended',()=>{const el=document.createElement('div'); el.className='line sys'; el.textContent='Session ended'; msgs.appendChild(el); setTimeout(()=>location.href='${EXPIRED_REDIRECT_URL || '/session-ended.html'}', 1200); });
document.getElementById('form').addEventListener('submit',e=>{e.preventDefault(); const t=inp.value.trim(); if(!t)return; socket.emit('message',{room:id,text:t,role:'agent'}); inp.value='';});
end.addEventListener('click',()=>{ socket.emit('end-session',{ room:id }); });
window.addEventListener('beforeunload',()=>{ socket.emit('closed',{ room:id, role:'agent' }); });
</script>
</body></html>`}

function guardAndSendAgent(req, res){
  const id = String(req.query.id || '').trim();
  const r = id && rooms.get(id);
  if (!id || !r || r.status !== 'active') {
    if (EXPIRED_REDIRECT_URL) return res.redirect(302, EXPIRED_REDIRECT_URL);
    return res.status(410).send('Session expired');
  }
  res.type('html').send(agentPageHtml());
}
app.get('/agent', guardAndSendAgent);
app.get('/agent.html', guardAndSendAgent);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('chat server listening on :' + PORT));
