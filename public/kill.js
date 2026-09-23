function _kill() {
    let status = document.getElementById('kill-status');
    fetch('/oom', { method: 'POST', signal: AbortSignal.timeout(8000) })
        .then(function (res) {
            if (res.status !== 202) throw new Error(`HTTP ${res.status}`);
            return res.json();
        })
        .then(function (res) {
            document.querySelector('.panel').classList.add('is-killing');
            status.textContent = `killing ${res.host}`;
            document.dispatchEvent(new CustomEvent('oom:start', {detail: res}));
        })
        .catch(function () {
            status.textContent = 'Kill request not confirmed. Check the pod trace before retrying.';
            document.querySelector('.btn-kill').disabled = false;
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
    document.addEventListener('oom:complete', function (event) {
        document.querySelector('.panel').classList.remove('is-killing');
        document.getElementById('kill-status').textContent = event.detail.phase === 'restarted'
            ? `${event.detail.host} restarted and is responding. The switch is ready again.`
            : 'Allocation reached the safety cap; this process has no container memory limit.';
        button.disabled = false;
    });
});
