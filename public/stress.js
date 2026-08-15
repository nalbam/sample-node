/**
 * Drives the CPU stress switch.
 *
 * Which pod picks up the request is the load balancer's call, and so is the
 * stop — the pod list is what actually shows where the burn landed. The
 * countdown here is only what this page asked for.
 */

const STRESS_SECONDS = 60;

document.addEventListener('DOMContentLoaded', function () {
    let button = document.querySelector('.btn-stress');
    let ticker = null;
    let remaining = 0;

    function idle() {
        clearInterval(ticker);
        ticker = null;
        remaining = 0;
        button.textContent = `stress ${STRESS_SECONDS}s`;
        button.classList.remove('is-on');
    }

    function countdown() {
        remaining -= 1;
        if (remaining <= 0) {
            idle();
            return;
        }
        button.textContent = `stop ${remaining}s`;
    }

    button.addEventListener('click', function () {
        if (ticker) {
            fetch('/stress', { method: 'DELETE' })
                .catch(function () { })
                .then(idle);
            return;
        }

        fetch(`/stress/${STRESS_SECONDS}`, { method: 'POST' })
            .then(function (res) {
                return res.json();
            })
            .then(function () {
                remaining = STRESS_SECONDS;
                button.classList.add('is-on');
                button.textContent = `stop ${remaining}s`;
                ticker = setInterval(countdown, 1000);
            })
            .catch(idle);
    });

    idle();
});
