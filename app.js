const os = require('os'),
    moment = require("moment-timezone"),
    express = require('express');

const app = express();
app.set('view engine', 'ejs');

app.get('/', function (req, res) {
    let host = os.hostname();
    let date = moment().tz("Asia/Seoul").format();
    res.render('index.ejs', {host: host, date: date});
});

app.listen(3000, function () {
    console.log('Listening on port 3000!');
});
