let http = require('http'),
    moment = require("moment-timezone");

let handle = function (req, res) {
    console.log('Received request for URL: ' + req.url);
    res.writeHead(200);
    let date = moment().tz("Asia/Seoul").format();
    res.end('<p>Hello World!</p>' + date);
};

let server = http.createServer(handle);
server.listen(3000);
