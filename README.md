# RabbitMQ Phone Wallpaper Demo

A small, visual demo of **background job processing** with RabbitMQ.

RabbitMQ in this project acts as an asynchronous buffer and workload distributor. It ensures that your web application never freezes up when users upload heavy photos.

Instead of forcing the web server to resize images on the spot, RabbitMQ takes the request, holds onto it safely, and hands it off to background workers.

Description : You upload images through a web UI, the API saves them and publishes a task message to a queue, a worker container picks up each message, resizes the image to a phone wallpaper (1080×1920 WebP, full image preserved with configurable letterbox color), and streams progress back to the browser in real time.

RabbitMQ provides your app with three core architectural superpowers:

- No UI Blocking: Users can batch-upload 10 images at once and get an instant response because RabbitMQ defers the heavy CPU work to the background.

- Shock Absorption (Buffering): If you stop your workers entirely (podman compose stop worker), your website doesn't crash. Users can still upload photos; RabbitMQ safely holds the backlog until you turn the workers back on.

- Horizontal Scaling: You can instantly multiply your processing speed simply by spinning up more worker containers. RabbitMQ automatically adjusts and begins utilizing them without rewriting a single line of application code.

Everything runs in **rootless Podman** containers orchestrated with Compose.

## Features

- Single or **batch image upload** (home page and gallery)
- **RabbitMQ queue** between the web server and background workers
- **Socket.io** for live progress updates
- **Nginx** serves the frontend; Node.js handles API and WebSockets
- **Sharp** resizes images (`fit: contain` — nothing is cropped)
- Custom **background color** for letterbox bars
- Left sidebar shows **JSON messages** published to the queue and which worker claimed each job
- **Gallery** page lists all finished wallpapers

## Tech stack

| Layer          | Technology                       |
| -------------- | -------------------------------- |
| Frontend       | HTML, CSS, Socket.io client      |
| Reverse proxy  | Nginx (Alpine)                   |
| API            | Node.js, Express, Multer         |
| Message broker | RabbitMQ 3 (management image)    |
| Worker         | Node.js, amqplib, Sharp          |
| Real-time      | Socket.io                        |
| Containers     | Podman Compose, `node:20-alpine` |

## Architecture

```mermaid
flowchart TB
    subgraph Browser
        UI[Web UI]
        Log[Queue message log]
    end

    subgraph nginx_svc [nginx :3000]
        NGX[Nginx]
    end

    subgraph node_svc [Node server]
        API[Express API]
        SIO[Socket.io]
    end

    subgraph broker [RabbitMQ]
        Q[(simulation_queue)]
    end

    subgraph workers [Workers]
        W1[worker 1]
        W2[worker N...]
    end

    VOL[(shared-uploads volume)]

    UI -->|HTTP upload / static| NGX
    NGX -->|proxy /upload /api /socket.io| API
    UI <-->|WebSocket progress| SIO
    Log <-->|task:queued / task:claimed| SIO

    API -->|publish JSON message| Q
    API -->|save original| VOL

    Q -->|consume + ack| W1
    Q -->|consume + ack| W2
    W1 -->|read original / write wallpaper| VOL
    W1 -->|worker:progress| SIO
```

### Request flow (one image)

1. **Upload** — Browser sends `POST /upload` (or `/upload/batch`) with the image, background color, and client label.
2. **Persist** — Server saves the file to `/uploads/originals/` on the shared volume.
3. **Publish** — Server pushes a small JSON message to the `simulation_queue` RabbitMQ queue and immediately responds with a `taskId`.
4. **Subscribe** — Browser joins a Socket.io room for that `taskId`.
5. **Consume** — A worker receives the message, emits `worker:claimed`, reads the file, resizes with Sharp, writes WebP + metadata to `/uploads/wallpapers/`.
6. **Progress** — Worker emits `worker:progress` (10% → 100%); server forwards to the browser.
7. **Ack** — Worker calls `channel.ack(msg)` so RabbitMQ removes the message from the queue.

