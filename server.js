'use strict';

// env
const CLUSTER = process.env.CLUSTER_NAME || 'local';
const FAULT_RATE = process.env.FAULT_RATE || 0;
const HOSTNAME = process.env.HOSTNAME || 'default.svc.cluster.local';
const LOOP_HOST = process.env.LOOP_HOST || `http://sample-node`;
const MESSAGE = process.env.MESSAGE || '';
const PORT = process.env.PORT || 3000;
const PROFILE = process.env.PROFILE || 'default';
const PROTOCOL = process.env.PROTOCOL || 'http';
const REDIS_HOST = process.env.REDIS_HOST || 'sample-redis';
const REDIS_PORT = process.env.REDIS_PORT || 6379;
const REDIS_PASS = process.env.REDIS_PASS || '';
const VERSION = process.env.VERSION || 'v0.0.0';

const os = require('os'),
  cors = require('cors'),
  express = require('express'),
  moment = require('moment-timezone'),
  redis = require('redis'),
  request = require('request'),
  prom = require('prom-client');

// express
const app = express();
app.set('view engine', 'ejs');

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// prom-client
const register = new prom.Registry();
prom.collectDefaultMetrics({ register });

// redis
const client = redis.createClient({
  host: REDIS_HOST,
  port: REDIS_PORT,
  db: 0,
  password: REDIS_PASS
});
client.on('connect', () => {
  console.log(`connected to redis: ${REDIS_HOST}:${REDIS_PORT}`);
});
client.on('error', err => {
  console.error(`${err}`);
});

app.get('/', function (req, res) {
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

app.get('/drop', function (req, res) {
  console.log(`get /drop`);

  res.render('drop.ejs', {
    rate: 100,
  });
});

app.get('/drop/:rate', function (req, res) {
  var rate = req.params.rate;

  console.log(`get /drop/${rate}`);

  res.render('drop.ejs', {
    rate: req.params.rate,
  });
});

app.get('/read', function (req, res) {
  console.log(`get /read`);

  return res.status(200).json({
    result: 'read',
  });
});

app.get('/live', function (req, res) {
  console.log(`get /live`);

  return res.status(200).json({
    result: 'live',
  });
});

app.get('/health', function (req, res) {
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

app.get('/spring', function (req, res) {
  console.log(`get /spring`);
  // console.log(`${JSON.stringify(req.headers)}`);

  var remoteService;
  if (PROFILE === 'default') {
    remoteService = 'http://sample-spring';
  } else {
    remoteService = `${PROTOCOL}://sample-spring.${HOSTNAME}`;
  }

  // const span = tracer.startSpan("http_request");
  request(`${remoteService}/health`, function (error, response, body) {
    if (error) {
      return res.status(500).json({
        result: 'error',
      });
    } else {
      return res.status(response.statusCode).json(JSON.parse(body));
    }
  });
  // span.finish();
});

app.get('/tomcat', function (req, res) {
  console.log(`get /tomcat`);
  // console.log(`${JSON.stringify(req.headers)}`);

  var remoteService;
  if (PROFILE === 'default') {
    remoteService = 'http://sample-tomcat';
  } else {
    remoteService = `${PROTOCOL}://sample-tomcat.${HOSTNAME}`;
  }

  // const span = tracer.startSpan("http_request");
  request(`${remoteService}/health`, function (error, response, body) {
    if (error) {
      return res.status(500).json({
        result: 'error'
      });
    } else {
      return res.status(response.statusCode).json(JSON.parse(body));
    }
  });
  // span.finish();
});

app.get('/loop/:count', function (req, res) {
  // console.log(`${JSON.stringify(req.headers)}`);

  var count = req.params.count;

  console.log(`get /loop/${count}`);

  if (count <= 0) {
    return res.status(200).json({
      result: 'ok',
      version: VERSION,
    });
  }

  count--;

  var remoteService = LOOP_HOST;

  // const span = tracer.startSpan("http_request");
  request(`${remoteService}/loop/${count}`, function (error, response, body) {
    // console.log('error:', error);
    // console.log('statusCode:', response && response.statusCode);
    // console.log('body:', body);

    if (error) {
      return res.status(500).json({
        result: 'error',
        version: VERSION,
      });
    } else {
      return res.status(response.statusCode).json({
        result: 'ok',
        version: VERSION,
        data: JSON.parse(body)
      });
    }
  });
  // span.finish();
});

app.get('/stress', function (req, res) {
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

app.get('/success/:rate', function (req, res) {
  const rate = req.params.rate;

  console.log(`get /success/${rate}`);

  if (Math.random() * 100 <= rate) {
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
});

app.get('/fault/:rate', function (req, res) {
  const rate = req.params.rate;

  console.log(`get /fault/${rate}`);

  if (Math.random() * 100 >= rate) {
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
});

app.get('/delay/:sec', function (req, res) {
  const sec = req.params.sec;

  console.log(`get /delay/${sec}`);

  sleep(sec);
  return res.status(200).json({
    result: 'ok',
    sec: sec,
    version: VERSION,
  });
});

app.get('/cache/:name', function (req, res) {
  const name = req.params.name;

  console.log(`get /cache/${name}`);

  return client.get(`cache:${name}`, (err, result) => {
    if (err) {
      console.error(`${err}`);
      return res.status(500).json({
        status: 500,
        message: err.message,
      });
    }
    return res.status(200).json(result == null ? {} : JSON.parse(result));
  });
});

app.post('/cache/:name', function (req, res) {
  const name = req.params.name;
  console.log(`post /cache/${name}`);

  const json = JSON.stringify(req.body);
  //console.log(`req.body: ${json}`);
  return client.set(`cache:${name}`, json, (err, result) => {
    if (err) {
      console.error(`${err}`);
      return res.status(500).json({
        status: 500,
        message: err.message,
      });
    }
    return res.status(200).json(result == null ? {} : result);
  });
});

app.get('/counter/:name', function (req, res) {
  const name = req.params.name;

  console.log(`get /counter/${name}`);

  return client.get(`counter:${name}`, (err, result) => {
    res.setHeader('Content-Type', 'text/plain; charset=UTF-8');
    if (err) {
      console.error(`${err}`);
      return res.status(500).send(err.message);
    }
    return res.send(result == null ? '0' : result.toString());
  });
});

app.post('/counter/:name', function (req, res) {
  const name = req.params.name;

  console.log(`post /counter/${name}`);

  return client.incr(`counter:${name}`, (err, result) => {
    res.setHeader('Content-Type', 'text/plain; charset=UTF-8');
    if (err) {
      console.error(`${err}`);
      return res.status(500).send(err.message);
    }
    return res.send(result == null ? '0' : result.toString());
  });
});

app.delete('/counter/:name', function (req, res) {
  const name = req.params.name;

  console.log(`delete /counter/${name}`);

  return client.decr(`counter:${name}`, (err, result) => {
    res.setHeader('Content-Type', 'text/plain; charset=UTF-8');
    if (err) {
      console.error(`${err}`);
      return res.status(500).send(err.message);
    }
    return res.send(result == null ? '0' : result.toString());
  });
});

app.get('/metrics', async (req, res) => {
  console.log(`get /metrics`);

  res.setHeader('Content-Type', register.contentType);
  res.send(await register.metrics());
});

app.listen(PORT, function () {
  console.log(`[${PROFILE}] Listening on port ${PORT}!`);
  console.log(`connecting to redis: ${REDIS_URL}`);
});
