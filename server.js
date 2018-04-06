let http = require('http');

let handle = function(req, res) {
  console.log('Received request for URL: ' + req.url);
  res.writeHead(200);
  let date = new Date();
  res.end('<p>Hello World! - ' + date + '</p>');
};

let server = http.createServer(handle);
server.listen(3000);