The web server **never blocks** on resizing. That is the core RabbitMQ pattern: **decouple producers from slow consumers**.

## The worker — what it does and why it matters

### What is the worker?

In this project, the **worker** (`worker.js`) is a separate program that runs in its own container. It does **not** serve web pages. Its only job is to **wait for tasks in RabbitMQ and do the slow work**.

Think of it like a **kitchen** in a restaurant:

| Role              | In the restaurant                                                        | In this project                                                                         |
| ----------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| Customer          | Orders food                                                              | User uploads an image                                                                   |
| Waiter            | Takes the order, brings it to the kitchen, answers “your order is ready” | **Server** — saves the file, puts a message in the queue, sends progress to the browser |
| Order ticket rail | Holds orders until a cook is free                                        | **RabbitMQ queue** — holds task messages                                                |
| Cook              | Actually prepares the food                                               | **Worker** — resizes the image with Sharp                                               |

When you upload a photo, the **server** only:

1. Saves the original file.
2. Drops a small JSON note into the queue (“resize this file, this task ID, this background color”).
3. Tells the browser “got it, here is your `taskId`.”

The **worker** then:

1. Picks up that note from RabbitMQ.
2. Opens the image from the shared `/uploads` folder.
3. Resizes it to 1080×1920 WebP (full image, colored bars if needed).
4. Saves the wallpaper and sends progress updates (10% → 100%) via Socket.io.
5. Tells RabbitMQ **“done”** (`ack`) so the message is removed from the queue.

Resizing can take several seconds. If the server did that work itself, every upload would **block** the API and other users would wait. The worker keeps the website **fast and responsive**.

### Why run multiple workers?

With **one worker**, tasks are handled **one after another** — like a restaurant with a single cook. If 10 people upload 10 images, image 10 waits until images 1–9 are finished.

With **multiple workers**, RabbitMQ **hands each message to the next free worker** — like opening more checkout lanes or hiring more cooks.

```
1 worker, 6 images:     [====][====][====][====][====][====]  → one long line

3 workers, 6 images:    [====][====]
                        [====][====]
                        [====]              → done ~3× faster
```

**Simple reasons to add more workers:**

1. **Speed** — Several images can be resized **at the same time** instead of waiting in a single line.
2. **Fairness** — Uploads still succeed quickly even when many users send jobs at once; work piles up in the queue, not on the web server.
3. **Reliability** — If one worker is busy (or restarting), others keep processing. The queue holds jobs until someone is free.
4. **Easy scaling** — You do not change the server code. Just run more worker containers:

```bash
podman compose up -d --scale worker=3
```

You do **not** need more workers for a single image — one job only needs one worker. Multiple workers help when you have **many jobs at the same time** (batch upload, many users, or a backlog).

**Rule of thumb:** More workers = more parallel resizing. The queue + RabbitMQ decide **who** gets the next job.

## Project structure

```
RabbitMQ/
├── openshift/              # OpenShift manifests (app only; RabbitMQ via operator)
│   ├── argocd/             # ApplicationSet + GitOps bootstrap
│   ├── kustomization.yaml
│   ├── server.yaml         # API microservice
│   ├── worker.yaml         # Worker microservice
│   ├── nginx.yaml          # Frontend microservice
│   ├── deploy.sh           # Imperative one-command deploy
│   ├── pvc.yaml
│   └── README.md
├── docker-compose.yml      # Podman Compose services
├── Dockerfile              # Node image (server + worker)
├── package.json
├── server.js               # API, Multer, RabbitMQ publisher, Socket.io
├── worker.js               # Queue consumer, Sharp resize, progress reporter
├── nginx/
│   ├── Dockerfile
│   └── nginx.conf          # Static files + reverse proxy
└── public/
    ├── index.html          # Single + batch upload
    ├── gallery.html        # Batch upload + wallpaper gallery
    ├── bg-picker.js        # Background color UI
    ├── queue-log.js        # Left sidebar message log
    └── queue-log.css
```

