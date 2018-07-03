let os = require('os'),
    http = require('http'),
    moment = require("moment-timezone");

let handle = function (req, res) {
    console.log('Received request for URL: ' + req.url);
    let logo = 'https://cdn.nalbam.com/logo/logo_nodejs.png';
    let host = os.hostname();
    let date = moment().tz("Asia/Seoul").format();
    res.writeHead(200);
    res.end('<h1>Hello Node.js!</h1><p><img src="' + logo + '"></p><p>' + host + '</p><p>' + date + '</p>');
};

let server = http.createServer(handle);
server.listen(3000);
