let http = require('http');
let moment = require('moment-timezone');

let handle = function(req, res) {
  console.log('Received request for URL: ' + req.url);
  res.writeHead(200);
  let date = moment().tz("Asia/Seoul").format();
  res.end('<p>Hello World! - ' + date + '</p>');
};

let server = http.createServer(handle);
server.listen(3000);