## Quick start

### Prerequisites

- [Podman](https://podman.io/) with Compose support (`podman compose` or `podman-compose`)
- Port **3000** (app) and **15672** (RabbitMQ management UI) available

### Run

```bash
cd RabbitMQ
podman compose up --build -d
```

Open:

| URL                                | Purpose                                 |
| ---------------------------------- | --------------------------------------- |
| http://localhost:3000              | Upload & resize                         |
| http://localhost:3000/gallery.html | Batch upload + saved wallpapers         |
| http://localhost:15672             | RabbitMQ Management (`guest` / `guest`) |

### Stop

```bash
podman compose down
```

## OpenShift deployment

**GitOps (ApplicationSet):**

```bash
cp openshift/argocd/params.env.example openshift/argocd/params.env
# edit REPO_URL, then:
./openshift/argocd/bootstrap.sh
```

**Imperative one-shot:**

```bash
./openshift/deploy.sh
```

See **[openshift/README.md](openshift/README.md)** and **[openshift/argocd/README.md](openshift/argocd/README.md)**.

---

## RabbitMQ learning simulation

Follow these steps to **see** how a message broker works. Keep the left sidebar open on the web UI — it shows the exact JSON sent to the queue.

### Step 1 — Start the stack and open the UI

```bash
podman compose up --build -d
```

Open http://localhost:3000 in your browser. Set **Client name** in the left panel to `Learner-1`.

You should see four containers running:

```bash
podman compose ps
```

| Service    | Role                       |
| ---------- | -------------------------- |
| `rabbitmq` | Message broker             |
| `server`   | Producer (publishes tasks) |
| `worker`   | Consumer (processes tasks) |
| `nginx`    | Frontend + proxy           |

### Step 2 — Upload one image and watch the message

1. Choose one image file.
2. Click **Upload & Resize**.
3. In the **left sidebar**, a blue **→ QUEUE** entry appears with JSON like:

```json
{
  "taskId": "a1b2c3d4-...",
  "filename": "1730....-photo.jpg",
  "originalName": "photo.jpg",
  "backgroundColor": "#000000",
  "clientLabel": "Learner-1",
  "queue": "simulation_queue"
}
```

That is the **producer → broker** step: the server did not resize anything yet; it only enqueued work.

4. Shortly after, a green **WORKER PICKED** entry shows which container took the job:

```json
{
  "taskId": "a1b2c3d4-...",
  "workerId": "rabbitmq-worker-1",
  "claimedAt": "..."
}
```

5. The progress bar moves from **In RabbitMQ Queue…** to **Done!**

**Takeaway:** The HTTP response returned immediately with `taskId`. Heavy work happened **asynchronously** in the worker.

### Step 3 — Inspect the queue in RabbitMQ Management

1. Open http://localhost:15672 (login: `guest` / `guest`).
2. Go to **Queues and Streams** → `simulation_queue`.
3. Upload another image and refresh the queue page quickly — you may briefly see **Ready** messages before the worker consumes them.
4. Note **Consumers** = number of worker containers attached to the queue.

### Step 4 — Simulate multiple users (producers)

RabbitMQ decouples **who sends work** from **who does work**.

1. Open http://localhost:3000 in **two browser tabs** (or normal + private window).
2. Tab A: set client name to `User-A`. Tab B: set client name to `User-B`.
3. Upload images from both tabs at nearly the same time.
4. Both sidebars show all `→ QUEUE` messages (broadcast via Socket.io), each tagged with `clientLabel`.

**Takeaway:** Many clients can publish to one queue without waiting for processing to finish.

### Step 5 — Simulate multiple workers (consumers)

Scale workers so jobs can be processed in parallel:

```bash
podman compose up -d --scale worker=3
podman compose ps
```

Upload **5–10 images** at once (hold Ctrl/Cmd in the file picker, or use the gallery page).

Watch the sidebar:

- Several **WORKER PICKED** entries with different `workerId` values (`rabbitmq-worker-1`, `rabbitmq-worker-2`, …).
- Jobs finish faster than with a single worker.

In RabbitMQ Management, **Consumers** should show `3`.

Scale back to one worker:

```bash
podman compose up -d --scale worker=1
```

**Takeaway:** Add consumers to increase throughput; the queue buffers work when producers outpace workers.

### Step 6 — See what happens when workers are down

This demonstrates **durability** and **buffering**.

```bash
podman compose stop worker
```

Upload 2–3 images. Messages pile up in `simulation_queue` (check Management UI — **Ready** count increases). The UI stays responsive; uploads still succeed.

Start the worker again:

```bash
podman compose start worker
```

The worker drains the backlog one message at a time (`prefetch: 1`).

**Takeaway:** The queue holds work until a consumer is available. Producers are not blocked.

### Step 7 — Batch upload and ordering

1. Open http://localhost:3000/gallery.html.
2. Select multiple images and click **Upload all & resize**.
3. Each file becomes **one RabbitMQ message** (one JSON object per image in the sidebar).
4. With one worker, messages are processed **serially** (FIFO per consumer).
5. With multiple workers, messages are distributed across consumers.

### Step 8 — Follow logs (optional)

```bash
# Producer logs (what gets queued)
podman compose logs -f server

# Consumer logs (resize steps + ack)
podman compose logs -f worker
```

Example worker output:

```
Processing task a1b2c3d4-... (1730....-photo.jpg) on rabbitmq-worker-1
[a1b2c3d4-...] 10% — In RabbitMQ Queue...
[a1b2c3d4-...] 100% — Done!
Acknowledged task a1b2c3d4-...
```

`Acknowledged` means RabbitMQ will not redeliver that message.

---

## API endpoints

| Method | Path                   | Description                                             |
| ------ | ---------------------- | ------------------------------------------------------- |
| `POST` | `/upload`              | Single image (`file`, `backgroundColor`, `clientLabel`) |
| `POST` | `/upload/batch`        | Multiple images (`files[]`, same fields)                |
| `GET`  | `/api/wallpapers`      | List completed wallpapers (metadata JSON)               |
| `GET`  | `/api/queue-log`       | Recent queued task payloads                             |
| `GET`  | `/wallpapers/:id.webp` | Download resized wallpaper                              |

## Environment variables

| Variable       | Service        | Default                            |
| -------------- | -------------- | ---------------------------------- |
| `RABBITMQ_URL` | server, worker | `amqp://guest:guest@rabbitmq:5672` |
| `QUEUE_NAME`   | server, worker | `simulation_queue`                 |
| `UPLOAD_DIR`   | server, worker | `/uploads`                         |
| `SERVER_URL`   | worker         | `http://server:3000`               |
| `PORT`         | server         | `3000`                             |

## Rootless Podman note (Fedora / SELinux)

The RabbitMQ service runs as `user: "0:0"` with `security_opt: label=disable` to avoid `.erlang.cookie` permission errors under rootless Podman. This is acceptable for local learning; do not use as-is in production.

## Concepts map

| RabbitMQ concept | In this project                                               |
| ---------------- | ------------------------------------------------------------- |
| **Producer**     | `server.js` — `channel.sendToQueue()` on upload               |
| **Queue**        | `simulation_queue`                                            |
| **Consumer**     | `worker.js` — `channel.consume()`                             |
| **Message**      | JSON: `taskId`, `filename`, `originalName`, `backgroundColor` |
| **Ack**          | `channel.ack(msg)` after resize succeeds                      |
| **Prefetch**     | `prefetch(1)` — one job per worker at a time                  |
| **Durability**   | Queue declared `durable: true`; messages `persistent: true`   |

## License

Demo project for learning — use and modify freely.
