let os = require('os'),
    http = require('http'),
    moment = require("moment-timezone");

let handle = function (req, res) {
    console.log('Received request for URL: ' + req.url);
    res.writeHead(200);
    let date = moment().tz("Asia/Seoul").format();
    res.end('<h1>Hello World!</h1><p>' + os.hostname() + '</p><p>' + date + '</p>');
};

let server = http.createServer(handle);
server.listen(3000);
