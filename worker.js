const fs = require('fs');
const os = require('os');
const path = require('path');
const amqp = require('amqplib');
const sharp = require('sharp');
const { io } = require('socket.io-client');

const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://guest:guest@rabbitmq:5672';
const SERVER_URL = process.env.SERVER_URL || 'http://server:3000';
const QUEUE_NAME = process.env.QUEUE_NAME || 'simulation_queue';
const UPLOAD_DIR = process.env.UPLOAD_DIR || '/uploads';
const ORIGINALS_DIR = path.join(UPLOAD_DIR, 'originals');
const WALLPAPERS_DIR = path.join(UPLOAD_DIR, 'wallpapers');

const WALLPAPER_WIDTH = 1080;
const WALLPAPER_HEIGHT = 1920;
const OUTPUT_FORMAT = 'webp';
const WORKER_ID = process.env.WORKER_ID || os.hostname();

fs.mkdirSync(WALLPAPERS_DIR, { recursive: true });

function parseBackgroundColor(hex) {
  const normalized = (hex || '#000000').replace('#', '');
  let r; let g; let b;
  if (normalized.length === 3) {
    r = parseInt(normalized[0] + normalized[0], 16);
    g = parseInt(normalized[1] + normalized[1], 16);
    b = parseInt(normalized[2] + normalized[2], 16);
  } else {
    r = parseInt(normalized.slice(0, 2), 16);
    g = parseInt(normalized.slice(2, 4), 16);
    b = parseInt(normalized.slice(4, 6), 16);
  }
  if ([r, g, b].some((n) => Number.isNaN(n))) return { r: 0, g: 0, b: 0 };
  return { r, g, b };
}

function emitProgress(socket, taskId, progress, status, extra = {}) {
  socket.emit('worker:progress', { taskId, progress, status, ...extra });
  console.log(`[${taskId}] ${progress}% — ${status}`);
}

async function resizeForWallpaper(socket, taskId, filename, originalName, backgroundColor) {
  const inputPath = path.join(ORIGINALS_DIR, filename);
  const outputName = `${taskId}.${OUTPUT_FORMAT}`;
  const outputPath = path.join(WALLPAPERS_DIR, outputName);
  const bg = parseBackgroundColor(backgroundColor);

  emitProgress(socket, taskId, 10, 'In RabbitMQ Queue...', { originalName, backgroundColor });
  emitProgress(socket, taskId, 25, 'Loading image...');

  const metadata = await sharp(inputPath).metadata();
  emitProgress(
    socket,
    taskId,
    40,
    `Original: ${metadata.width}×${metadata.height} — fitting entire image...`,
  );

  await sharp(inputPath)
    .rotate()
    .resize(WALLPAPER_WIDTH, WALLPAPER_HEIGHT, {
      fit: 'contain',
      background: bg,
    })
    .webp({ quality: 85, effort: 4 })
    .toFile(outputPath);

  emitProgress(socket, taskId, 75, 'Saving phone wallpaper (WebP)...');

  const outputMeta = await sharp(outputPath).metadata();
  const stats = fs.statSync(outputPath);
  const createdAt = new Date().toISOString();

  const meta = {
    taskId,
    originalName,
    backgroundColor: backgroundColor || '#000000',
    resultUrl: `/wallpapers/${outputName}`,
    width: outputMeta.width,
    height: outputMeta.height,
    format: OUTPUT_FORMAT,
    sizeKb: Math.round(stats.size / 1024),
    createdAt,
  };

  fs.writeFileSync(path.join(WALLPAPERS_DIR, `${taskId}.json`), JSON.stringify(meta));

  emitProgress(socket, taskId, 100, 'Done!', meta);
}

async function connectRabbitMQ(retries = 10) {
  for (let i = 0; i < retries; i++) {
    try {
      const conn = await amqp.connect(RABBITMQ_URL);
      const channel = await conn.createChannel();
      await channel.assertQueue(QUEUE_NAME, { durable: true });
      await channel.prefetch(1);
      console.log('Worker connected to RabbitMQ');
      return channel;
    } catch (err) {
      console.log(`RabbitMQ not ready (${i + 1}/${retries}), retrying...`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw new Error('Could not connect to RabbitMQ');
}

async function main() {
  const socket = io(SERVER_URL, { reconnection: true });
  socket.on('connect', () => console.log('Worker connected to server WebSocket'));
  socket.on('connect_error', (err) => console.log('WebSocket error:', err.message));

  const channel = await connectRabbitMQ();

  channel.consume(QUEUE_NAME, async (msg) => {
    if (!msg) return;

    const { taskId, filename, originalName, backgroundColor } = JSON.parse(msg.content.toString());
    console.log(`Processing task ${taskId} (${filename}) on ${WORKER_ID}`);

    socket.emit('worker:claimed', {
      taskId,
      workerId: WORKER_ID,
      claimedAt: new Date().toISOString(),
    });

    try {
      await resizeForWallpaper(socket, taskId, filename, originalName, backgroundColor);
      channel.ack(msg);
      console.log(`Acknowledged task ${taskId}`);
    } catch (err) {
      console.error(`Task ${taskId} failed:`, err.message);
      emitProgress(socket, taskId, 100, `Error: ${err.message}`);
      channel.nack(msg, false, false);
    }
  });

  console.log(`Listening on queue "${QUEUE_NAME}"`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
