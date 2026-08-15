let API_URL = location.protocol + '//' + location.host.replace(/sample-([a-z]+)/, 'sample-node');

// Only picks up other people's clicks — our own land in the POST response — so
// it does not need to be quick.
const COUNTER_INTERVAL = 5000;

function _counter(name, method) {
    fetch(`${API_URL}/counter/${name}`, { method: method })
        .then(function (res) {
            return res.ok ? res.text() : null;
        })
        .then(function (text) {
            if (text) {
                document.getElementById(`thumbs-${name}-count`).textContent = text;
            }
        })
        .catch(function () {
            // Polling is best effort, so a failed read keeps the last value.
        });
}

document.addEventListener('DOMContentLoaded', function () {
    _counter('up', 'GET');
    _counter('down', 'GET');
    setInterval(function () {
        if (!document.hidden) {
            _counter('up', 'GET');
            _counter('down', 'GET');
        }
    }, COUNTER_INTERVAL);

    document.querySelector('.btn-thumbs-up').addEventListener('click', function () {
        _counter('up', 'POST');
    });
    document.querySelector('.btn-thumbs-down').addEventListener('click', function () {
        _counter('down', 'POST');
    });
});
