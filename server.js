const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const amqp = require('amqplib');
const { Server } = require('socket.io');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = process.env.UPLOAD_DIR || '/uploads';
const ORIGINALS_DIR = path.join(UPLOAD_DIR, 'originals');
const WALLPAPERS_DIR = path.join(UPLOAD_DIR, 'wallpapers');
const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://guest:guest@rabbitmq:5672';
const QUEUE_NAME = process.env.QUEUE_NAME || 'simulation_queue';
const MAX_BATCH_FILES = 20;
const MAX_QUEUE_LOG = 100;

fs.mkdirSync(ORIGINALS_DIR, { recursive: true });
fs.mkdirSync(WALLPAPERS_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: ORIGINALS_DIR,
    filename: (_req, file, cb) => {
      const unique = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
      cb(null, `${unique}-${file.originalname}`);
    },
  }),
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  },
  limits: { fileSize: 25 * 1024 * 1024 },
});

function normalizeBackgroundColor(value) {
  if (!value || typeof value !== 'string') return '#000000';
  const hex = value.trim();
  if (/^#[0-9A-Fa-f]{6}$/.test(hex)) return hex.toLowerCase();
  if (/^#[0-9A-Fa-f]{3}$/.test(hex)) return hex.toLowerCase();
  return '#000000';
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const queueLog = [];

function queueTask(file, backgroundColor = '#000000', clientLabel = 'anonymous') {
  const taskId = crypto.randomUUID();
  const payload = {
    taskId,
    filename: file.filename,
    originalName: file.originalname,
    backgroundColor: normalizeBackgroundColor(backgroundColor),
    clientLabel: String(clientLabel || 'anonymous').slice(0, 40),
    queue: QUEUE_NAME,
    queuedAt: new Date().toISOString(),
  };
  const message = JSON.stringify({
    taskId: payload.taskId,
    filename: payload.filename,
    originalName: payload.originalName,
    backgroundColor: payload.backgroundColor,
  });
  channel.sendToQueue(QUEUE_NAME, Buffer.from(message), { persistent: true });
  queueLog.unshift(payload);
  if (queueLog.length > MAX_QUEUE_LOG) queueLog.pop();
  io.emit('task:queued', payload);
  console.log(`Queued task ${taskId}: ${file.originalname} (${payload.clientLabel})`);
  return { taskId, originalName: file.originalname };
}

let channel;

async function connectRabbitMQ(retries = 10) {
  for (let i = 0; i < retries; i++) {
    try {
      const conn = await amqp.connect(RABBITMQ_URL);
      channel = await conn.createChannel();
      await channel.assertQueue(QUEUE_NAME, { durable: true });
      console.log('Connected to RabbitMQ');
      return;
    } catch (err) {
      console.log(`RabbitMQ not ready (${i + 1}/${retries}), retrying...`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw new Error('Could not connect to RabbitMQ');
}

app.use('/wallpapers', express.static(WALLPAPERS_DIR));

app.get('/api/queue-log', (_req, res) => {
  res.json(queueLog);
});

app.get('/api/wallpapers', (_req, res) => {
  const entries = fs.readdirSync(WALLPAPERS_DIR).filter((f) => f.endsWith('.json'));
  const wallpapers = entries
    .map((f) => JSON.parse(fs.readFileSync(path.join(WALLPAPERS_DIR, f), 'utf8')))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(wallpapers);
});

app.post('/upload', (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No image uploaded' });
    }

    const { taskId } = queueTask(req.file, req.body.backgroundColor, req.body.clientLabel);
    res.json({ taskId });
  });
});

app.post('/upload/batch', (req, res) => {
  upload.array('files', MAX_BATCH_FILES)(req, res, (err) => {
    if (err) {
      return res.status(400).json({ error: err.message });
    }
    if (!req.files?.length) {
      return res.status(400).json({ error: 'No images uploaded' });
    }

    const backgroundColor = normalizeBackgroundColor(req.body.backgroundColor);
    const clientLabel = req.body.clientLabel;
    const tasks = req.files.map((file) => queueTask(file, backgroundColor, clientLabel));
    res.json({ tasks });
  });
});

io.on('connection', (socket) => {
  socket.on('join-task', (taskId) => {
    socket.join(`task:${taskId}`);
  });

  socket.on('worker:progress', (payload) => {
    io.to(`task:${payload.taskId}`).emit('task:progress', payload);
    if (payload.progress === 100 && payload.resultUrl && !payload.status?.startsWith('Error')) {
      io.emit('wallpaper:added', payload);
    }
  });

  socket.on('worker:claimed', (payload) => {
    io.emit('task:claimed', payload);
  });
});

connectRabbitMQ()
  .then(() => server.listen(PORT, () => console.log(`Server listening on :${PORT}`)))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
