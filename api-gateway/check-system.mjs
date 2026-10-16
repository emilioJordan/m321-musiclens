import WebSocket from "ws";

const gateway = process.env.GATEWAY ?? "http://127.0.0.1:3000";
const stats = process.env.STATS ?? "http://127.0.0.1:8001";
const recs = process.env.RECS ?? "http://127.0.0.1:8002";
const rabbitUser = process.env.RABBITMQ_USER ?? "musiclens";
const rabbitPass = process.env.RABBITMQ_PASSWORD ?? "musiclens";

async function mustOk(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`${url} -> ${res.status}`);
  }
  console.log("ok", url);
}

function waitFor(url, attempts = 40) {
  return new Promise((resolve, reject) => {
    const tick = async (left) => {
      try {
        const res = await fetch(url);
        if (res.ok) {
          resolve();
          return;
        }
      } catch {
        // Service ist noch nicht da.
      }
      if (left <= 0) {
        reject(new Error(`timeout ${url}`));
        return;
      }
      setTimeout(() => tick(left - 1), 2000);
    };
    tick(attempts);
  });
}

function ping(kind) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${gateway.replace(/^http/, "ws")}/ws`);
    const jobId = crypto.randomUUID();
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`timeout ${kind}`));
    }, 15000);
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "job", jobId, kind }));
    });
    ws.on("message", (buf) => {
      const msg = JSON.parse(buf.toString());
      console.log(kind, msg.type, msg.label ?? msg.error ?? "");
      if (msg.jobId !== jobId) return;
      if (msg.type === "result") {
        clearTimeout(timer);
        ws.close();
        resolve(msg);
      }
      if (msg.type === "error") {
        clearTimeout(timer);
        ws.close();
        reject(new Error(msg.error));
      }
    });
    ws.on("error", () => {
      clearTimeout(timer);
      reject(new Error(`socket ${kind}`));
    });
  });
}

await waitFor(`${gateway}/health`);
await mustOk(`${gateway}/health`);
await mustOk(`${stats}/health`);
await mustOk(`${recs}/health`);

const denied = await fetch(`${gateway}/stats/top`);
if (denied.status !== 401) {
  throw new Error(`top ohne Login sollte 401 sein, war ${denied.status}`);
}
console.log("ok auth gate");

const queues = await fetch("http://127.0.0.1:15672/api/queues", {
  headers: {
    Authorization: `Basic ${Buffer.from(`${rabbitUser}:${rabbitPass}`).toString("base64")}`,
  },
});
if (!queues.ok) {
  throw new Error(`RabbitMQ API ${queues.status}`);
}
const names = new Set((await queues.json()).map((queue) => queue.name));
for (const name of ["musiclens.stats.jobs", "musiclens.recs.jobs", "musiclens.stats.updated", "musiclens.gateway.events"]) {
  if (!names.has(name)) {
    throw new Error(`Queue fehlt: ${name}`);
  }
  console.log("queue", name);
}

const statsPing = await ping("ping-stats");
const recsPing = await ping("ping-recs");
if (!statsPing.payload?.ok || statsPing.payload.service !== "statistics") {
  throw new Error("statistics ping");
}
if (!recsPing.payload?.ok || recsPing.payload.service !== "recommendation") {
  throw new Error("recommendation ping");
}

const anon = await ping("dashboard").catch((err) => err);
if (!(anon instanceof Error) || anon.message !== "not_authenticated") {
  throw new Error("dashboard ohne Login muss ablehnen");
}
console.log("pipeline ok");
