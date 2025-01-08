'use strict';

// env
const CLUSTER = process.env.CLUSTER_NAME ?? 'local';
const FAULT_RATE = parseFloat(process.env.FAULT_RATE) || 0;
const HOSTNAME = process.env.HOSTNAME ?? 'default.svc.cluster.local';
const LOOP_HOST = process.env.LOOP_HOST ?? `http://sample-node`;
const MESSAGE = process.env.MESSAGE ?? '';
const PORT = parseInt(process.env.PORT, 10) || 3000;
const PROFILE = process.env.PROFILE ?? 'default';
const PROTOCOL = process.env.PROTOCOL ?? 'http';
const REDIS_HOST = process.env.REDIS_HOST ?? 'redis';
const REDIS_PORT = parseInt(process.env.REDIS_PORT, 10) || 6379;
const REDIS_PASS = process.env.REDIS_PASS ?? '';
const VERSION = process.env.VERSION ?? 'v0.0.0';

import fetch from 'node-fetch';
import os from 'os';
import cors from 'cors';
import express from 'express';
import moment from 'moment-timezone';
import redis from 'redis';
import prom from 'prom-client';

import { promisify } from 'util';

// redis
const client = redis.createClient({
  url: `redis://${REDIS_HOST}:${REDIS_PORT}`,
  password: REDIS_PASS
});
client.on('connect', () => {
  console.log(`connected to redis: ${REDIS_HOST}:${REDIS_PORT}`);
});
client.on('error', err => {
  console.error(`${err}`);
});

const clientGetAsync = promisify(client.get).bind(client);
const clientSetAsync = promisify(client.set).bind(client);
const clientIncrAsync = promisify(client.incr).bind(client);
const clientDecrAsync = promisify(client.decr).bind(client);

// express
const app = express();
app.set('view engine', 'ejs');

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// prom-client
const register = new prom.Registry();
prom.collectDefaultMetrics({ register });

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms * 1000));
}

async function handleRemoteService(req, res, serviceName) {
  console.log(`get /${serviceName}`);
  const remoteService = PROFILE === 'default' ? `http://sample-${serviceName}` : `${PROTOCOL}://sample-${serviceName}.${HOSTNAME}`;

  try {
    const response = await fetch(`${remoteService}/health`);
    const body = await response.json();
    return res.status(response.status).json(body);
  } catch (error) {
    return res.status(500).json({
      result: 'error',
    });
  }
}

app.get('/node', async (req, res) => handleRemoteService(req, res, 'node'));
app.get('/spring', async (req, res) => handleRemoteService(req, res, 'spring'));
app.get('/tomcat', async (req, res) => handleRemoteService(req, res, 'tomcat'));

app.get('/', async function (req, res) {
  console.log(`get /`);

  let host = os.hostname();
  let date = moment().tz('Asia/Seoul').format();
  res.render('index.ejs', {
    host: host,
    date: date,
    cluster: CLUSTER,
    profile: PROFILE,
    message: MESSAGE,
    version: VERSION,
  });
});

app.get('/drop', async function (req, res) {
  console.log(`get /drop`);

  res.render('drop.ejs', {
    rate: 100,
  });
});

app.get('/drop/:rate', async function (req, res) {
  var rate = req.params.rate;

  console.log(`get /drop/${rate}`);

  res.render('drop.ejs', {
    rate: req.params.rate,
  });
});

app.get('/read', async function (req, res) {
  console.log(`get /read`);

  return res.status(200).json({
    result: 'read',
  });
});

app.get('/live', async function (req, res) {
  console.log(`get /live`);

  return res.status(200).json({
    result: 'live',
  });
});

app.get('/health', async function (req, res) {
  console.log(`get /health`);

  if (Math.random() * 100 >= FAULT_RATE) {
    return res.status(200).json({
      result: 'ok',
      version: VERSION,
    });
  } else {
    return res.status(500).json({
      result: 'error',
      version: VERSION,
    });
  }
});

app.get('/loop/:count', async function (req, res) {
  var count = parseInt(req.params.count, 10);

  console.log(`get /loop/${count}`);

  if (isNaN(count) || count < 0) {
    return res.status(400).json({
      result: 'error',
      message: 'Invalid count value',
    });
  }

  if (count <= 0) {
    return res.status(200).json({
      result: 'ok',
      version: VERSION,
    });
  }

  count--;

  var remoteService = LOOP_HOST;

  try {
    const response = await fetch(`${remoteService}/loop/${count}`);
    const body = await response.json();
    return res.status(response.status).json({
      result: 'ok',
      version: VERSION,
      data: body
    });
  } catch (error) {
    return res.status(500).json({
      result: 'error',
      version: VERSION,
    });
  }
});

