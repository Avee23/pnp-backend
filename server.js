const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const cors = require('cors');
require('dotenv').config();
const { AccessToken } = require('livekit-server-sdk');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(cors());
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || 'pnp-secret-key-2024';

let users = [
  { id: 1, name: 'Juan Dela Cruz', rank: 'PMAJ', station: 'NCRPO Station 1', email: 'juan.dela.cruz@pnp.gov.ph', password: 'password1', role: 'admin', initials: 'JD' },
  { id: 2, name: 'Maria Santos', rank: 'PO2', station: 'NCR, Station 5', email: 'maria.santos@pnp.gov.ph', password: 'password2', role: 'user', initials: 'MS' },
  { id: 3, name: 'Roberto Reyes', rank: 'SPO1', station: 'Region 3, Station 2', email: 'roberto.reyes@pnp.gov.ph', password: 'password3', role: 'user', initials: 'RR' },
  { id: 4, name: 'Ana Bautista', rank: 'PO3', station: 'Davao Region', email: 'ana.bautista@pnp.gov.ph', password: 'password4', role: 'user', initials: 'AB' },
];

let channels = [
  { id: 'ch1', name: 'alpha-team', desc: 'Alpha Team Operations', members: [1, 2], live: true },
  { id: 'ch2', name: 'ncr-ops', desc: 'NCR Regional Operations', members: [1], live: false },
  { id: 'ch3', name: 'incident-2024-001', desc: 'Incident Response', members: [1, 2, 3, 4], live: true },
];
let invites = [];

app.get('/', (req, res) => {
  res.json({ status: 'PNP SecureTalk server running' });
});

app.post('/auth/login', (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !email.endsWith('@pnp.gov.ph')) {
      return res.status(401).json({ error: 'Unauthorized email domain' });
    }
    const user = users.find(u => u.email === email.toLowerCase() && u.password === password);
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '24h' });
    const { password: _, ...userWithoutPassword } = user;
    res.json({ token, user: userWithoutPassword });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/auth/register', (req, res) => {
  try {
    const { name, rank, station, email, password } = req.body;
    if (!name || !rank || !station || !email || !password) {
      return res.status(400).json({ error: 'All fields are required' });
    }
    if (!email.endsWith('@pnp.gov.ph')) {
      return res.status(400).json({ error: 'Only @pnp.gov.ph addresses are permitted' });
    }
    if (users.find(u => u.email === email.toLowerCase())) {
      return res.status(400).json({ error: 'Email already registered' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    const initials = name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase();
    const newUser = { id: Date.now(), name, rank, station, email: email.toLowerCase(), password, role: 'user', initials };
    users.push(newUser);
    const token = jwt.sign({ id: newUser.id, email: newUser.email }, JWT_SECRET, { expiresIn: '24h' });
    const { password: _, ...userWithoutPassword } = newUser;
    res.json({ token, user: userWithoutPassword });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

app.get('/users', authMiddleware, (req, res) => {
  res.json(users.map(({ password, ...u }) => u));
});

app.get('/channels', authMiddleware, (req, res) => {
  const myChannels = channels.filter(c => c.members.includes(req.user.id));
  res.json(myChannels);
});

app.post('/channels', authMiddleware, (req, res) => {
  const { name, desc } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Channel name required' });
  const cleanName = name.trim().toLowerCase().replace(/\s+/g, '-');
  const newChannel = {
    id: 'ch' + Date.now(),
    name: cleanName,
    desc: desc?.trim() || 'No description',
    members: [req.user.id],
    live: false,
  };
  channels.push(newChannel);
  res.json(newChannel);
});

app.post('/channels/:id/join', authMiddleware, (req, res) => {
  const channel = channels.find(c => c.id === req.params.id);
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  if (!channel.members.includes(req.user.id)) {
    channel.members.push(req.user.id);
  }
  io.emit('channel:updated', channel);
  res.json(channel);
});

app.post('/channels/:id/invite', authMiddleware, (req, res) => {
  const channel = channels.find(c => c.id === req.params.id);
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  const targetUser = users.find(u => u.email === email.toLowerCase());
  if (!targetUser) return res.status(404).json({ error: 'No PNP account found with that email' });
  if (channel.members.includes(targetUser.id)) {
    return res.status(400).json({ error: 'User is already a member' });
  }
  const existing = invites.find(i => i.channelId === channel.id && i.toEmail === email.toLowerCase() && i.status === 'pending');
  if (existing) return res.status(400).json({ error: 'Invite already pending for this user' });

  const invite = {
    id: 'inv' + Date.now(),
    channelId: channel.id,
    channelName: channel.name,
    fromUserId: req.user.id,
    toEmail: email.toLowerCase(),
    status: 'pending',
  };
  invites.push(invite);
  res.json(invite);
});

app.get('/invites', authMiddleware, (req, res) => {
  const myInvites = invites.filter(i => i.toEmail === req.user.email && i.status === 'pending');
  res.json(myInvites);
});

app.post('/invites/:id/accept', authMiddleware, (req, res) => {
  const invite = invites.find(i => i.id === req.params.id && i.toEmail === req.user.email);
  if (!invite) return res.status(404).json({ error: 'Invite not found' });
  const channel = channels.find(c => c.id === invite.channelId);
  if (!channel) return res.status(404).json({ error: 'Channel no longer exists' });
  if (!channel.members.includes(req.user.id)) {
    channel.members.push(req.user.id);
  }
  invite.status = 'accepted';
  res.json({ channel });
});

app.post('/invites/:id/decline', authMiddleware, (req, res) => {
  const invite = invites.find(i => i.id === req.params.id && i.toEmail === req.user.email);
  if (!invite) return res.status(404).json({ error: 'Invite not found' });
  invite.status = 'declined';
  res.json({ ok: true });
});

app.post('/livekit/token', authMiddleware, (req, res) => {
  try {
    const { channelId } = req.body;
    const user = users.find(u => u.id === req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const at = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, {
      identity: String(user.id),
      name: `${user.rank} ${user.name}`,
    });
    at.addGrant({ roomJoin: true, room: channelId, canPublish: true, canSubscribe: true });

    res.json({ token: at.toJwt(), url: process.env.LIVEKIT_URL });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  socket.on('join:channel', (channelId) => socket.join(channelId));
  socket.on('ptt:start', ({ channelId, userId, userName }) => {
    socket.to(channelId).emit('ptt:speaking', { userId, userName });
  });
  socket.on('ptt:stop', ({ channelId, userId }) => {
    socket.to(channelId).emit('ptt:stopped', { userId });
  });
  socket.on('disconnect', () => console.log('Client disconnected:', socket.id));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ PNP SecureTalk server running on port ${PORT}`);
});