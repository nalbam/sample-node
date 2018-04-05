let http = require('http');

let handle = function(req, res) {
  console.log('Received request for URL: ' + req.url);
  res.writeHead(200);
  res.end('<p>Hello World!</p>');
};

let www = http.createServer(handle);
www.listen(3000);
