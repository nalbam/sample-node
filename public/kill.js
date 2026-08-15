function _kill() {
    let status = document.getElementById('kill-status');
    fetch('/oom', { method: 'POST' })
        .then(function (res) {
            return res.json();
        })
        .then(function (res) {
            document.querySelector('.panel').classList.add('is-killing');
            status.textContent = `killing ${res.host}`;
        })
        .catch(function () {
            status.textContent = 'kill failed';
        });
}

document.addEventListener('DOMContentLoaded', function () {
    let dialog = document.getElementById('kill-dialog');
    let button = document.querySelector('.btn-kill');

    button.addEventListener('click', function () {
        dialog.showModal();
    });

    document.getElementById('kill-cancel').addEventListener('click', function () {
        dialog.close();
    });

    document.getElementById('kill-confirm').addEventListener('click', function () {
        dialog.close();
        // The instance is going down, so a second press has nothing to do.
        button.disabled = true;
        _kill();
    });
});
