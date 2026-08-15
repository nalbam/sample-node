let API_URL = location.protocol + '//' + location.host.replace(/sample-([a-z]+)/, 'sample-node');

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
        _counter('up', 'GET');
        _counter('down', 'GET');
    }, 1000);

    document.querySelector('.btn-thumbs-up').addEventListener('click', function () {
        _counter('up', 'POST');
    });
    document.querySelector('.btn-thumbs-down').addEventListener('click', function () {
        _counter('down', 'POST');
    });
});
