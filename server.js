'use strict';

// const TRACER = process.env.TRACER || 'none';

// // datadog tracer
// if (TRACER === 'all' || TRACER === 'datadog') {
//     require('dd-trace').init({
//         hostname: process.env.DD_AGENT_HOST,
//         port: process.env.DD_AGENT_PORT,
//         analytics: true
//     })
// }

// // newrelic tracer
// if (TRACER === 'all' || TRACER === 'newrelic') {
//     require('newrelic');
// }

// env
const PORT = process.env.PORT || 3000;
const PROFILE = process.env.PROFILE || 'default';
const VERSION = process.env.VERSION || 'v0.0.0';
const MESSAGE = process.env.MESSAGE || PROFILE;
const FAULT_RATE = process.env.FAULT_RATE || 0;
const REDIS_URL = process.env.REDIS_URL || `redis://sample-node-redis:6379`;

const os = require('os'),
    cors = require('cors'),
    express = require('express'),
    moment = require('moment-timezone'),
    redis = require('redis'),
    request = require('request');

// jaeger
// const initTracer = require('jaeger-client').initTracer;
// const config = {
//     serviceName: 'sample-node',
// };
// const options = {
//     tags: {
//         'sample-node.version': VERSION,
//     },
//     // metrics: metrics,
//     logger: {
//         info(msg) {
//             console.log("INFO ", msg);
//         },
//         error(msg) {
//             console.log("ERROR", msg);
//         },
//     },
// };
// const {
//     track
// } = require("express-jaeger");
// const tracer = initTracer(config, options);

const Tracer = require('@risingstack/jaeger');
const tracer = new Tracer({
    serviceName: 'sample-node'
});

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
        message: MESSAGE,
        version: VERSION
    });
});

app.get('/drop', function (req, res) {
    // console.log(`${req.method} ${req.path}`);
    res.render('drop.ejs', {
        version: VERSION
    });
});

app.get('/read', function (req, res) {
    // console.log(`${req.method} ${req.path}`);
    return res.status(200).json({
        result: 'read'
    });
});

app.get('/live', function (req, res) {
    // console.log(`${req.method} ${req.path}`);
    return res.status(200).json({
        result: 'live'
    });
});

app.get('/health', function (req, res) {
    // console.log(`${req.method} ${req.path}`);
    var version;
    if (PROFILE === 'default') {
        version = `v0.0.${parseInt(Math.random() * 2)}`;
    } else {
        version = VERSION;
    }

    if (Math.random() * 100 >= FAULT_RATE) {
        return res.status(200).json({
            result: 'ok',
            version: version
        });
    } else {
        return res.status(500).json({
            result: 'error',
            version: version
        });
    }
});

app.get('/spring', function (req, res) {
    // console.log(`${req.method} ${req.path}`);
    console.log(`${JSON.stringify(req.headers)}`);

    var remoteService;
    if (PROFILE === 'default') {
        remoteService = 'localhost:8080';
    } else {
        remoteService = 'sample-spring';
    }

    request(`http://${remoteService}/health`, function (error, response, body) {
        if (error) {
            return res.status(500).json({
                result: 'error'
            });
        } else {
            return res.status(response.statusCode).json(JSON.parse(body));
        }
    });
});

app.get('/tomcat', function (req, res) {
    // console.log(`${req.method} ${req.path}`);
    console.log(`${JSON.stringify(req.headers)}`);

    var remoteService;
    if (PROFILE === 'default') {
        remoteService = 'localhost:8080';
    } else {
        remoteService = 'sample-tomcat';
    }

    request(`http://${remoteService}/health`, function (error, response, body) {
        if (error) {
            return res.status(500).json({
                result: 'error'
            });
        } else {
            return res.status(response.statusCode).json(JSON.parse(body));
        }
    });
});

app.get('/loop/:count', function (req, res) {
    // console.log(`${req.method} ${req.path}`);
    console.log(`${JSON.stringify(req.headers)}`);

    var count = req.params.count;

    if (count <= 0) {
        return res.status(200).json({
            result: 'ok'
        });
    }

    count--;

    var remoteService;
    if (PROFILE === 'default') {
        remoteService = 'localhost:3000';
    } else {
        remoteService = 'sample-node';
    }

    // const zipRequest = zipkinRequest(request, {
    //     tracer,
    //     remoteService
    // });

    // zipRequest({
    //     url: `http://${remoteService}/loop/${count}`,
    //     method: 'GET',
    // }, function (error, response, body) {
    //     if (error) {
    //         return res.status(500).json({
    //             result: 'error'
    //         });
    //     } else {
    //         return res.status(response.statusCode).json({
    //             result: 'ok',
    //             data: JSON.parse(body)
    //         });
    //     }
    // });

    request(`http://${remoteService}/loop/${count}`, function (error, response, body) {
        // console.log('error:', error);
        // console.log('statusCode:', response && response.statusCode);
        // console.log('body:', body);

        if (error) {
            return res.status(500).json({
                result: 'error'
            });
        } else {
            return res.status(response.statusCode).json({
                result: 'ok',
                data: JSON.parse(body)
            });
        }
    });
});

app.get('/stress', function (req, res) {
    // console.log(`${req.method} ${req.path}`);
    let sum = 0;
    for (let i = 0; i < 1000000; i++) {
        sum += Math.sqrt(i);
    }
    return res.status(200).json({
        sum: sum
    });
});

app.get('/fault/:rate', function (req, res) {
    // console.log(`${req.method} ${req.path}`);
    const rate = req.params.rate;
    if (Math.random() * 100 >= rate) {
        return res.status(200).json({
            result: 'ok'
        });
    } else {
        return res.status(500).json({
            result: 'error'
        });
    }
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
