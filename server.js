'use strict';

const DD_AGENT = process.env.DD_AGENT_ENABLED || false;

// datadog tracer
if (DD_AGENT) {
  require('dd-trace').init({
    // hostname: process.env.DD_AGENT_HOST,
    // port: process.env.DD_AGENT_PORT,
    // analytics: true,
  })
}

// // newrelic tracer
// if (TRACER === 'all' || TRACER === 'newrelic') {
//     require('newrelic');
// }

// env
const CLUSTER = process.env.CLUSTER_NAME || 'local';
const COLLECTOR = process.env.COLLECTOR || `http://jaeger-collector.istio-system.svc.cluster.local:14268/api/traces`;
const FAULT_RATE = process.env.FAULT_RATE || 0;
const HOSTNAME = process.env.HOSTNAME || 'default.svc.cluster.local';
const LOOP_HOST = process.env.LOOP_HOST || `http://sample-node`;
const MESSAGE = process.env.MESSAGE || '';
const NAMESPACE = process.env.NAMESPACE || 'default';
const PORT = process.env.PORT || 3000;
const PROFILE = process.env.PROFILE || 'default';
const PROTOCOL = process.env.PROTOCOL || 'http';
const REDIS_URL = process.env.REDIS_URL || `redis://sample-redis:6379`;
const VERSION = process.env.VERSION || 'v0.0.0';

const os = require('os'),
  cors = require('cors'),
  express = require('express'),
  moment = require('moment-timezone'),
  redis = require('redis'),
  request = require('request');

// // prom
// var PrometheusMetricsFactory = require('jaeger-client').PrometheusMetricsFactory;
// var promClient = require('prom-client');

// var config = {
//   serviceName: 'sample-node',
// };
// var namespace = config.serviceName;
// var metrics = new PrometheusMetricsFactory(promClient, namespace);

// // jaeger
// const initTracer = require('jaeger-client').initTracer;
// const config = {
//   serviceName: `sample-node.${NAMESPACE}`,
//   reporter: {
//     collectorEndpoint: COLLECTOR,
//     logSpans: true,
//   },
//   sampler: {
//     type: 'const',
//     param: 1
//   },
// };
// const options = {
//   tags: {
//     'sample-node.version': VERSION,
//   },
//   // metrics: metrics,
//   logger: console,
// };
// const tracer = initTracer(config, options);

// // zipkin
// const {
//     Tracer,
//     ExplicitContext,
//     ConsoleRecorder
// } = require("zipkin");
// const zipkinExpress = require("zipkin-instrumentation-express").expressMiddleware;
// const zipkinRequest = require('zipkin-instrumentation-request');

// // zipkin tracer
// const tracer = new Tracer({
//     ctxImpl: new ExplicitContext(),
//     recorder: new ConsoleRecorder(),
//     localServiceName: "sample-node",
// });

// express
const app = express();
app.set('view engine', 'ejs');

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// app.use(zipkinExpress({
//     tracer
// }));

// redis
const retry_strategy = function (options) {
  if (options.error && (options.error.code === 'ECONNREFUSED' || options.error.code === 'NR_CLOSED')) {
    // Try reconnecting after 5 seconds
    console.error('The server refused the connection. Retrying connection...');
    return 5000;
  }
  if (options.total_retry_time > 1000 * 60 * 60) {
    // End reconnecting after a specific timeout and flush all commands with an individual error
    return new Error('Retry time exhausted');
  }
  if (options.attempt > 50) {
    // End reconnecting with built in error
    return undefined;
  }
  // reconnect after
  return Math.min(options.attempt * 100, 5000);
};
const client = redis.createClient(REDIS_URL, {
  retry_strategy: retry_strategy
});
client.on('connect', () => {
  console.log(`connected to redis: ${REDIS_URL}`);
});
client.on('error', err => {
  console.error(`${err}`);
});

app.get('/', function (req, res) {
  // console.log(`${req.method} ${req.path}`);
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
  // console.log(`${req.method} ${req.path}`);
  res.render('drop.ejs', {
    rate: 100,
  });
});

app.get('/drop/:rate', function (req, res) {
  // console.log(`${req.method} ${req.path}`);
  res.render('drop.ejs', {
    rate: req.params.rate,
  });
});

app.get('/read', function (req, res) {
  // console.log(`${req.method} ${req.path}`);
  return res.status(200).json({
    result: 'read',
  });
});

app.get('/live', function (req, res) {
  // console.log(`${req.method} ${req.path}`);
  return res.status(200).json({
    result: 'live',
  });
});

app.get('/health', function (req, res) {
  // console.log(`${req.method} ${req.path}`);
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
  // console.log(`${req.method} ${req.path}`);
  console.log(`${JSON.stringify(req.headers)}`);

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
  // console.log(`${req.method} ${req.path}`);
  console.log(`${JSON.stringify(req.headers)}`);

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
  // console.log(`${req.method} ${req.path}`);
  console.log(`${JSON.stringify(req.headers)}`);

  var count = req.params.count;

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
  console.log(`${req.method} ${req.path}`);
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
  console.log(`${req.method} ${req.path}`);
  const rate = req.params.rate;
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
  console.log(`${req.method} ${req.path}`);
  const rate = req.params.rate;
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
  console.log(`${req.method} ${req.path}`);
  sleep(sec);
  return res.status(200).json({
    result: 'ok',
    sec: sec,
    version: VERSION,
  });
});

app.get('/cache/:name', function (req, res) {
  // console.log(`${req.method} ${req.path}`);
  const name = req.params.name;
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
  // console.log(`${req.method} ${req.path}`);
  const name = req.params.name;
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
  // console.log(`${req.method} ${req.path}`);
  const name = req.params.name;
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
  // console.log(`${req.method} ${req.path}`);
  const name = req.params.name;
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
  // console.log(`${req.method} ${req.path}`);
  const name = req.params.name;
  return client.decr(`counter:${name}`, (err, result) => {
    res.setHeader('Content-Type', 'text/plain; charset=UTF-8');
    if (err) {
      console.error(`${err}`);
      return res.status(500).send(err.message);
    }
    return res.send(result == null ? '0' : result.toString());
  });
});

app.listen(PORT, function () {
  console.log(`[${PROFILE}] Listening on port ${PORT}!`);
  console.log(`connecting to redis: ${REDIS_URL}`);
});