app.get('/stress', async function (req, res) {
  console.log(`get /stress`);

  let sum = 0;
  for (let i = 0; i < 5000000; i++) {
    sum += Math.sqrt(i);
  }
  return res.status(200).json({
    result: 'ok',
    version: VERSION,
    sum: sum,
  });
});

function handleRateBasedResponse(req, res, rate, successCondition) {
  if (successCondition(rate)) {
    return res.status(200).json({
      result: 'ok',
      rate: rate,
      version: VERSION,
    });
  } else {
    return res.status(500).json({
      result: 'error',
      rate: rate,
      version: VERSION,
    });
  }
}

app.get('/success/:rate', async function (req, res) {
  const rate = parseFloat(req.params.rate);
  console.log(`get /success/${rate}`);
  handleRateBasedResponse(req, res, rate, (rate) => Math.random() * 100 <= rate);
});

app.get('/fault/:rate', async function (req, res) {
  const rate = parseFloat(req.params.rate);
  console.log(`get /fault/${rate}`);
  handleRateBasedResponse(req, res, rate, (rate) => Math.random() * 100 >= rate);
});

app.get('/delay/:sec', async function (req, res) {
  const sec = req.params.sec;

  console.log(`get /delay/${sec}`);

  await sleep(sec);
  return res.status(200).json({
    result: 'ok',
    sec: sec,
    version: VERSION,
  });
});

app.get('/cache/:name', async function (req, res) {
  const name = req.params.name;
  console.log(`get /cache/${name}`);

  try {
    const result = await clientGetAsync(`cache:${name}`);
    return res.status(200).json(result == null ? {} : JSON.parse(result));
  } catch (err) {
    console.error(`${err}`);
    return res.status(500).json({
      status: 500,
      message: err.message,
    });
  }
});

app.post('/cache/:name', async function (req, res) {
  const name = req.params.name;
  console.log(`post /cache/${name}`);

  const json = JSON.stringify(req.body);
  try {
    const result = await clientSetAsync(`cache:${name}`, json);
    return res.status(200).json(result == null ? {} : result);
  } catch (err) {
    console.error(`${err}`);
    return res.status(500).json({
      status: 500,
      message: err.message,
    });
  }
});

app.get('/counter/:name', async function (req, res) {
  const name = req.params.name;

  console.log(`get /counter/${name}`);

  try {
    const result = await clientGetAsync(`counter:${name}`);
    res.setHeader('Content-Type', 'text/plain; charset=UTF-8');
    return res.send(result == null ? '0' : result.toString());
  } catch (err) {
    console.error(`${err}`);
    return res.status(500).send(err.message);
  }
});

app.post('/counter/:name', async function (req, res) {
  const name = req.params.name;

  console.log(`post /counter/${name}`);

  try {
    const result = await clientIncrAsync(`counter:${name}`);
    res.setHeader('Content-Type', 'text/plain; charset=UTF-8');
    return res.send(result == null ? '0' : result.toString());
  } catch (err) {
    console.error(`${err}`);
    return res.status(500).send(err.message);
  }
});

app.delete('/counter/:name', async function (req, res) {
  const name = req.params.name;

  console.log(`delete /counter/${name}`);

  try {
    const result = await clientDecrAsync(`counter:${name}`);
    res.setHeader('Content-Type', 'text/plain; charset=UTF-8');
    return res.send(result == null ? '0' : result.toString());
  } catch (err) {
    console.error(`${err}`);
    return res.status(500).send(err.message);
  }
});

app.get('/metrics', (req, res) => {
  console.log(`get /metrics`);

  res.setHeader('Content-Type', register.contentType);
  res.send(register.metrics());
});

// Redis 클라이언트 연결 상태 확인 및 재연결
async function ensureRedisConnection() {
  if (!client.isOpen) {
    try {
      await client.connect();
      console.log('Redis 클라이언트가 재연결되었습니다.');
    } catch (err) {
      console.error('Redis 클라이언트 재연결 실패:', err);
    }
  }
}

// Redis 명령 실행 전 연결 상태 확인
app.use(async (req, res, next) => {
  await ensureRedisConnection();
  next();
});

app.listen(PORT, function () {
  console.log(`[${PROFILE}] Listening on port ${PORT}!`);
  console.log(`connecting to redis: ${REDIS_HOST}:${REDIS_PORT}`);
});
