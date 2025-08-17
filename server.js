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
async function pingDiscord(id){
  const hook = process.env.DISCORD_WEBHOOK_URL; if(!hook) return;
  const joinUrl = `${process.env.PUBLIC_URL || ''}/agent.html?id=${id}`;
  const payload = { content: `🟢 New private support chat: **${id}**\nJoin: ${joinUrl}` };
  try { await fetch(hook, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) }); } catch(e){ console.error('Webhook error', e); }
}
app.post('/api/start-session', async (req,res)=>{ const id=rid(); rooms.set(id,{clients:new Set(),agents:new Set()}); await pingDiscord(id); res.json({id}); });
app.get('/health',(req,res)=>res.json({ok:true}));
io.on('connection',(socket)=>{
  socket.on('join',({room,role})=>{
    if(!rooms.has(room)) rooms.set(room,{clients:new Set(),agents:new Set()});
    const r=rooms.get(room);
    socket.data={room,role}; socket.join(room);
    (role==='agent'?r.agents:r.clients).add(socket.id);
    io.to(room).emit('message',{text:`${role} joined`,role:'sys'});
  });
  socket.on('message',({room,text,role})=>{ if(!rooms.has(room)) return; io.to(room).emit('message',{text,role}); });
  socket.on('disconnect',()=>{
    const {room,role}=socket.data||{}; if(!room||!rooms.has(room)) return;
    const r=rooms.get(room); if(role==='agent') r.agents.delete(socket.id); else if(role==='client') r.clients.delete(socket.id);
    if(r.clients.size===0 && r.agents.size===0){ io.to(room).emit('ended'); rooms.delete(room); }
  });
});
app.get('/agent.html',(req,res)=>{
  res.set('Content-Type','text/html').send(`<!doctype html><meta charset="utf-8"><title>Agent Console</title>
  <script src="https://cdn.socket.io/4.7.5/socket.io.min.js"></script>
  <style>body{font-family:system-ui;padding:20px}#messages{height:60vh;overflow:auto;border:1px solid #ddd;border-radius:8px;padding:10px;margin-bottom:10px}
  .line{padding:6px 8px;margin-bottom:6px;border-radius:6px;background:#eef}.client{background:#e1f5ea}.agent{background:#eaf7e1}</style>
  <h1>Agent Console</h1><p id="status"></p><div id="messages"></div>
  <form id="form"><input id="input" placeholder="Type a reply..." autofocus /><button type="submit">Send</button><button id="endBtn" type="button">End</button></form>
  <script>
  const id=new URLSearchParams(location.search).get('id'); const status=document.getElementById('status'); const msgs=document.getElementById('messages'); const inp=document.getElementById('input'); const end=document.getElementById('endBtn');
  if(!id){document.body.innerHTML='<p>Missing ?id=</p>';}
  const socket=io('/',{transports:['websocket']}); socket.on('connect',()=>{socket.emit('join',{room:id,role:'agent'}); status.textContent='Connected as agent';});
  socket.on('message',m=>{const el=document.createElement('div'); el.className='line '+(m.role||'sys'); el.textContent=m.text; msgs.appendChild(el); msgs.scrollTop=msgs.scrollHeight;});
  socket.on('ended',()=>{const el=document.createElement('div'); el.className='line sys'; el.textContent='Session ended'; msgs.appendChild(el);});
  document.getElementById('form').addEventListener('submit',e=>{e.preventDefault(); const t=inp.value.trim(); if(!t)return; socket.emit('message',{room:id,text:t,role:'agent'}); inp.value='';});
  end.addEventListener('click',()=>{socket.disconnect(); status.textContent='Disconnected.';});
  </script>`);
});
const PORT=process.env.PORT||3000; server.listen(PORT,()=>console.log('evergreen chat server :'+PORT));
