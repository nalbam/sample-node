let os = require('os'),
    fs = require('fs'),
    http = require('http'),
    moment = require("moment-timezone");

let handle = function (req, res) {
    console.log('Received request for URL: ' + req.url);
    let logo = 'https://cdn.nalbam.com/logo/nodejs.png';
    let host = os.hostname();
    let date = moment().tz("Asia/Seoul").format();
    res.writeHead(200);
    res.end('<p><img src="' + logo + '"></p><p>' + host + '</p><p>' + date + '</p>');
};

let server = http.createServer(handle);
server.listen(3000);
